#!/usr/bin/env node
// Diagnose the two canary gaps: (1) shell redirection produces an empty file,
// (2) Get-NetFirewallProfile returns Access denied, only when injected.
//
// Runs each case inside the injected child, reads back the file, and prints the
// shim log lines that show which branch every CreateFileW / Reg* call took.
//
// Usage: node tools/dbg-capability.mjs [--json]
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
const PS = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYS, 'System32', 'cmd.exe');
const RUN_ID = crypto.randomBytes(3).toString('hex');
const STAGE = path.join(REPO, 'shim', '.stage', `cap-${RUN_ID}`);
const EV = path.join(STAGE, 'evidence');
const JSON_OUT = process.argv.includes('--json');

function runNative(exe, args, { tag, stdio = 'files' } = {}) {
  fs.mkdirSync(EV, { recursive: true });
  const outFile = path.join(EV, `${tag}.stdout.txt`);
  const errFile = path.join(EV, `${tag}.stderr.txt`);
  const o = fs.openSync(outFile, 'w');
  const e = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, args, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 120000 });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  return { status: res.status, error: res.error ? String(res.error) : null, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8'), outFile, errFile };
}

function inject(tag, exe, args) {
  return runNative(INJECTOR, ['--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    '--set-env', 'WINSTAGE_SHIM_VERBOSE=1',
    '--report', path.join(EV, `${tag}.inject.json`),
    '--timeout-ms', '60000', '--child-timeout-ms', '120000',
    '--', exe, ...args], { tag });
}

function shimLogLines() {
  const p = path.join(STAGE, 'shim.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
}

function main() {
  fs.mkdirSync(EV, { recursive: true });
  const results = {};

  // --- 1. redirection in the injected child -------------------------------
  const target = path.join(STAGE, 'redirect-out.txt');
  const realTarget = path.join(REPO, 'shim', '.stage', `redirect-real-${RUN_ID}.txt`);
  for (const [label, cmdExe, cmdArgs] of [
    ['cmd-redirect', CMD, ['/c', `node --version > "${realTarget}"`]],
    ['ps-redirect', PS, ['-NoProfile', '-Command', `node --version > "${realTarget}"`]],
    ['ps-setcontent', PS, ['-NoProfile', '-Command', `Set-Content -Path "${realTarget}" -Value 'REDIRECT-PAYLOAD'`]],
  ]) {
    fs.rmSync(realTarget, { force: true });
    const r = inject(label, cmdExe, cmdArgs);
    const staged = path.join(STAGE, 'fs', ...realTarget.replace(/^([A-Za-z]):/, '$1').split('\\').filter(Boolean));
    const stagedAlt = path.join(STAGE, 'fs', realTarget[0], ...realTarget.slice(3).split('\\'));
    const entry = {
      exit: r.status,
      stdout: r.stdout.slice(0, 200),
      stderr: r.stderr.slice(0, 300),
      realExists: fs.existsSync(realTarget),
      realContent: fs.existsSync(realTarget) ? fs.readFileSync(realTarget, 'utf8').slice(0, 120) : null,
      stagedCandidates: [staged, stagedAlt].filter((p) => fs.existsSync(p)).map((p) => ({ p, content: fs.readFileSync(p, 'utf8').slice(0, 120) })),
      stageTree: [],
    };
    const walk = (dir, rel, acc) => {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const r2 = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(dir, it.name), r2, acc);
        else acc.push(r2);
      }
    };
    walk(path.join(STAGE, 'fs'), '', entry.stageTree);
    results[label] = entry;
  }

  // --- 2. firewall read in the injected child ----------------------------
  const fwScript = 'try { $p = Get-NetFirewallProfile -ErrorAction Stop | Select-Object -First 1; "FW-OK:" + $p.Name } catch { "FW-ERR:" + $_.Exception.Message }';
  const fw = inject('firewall', PS, ['-NoProfile', '-Command', fwScript]);
  results.firewall = { exit: fw.status, stdout: fw.stdout.slice(0, 300), stderr: fw.stderr.slice(0, 300) };

  // --- 3. what did the shim do? -----------------------------------------
  const regScript = 'try { $k = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\StandardProfile"; $v = (Get-ItemProperty -Path $k -Name EnableFirewall -ErrorAction Stop).EnableFirewall; "REG-OK:" + $v } catch { "REG-ERR:" + $_.Exception.Message }';
  const rr = inject('ps-regread', PS, ['-NoProfile', '-Command', regScript]);
  results.psRegRead = { exit: rr.status, stdout: rr.stdout.slice(0, 300), stderr: rr.stderr.slice(0, 300) };
  const psVer = inject('ps-version', PS, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  results.psVersion = { exit: psVer.status, stdout: psVer.stdout.slice(0, 120), stderr: psVer.stderr.slice(0, 200) };

  const log = shimLogLines();
  results.shimLogSummary = {
    totalLines: log.length,
    createRequests: log.filter((l) => /CreateFile request/.test(l)).slice(0, 60),
    hardDeny: log.filter((l) => /hard deny|fail-closed|read masked/.test(l)).slice(0, 40),
    createFile: log.filter((l) => /CreateFile/.test(l)).slice(0, 40),
    regFallbacks: log.filter((l) => /Reg.*(passthrough|refused|fail-closed|hard)/.test(l)).slice(0, 40),
  };

  const report = { runId: RUN_ID, stageRoot: STAGE, results };
  fs.writeFileSync(path.join(OUT, 'dbg-capability-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [k, v] of Object.entries(results)) {
      if (k === 'shimLogSummary') continue;
      console.log(`== ${k}: exit=${v.exit} real=${JSON.stringify(v.realContent)} realExists=${v.realExists} staged=${JSON.stringify(v.stagedCandidates)}`);
      if (v.stdout) console.log(`   stdout=${JSON.stringify(v.stdout.slice(0, 160))}`);
      if (v.stderr) console.log(`   stderr=${JSON.stringify(v.stderr.slice(0, 160))}`);
    }
    console.log(`== shim log: ${results.shimLogSummary.totalLines} lines`);
    console.log('--- hard deny / fail-closed / masked ---');
    console.log(results.shimLogSummary.hardDeny.join('\n') || '(none)');
    console.log('--- CreateFile branches ---');
    console.log(results.shimLogSummary.createFile.slice(0, 12).join('\n') || '(none)');
    console.log('--- registry fallbacks ---');
    console.log(results.shimLogSummary.regFallbacks.slice(0, 12).join('\n') || '(none)');
    console.log(`\nstage: ${STAGE}  report: shim/out/dbg-capability-report.json`);
  }
}

try { main(); } catch (e) { console.error(`[dbg-capability] FAILED: ${e.message}`); process.exit(2); }
