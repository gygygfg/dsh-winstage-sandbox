#!/usr/bin/env node
// WinStageSandbox T4 -- build the shim DLL, the injector and the probe.
//
// One command: `node tools/build-shim.mjs`
// Requires the toolchain from `node tools/fetch-toolchain.mjs` (zig 0.13.0 is
// unpacked into tools/toolchain/). Uses zig's bundled mingw-w64 headers and
// libraries to cross-compile x86_64 Windows GNU binaries; no MSVC/SDK needed.
//
// Outputs (all inside shim/out/):
//   winstage-shim.dll      the injected shim (export table is verified)
//   winstage-inject.exe    CreateProcess(CREATE_SUSPENDED) + remote LoadLibraryW
//   winstage-probe.exe     probe/selftest utility
//
// ===========================================================================
// POST-MORTEM: the artifact tree must never be allowed to be "missing a file".
// ===========================================================================
// The previous version of this script compiled straight onto the FINAL output
// path, and when that path was transiently locked (Defender / crash handler
// holding a handle right after a killed injected process) it did:
//
//     fs.renameSync(out, out + '.stale-' + Date.now());   // move the good one away
//     ... retry the compiler, writing the final path again ...
//
// That order is the root cause of the 2026-10-01 outage. Measured state of
// shim/out/ afterwards:
//
//     winstage-shim.dll.stale-1790931737088     <- old copy, moved aside
//     winstage-inject.exe.stale-1790931739730   <- old copy, moved aside
//     winstage-probe.exe.stale-1790931742899    <- old copy, moved aside
//     winstage-shim.dll    rebuilt 10-02 17:02  <- present
//     winstage-probe.exe   rebuilt 10-02 17:02  <- present
//     winstage-inject.exe                       <- ** ABSENT **
//
// i.e. the DLL and the probe came back, the injector did not. Consequence
// chain (all measured):
//   * src/executor.mjs probeTransparentShimUncached() hard-depends on
//     winstage-inject.exe, so the transparent-shim probe reported
//     `available:false` for ever;
//   * selectLaunchMode() therefore fail-closed onto the restricted-token tier,
//     which hard-denies every write and severs the child's stdio;
//   * .t/dsh2/sync-plugin.mjs died with ENOENT on the same path.
// Nothing raised an error. The build "succeeded" while the tree was broken.
//
// Rules this file now follows, in order of importance:
//   1. Never move, rename or delete a *usable* artifact to make room for a new
//      one. Compile to a sibling `*.tmp-<ts>` file instead; the public name is
//      only ever overwritten by an atomic rename of a fully built, PE-validated
//      file. A locked or failed compile therefore leaves the old artifact
//      exactly where it was.
//   2. A missing artifact is an error, never a silent downgrade. Verification
//      runs after the swap and reports `artifact_missing`; `--check` reports the
//      same condition without building anything (it is offline and cheap, so CI
//      and runtime gates can call it).
//   3. Recover from an interrupted old-style build: `--repair-stale` restores
//      each missing final name from its newest well-formed `*.stale-<ts>`
//      sibling. `.stale-*` files are never used as compiler input.
//
// Exit codes: 0 = ok, 1 = build/verify failure, 2 = usage error.
//
// Native-process output is captured through temp FILES, never pipes (PowerShell
// piping around native executables is unreliable on this host).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePe } from './pe-exports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHIM = path.join(REPO, 'shim');
/* Artifact directory. `--out-dir <dir>` or WINSTAGE_SHIM_OUT lets two builds
 * (e.g. two agents working on different hook families) run side by side without
 * fighting over shim/out/winstage-shim.dll. */
