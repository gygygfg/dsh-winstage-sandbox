#!/usr/bin/env node
// Stop processes that still have winstage-shim.dll loaded, AND stray
// winstage-inject.exe processes.
//
// Injected children can outlive a test run (a hung child keeps the DLL mapped,
// which makes the next `lldb-link`/`lld-link` write fail with "Permission
// denied", and keeps staging handles open -> the cleanup EPERM the Lead saw).
// Selecting by "has our DLL loaded" makes this safe: an ordinary shell never
// matches. P2-9: the injector itself remote-loads the DLL into the carrier and
// never maps it into its own address space, so a leftover `winstage-inject.exe`
// is invisible to `tasklist /m`; we additionally match by image name and merge
// the two lists by PID. The injector now also kills children after
// --child-timeout-ms.
//
// Usage: node tools/stop-shim-holders.mjs [--json] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = path.join(REPO, 'shim', 'out');
const JSON_OUT = process.argv.includes('--json');
const DRY = process.argv.includes('--dry-run');
const TASKLIST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');

/** Run tasklist with output redirected to a temp file (no pipes: host issue). */
function tasklist(args, label) {
  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, `tasklist-${label}.txt`);
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(TASKLIST, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 60000 });
  fs.closeSync(fd);
  const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  fs.rmSync(outFile, { force: true });
  return { text, exitCode: r.status };
}

function listHolders() {
  const dll = tasklist(['/m', 'winstage-shim.dll'], 'shim-holders');
  const byPid = new Map();
  for (const raw of dll.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Image name/i.test(line) || /^=/i.test(line)) continue;
    const m = line.match(/^(\S+?\.exe)\s+(\d+)\s/);
    if (m && /winstage-shim\.dll/i.test(line)) {
      const pid = Number(m[2]);
      byPid.set(pid, { image: m[1], pid });
    }
  }
  /* Second criterion: image name is the injector. Merge by PID so a process that
   * matches both is reported once; the DLL holders win the image label. */
  const inj = tasklist(['/fi', 'imagename eq winstage-inject.exe', '/fo', 'csv', '/nh'], 'injector-images');
  for (const raw of inj.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"([^"]+)"\s*,\s*"(\d+)"/);
    if (m && /^winstage-inject\.exe$/i.test(m[1])) {
      const pid = Number(m[2]);
      if (!byPid.has(pid)) byPid.set(pid, { image: m[1], pid });
    }
  }
  return {
    holders: [...byPid.values()],
    exitCode: dll.exitCode,
    raw: (dll.text + inj.text).slice(0, 2000),
  };
}

const { holders, exitCode } = listHolders();
const killed = [];
for (const h of holders) {
  if (h.pid === process.pid) continue;
  if (DRY) {
    killed.push({ ...h, killed: false, dryRun: true });
    continue;
  }
  try {
    process.kill(h.pid);
    killed.push({ ...h, killed: true });
  } catch (e) {
    killed.push({ ...h, killed: false, error: e.message });
  }
}
const report = { ok: true, tasklistExit: exitCode, holders: killed };
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log(killed.length ? killed.map((k) => `${k.killed ? 'killed' : k.dryRun ? 'would kill' : 'failed'} ${k.image} (pid ${k.pid})`).join('\n')
    : 'no process has winstage-shim.dll loaded and no winstage-inject.exe is running');
}
