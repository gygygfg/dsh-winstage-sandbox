#!/usr/bin/env node
// Read-mask regression: proves the shim's C matcher reproduces T2's table.
//
//  1. `node src/paths.mjs --export-mask` -> entries[] (29) + probes[] (68)
//  2. winstage-probe.exe maskcheck <dll> <mask.json> -> the shim evaluates every
//     probe through its own normalize+match path; every probe must reproduce the
//     expected `maskClass` (null = must NOT match).
//  3. Case-variant mutation self-proof: the same paths with WINDOWS-style casing
//     must still be denied; with WINSTAGE_MASK_CASE_SENSITIVE=1 (folding disabled)
//     the check must go red -- proving the case-folding really is load-bearing.
//  4. Junction escape: a junction pointing at a sensitive directory must be
//     denied through the resolved real path.
//
// Usage: node tools/mask-regression.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = process.env.WINSTAGE_SHIM_OUT ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : path.join(REPO, 'shim', 'out');
const DLL = path.join(OUT, 'winstage-shim.dll');
const PROBE = path.join(OUT, 'winstage-probe.exe');
const MASK = path.join(OUT, 'mask.json');
const JSON_OUT = process.argv.includes('--json');

const checks = [];
const check = (id, ok, detail) => {
  checks.push({ id, ok: !!ok, detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' -- ' + detail : ''}`);
  return !!ok;
};

function runNative(exe, args, { tag, env } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, `mask-reg-${tag}.out.txt`);
  const errFile = path.join(OUT, `mask-reg-${tag}.err.txt`);
  const o = fs.openSync(outFile, 'w');
  const e = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, args, { stdio: ['ignore', o, e], cwd: REPO, env: env || process.env, windowsHide: true, timeout: 120000 });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  return {
    status: res.status,
    error: res.error ? String(res.error) : null,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function main() {
  // 1. fresh export
  const exp = runNative(process.execPath, [path.join(REPO, 'src', 'paths.mjs'), '--export-mask', MASK], { tag: 'export' });
  if (!fs.existsSync(MASK)) throw new Error(`mask export failed: ${exp.stderr || exp.stdout}`);
  const mask = JSON.parse(fs.readFileSync(MASK, 'utf8'));
  const entries = mask.entries ?? [];
  const probes = mask.probes ?? [];
  check('mask.export-schema', mask.schema === 'winstage.mask.v1' && entries.length > 0 && probes.length > 0,
    `schema=${mask.schema} entries=${entries.length} probes=${probes.length} normalizer=${mask.normalizer?.name}`);
  check('mask.normalizer-is-t2s', mask.normalizer?.name === 'maskKey',
    'the shim must use T2 normalization semantics, not its own');

  // 2. all probes through the shim's matcher
  const probeOut = path.join(OUT, 'maskcheck.result.json');
  const detailFile = `${probeOut}.detail.json`; // the shim writes per-probe detail here
  const r = runNative(PROBE, ['maskcheck', DLL, MASK, probeOut], { tag: 'maskcheck' });
  let probeResult = null;
  try { probeResult = JSON.parse(fs.readFileSync(probeOut, 'utf8')); } catch { /* ignored */ }
  let mc = null;
  try { mc = JSON.parse(fs.readFileSync(detailFile, 'utf8')); } catch { /* ignored */ }
  check('mask.shim-evaluated-all-probes', !!mc && mc.total === probes.length,
    `exit=${r.status} probe=${JSON.stringify(probeResult)} detail=${JSON.stringify(mc ? { total: mc.total, agree: mc.agree, mismatch: mc.mismatch, rules: mc.rules } : null)}`);
  const bad = (mc?.cases ?? []).filter((c) => !c.ok);
  check('mask.all-probes-agree', bad.length === 0,
    bad.length ? `${bad.length} mismatch: ${bad.slice(0, 5).map((b) => `${b.path} want=${b.expected} got=${b.got}`).join(' ; ')}` : `${mc?.agree}/${mc?.total} agree`);

  // 3. case-variant mutation: deny must survive different casing, and must break
  //    when folding is disabled (otherwise the probe proves nothing).
  const variant = 'C:\\WINDOWS\\System32\\config\\SAM';
  const cv = runNative(PROBE, ['check-path', DLL, MASK, variant, path.join(OUT, 'maskcheck-case.json')], { tag: 'case' });
  let cvJson = null;
  try { cvJson = JSON.parse(fs.readFileSync(path.join(OUT, 'maskcheck-case.json'), 'utf8')); } catch { /* ignored */ }
  check('mask.case-variant-denied', cvJson?.deny === true, `deny=${cvJson?.deny} detail=${(cvJson?.detail ?? '').slice(0, 160)}`);
  const cs = runNative(PROBE, ['check-path', DLL, MASK, variant, path.join(OUT, 'maskcheck-case-cs.json')],
    { tag: 'case-cs', env: { ...process.env, WINSTAGE_MASK_CASE_SENSITIVE: '1' } });
  let csJson = null;
  try { csJson = JSON.parse(fs.readFileSync(path.join(OUT, 'maskcheck-case-cs.json'), 'utf8')); } catch { /* ignored */ }
  check('mask.mutation-case-folding-is-load-bearing', csJson?.deny === false,
    `case-sensitive run: deny=${csJson?.deny} (must be false, proving the folding matters)`);

  // 4. junction escape: create a junction to the sensitive directory and check
  //    the path through it (the mask must match the resolved real path).
  const junction = path.join(REPO, 'shim', '.stage', 'mask-junction');
  fs.mkdirSync(path.dirname(junction), { recursive: true });
  const sensitiveDir = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh');
  let junctionCreated = false;
  try {
    fs.rmSync(junction, { recursive: true, force: true });
    if (fs.existsSync(sensitiveDir)) {
      const j = runNative(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
        ['/c', 'mklink', '/J', junction, sensitiveDir], { tag: 'junction' });
      junctionCreated = fs.existsSync(junction);
    }
  } catch { /* ignored */ }
  if (junctionCreated) {
    const jp = path.join(junction, '.credentials.yaml');
    const jr = runNative(PROBE, ['check-path', DLL, MASK, jp, path.join(OUT, 'maskcheck-junction.json')], { tag: 'junction-check' });
    let jJson = null;
    try { jJson = JSON.parse(fs.readFileSync(path.join(OUT, 'maskcheck-junction.json'), 'utf8')); } catch { /* ignored */ }
    check('mask.junction-escape-denied', jJson?.deny === true, `path=${jp} deny=${jJson?.deny}`);
    fs.rmSync(junction, { recursive: true, force: true });
  } else {
    check('mask.junction-escape-denied', false, `could not create the junction (sensitive dir exists=${fs.existsSync(sensitiveDir)})`);
  }

  const report = { ok: checks.every((c) => c.ok), maskFile: MASK, entries: entries.length, probes: probes.length, checks };
  fs.writeFileSync(path.join(OUT, 'mask-regression-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n${report.ok ? 'MASK REGRESSION PASSED' : 'MASK REGRESSION FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  process.exit(report.ok ? 0 : 1);
}

try { main(); } catch (e) { console.error(`[mask-regression] FAILED: ${e.message}`); process.exit(2); }