const OUT_DIR_ARG = (() => {
  const eq = process.argv.slice(2).find((a) => a.startsWith('--out-dir='));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = process.argv.indexOf('--out-dir');
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : process.env.WINSTAGE_SHIM_OUT;
})();
const OUT = OUT_DIR_ARG ? path.resolve(REPO, OUT_DIR_ARG) : path.join(SHIM, 'out');
const LOGS = path.join(OUT, 'build-logs');
const TOOLCHAIN = path.join(HERE, 'toolchain');
const MANIFEST = path.join(TOOLCHAIN, 'toolchain.json');

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const CLEAN = args.has('--clean');
/* Do not try to name the variable `--check`/`--repair-stale` in a way that
 * collides with the build flags: both are pure filesystem modes, no toolchain. */
const CHECK_ONLY = args.has('--check');
const REPAIR_ONLY = args.has('--repair-stale');
const PROFILE = (() => {
  const flag = process.argv.slice(2).find((a) => a.startsWith('--profile='));
  if (flag) return flag.split('=')[1];
  const idx = process.argv.indexOf('--profile');
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : 'full';
})();

const log = (...a) => { if (!JSON_OUT && !CHECK_ONLY) console.log('[build-shim]', ...a); };

export class BuildError extends Error {
  constructor(msg, detail) {
    super(msg);
    this.name = 'BuildError';
    this.code = (detail && detail.code) || null;
    this.detail = detail;
  }
}

function die(e) {
  const detail = e instanceof BuildError ? e.detail : undefined;
  if (JSON_OUT || CHECK_ONLY) {
    console.log(JSON.stringify({ ok: false, error: e.message, ...(detail || {}) }, null, 2));
  } else {
    console.error(`\n[build-shim] FAILED: ${e.message}`);
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        console.error(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
      }
    }
  }
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * Artifact-integrity helpers.
 *
 * Everything in this block is a pure function of paths + bytes: no toolchain,
 * no network, no Win32 call. tests/shim-artifact-integrity.mjs drives these
 * directly to prove the invariants above without running a real compilation.
 * ------------------------------------------------------------------------- */

/** The three artifacts every successful build must leave behind. */
export function artifactNames(profile = 'full') {
  return [
    profile === 'file-only' ? 'winstage-shim-file-only.dll' : 'winstage-shim.dll',
    'winstage-inject.exe',
    'winstage-probe.exe',
  ];
}

/** Transient Windows lock signature seen when an injected process crashed. */
export function isTransientLock(text) {
  return /Permission denied|being used by another process|sharing violation|EBUSY|EPERM|EACCES/i.test(String(text || ''));
}

/** Cheap "is this the file we meant to build" check, run before publishing. */
export function looksLikePe(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(0x40);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      if (n < 0x40) return false;
      if (head.readUInt16LE(0) !== 0x5a4d) return false; // 'MZ'
      return head.readUInt32LE(0x3c) >= 0x40; // e_lfanew points past the DOS stub
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** `winstage-inject.exe.stale-1790931739730` -> { base, stamp } (null if not a stale sibling). */
export function parseStaleName(fileName) {
  const m = /^(.*)\.stale-(\d+)$/.exec(fileName);
  if (!m) return null;
  return { base: m[1], stamp: Number(m[2]) };
}

export function withSuffix(file, suffix) {
  return `${file}${suffix}`;
}

/**
 * Newest well-formed `*.stale-*` sibling of `finalPath`.
 *
 * Only files large enough to hold a PE header are considered, so a 0-byte
 * object left by a half-finished compiler invocation can never win the
 * "newest" race and be restored as a usable artifact. Ties break on the mtime
 * recorded in the name -> nothing, then on the filesystem mtime, so the choice
 * is deterministic for a given directory.
 */
export function findNewestStale(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    const parsed = parseStaleName(name);
    if (!parsed || parsed.base !== base) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size < 0x40) continue;
    candidates.push({ path: full, stamp: parsed.stamp, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.stamp - a.stamp) || (b.mtimeMs - a.mtimeMs));
  return candidates[0];
}

/**
 * Report-only artifact integrity: which of `names` exist in `outDir`, which are
 * missing, which are malformed, and which could be recovered from `.stale-*`.
 * This is the function that must FAIL (ok:false) instead of passing silently
 * when the tree is missing a file.
 */
