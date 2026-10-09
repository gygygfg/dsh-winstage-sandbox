#!/usr/bin/env node
// Read-masking end-to-end acceptance (task-10 execution half).
//
// Injects with `WINSTAGE_SHIM_CONFIG` pointing at a config that declares
// `readDenyFile` (T2's `winstage.mask.v1` export) and checks:
//   1. carrier gate still passes (cmd/node/powershell exit 0) -- masking must not
//      break the shell itself;
//   2. sensitive paths are DENIED in the injected child (ERROR_ACCESS_DENIED);
//   3. an ordinary file is still readable (read-through unaffected);
//   4. a junction pointing at a sensitive directory is still denied (the mask
//      matches the resolved real path, not the literal path);
//   5. the same denials do NOT happen without the config (negative control), which
//      proves the denial comes from the mask and not from something else.
//
// Usage: node tools/mask-e2e.mjs [--json] [--keep-stage]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = process.env.WINSTAGE_SHIM_OUT ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : path.join(REPO, 'shim', 'out');
const DLL = path.join(OUT, 'winstage-shim.dll');
const INJECTOR = path.join(OUT, 'winstage-inject.exe');
const PROBE = path.join(OUT, 'winstage-probe.exe');
const MASK = path.join(OUT, 'mask.json');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const HOME = process.env.USERPROFILE || 'C:\\Users\\Administrator';
const RUN_ID = crypto.randomBytes(3).toString('hex');
const STAGE = path.join(REPO, 'shim', '.stage', `mask-${RUN_ID}`);
const EV = path.join(STAGE, 'evidence');
const JSON_OUT = process.argv.includes('--json');

const checks = [];
const evidence = {};
const check = (id, ok, detail) => {
  checks.push({ id, ok: !!ok, detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' -- ' + detail : ''}`);
  return !!ok;
};

const SENSITIVE = [
  { id: 'dsh-credentials', path: path.join(HOME, '.dsh', '.credentials.yaml') },
  { id: 'edge-login-data', path: path.join(HOME, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data') },
  { id: 'psreadline-history', path: path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt') },
  { id: 'ssh-key', path: path.join(HOME, '.ssh', 'id_rsa') },
  { id: 'sam-hive', path: path.join(SYS, 'System32', 'config', 'SAM') },
];
const ORDINARY = path.join(SYS, 'win.ini');

function runNative(exe, args, { tag, timeout = 120000 } = {}) {
  fs.mkdirSync(EV, { recursive: true });
  const outFile = path.join(EV, `${tag}.stdout.txt`);
  const errFile = path.join(EV, `${tag}.stderr.txt`);
  const o = fs.openSync(outFile, 'w');
  const e = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, args, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout });
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

function inject(tag, exe, args, cfgPath) {
  const argv = ['--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`];
  if (cfgPath) argv.push('--set-env', `WINSTAGE_SHIM_CONFIG=${cfgPath}`);
  argv.push('--report', path.join(EV, `${tag}.inject.json`), '--timeout-ms', '60000', '--child-timeout-ms', '120000', '--', exe, ...args);
  return runNative(INJECTOR, argv, { tag });
}

/** Inject the probe and read back its JSON verdict for `mode ... path`. */
function probeRead(tag, target, cfgPath) {
  const out = path.join(EV, `${tag}.json`);
  const r = inject(tag, PROBE, ['file-read', target, out], cfgPath);
  let verdict = null;
  try { verdict = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignored */ }
  let injectReport = null;
  try { injectReport = JSON.parse(fs.readFileSync(path.join(EV, `${tag}.inject.json`), 'utf8')); } catch { /* ignored */ }
  return { ...r, verdict, injectReport };
}

