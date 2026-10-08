#!/usr/bin/env node
// Bisect which single hooked API breaks a target runtime.
// Usage: node tools/bisect-api.mjs [--target node|ps] [--extra-env K=V]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DLL = path.join(REPO, 'shim', 'out', 'winstage-shim.dll');
const INJECTOR = path.join(REPO, 'shim', 'out', 'winstage-inject.exe');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const OUT = path.join(REPO, 'shim', 'out', 'bisect');
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = {
  node: { exe: process.execPath, args: ['-e', "process.stdout.write('NODEOK')"], expect: /NODEOK/ },
  ps: {
    exe: path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-Command', "Write-Output ('PSOK'+(1+1))"],
    expect: /PSOK2/,
  },
};

const REG_ALL = [
  'RegCreateKeyExW', 'RegCreateKeyExA', 'RegOpenKeyExW', 'RegOpenKeyExA', 'RegSetValueExW', 'RegSetValueExA',
  'RegQueryValueExW', 'RegQueryValueExA', 'RegDeleteKeyExW', 'RegDeleteKeyExA', 'RegDeleteValueW', 'RegDeleteValueA',
  'RegCloseKey', 'RegFlushKey', 'RegQueryInfoKeyW', 'RegEnumValueW', 'RegEnumKeyExW',
];

function runOne(tag, target, skipList, extraEnv = {}) {
  const stage = path.join(OUT, tag);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const o = fs.openSync(path.join(OUT, `${tag}.stdout.txt`), 'w');
  const e = fs.openSync(path.join(OUT, `${tag}.stderr.txt`), 'w');
  const argv = [
    '--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`,
    ...Object.entries(extraEnv).flatMap(([k, v]) => ['--set-env', `${k}=${v}`]),
  ];
  if (skipList.length) argv.push('--set-env', `WINSTAGE_SHIM_SKIP=${skipList.join(',')}`);
  argv.push('--report', path.join(stage, 'inject.json'), '--timeout-ms', '60000', '--', target.exe, ...target.args);
  let res;
  try {
    res = spawnSync(INJECTOR, argv, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 180000 });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  const stdout = fs.readFileSync(path.join(OUT, `${tag}.stdout.txt`), 'utf8');
  const stderr = fs.readFileSync(path.join(OUT, `${tag}.stderr.txt`), 'utf8');
  return { ok: res.status === 0 && target.expect.test(stdout), status: res.status, stdout: stdout.slice(0, 80), stderr: stderr.slice(0, 160) };
}

const which = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'node';
const target = TARGETS[which];
const steps = [
  { tag: 'base-all-reg', skip: [] },
  { tag: 'base-no-reg', skip: REG_ALL },
  { tag: 'only-read-w', skip: REG_ALL.filter((n) => !['RegOpenKeyExW', 'RegQueryValueExW'].includes(n)) },
  { tag: 'only-open-w', skip: REG_ALL.filter((n) => n !== 'RegOpenKeyExW') },
  { tag: 'only-query-w', skip: REG_ALL.filter((n) => n !== 'RegQueryValueExW') },
  { tag: 'only-write-w', skip: REG_ALL.filter((n) => !['RegCreateKeyExW', 'RegSetValueExW'].includes(n)) },
  { tag: 'only-enum', skip: REG_ALL.filter((n) => !['RegQueryInfoKeyW', 'RegEnumValueW', 'RegEnumKeyExW'].includes(n)) },
  { tag: 'only-close', skip: REG_ALL.filter((n) => !['RegCloseKey', 'RegFlushKey'].includes(n)) },
  { tag: 'only-delete', skip: REG_ALL.filter((n) => !['RegDeleteKeyExW', 'RegDeleteValueW'].includes(n)) },
];
for (const s of steps) {
  const r = runOne(`${which}-${s.tag}`, target, s.skip);
  const skipped = s.skip.length === REG_ALL.length ? 'ALL-reg-skipped' : s.skip.length ? `${REG_ALL.length - s.skip.length} reg APIs hooked` : 'all hooked';
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${s.tag.padEnd(16)} [${skipped.padEnd(20)}] exit=${r.status} ${r.ok ? JSON.stringify(r.stdout) : JSON.stringify(r.stderr)}`);
}