export function checkArtifactIntegrity(outDir, names) {
  const present = [];
  const missing = [];
  const malformed = [];
  const recoverable = [];
  for (const name of names) {
    const full = path.join(outDir, name);
    let st = null;
    try {
      st = fs.statSync(full);
    } catch {
      st = null;
    }
    if (!st || !st.isFile() || st.size === 0) {
      missing.push(name);
      const stale = findNewestStale(full);
      recoverable.push({ name, stale: stale ? path.basename(stale.path) : null, bytes: stale ? stale.size : 0 });
      continue;
    }
    if (!looksLikePe(full)) {
      malformed.push({ name, bytes: st.size });
      const stale = findNewestStale(full);
      recoverable.push({ name, stale: stale ? path.basename(stale.path) : null, bytes: stale ? stale.size : 0 });
      continue;
    }
    present.push({ name, bytes: st.size });
  }
  const ok = missing.length === 0 && malformed.length === 0;
  const detail = {
    code: ok ? null : 'artifact_missing',
    outDir,
    present: present.map((p) => p.name),
    missing,
    malformed,
    recoverable: recoverable.filter((r) => r.stale),
  };
  return { ok, present, missing, malformed, recoverable, detail };
}

/** Throwing wrapper around checkArtifactIntegrity, with the recovery command. */
export function assertArtifactIntegrity(outDir, names) {
  const report = checkArtifactIntegrity(outDir, names);
  if (report.ok) return report;
  throw new BuildError(
    `artifact tree is missing or has malformed files: ${[...report.missing, ...report.malformed.map((m) => m.name)].join(', ')}`,
    {
      ...report.detail,
      recovery: 'node tools/build-shim.mjs --repair-stale   (restores each missing name from its newest .stale-<ts> copy)',
    },
  );
}

/**
 * Restore every missing/malformed final name from its newest `.stale-*` copy.
 *
 * Only names in `names` are touched, and only when the final path is absent,
 * empty or not a PE. `.stale-*` sources are copied (never moved), so a failed
 * recovery still leaves the backup intact. Returns a full account of what
 * happened; callers decide whether the outcome is a failure.
 */
export function repairFromStale(outDir, names) {
  const restored = [];
  const unrecoverable = [];
  const skipped = [];
  for (const name of names) {
    const full = path.join(outDir, name);
    let needsRepair = false;
    let size = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      needsRepair = !st.isFile() || st.size === 0 || !looksLikePe(full);
    } catch {
      needsRepair = true;
    }
    if (!needsRepair) {
      skipped.push({ name, reason: `already present and well-formed (${size} bytes)` });
      continue;
    }
    const stale = findNewestStale(full);
    if (!stale) {
      unrecoverable.push({ name, reason: 'no well-formed .stale-* copy to restore from' });
      continue;
    }
    const published = withSuffix(full, `.repaired-${Date.now()}`);
    try {
      fs.copyFileSync(stale.path, published);
      fs.renameSync(published, full);
    } catch (e) {
      try { fs.rmSync(published, { force: true }); } catch { /* nothing to clean */ }
      unrecoverable.push({ name, reason: `copy from ${path.basename(stale.path)} failed: ${e.message}` });
      continue;
    }
    restored.push({ name, from: path.basename(stale.path), bytes: stale.size });
  }
  return { restored, unrecoverable, skipped, ok: unrecoverable.length === 0 && restored.length + skipped.length > 0 };
}

/**
 * Atomically publish freshly built artifacts over the final names.
 *
 * Each `staged` file was compiled elsewhere (a `*.tmp-<ts>` sibling). The final
 * name only ever changes via `renameSync`, which is atomic on NTFS, so a reader
 * sees either the complete old artifact or the complete new one -- never a
 * truncated or absent one. A rename that fails (the final name is locked by a
 * live process) leaves the OLD artifact in place and reports the failure; it is
 * never "worked around" by deleting or renaming the old artifact away.
 */
