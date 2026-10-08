#!/usr/bin/env node
// Greedy minimizer: find a small set of hooked APIs whose presence breaks the
// target, using WINSTAGE_SHIM_SKIP (no rebuilds).
// Usage: node tools/minimize-hooks.mjs [--target node|ps|reg] [--base reg|file|all]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DLL = path.join(REPO, 'shim', 'out', 'winstage-shim.dll');
const INJECTOR = path.join(REPO, 'shim', 'out', 'winstage-inject.exe');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const OUT = path.join(REPO, 'shim', 'out', 'minimize');
fs.mkdirSync(OUT, { recursive: true });

const REG = ['RegCreateKeyExW', 'RegCreateKeyExA', 'RegOpenKeyExW', 'RegOpenKeyExA', 'RegSetValueExW', 'RegSetValueExA',
  'RegQueryValueExW', 'RegQueryValueExA', 'RegDeleteKeyExW', 'RegDeleteKeyExA', 'RegDeleteValueW', 'RegDeleteValueA',
  'RegCloseKey', 'RegFlushKey', 'RegQueryInfoKeyW', 'RegEnumValueW', 'RegEnumKeyExW'];
const FILE = ['CreateFileW', 'CreateFileA', 'CreateDirectoryW', 'CreateDirectoryA', 'DeleteFileW', 'DeleteFileA',
  'MoveFileExW', 'MoveFileExA', 'MoveFileW', 'MoveFileA', 'RemoveDirectoryW', 'RemoveDirectoryA', 'CopyFileW',
  'CopyFileA', 'SetFileAttributesW'];

const TARGETS = {
  node: { exe: process.execPath, args: ['-e', "process.stdout.write('NODEOK')"], expect: /NODEOK/ },
  ps: { exe: path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-Command', "Write-Output ('PSOK'+(1+1))"], expect: /PSOK2/ },
  reg: { exe: path.join(SYS, 'System32', 'reg.exe'), args: ['add', 'HKCU\\Software\\WinstageMin', '/v', 'V', '/t', 'REG_SZ', '/d', 'x', '/f'], expect: /./ },
};

let runCount = 0;
function test(skip, target, label) {
  runCount++;
  const stage = path.join(OUT, `run-${runCount}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const o = fs.openSync(path.join(OUT, `run-${runCount}.out`), 'w');
  const e = fs.openSync(path.join(OUT, `run-${runCount}.err`), 'w');
  const argv = ['--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`];
  if (skip.length) argv.push('--set-env', `WINSTAGE_SHIM_SKIP=${skip.join(',')}`);
  argv.push('--report', path.join(stage, 'inject.json'), '--timeout-ms', '60000', '--', target.exe, ...target.args);
  let res;
  try {
    res = spawnSync(INJECTOR, argv, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 180000 });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  const stdout = fs.readFileSync(path.join(OUT, `run-${runCount}.out`), 'utf8');
  const stderr = fs.readFileSync(path.join(OUT, `run-${runCount}.err`), 'utf8');
  const ok = res.status === 0 && target.expect.test(stdout);
  if (process.env.VERBOSE) console.log(`   [${runCount}] ${label}: skip=${skip.length} -> ${ok ? 'PASS' : 'FAIL'} exit=${res.status}`);
  return { ok, status: res.status, stdout: stdout.slice(0, 60), stderr: stderr.slice(0, 120) };
}

const which = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'node';
const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'reg';
const target = TARGETS[which];
const universe = base === 'reg' ? REG : base === 'file' ? FILE : [...REG, ...FILE];

console.log(`target=${which} base=${base} universe=${universe.length} APIs`);
const allSkipped = test([...universe], target, 'baseline (all skipped)');
console.log(`baseline (all skipped): ${allSkipped.ok ? 'PASS' : 'FAIL'} exit=${allSkipped.status} ${JSON.stringify(allSkipped.stdout || allSkipped.stderr)}`);

const hooked = new Set();          // candidates that may be required for the failure
let active = [...universe];        // currently hooked set (hooked = not in skip)
// start from everything hooked
let current = test([], target, 'all hooked');
console.log(`all hooked: ${current.ok ? 'PASS' : 'FAIL'}`);
if (current.ok) {
  console.log('all-hooked passes; nothing to minimize');
  process.exit(0);
}
// Greedy removal: for each API, try skipping it (in addition to the already skipped set).
let skipped = new Set();
for (const api of universe) {
  const trial = new Set(skipped);
  trial.add(api);
  const skipList = universe.filter((n) => trial.has(n));
  const r = test(skipList, target, `skip ${api}`);
  if (!r.ok) {
    skipped = trial; // still fails without it -> not required
  }
  // if it passes when skipped, that API is required for the failure
}
const minimalHooked = universe.filter((n) => !skipped.has(n));
const check = test(universe.filter((n) => skipped.has(n)), target, 'verify minimal');
console.log(`\nminimal failing hooked set (${minimalHooked.length}): ${minimalHooked.join(', ')}`);
console.log(`verify: ${check.ok ? 'PASS (unexpected)' : 'FAIL (confirmed)'} exit=${check.status} ${JSON.stringify(check.stderr)}`);
console.log(`runs: ${runCount}`);
