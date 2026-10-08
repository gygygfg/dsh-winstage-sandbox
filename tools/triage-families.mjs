#!/usr/bin/env node
// Triage matrix for the injection P0: which hook family breaks node/PowerShell?
//
// Runs the same injected targets under four environment configurations:
//   A: all hooks        B: registry family off
//   C: file family off  D: everything off (baseline)
// and prints a compact matrix. Uses absolute target paths.
//
// Usage: node tools/triage-families.mjs [--json]
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
const CMD = path.join(SYS, 'System32', 'cmd.exe');
const RUN_ID = crypto.randomBytes(3).toString('hex');
const STAGE_BASE = path.join(REPO, 'shim', '.stage', `triage-${RUN_ID}`);
const EV = path.join(STAGE_BASE, 'evidence');
const JSON_OUT = process.argv.includes('--json');
// P2-8: the injector's child timeout defaults to 300s; this tool kills the
// injector at PARENT_TIMEOUT_MS, so pin the child timeout 30s shorter.
const PARENT_TIMEOUT_MS = 120000;
const CHILD_TIMEOUT_MS = PARENT_TIMEOUT_MS - 30000;

const configs = [
  { id: 'A-all', env: {} },
  { id: 'B-reg-off', env: { WINSTAGE_SHIM_DISABLE_REG: '1' } },
  { id: 'C-file-off', env: { WINSTAGE_SHIM_DISABLE_FILE: '1' } },
  { id: 'D-both-off', env: { WINSTAGE_SHIM_DISABLE_REG: '1', WINSTAGE_SHIM_DISABLE_FILE: '1' } },
];

const targets = [
  { id: 'cmd', exe: CMD, args: ['/c', 'echo OK'], expect: /OK/ },
  { id: 'node', exe: process.execPath, args: ['-e', "process.stdout.write('NODEOK')"], expect: /NODEOK/ },
  { id: 'powershell', exe: POWERSHELL, args: ['-NoProfile', '-Command', "Write-Output ('PSOK' + (1+1))"], expect: /PSOK2/ },
];

function run(exe, argv, { tag, env }) {
  fs.mkdirSync(EV, { recursive: true });
  const outFile = path.join(EV, `${tag}.out.txt`);
  const errFile = path.join(EV, `${tag}.err.txt`);
  const o = fs.openSync(outFile, 'w');
  const e = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, argv, { stdio: ['ignore', o, e], cwd: REPO, env, windowsHide: true, timeout: PARENT_TIMEOUT_MS });
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
  const results = [];
  for (const c of configs) {
    const stage = path.join(STAGE_BASE, c.id);
    fs.mkdirSync(stage, { recursive: true });
    for (const t of targets) {
      const r = run(INJECTOR, [
        '--dll', DLL,
        '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
        '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
        '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`,
        ...Object.entries(c.env).flatMap(([k, v]) => ['--set-env', `${k}=${v}`]),
        '--report', path.join(EV, `${c.id}-${t.id}.inject.json`),
        '--timeout-ms', '60000',
        '--child-timeout-ms', String(CHILD_TIMEOUT_MS),
        '--',
        t.exe, ...t.args,
      ], { tag: `${c.id}-${t.id}`, env: process.env });
      const ok = r.status === 0 && t.expect.test(r.stdout);
      results.push({ config: c.id, target: t.id, ok, exitCode: r.status, stdout: r.stdout.slice(0, 120), stderr: r.stderr.slice(0, 200) });
      if (!JSON_OUT) {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id.padEnd(11)} ${t.id.padEnd(11)} exit=${r.status} ${JSON.stringify(r.stdout.slice(0, 40))} ${ok ? '' : JSON.stringify(r.stderr.slice(0, 120))}`);
      }
    }
  }
  const report = { ok: results.every((r) => r.ok), runId: RUN_ID, results };
  fs.writeFileSync(path.join(REPO, 'shim', 'out', 'triage-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  if (!process.argv.includes('--keep-stage')) fs.rmSync(STAGE_BASE, { recursive: true, force: true });
  process.exit(0);
}

try { main(); } catch (e) { console.error(`[triage] FAILED: ${e.message}`); process.exit(2); }
