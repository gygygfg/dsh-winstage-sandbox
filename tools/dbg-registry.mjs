#!/usr/bin/env node
// Verbose single-purpose debug runner (node-driven, so no PowerShell pipe issues).
// Usage: node tools/dbg-registry.mjs <node|ps|reg|reg2> [--stage name]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DLL = path.join(REPO, 'shim', 'out', 'winstage-shim.dll');
const INJECTOR = path.join(REPO, 'shim', 'out', 'winstage-inject.exe');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const which = process.argv[2] || 'reg';
const tag = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : `dbg-${which}-${Date.now().toString(36)}`;
const STAGE = path.join(REPO, 'shim', '.stage', tag);

const targets = {
  node: [process.execPath, ['-e', "process.stdout.write('NODEOK')"]],
  ps: [path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command', "Write-Output ('PSOK'+(1+1))"]],
  reg: [path.join(SYS, 'System32', 'reg.exe'), ['add', 'HKCU\\Software\\WinstageDbg', '/v', 'V', '/t', 'REG_SZ', '/d', 'hello', '/f']],
  reg2: [path.join(SYS, 'System32', 'reg.exe'), ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion', '/v', 'ProgramFilesDir']],
};

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const [exe, args] = targets[which];
const outFile = path.join(STAGE, 'child.stdout.txt');
const errFile = path.join(STAGE, 'child.stderr.txt');
const o = fs.openSync(outFile, 'w');
const e = fs.openSync(errFile, 'w');
const skip = process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1] : '';
const res = spawnSync(INJECTOR, [
  '--dll', DLL,
  ...(skip ? ['--set-env', `WINSTAGE_SHIM_SKIP=${skip}`] : []),
  '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
  '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
  '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
  '--set-env', 'WINSTAGE_SHIM_VERBOSE=1',
  '--report', path.join(STAGE, 'inject.json'),
  '--timeout-ms', '60000',
  '--',
  exe, ...args,
], { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 180000 });
fs.closeSync(o);
fs.closeSync(e);

const log = fs.existsSync(path.join(STAGE, 'shim.log')) ? fs.readFileSync(path.join(STAGE, 'shim.log'), 'utf8') : '';
const interesting = log.split(/\r?\n/).filter((l) => /Reg|deny|DENY|fail|Attach|staging|overlay|real hive/.test(l));
console.log(`target=${which} exit=${res.status} stdout=${JSON.stringify(fs.readFileSync(outFile, 'utf8').slice(0, 200))} stderr=${JSON.stringify(fs.readFileSync(errFile, 'utf8').slice(0, 200))}`);
console.log(`stage=${STAGE}`);
const regDir = path.join(STAGE, 'registry');
if (fs.existsSync(regDir)) {
  for (const f of fs.readdirSync(regDir)) {
    console.log(`  registry/${f} ${fs.statSync(path.join(regDir, f)).size} bytes`);
  }
}
console.log(`--- shim.log registry lines (${interesting.length}) ---`);
console.log(interesting.slice(-60).join('\n'));
