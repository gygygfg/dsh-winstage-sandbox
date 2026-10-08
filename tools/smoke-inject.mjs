#!/usr/bin/env node
// Carrier gate: after injection, real runtimes must still start.
//
// Every shell command in this project is a PowerShell/node child, so "the shim
// does not break the runtime" is a hard prerequisite. Historically:
//   node -> WSAStartup 10107 (RegQueryValueExA forwarded to the W API)
//   ps   -> InitialSessionState / 0x80131623 (CONOUT$ staged, no file CoW)
//
// Robustness rules (Lead-reported occasional flakiness):
//   * a CLEANUP failure must never be reported as a carrier failure -- cleanup is
//     reported separately and never affects the exit code;
//   * cleanup retries with a bounded backoff (child handles may still be open);
//   * each case runs --repeat times (default 3) and must pass every time; the
//     failure rate is printed so a flake is visible instead of being mistaken for
//     a regression;
//   * a spawn error / timeout (status === null) is retried once before counting
//     as a failure, and both attempts stay in the evidence.
//
// Usage: node tools/smoke-inject.mjs [--json] [--keep-stage] [--repeat N]
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
const SYS = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RUN_ID = crypto.randomBytes(3).toString('hex');
const STAGE = path.join(REPO, 'shim', '.stage', `smoke-${RUN_ID}`);
const EV = path.join(STAGE, 'evidence');
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep-stage');
const REPEAT = (() => {
  const i = process.argv.indexOf('--repeat');
  const n = i >= 0 ? Number(process.argv[i + 1]) : 3;
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(exe, argv, { tag, env, timeout = 120000 }) {
  fs.mkdirSync(EV, { recursive: true });
  const outFile = path.join(EV, `${tag}.stdout.txt`);
  const errFile = path.join(EV, `${tag}.stderr.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, argv, {
      stdio: ['ignore', outFd, errFd],
      cwd: REPO,
      env: env || process.env,
      windowsHide: true,
      timeout,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: res.status,
    signal: res.signal,
    error: res.error ? String(res.error) : null,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function inject(tag, exe, args) {
  return run(INJECTOR, [
    '--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    '--report', path.join(EV, `${tag}.inject.json`),
    '--timeout-ms', '60000',
    '--',
    exe, ...args,
  ], { tag });
}

/* Cleanup is best effort and NEVER part of the verdict. */
function cleanupStage() {
  const errors = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(STAGE, { recursive: true, force: true, maxRetries: 2 });
      if (!fs.existsSync(STAGE)) return errors;
    } catch (e) {
      errors.push(`attempt ${attempt}: ${e.code || 'error'} ${e.message}`);
    }
    sleepMs(150 * attempt);
  }
  return errors;
}

function main() {
  for (const f of [DLL, INJECTOR]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f}; run node tools/build-shim.mjs`);
  }
  fs.mkdirSync(EV, { recursive: true });

  const defs = [
    { id: 'cmd', exe: path.join(SYS, 'System32', 'cmd.exe'), args: ['/c', 'echo SMOKE-CMD-OK'], expect: /SMOKE-CMD-OK/ },
    { id: 'node', exe: process.execPath, args: ['--version'], expect: /^v\d+\./ },
    { id: 'node-eval', exe: process.execPath, args: ['-e', "process.stdout.write('SMOKE-NODE-EVAL-OK')"], expect: /SMOKE-NODE-EVAL-OK/ },
    { id: 'powershell', exe: POWERSHELL, args: ['-NoProfile', '-Command', '1+1'], expect: /2/ },
    {
      id: 'powershell-script',
      exe: POWERSHELL,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Write-Output ('SMOKE-PS-' + (1+1))"],
      expect: /SMOKE-PS-2/,
    },
  ];

  const cases = [];
  for (const d of defs) {
    const attempts = [];
    let passes = 0;
    for (let i = 1; i <= REPEAT; i++) {
      let r = inject(`${d.id}-${i}`, d.exe, d.args);
      if (r.status === null) {
        // Spawn error / timeout: the exit code never arrived. Retry once so a
        // transient process-creation race is not reported as a regression.
        sleepMs(250);
        const first = { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) };
        r = inject(`${d.id}-${i}-retry`, d.exe, d.args);
        attempts.push({ i, retried: true, first, status: r.status, signal: r.signal, error: r.error, stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) });
      } else {
        attempts.push({ i, retried: false, status: r.status, signal: r.signal, error: r.error, stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) });
      }
      if (r.status === 0 && d.expect.test(r.stdout)) passes++;
    }
    const ok = passes === REPEAT;
    cases.push({ id: d.id, ok, repeat: REPEAT, passes, failureRate: Number((1 - passes / REPEAT).toFixed(3)), attempts });
    if (!JSON_OUT) {
      const last = attempts[attempts.length - 1];
      console.log(`${ok ? 'PASS' : 'FAIL'} ${d.id.padEnd(18)} ${passes}/${REPEAT} ok` +
        (ok ? '' : `  last: exit=${last.status} err=${JSON.stringify((last.stderr || last.error || '').slice(0, 140))}`));
    }
  }

  const regDir = path.join(STAGE, 'registry');
  const registryFiles = fs.existsSync(regDir) ? fs.readdirSync(regDir) : [];
  const stageTree = [];
  const walk = (dir, rel) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      stageTree.push(r);
      if (it.isDirectory()) walk(path.join(dir, it.name), r);
    }
  };
  walk(STAGE, '');
  const phantom = stageTree.filter((p) => /fs\/.*(SystemCertificates|Microsoft\\|Software\\Microsoft)/i.test(p.replace(/\//g, '\\')));

  const report = {
    ok: cases.every((c) => c.ok),
    runId: RUN_ID,
    stageRoot: STAGE,
    dll: DLL,
    repeat: REPEAT,
    cases,
    overlay: { registryFiles, stageTreeSample: stageTree.slice(0, 100), phantomReadOnlyPaths: phantom },
    cleanup: { attempted: !KEEP, errors: [], ignored: true },
  };

  if (!KEEP) {
    report.cleanup.errors = cleanupStage();
    if (!JSON_OUT && report.cleanup.errors.length) {
      console.log(`\n[smoke] cleanup incomplete (NOT a test failure, ${report.cleanup.errors.length} attempt(s)); stage kept at ${STAGE}`);
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const totalPass = cases.filter((c) => c.ok).length;
    console.log(`\n${report.ok ? 'SMOKE PASSED' : 'SMOKE FAILED'} (${totalPass}/${cases.length} cases, ${REPEAT} repeats each)`);
    console.log(`registry files: ${registryFiles.join(', ') || '(none)'}   phantom read-only overlay paths: ${phantom.length}`);
    console.log(`cleanup: ${KEEP ? 'skipped (--keep-stage)' : report.cleanup.errors.length ? `${report.cleanup.errors.length} retry failure(s), stage kept (ignored)` : 'clean'}`);
  }
  process.exit(report.ok ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error(`[smoke] FAILED: ${e.message}`);
  process.exit(2);
}