function main() {
  for (const f of [DLL, INJECTOR, PROBE]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f}; run node tools/build-shim.mjs`);
  }
  fs.mkdirSync(EV, { recursive: true });
  // 1. mask export + config
  const exp = runNative(process.execPath, [path.join(REPO, 'src', 'paths.mjs'), '--export-mask', MASK], { tag: 'export' });
  if (!fs.existsSync(MASK)) throw new Error(`mask export failed: ${exp.stderr}`);
  const cfgPath = path.join(STAGE, 'winstage-shim.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ readDenyFile: MASK }, null, 2) + '\n');
  evidence.config = { path: cfgPath, readDenyFile: MASK, maskBytes: fs.statSync(MASK).size };

  // 2. carrier gate with the mask active
  const carriers = [
    { id: 'cmd', exe: path.join(SYS, 'System32', 'cmd.exe'), args: ['/c', 'echo MASK-CMD-OK'], expect: /MASK-CMD-OK/ },
    { id: 'node', exe: process.execPath, args: ['-e', "process.stdout.write('MASK-NODE-OK')"], expect: /MASK-NODE-OK/ },
    { id: 'powershell', exe: path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-Command', "Write-Output ('MASK-PS-' + (1+1))"], expect: /MASK-PS-2/ },
  ];
  evidence.carriers = [];
  for (const c of carriers) {
    const r = inject(`carrier-${c.id}`, c.exe, c.args, cfgPath);
    const ok = r.status === 0 && c.expect.test(r.stdout);
    evidence.carriers.push({ id: c.id, ok, status: r.status, stdout: r.stdout.slice(0, 120), stderr: r.stderr.slice(0, 200) });
    check(`mask.carrier-${c.id}`, ok, `exit=${r.status} out=${JSON.stringify(r.stdout.slice(0, 40))} err=${JSON.stringify(r.stderr.slice(0, 100))}`);
  }

  // 3. sensitive paths denied, ordinary file allowed
  evidence.reads = [];
  for (const s of SENSITIVE) {
    const exists = fs.existsSync(s.path);
    const r = probeRead(`read-${s.id}`, s.path, cfgPath);
    const denied = r.verdict?.openOk === false && r.verdict?.openError === 5;
    evidence.reads.push({ ...s, exists, verdict: r.verdict });
    check(`mask.deny-${s.id}`, denied,
      `exists=${exists} openOk=${r.verdict?.openOk} openError=${r.verdict?.openError} (5 = ERROR_ACCESS_DENIED)`);
  }
  const ordinary = probeRead('read-ordinary', ORDINARY, cfgPath);
  evidence.readOrdinary = ordinary.verdict;
  check('mask.allow-ordinary-file', ordinary.verdict?.openOk === true,
    `path=${ORDINARY} openOk=${ordinary.verdict?.openOk} openError=${ordinary.verdict?.openError}`);

  // 3b. negative control: the same read WITHOUT the config must succeed (proves the
  // denial above comes from the mask, not from the path/file itself).
  const control = probeRead('read-control', SENSITIVE[0].path, null);
  evidence.negativeControl = control.verdict;
  check('mask.negative-control-without-config', control.verdict?.openOk === true,
    `openOk=${control.verdict?.openOk} openError=${control.verdict?.openError}`);

  // 4. Junction escape. Creating a reparse point is refused in this sandbox
  //    ("Access is denied" even as Administrator, in the workspace and in %TEMP%),
  //    so the test uses an OS-provided junction instead: C:\Users\All Users ->
  //    C:\ProgramData (and friends). Reading a masked file *through* it must be
  //    denied, which only happens if normalization resolves the real path.
  //    Evidence is two-fold: the DLL reports the normalized path, and the injected
  //    read returns ACCESS_DENIED.
  const junctionCandidates = [
    { link: path.join('C:\\Users', 'All Users'), suffix: ['Microsoft', 'WlanSvc', 'Profiles.xml'] },
    { link: 'C:\\Documents and Settings', suffix: ['Default', 'NTUSER.DAT'] },
    { link: path.join('C:\\ProgramData', 'Application Data'), suffix: ['Microsoft', 'WlanSvc', 'Profiles.xml'] },
  ];
  let junctionEvidence = null;
  for (const cand of junctionCandidates) {
    let isReparse = false;
    try {
      const st = fs.lstatSync(cand.link);
      isReparse = st.isSymbolicLink();
    } catch { /* not present */ }
    if (!isReparse) continue;
    const target = path.join(cand.link, ...cand.suffix);
    const cpOut = path.join(EV, 'junction-checkpath.json');
    let cpJson = null;
    let cpErr = null;
    for (let attempt = 1; attempt <= 3 && !cpJson; attempt++) {
      const r = runNative(PROBE, ['check-path', DLL, MASK, target, cpOut], { tag: `junction-checkpath-${attempt}` });
      try {
        cpJson = JSON.parse(fs.readFileSync(cpOut, 'utf8'));
      } catch (e) {
        // Keep the error separate: storing an error object in cpJson would make
        // the loop believe it succeeded and skip the retry.
        cpErr = `${e.code || e.message} exit=${r.status} stderr=${JSON.stringify(r.stderr.slice(0, 120))}`;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
    if (!cpJson) cpJson = { error: cpErr };
    const viaInject = probeRead('read-junction', target, cfgPath);
    let detailJson = null;
    try { detailJson = cpJson?.detail ? JSON.parse(cpJson.detail) : null; } catch { detailJson = null; }
    junctionEvidence = {
      link: cand.link,
      target,
      normalized: detailJson?.normalized ?? null,
      rule: detailJson?.rule ?? null,
      decision: cpJson?.deny === true ? 'deny' : 'allow',
      checkPathError: cpJson?.error ?? null,
      injectedRead: viaInject.verdict,
    };
    check('mask.junction-escape-denied',
      cpJson?.deny === true && viaInject.verdict?.openOk === false && viaInject.verdict?.openError === 5,
      `link=${cand.link} normalized=${junctionEvidence.normalized} decision=${junctionEvidence.decision} injectedOpenOk=${viaInject.verdict?.openOk} openError=${viaInject.verdict?.openError}`);
    const norm = (junctionEvidence.normalized ?? '').toLowerCase();
    check('mask.junction-path-is-resolved',
      !!junctionEvidence.normalized && !norm.includes('all users') && (norm.includes('programdata') || norm.includes('users\\default')),
      `normalized=${junctionEvidence.normalized}`);
    break;
  }
  evidence.junction = junctionEvidence ?? { error: 'no reparse-point directory found among the candidates' };
  if (!junctionEvidence) {
    check('mask.junction-escape-denied', false, 'no OS-provided junction found to test through');
  }
  const report = { ok: checks.every((c) => c.ok), runId: RUN_ID, stageRoot: STAGE, config: cfgPath, checks, evidence };
  fs.writeFileSync(path.join(OUT, 'mask-e2e-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n${report.ok ? 'MASK E2E PASSED' : 'MASK E2E FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length})`);

  if (!process.argv.includes('--keep-stage')) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { fs.rmSync(STAGE, { recursive: true, force: true, maxRetries: 2 }); break; } catch { /* retried */ }
    }
  }
  process.exit(report.ok ? 0 : 1);
}

try { main(); } catch (e) { console.error(`[mask-e2e] FAILED: ${e.message}`); process.exit(2); }