export function publishArtifacts(staged) {
  const published = [];
  const failed = [];
  for (const item of staged) {
    try {
      if (!fs.existsSync(item.tmp)) {
        failed.push({ ...item, reason: `staged file ${path.basename(item.tmp)} vanished before publish` });
        continue;
      }
      fs.renameSync(item.tmp, item.final);
      published.push(item.final);
    } catch (e) {
      failed.push({ ...item, reason: e.message });
    }
  }
  return { published, failed, ok: failed.length === 0 };
}

/**
 * Remove leftover `*.tmp-*` staging files for the artifact names we manage.
 *
 * Deliberately narrow: a concurrent build of a *different* profile may own a
 * temp file for its own name, and `.stale-*` files are evidence (and the
 * recovery source), so neither is ever collected here.
 */
export function sweepTemps(outDir, names, olderThanMs = 0) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const name of entries) {
    const m = /^(.*)\.tmp-(\d+)$/.exec(name);
    if (!m || !names.includes(m[1])) continue;
    const full = path.join(outDir, name);
    try {
      if (olderThanMs > 0 && now - fs.statSync(full).mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    } catch { /* still held by a dying compiler process: collect next time */ }
  }
  return removed;
}

/** Run a native exe with stdout/stderr redirected to files (no pipes). */
function run(exe, argv, label) {
  fs.mkdirSync(LOGS, { recursive: true });
  const outFile = path.join(LOGS, `${label}.out.txt`);
  const errFile = path.join(LOGS, `${label}.err.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, argv, {
      stdio: ['ignore', outFd, errFd],
      cwd: REPO,
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: path.join(TOOLCHAIN, 'zig-cache', 'global'),
        ZIG_LOCAL_CACHE_DIR: path.join(TOOLCHAIN, 'zig-cache', 'local'),
      },
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  return { status: res.status, error: res.error, stdout, stderr, outFile, errFile, argv };
}

function resolveZig() {
  if (fs.existsSync(MANIFEST)) {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const p = path.join(REPO, m.exe);
    if (fs.existsSync(p)) return p;
  }
  // fall back to any unpacked zig directory
  if (fs.existsSync(TOOLCHAIN)) {
    for (const d of fs.readdirSync(TOOLCHAIN)) {
      const p = path.join(TOOLCHAIN, d, 'zig.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new BuildError('zig toolchain not found -- run `node tools/fetch-toolchain.mjs` first', {
    lookedIn: TOOLCHAIN,
  });
}

function sourcesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.c')).map((f) => path.join(dir, f));
}

/**
 * A file's mandatory integrity label decides the integrity level (IL) of every
 * process started from it. If the workspace sits under a Low-labeled directory
 * (measured on this host: `C:\Users\Administrator\Desktop` carries an explicit
 * `Mandatory Label\Low Mandatory Level` ACE, so everything under it inherits it),
 * then `winstage-inject.exe` runs at Low IL and so does every carrier it starts.
 * Low-IL carriers silently lose APIs that require elevated integrity: the
 * `root\StandardCimv2` WMI namespace answers `Access is denied`, which is exactly
 * what made the `firewall` canary (`Get-NetFirewallProfile`) fail while the same
 * call succeeded in an un-injected shell.
 *
 * Only the broken case is repaired (Low -> Medium, never above the caller's own
 * IL): a healthy build keeps whatever label it had, and a failure here is a
 * warning, never a build failure.
 */
function repairLowIntegrityLabels(files) {
  const runText = (exe, argv) => {
    try {
      const r = spawnSync(exe, argv, { encoding: 'utf8', windowsHide: true });
      return typeof r.stdout === 'string' ? r.stdout + (r.stderr || '') : '';
    } catch {
      return '';
    }
  };
  const own = runText('whoami.exe', ['/groups']);
  const ownIl = (own.match(/Mandatory Label\\(High|Medium|Low) Mandatory Level/) || [])[1];
  const repaired = [];
  const notes = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const before = runText('icacls', [file]);
    if (!/Low Mandatory Level/.test(before)) continue;
    if (!ownIl || ownIl === 'Low') {
      notes.push(`${path.basename(file)}: still Low (this build ran at ${ownIl || 'unknown'} IL)`);
      continue;
    }
    runText('icacls', [file, '/setintegritylevel', 'Medium']);
    const after = runText('icacls', [file]);
    if (/Low Mandatory Level/.test(after)) {
      notes.push(`${path.basename(file)}: could not clear the Low label`);
    } else {
      repaired.push(`${path.basename(file)} Low->Medium (build IL ${ownIl})`);
    }
  }
  return { repaired, notes };
}

/**
 * Compile one artifact to a staged temp file and return the staging record.
 *
 * The public name is *never* opened for writing here and is never moved aside:
 * the compiler writes `<final>.tmp-<ts>` and only a successful PE-shaped result
 * is handed back to the caller for publishing. That is the whole fix for the
 * "missing artifact" defect described at the top of this file.
 */
function buildOne(zig, { label, out: finalOut, sources, extra = [], shared = false }) {
  const tmp = `${finalOut}.tmp-${Date.now()}`;
  const argv = [
    'cc',
    '-target', 'x86_64-windows-gnu',
    '-std=c11',
    '-O2',
    '-Wall', '-Wextra',
    '-Wno-unused-parameter', '-Wno-unused-function',
    '-DUNICODE', '-D_UNICODE',
    ...(shared ? ['-shared'] : []),
    ...extra,
    '-o', tmp,
    ...sources,
  ];
  log(`building ${label}: ${path.basename(tmp)} -> ${path.relative(REPO, finalOut)}`);

  /* A stale lock on *this* temp name is possible (a crashed compiler), but it
   * has nothing to do with the published artifact: retrying with a fresh temp
   * name is enough. There is deliberately no "rename the old output away" step. */
  let r = run(zig, argv, label);
  let attempt = 0;
  let attemptTmp = tmp;
  while ((r.status !== 0 || !fs.existsSync(attemptTmp)) && attempt < 3 && isTransientLock(r.stderr)) {
    attempt += 1;
    log(`  temp output locked, retrying in ${1.5 * attempt}s (${attempt}/3) -- if this keeps failing run: node tools/stop-shim-holders.mjs`);
    /* A failed/partial temp is disposable: it is not the published artifact. */
    try { fs.rmSync(attemptTmp, { force: true }); } catch { /* keep retrying */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * attempt);
    attemptTmp = `${finalOut}.tmp-${Date.now()}-r${attempt}`;
    argv[argv.indexOf('-o') + 1] = attemptTmp;
    r = run(zig, argv, `${label}-retry${attempt}`);
  }
  const produced = fs.existsSync(attemptTmp) ? attemptTmp : null;

  if (r.status !== 0 || !produced) {
    /* The previous good artifact is still at finalOut and was never touched. */
    try { if (produced) fs.rmSync(produced, { force: true }); } catch { /* best effort */ }
    const oldPresent = fs.existsSync(finalOut);
    throw new BuildError(
      `compilation failed for ${path.basename(finalOut)} (zig exit ${r.status}${r.error ? `, spawn error ${r.error}` : ''})`,
      {
        code: oldPresent ? 'build_failed_old_artifact_preserved' : 'build_failed_no_artifact_in_tree',
        artifact: path.basename(finalOut),
        oldArtifactPreserved: oldPresent,
        note: oldPresent
          ? 'the previously built artifact is still published and usable (the build wrote only a .tmp file)'
          : 'no previous artifact existed either: the tree is currently missing this file, rebuild after fixing the compiler error',
        argv: r.argv.join(' '),
        stdout: r.stdout.slice(-4000),
        stderr: r.stderr.slice(-8000),
        logFiles: [path.relative(REPO, r.outFile), path.relative(REPO, r.errFile)],
      },
    );
  }
  if (!looksLikePe(produced)) {
    const size = (() => { try { return fs.statSync(produced).size; } catch { return 0; } })();
    try { fs.rmSync(produced, { force: true }); } catch { /* best effort */ }
    throw new BuildError(`compiler produced a non-PE file for ${path.basename(finalOut)}`, {
      code: 'build_failed_old_artifact_preserved',
      artifact: path.basename(finalOut),
      stagedBytes: size,
      oldArtifactPreserved: fs.existsSync(finalOut),
      argv: r.argv.join(' '),
      stderr: r.stderr.slice(-8000),
    });
  }
  const warnings = (r.stderr.match(/warning:/g) || []).length;
  return { label, out: finalOut, tmp: produced, warnings, stderr: r.stderr };
}

/** `--check`: report the artifact tree and exit. No toolchain, no build. */
function checkMode(names) {
  const report = checkArtifactIntegrity(OUT, names);
  if (JSON_OUT || CHECK_ONLY) {
    console.log(JSON.stringify({ outDir: OUT, artifacts: names, ...report.detail, ok: report.ok }, null, 2));
  } else {
    log(report.ok ? `artifact tree OK in ${OUT}` : `artifact tree BROKEN in ${OUT}`);
  }
  process.exit(report.ok ? 0 : 1);
}

/** `--repair-stale`: restore missing names from their newest `.stale-*` copy. */
function repairMode(names) {
  const repaired = repairFromStale(OUT, names);
  if (!repaired.ok) {
    const lines = [
      `could not restore ${repaired.unrecoverable.map((u) => u.name).join(', ')}`,
      'the artifact tree is still missing files; an external toolchain build is required',
    ];
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, ...repaired }, null, 2));
    else for (const l of lines) console.error(`[build-shim] ${l}`);
    process.exit(1);
  }
  const after = checkArtifactIntegrity(OUT, names);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: after.ok, action: 'repair-stale', ...repaired, integrity: after.detail }, null, 2));
  } else {
    for (const r of repaired.restored) log(`restored ${r.name} from ${r.from} (${r.bytes} bytes)`);
    for (const s of repaired.skipped) log(`left alone ${s.name}: ${s.reason}`);
    log(`artifact tree ${after.ok ? 'OK' : 'STILL BROKEN'} in ${OUT}`);
  }
  process.exit(after.ok ? 0 : 1);
}

function main() {
  const names = artifactNames(PROFILE);

  /* These two modes are pure filesystem operations: they must work even when
   * the toolchain is missing, because they are the recovery path for a broken
   * artifact tree (see the post-mortem at the top of this file). */
  if (CHECK_ONLY) checkMode(names);
  if (REPAIR_ONLY) repairMode(names);

  const zig = resolveZig();
  fs.mkdirSync(OUT, { recursive: true });
  if (CLEAN) {
    /* --clean is an explicit request to drop the artifacts, so a subsequent
     * failure legitimately leaves them missing; it is not the default path. */
    for (const f of names) {
      fs.rmSync(path.join(OUT, f), { force: true });
    }
    fs.rmSync(LOGS, { recursive: true, force: true });
  }

  /* Leftovers from a previous interrupted build (never `.stale-*`: those are
   * evidence and the recovery source). Only files older than an hour are swept,
   * so a concurrent build's staging file is not stolen. */
  const swept = sweepTemps(OUT, names, 60 * 60 * 1000);

  const includeDirs = ['-I', path.join(SHIM, 'include'), '-I', path.join(SHIM, 'src')];
  const dllSources = sourcesIn(path.join(SHIM, 'src'));
  if (!dllSources.length) throw new BuildError('no shim sources found', { dir: path.join(SHIM, 'src') });

  /* Compile everything to temp files FIRST. Nothing public is touched until all
   * three compiles have succeeded and been shape-checked. */
  const results = [];
  const dllName = names[0];
  const profileDefines = PROFILE === 'file-only' ? ['-DWINSTAGE_PROFILE_FILE_ONLY=1'] : [];
  results.push(buildOne(zig, {
    label: PROFILE === 'file-only' ? 'dll-file-only' : 'dll',
    out: path.join(OUT, dllName),
    sources: dllSources,
    extra: [...includeDirs, ...profileDefines],
    shared: true,
  }));
  results.push(buildOne(zig, {
    label: 'injector',
    out: path.join(OUT, 'winstage-inject.exe'),
    sources: [path.join(SHIM, 'injector', 'winstage-inject.c')],
    extra: ['-municode'],
  }));
  results.push(buildOne(zig, {
    label: 'probe',
    out: path.join(OUT, 'winstage-probe.exe'),
    sources: [path.join(SHIM, 'probe', 'winstage-probe.c')],
    extra: ['-municode'],
  }));

  // Verify the staged artefacts: machine type, DLL flag and the export table.
  // This is the "no dumpbin on this host" substitute required by task-4, and it
  // runs BEFORE publishing so a bad build can never displace a good artifact.
  const requiredExports = [
    'WinstageShimInit',
    'WinstageShimShutdown',
    'WinstageShimAbiVersion',
    'WinstageShimBindStageApi',
    'WinstageShimOriginal',
    'WinstageShimRefreshHooks',
    'WinstageShimStatsJson',
  ];
  const stagedDll = results[0].tmp;
  const stagedInjector = results[1].tmp;
  const stagedProbe = results[2].tmp;
  /* A parse failure here means the compiler emitted something unreadable; it is
   * a build failure that must not touch the published names. */
  const parseOrFail = (file) => {
    try {
      return parsePe(file);
    } catch (e) {
      const name = path.basename(file).replace(/\.tmp-\d+(-r\d+)?$/, '');
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      throw new BuildError(`staged artifact for ${name} is not a readable PE file: ${e.message}`, {
        code: 'build_failed_old_artifact_preserved',
        artifact: name,
        oldArtifactPreserved: fs.existsSync(path.join(OUT, name)),
        note: 'nothing was published: the previously built artifact is still in place',
      });
    }
  };
  const dllInfo = parseOrFail(stagedDll);
  const missing = requiredExports.filter((e) => !dllInfo.exports.includes(e));
  if (missing.length) {
    throw new BuildError('shim DLL is missing required exports', { missing, exports: dllInfo.exports });
  }
  if (dllInfo.machine !== 'x86_64' || !dllInfo.isDll) {
    throw new BuildError('shim DLL has the wrong PE shape', { machine: dllInfo.machine, isDll: dllInfo.isDll });
  }
  const injectorInfo = parseOrFail(stagedInjector);
  const probeInfo = parseOrFail(stagedProbe);
  /* A Windows x64 .exe and a .dll differ in the COFF characteristics flag; if
   * they were swapped the launcher would silently fail to start carriers. */
  if (injectorInfo.isDll || probeInfo.isDll) {
    throw new BuildError('an executable artifact has the DLL flag set', {
      injectorIsDll: injectorInfo.isDll,
      probeIsDll: probeInfo.isDll,
    });
  }

  /* Publish: three atomic renames, old artifact replaced only by a complete new
   * one. If a rename is refused the OLD artifact survives and we fail loudly. */
  const publish = publishArtifacts([
    { final: path.join(OUT, dllName), tmp: stagedDll, label: results[0].label },
    { final: path.join(OUT, 'winstage-inject.exe'), tmp: stagedInjector, label: 'injector' },
    { final: path.join(OUT, 'winstage-probe.exe'), tmp: stagedProbe, label: 'probe' },
  ]);
  const preserved = names.filter((n) => fs.existsSync(path.join(OUT, n)));
  if (!publish.ok) {
    for (const f of publish.failed) {
      try { fs.rmSync(f.tmp, { force: true }); } catch { /* best effort */ }
    }
    throw new BuildError(
      `could not publish ${publish.failed.map((f) => path.basename(f.final)).join(', ')} (the output name is locked)`,
      {
        code: 'publish_failed_old_artifact_preserved',
        failed: publish.failed.map((f) => ({ artifact: path.basename(f.final), reason: f.reason })),
        published: publish.published.map((p) => path.basename(p)),
        artifactsPresentInTree: preserved,
        note: 'the previous artifacts were left in place; no file was renamed aside, so nothing is missing',
        recovery: 'node tools/stop-shim-holders.mjs   then re-run the build',
      },
    );
  }

  /* Post-publish gate: the tree must contain all three artifacts, and they must
   * still be PE files. Failing here means "missing artifact", never a silent
   * downgrade -- that is exactly how the 10-01 outage stayed invisible. */
  const integrity = assertArtifactIntegrity(OUT, names);

  const report = {
    ok: true,
    toolchain: path.relative(REPO, zig).replace(/\\/g, '/'),
    sweptTemps: swept,
    artifacts: {
      dll: {
        profile: PROFILE,
        path: path.relative(REPO, path.join(OUT, dllName)).replace(/\\/g, '/'),
        bytes: fs.statSync(path.join(OUT, dllName)).size,
        machine: dllInfo.machine,
        isDll: dllInfo.isDll,
        imports: dllInfo.importDlls,
        exports: dllInfo.exports,
      },
      injector: {
        path: path.relative(REPO, path.join(OUT, 'winstage-inject.exe')).replace(/\\/g, '/'),
        bytes: fs.statSync(path.join(OUT, 'winstage-inject.exe')).size,
        machine: injectorInfo.machine,
      },
      probe: {
        path: path.relative(REPO, path.join(OUT, 'winstage-probe.exe')).replace(/\\/g, '/'),
        bytes: fs.statSync(path.join(OUT, 'winstage-probe.exe')).size,
        machine: probeInfo.machine,
      },
    },
    integrity: integrity.detail,
    warnings: results.reduce((n, r) => n + r.warnings, 0),
  };

  /* Keep the launcher's children at the session's integrity level (see the
   * function comment: a Low-labeled artifact silently downgrades every carrier). */
  const labels = repairLowIntegrityLabels([
    path.join(OUT, dllName),
    path.join(OUT, 'winstage-inject.exe'),
    path.join(OUT, 'winstage-probe.exe'),
  ]);
  report.integrityLabels = labels;

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(`dll      -> ${report.artifacts.dll.path} (${report.artifacts.dll.bytes} bytes, ${dllInfo.exports.length} exports)`);
    log(`injector -> ${report.artifacts.injector.path} (${report.artifacts.injector.bytes} bytes)`);
    log(`probe    -> ${report.artifacts.probe.path} (${report.artifacts.probe.bytes} bytes)`);
    log(`imports  : ${dllInfo.importDlls.join(', ')}`);
    log(`exports  : ${dllInfo.exports.join(', ')}`);
    log(`warnings : ${report.warnings} (full compiler output in shim/out/build-logs)`);
    if (swept.length) log(`swept    : ${swept.length} abandoned .tmp staging file(s)`);
    for (const note of labels.notes) {
      log(`integrity: WARNING ${note}`);
    }
    if (labels.repaired.length) {
      log(`integrity: repaired a Low mandatory label that would have forced Low-IL carriers -> ${labels.repaired.join('; ')}`);
    }
  }
  return report;
}

/* Importable as a library (tests) without performing a build. */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => {
    try { return fs.realpathSync.native(path.resolve(p)).toLowerCase(); }
    catch { return path.resolve(p).toLowerCase(); }
  };
  const self = fileURLToPath(import.meta.url);
  return norm(entry) === norm(self);
}

if (isMain()) {
  try {
    main();
  } catch (e) {
    die(e);
  }
}
