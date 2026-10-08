#!/usr/bin/env node
/* WinStageSandbox T4 -- file-layer copy-on-write / creation-disposition matrix.
 *
 * Why this exists (the executable regression for the redirect fix)
 * ---------------------------------------------------------------
 * The handoff claim was: "inside an injected PowerShell, `& node --version > $f`
 * wrote a 0-byte file" because `>` uses CREATE_ALWAYS and the copy-on-write (CoW)
 * path left an empty copy in the overlay while the real write landed elsewhere.
 * The Lead then found the real cause (the hook engine patched the IAT of the very
 * modules the shim imports from, so the shim re-entered its own hooks and recursed
 * under verbose tracing) and fixed it in ws_hook.c (skip self-provider modules)
 * plus ws_util.c (log through the captured original CreateFileW).
 *
 * This script locks that fix in with byte-level assertions. It injects the shim
 * into a carrier process and exercises, INSIDE the sandbox:
 *
 *   c1   CREATE_ALWAYS on a non-existent path        -> write, read back byte-exact
 *   c1p  same disposition through the shim's own probe exe (winstage-probe.exe)
 *   c2   CREATE_NEW    on a non-existent path        -> write, read back byte-exact
 *   c3   CREATE_NEW    on an EXISTING real path      -> ERROR_FILE_EXISTS, real untouched,
 *                                                       and no staged file (no staging side effect)
 *   c4   OPEN_ALWAYS + GENERIC_WRITE on an existing real file (CoW) -> the pre-read shows the
 *        real content through the overlay, the write lands in the overlay, the read-back
 *        returns the new bytes, the real file is unchanged
 *   c4b  CoW copy byte-exactness (OPEN_ALWAYS, no write)
 *   c4d  a FAILED CoW fails closed (target is a real directory -> CopyFileW fails)
 *   c5   CREATE_ALWAYS (truncate) on an existing real file -> overlay == new bytes, real unchanged
 *   c5c  node's libuv TRUNCATE_EXISTING mask (FILE_APPEND_DATA|TRUNCATE_EXISTING): the error the
 *        sandboxed process sees must be the SAME error the uninjected host sees (LastError must
 *        survive the shim's own logging)
 *   c5t  a valid TRUNCATE_EXISTING (PowerShell FileMode.Truncate) on a real-only file ->
 *        empty overlay, real unchanged, real untouched
 *   c6cmd cmd.exe /c "<node> --version > <f>" inside the injected cmd, read back with `type`
 *         in the SAME injected process
 *   c6ps  PowerShell `& <node> --version > <f>`, read back with [IO.File]::ReadAllBytes in the
 *         SAME injected PowerShell process
 *   c7   DeleteFileW (probe `file-delete`) of a real-only file -> whiteout in <stage>\wo,
 *        read-back ERROR_FILE_NOT_FOUND, real file intact
 *   c8   staging provider unusable (staged parent is a file) -> fail-closed ACCESS_DENIED,
 *        real target not created
 *   c7b  node's fs.unlinkSync path: libuv opens the file with DELETE|FILE_READ_ATTRIBUTES and
 *        deletes it through SetFileInformationByHandle. The shim CoWs that open, the disposition
 *        is reverse-mapped from the staged copy to the logical path, and a whiteout marker is
 *        written -- the real file stays intact and the path reads back as gone (defect ①b:
 *        the whiteout is what makes the deletion visible to review/approval). FIXED: this used
 *        to be a recorded GAP ("returns success but the file is still readable") and is now a
 *        strict assertion.
 *
 * Recorded but NOT part of the pass count (see KNOWN GAPS in the output):
 *   c6cmd-canary  cmd.exe `if exist` still consults the real filesystem (different API than
 *                 GetFileAttributesW/ExW, which the shim hooks).
 *
 * Every assertion is about BYTES (length + exact content), never bare existence. The real
 * filesystem is verified from this (uninjected, unrestricted) process, the staging tree is
 * recorded per case, and the shim log supplies the disposition (`disp=`) evidence.
 *
 * Usage:
 *   node tests/file-cow-dispositions.mjs [--json] [--keep-stage] [--strict-gaps]
 *   WINSTAGE_SHIM_OUT=esc\par\a1 node tests\file-cow-dispositions.mjs
 *
 * Native-process output is captured through real file descriptors, never through
 * PowerShell pipes (documented host limitation).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..');
const OUT = process.env.WINSTAGE_SHIM_OUT
  ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT)
  : path.join(REPO, 'shim', 'out');
const DLL = path.join(OUT, 'winstage-shim.dll');
const INJECTOR = path.join(OUT, 'winstage-inject.exe');
const PROBE = path.join(OUT, 'winstage-probe.exe');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const CMD = path.join(SYS, 'System32', 'cmd.exe');
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NODE = process.execPath;

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const KEEP_STAGE = ARGS.has('--keep-stage');
const STRICT_GAPS = ARGS.has('--strict-gaps');

const DISP = {
  1: 'CREATE_NEW',
  2: 'CREATE_ALWAYS',
  3: 'OPEN_EXISTING',
  4: 'OPEN_ALWAYS',
  5: 'TRUNCATE_EXISTING',
};

/* ------------------------------------------------------------- tiny helpers */

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(a, b) === 0;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
function show(buf) {
  if (buf === null) return 'absent';
  const hex = buf.subarray(0, 16).toString('hex');
  return `${buf.length}B [${hex}${buf.length > 16 ? '...' : ''}]`;
}
/** Deterministic non-text byte pattern: contains NULs and >0x7f bytes on purpose. */
function pattern(len, seed) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * 7 + seed * 31 + 3) & 0xff;
  return b;
}
/** <stage>\fs\C\Users\... for a real "C:\Users\..." path (drive colon dropped). */
let OUT_STAGE = '';
function stagedOf(realPath, leaf = 'fs') {
  return path.join(OUT_STAGE, leaf, path.resolve(realPath).replace(/:/g, ''));
}
function walk(dir, rel, acc) {
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const it of items) {
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) walk(path.join(dir, it.name), r, acc);
    else acc.push(r);
  }
  return acc;
}

/* ================================================================= INNER RUN
 * Executed INSIDE the injected carrier. Reads the plan, performs the file API
 * calls with explicit dispositions, reads every target back, and prints one JSON
 * line to stdout (captured by the host through a file descriptor).
 */
function runInner() {
  const plan = JSON.parse(fs.readFileSync(process.env.WINSTAGE_COW_PLAN, 'utf8'));
  const C = plan.cases;
  const out = { marker: 'WINSTAGE-COW-INNER', runId: plan.runId, pid: process.pid, node: process.version, cases: {} };
  const rec = (id, obj) => {
    out.cases[id] = obj;
  };
  const attempt = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return {
        ok: false,
        code: (e && e.code) || null,
        errno: e && typeof e.errno === 'number' ? e.errno : null,
        msg: String((e && e.message) || e).slice(0, 160),
      };
    }
  };
  const readBack = (p) => {
    const r = attempt(() => fs.readFileSync(p));
    return r.ok ? { ok: true, b64: b64(r.value), len: r.value.length } : { ok: false, code: r.code, errno: r.errno };
  };
  const openClose = (p, flags) =>
    attempt(() => {
      const fd = fs.openSync(p, flags);
      fs.closeSync(fd);
    });

  // c1: CREATE_ALWAYS on a path that does not exist yet.
  {
    const w = attempt(() => fs.writeFileSync(C.c1.path, unb64(C.c1.contentB64)));
    rec('c1', {
      flag: "w = O_WRONLY|O_CREAT|O_TRUNC -> CREATE_ALWAYS",
      writeOk: w.ok,
      writeCode: w.code || null,
      errno: w.errno ?? null,
      read: readBack(C.c1.path),
    });
  }

  // c2: CREATE_NEW on a path that does not exist yet.
  {
    const w = attempt(() => fs.writeFileSync(C.c2.path, unb64(C.c2.contentB64), { flag: 'wx' }));
    rec('c2', {
      flag: "wx = O_WRONLY|O_CREAT|O_EXCL -> CREATE_NEW",
      writeOk: w.ok,
      writeCode: w.code || null,
      errno: w.errno ?? null,
      read: readBack(C.c2.path),
    });
  }

  // c3: CREATE_NEW on an existing REAL file -> must not create anything anywhere.
  {
    const w = attempt(() => fs.writeFileSync(C.c3.path, unb64(C.c3.contentB64), { flag: 'wx' }));
    rec('c3', {
      flag: "wx = O_WRONLY|O_CREAT|O_EXCL -> CREATE_NEW (target already exists)",
      writeOk: w.ok,
      writeCode: w.code || null,
      errno: w.errno ?? null,
      read: readBack(C.c3.path),
    });
  }

  // c4: OPEN_ALWAYS + GENERIC_WRITE on an existing real file (the CoW path).
  {
    const pre = readBack(C.c4.path);
    const o = attempt(() => {
      const fd = fs.openSync(C.c4.path, fs.constants.O_RDWR | fs.constants.O_CREAT);
      try {
        const buf = unb64(C.c4.contentB64);
        fs.writeSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    });
    rec('c4', {
      flag: 'O_RDWR|O_CREAT = OPEN_ALWAYS + GENERIC_READ|GENERIC_WRITE',
      preRead: pre,
      openOk: o.ok,
      openCode: o.code || null,
      errno: o.errno ?? null,
      read: readBack(C.c4.path),
    });
  }

  // c4b: CoW without any write -- the copy itself must be byte-exact.
  {
    const o = openClose(C.c4b.path, fs.constants.O_RDWR | fs.constants.O_CREAT);
    rec('c4b', {
      flag: 'O_RDWR|O_CREAT = OPEN_ALWAYS (CoW only, no write)',
      openOk: o.ok,
      openCode: o.code || null,
      errno: o.errno ?? null,
      read: readBack(C.c4b.path),
    });
  }

  // c4d: target is a real DIRECTORY -> CopyFileW cannot copy it -> the open must
  // fail closed (ERROR_ACCESS_DENIED) instead of touching the real directory.
  {
    const o = openClose(C.c4d.path, fs.constants.O_RDWR | fs.constants.O_CREAT);
    rec('c4d', {
      flag: 'O_RDWR|O_CREAT = OPEN_ALWAYS on a real directory (CoW must fail)',
      openOk: o.ok,
      openCode: o.code || null,
      errno: o.errno ?? null,
    });
  }

  // c5: CREATE_ALWAYS (truncate) on an existing real file.
  {
    const w = attempt(() => fs.writeFileSync(C.c5.path, unb64(C.c5.contentB64)));
    rec('c5', {
      flag: "w = O_WRONLY|O_CREAT|O_TRUNC -> CREATE_ALWAYS (target exists)",
      writeOk: w.ok,
      writeCode: w.code || null,
      errno: w.errno ?? null,
      read: readBack(C.c5.path),
    });
  }

  // c5c: libuv's TRUNCATE_EXISTING access mask (it sets FILE_APPEND_DATA, which
  // Windows rejects together with TRUNCATE_EXISTING). The point of this case is
  // that the sandboxed error must equal the uninjected error: a clobbered
  // LastError (the shim's own log write uses CreateFileW/OPEN_ALWAYS and leaves
  // ERROR_ALREADY_EXISTS behind) makes the caller see EEXIST instead of EINVAL.
  {
    const o = openClose(C.c5c.path, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
    rec('c5c', {
      flag: 'O_WRONLY|O_TRUNC = TRUNCATE_EXISTING (libuv mask, invalid on Windows)',
      openOk: o.ok,
      openCode: o.code || null,
      errno: o.errno ?? null,
      read: readBack(C.c5c.path),
    });
  }

  // c7b: node's delete-by-handle route. FIXED (was a recorded GAP): the shim's
  // NtSetInformationFile hook reverse-maps the staged handle to the logical path and records a
  // whiteout, so the real file survives and the path reads back as gone. Asserted strictly.
  {
    const d = attempt(() => fs.unlinkSync(C.c7b.path));
    rec('c7b', {
      flag: 'unlinkSync -> CreateFileW(DELETE|FILE_READ_ATTRIBUTES) + SetFileInformationByHandle',
      deleteOk: d.ok,
      deleteCode: d.code || null,
      errno: d.errno ?? null,
      read: readBack(C.c7b.path),
    });
  }

  // c8: the staging provider cannot materialize this path (its staged parent is a
  // regular file) -> fail closed, the real target must not exist.
  {
    const w = attempt(() => fs.writeFileSync(C.c8.path, unb64(C.c8.contentB64)));
    rec('c8', {
      flag: 'w = CREATE_ALWAYS under a staged path whose parent cannot be a directory',
      writeOk: w.ok,
      writeCode: w.code || null,
      errno: w.errno ?? null,
      read: readBack(C.c8.path),
    });
  }

  try {
    fs.writeFileSync(path.join(plan.evidenceDir, 'inner-node.json'), JSON.stringify(out, null, 2));
  } catch (e) {
    out.evidenceWriteError = String(e.message);
  }
  console.log(`${out.marker}-JSON ${JSON.stringify(out)}`);
  process.exit(0);
}

/* ================================================================= HOST RUN */

function runCarrier(tag, exe, argv, { verbose = false, env = {}, childTimeoutMs = 60000, timeoutMs = 300000 } = {}) {
  fs.mkdirSync(EV, { recursive: true });
  const outFile = path.join(EV, `${tag}.stdout.txt`);
  const errFile = path.join(EV, `${tag}.stderr.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const setEnv = [
    `WINSTAGE_STAGE_ROOT=${STAGE}`,
    `DSH_REGSTAGE_ROOT=${STAGE}`,
    `WINSTAGE_SHIM_LOG=${LOG}`,
  ];
  if (verbose) setEnv.push('WINSTAGE_SHIM_VERBOSE=1');
  for (const [k, v] of Object.entries(env)) setEnv.push(`${k}=${v}`);
  const injectorArgs = ['--dll', DLL];
  for (const kv of setEnv) injectorArgs.push('--set-env', kv);
  injectorArgs.push('--report', path.join(EV, `${tag}.inject.json`));
  injectorArgs.push('--timeout-ms', '30000', '--child-timeout-ms', String(childTimeoutMs), '--');
  injectorArgs.push(exe, ...argv);
  let res;
  try {
    res = spawnSync(INJECTOR, injectorArgs, {
      stdio: ['ignore', outFd, errFd],
      cwd: REPO,
      windowsHide: true,
      timeout: timeoutMs,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const injectReport = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(EV, `${tag}.inject.json`), 'utf8'));
    } catch {
      return null;
    }
  })();
  return {
    tag,
    status: res.status,
    signal: res.signal,
    error: res.error ? String(res.error) : null,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
    injectReport,
  };
}

/** Shell carriers are occasionally unstable inside the sandbox (see the report);
 *  a bounded retry keeps the byte assertions meaningful instead of flaky. Every
 *  attempt stays in the evidence. */
function runCarrierRetry(tag, exe, argv, opts, tries = 3) {
  const attempts = [];
  let last = null;
  for (let i = 1; i <= tries; i++) {
    last = runCarrier(i === 1 ? tag : `${tag}-try${i}`, exe, argv, opts);
    attempts.push({
      attempt: i,
      status: last.status,
      timedOut: last.injectReport ? last.injectReport.childTimedOut === true : null,
      stderr: last.stderr.replace(/\s+/g, ' ').slice(0, 200),
    });
    if (last.status === 0) return { ...last, attempts };
    sleepMs(300);
  }
  return { ...last, attempts };
}

function parseCreateRequests(logText) {
  const map = new Map();
  for (const raw of logText.split(/\r?\n/)) {
    const m = /CreateFile request raw=(.*) normalized=(.*) intercept=(\d+) access=(0x[0-9a-f]+) disp=(\d+)$/i.exec(raw.trim());
    if (m) {
      const key = m[2].toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ raw: m[1], normalized: m[2], intercept: Number(m[3]), access: m[4], disp: Number(m[5]) });
    }
  }
  return map;
}

function main() {
  for (const f of [DLL, INJECTOR, PROBE]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f}; build it (WINSTAGE_SHIM_OUT=... node tools/build-shim.mjs)`);
  }
  const runId = crypto.randomBytes(3).toString('hex');
  const STAGE = path.join(REPO, 'shim', '.stage', `cow-${runId}`);
  const EV = path.join(STAGE, 'evidence');
  const LOG = path.join(STAGE, 'shim.log');
  const REAL = path.join(OUT, `cow-real-${runId}`);
  OUT_STAGE = STAGE;
  globalThis.STAGE = STAGE;
  globalThis.EV = EV;
  globalThis.LOG = LOG;

  const P = (n) => path.join(REAL, `${n}-${runId}.txt`);
  const expectVersion = `v${process.versions.node}`;
  const contents = {
    c1: Buffer.from(`CASE1-CREATE_ALWAYS-${runId}\n`, 'utf8'),
    c1p: Buffer.from(`CASE1P-PROBE-CREATE_ALWAYS-${runId}`, 'utf8'),
    c2: Buffer.from(`CASE2-CREATE_NEW-${runId}\n`, 'utf8'),
    c3new: Buffer.from(`CASE3-MUST-NOT-LAND-${runId}\n`, 'utf8'),
    c3real: Buffer.from(`CASE3-REAL-ORIGINAL-${runId}\n`, 'utf8'),
    c4real: pattern(64, 1),
    c4new: pattern(64, 2),
    c4breal: pattern(96, 3),
    c5real: Buffer.from(`CASE5-REAL-ORIGINAL-${runId}\n`, 'utf8'),
    c5new: Buffer.from(`CASE5-OVERLAY-NEW-${runId}\n`, 'utf8'),
    c5creal: Buffer.from(`CASE5C-REAL-ORIGINAL-${runId}\n`, 'utf8'),
    c5treal: Buffer.from(`CASE5T-REAL-ORIGINAL-${runId}\n`, 'utf8'),
    c7real: Buffer.from(`CASE7-REAL-DO-NOT-DELETE-${runId}\n`, 'utf8'),
    c7breal: Buffer.from(`CASE7B-REAL-DO-NOT-DELETE-${runId}\n`, 'utf8'),
    c8new: Buffer.from(`CASE8-MUST-NOT-LAND-${runId}\n`, 'utf8'),
  };
  const targets = {
    c1: P('c1'),
    c1p: P('c1p'),
    c2: P('c2'),
    c3: P('c3'),
    c4: P('c4'),
    c4b: P('c4b'),
    c4d: path.join(REAL, `c4d-dir-${runId}`),
    c5: P('c5'),
    c5c: P('c5c'),
    c5t: P('c5t'),
    c6cmd: P('c6cmd'),
    c6cmdcanary: P('c6cmd-canary'),
    c6ps: P('c6ps'),
    c6pscanary: P('c6ps-canary'),
    c7: P('c7'),
    c7b: P('c7b'),
    c8: path.join(REAL, `c8blocked-${runId}`, 'f.txt'),
    c11: path.join(REAL, `c11-dir-${runId}`),
  };

  fs.mkdirSync(EV, { recursive: true });
  fs.mkdirSync(REAL, { recursive: true });
  // Seed the REAL filesystem (from this uninjected process).
  fs.writeFileSync(targets.c3, contents.c3real);
  fs.writeFileSync(targets.c4, contents.c4real);
  fs.writeFileSync(targets.c4b, contents.c4breal);
  fs.mkdirSync(targets.c4d);
  fs.writeFileSync(targets.c5, contents.c5real);
  fs.writeFileSync(targets.c5c, contents.c5creal);
  fs.writeFileSync(targets.c5t, contents.c5treal);
  fs.writeFileSync(targets.c7, contents.c7real);
  fs.writeFileSync(targets.c7b, contents.c7breal);
  fs.mkdirSync(targets.c11);
  const seededReal = walk(REAL, '', []).sort();
  // c8: make the *staged* parent of c8 a regular file so the provider cannot stage it.
  const c8StagedParent = stagedOf(path.dirname(targets.c8));
  fs.mkdirSync(path.dirname(c8StagedParent), { recursive: true });
  fs.writeFileSync(c8StagedParent, 'not-a-directory');

  /* Calibration baseline for c5c: the SAME node call, in THIS uninjected process. */
  const c5cBaselineTarget = P('c5c-host-baseline');
  fs.writeFileSync(c5cBaselineTarget, contents.c5creal);
  let c5cHost = null;
  try {
    const fd = fs.openSync(c5cBaselineTarget, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
    fs.closeSync(fd);
    c5cHost = { ok: true, code: null, errno: null };
  } catch (e) {
    c5cHost = { ok: false, code: e.code || null, errno: typeof e.errno === 'number' ? e.errno : null };
  }
  const c5cHostRealBytes = readIfExists(c5cBaselineTarget);
  fs.rmSync(c5cBaselineTarget, { force: true });

  const plan = {
    runId,
    stageRoot: STAGE,
    evidenceDir: EV,
    realDir: REAL,
    cases: {
      c1: { path: targets.c1, contentB64: b64(contents.c1) },
      c2: { path: targets.c2, contentB64: b64(contents.c2) },
      c3: { path: targets.c3, contentB64: b64(contents.c3new) },
      c4: { path: targets.c4, contentB64: b64(contents.c4new) },
      c4b: { path: targets.c4b },
      c4d: { path: targets.c4d },
      c5: { path: targets.c5, contentB64: b64(contents.c5new) },
      c5c: { path: targets.c5c },
      c7b: { path: targets.c7b },
      c8: { path: targets.c8, contentB64: b64(contents.c8new) },
    },
    /* Checked through .NET/PowerShell (GetFileAttributesExW) once the overlay is final. */
    statChecks: [
      { id: 'c1', path: targets.c1, expectExists: true, expectSize: contents.c1.length },
      { id: 'c1p', path: targets.c1p, expectExists: true, expectSize: contents.c1p.length },
      { id: 'c2', path: targets.c2, expectExists: true, expectSize: contents.c2.length },
      { id: 'c3', path: targets.c3, expectExists: true, expectSize: contents.c3real.length },
      { id: 'c4', path: targets.c4, expectExists: true, expectSize: contents.c4new.length },
      { id: 'c4b', path: targets.c4b, expectExists: true, expectSize: contents.c4breal.length },
      { id: 'c4d', path: targets.c4d, expectExists: true, expectDir: true },
      { id: 'c5', path: targets.c5, expectExists: true, expectSize: contents.c5new.length },
      { id: 'c5c', path: targets.c5c, expectExists: true, expectSize: contents.c5creal.length },
      { id: 'c5t', path: targets.c5t, expectExists: true, expectSize: 0 },
      { id: 'c7-whiteout', path: targets.c7, expectExists: false, expectDir: false },
      { id: 'c11-dir-whiteout', path: targets.c11, expectDir: false, expectExists: false },
      /* The whiteout lookup must not treat the wo tree's ancestor DIRECTORIES as
       * markers: ws_fs_map drops the drive colon, so <stage>\wo\C exists for any
       * marker on C:, and counting it as a whiteout made C:\ (and every ancestor
       * directory of any whiteout) look deleted -- which made injected PowerShell
       * refuse to load its .psm1 modules. */
      { id: 'dir-C-root', path: 'C:\\', expectExists: true, expectDir: true, key: 'ancestor-not-whiteouted' },
      { id: 'dir-C-Users', path: 'C:\\Users', expectExists: true, expectDir: true, key: 'ancestor-not-whiteouted' },
      { id: 'dir-C-Users-Administrator', path: 'C:\\Users\\Administrator', expectExists: true, expectDir: true, key: 'ancestor-not-whiteouted' },
      { id: 'dir-C-Windows', path: 'C:\\Windows', expectExists: true, expectDir: true, key: 'ancestor-not-whiteouted' },
      { id: 'c7b', path: targets.c7b, expectExists: false, expectDir: false },
      { id: 'c8-never-created', path: targets.c8, expectExists: false },
      { id: 'c6cmd', path: targets.c6cmd, expectExists: true, expectSize: `${expectVersion}\r\n`.length },
      { id: 'c6ps', path: targets.c6ps, expectExists: true, minSize: 1 },
      { id: 'c6cmd-canary', path: targets.c6cmdcanary, expectExists: true, expectSize: `${expectVersion}\r\n`.length },
    ],
  };
  const planPath = path.join(EV, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  /* ---------------------------------------------------- the injected runs */
  const inner = runCarrier('inner-node', NODE, [SELF, 'inner'], {
    verbose: true, // `disp=` disposition evidence + provider-skip evidence
    env: { WINSTAGE_COW_PLAN: planPath },
    childTimeoutMs: 120000,
  });
  const innerLine = inner.stdout.split(/\r?\n/).find((l) => l.startsWith('WINSTAGE-COW-INNER-JSON '));
  let innerJson = null;
  let innerParseError = null;
  if (innerLine) {
    try {
      innerJson = JSON.parse(innerLine.slice('WINSTAGE-COW-INNER-JSON '.length));
    } catch (e) {
      innerParseError = String(e.message);
    }
  } else {
    innerParseError = `inner carrier produced no result line (exit=${inner.status} stderr=${inner.stderr.slice(0, 200)})`;
  }

  const probeWrite = runCarrier(
    'probe-write',
    PROBE,
    ['file-write', targets.c1p, contents.c1p.toString('utf8'), path.join(EV, 'probe-write.json')],
    { verbose: true },
  );
  const probeRead = runCarrier('probe-read', PROBE, [
    'file-read', targets.c1p, path.join(EV, 'probe-read.json'),
  ]);
  const probeDelete = runCarrier(
    'probe-delete',
    PROBE,
    ['file-delete', targets.c7, path.join(EV, 'probe-delete.json')],
    { verbose: true },
  );
  const probeAfterDelete = runCarrier('probe-after-delete', PROBE, [
    'file-read', targets.c7, path.join(EV, 'probe-after-delete.json'),
  ]);
  /* c11 uses DeleteFileW/RemoveDirectoryW directly (the probe), not node: libuv's
   * rmdir opens with DELETE access and deletes through SetFileInformationByHandle
   * (the delete-by-handle route asserted separately as c7b). */
  const probeDirRemove = runCarrier(
    'probe-dir-remove',
    PROBE,
    ['dir-remove', targets.c11, path.join(EV, 'probe-dir-remove.json')],
    { verbose: true },
  );
  const probeDirAfterRemove = runCarrier('probe-dir-after-remove', PROBE, [
    'file-read', targets.c11, path.join(EV, 'probe-dir-after-remove.json'),
  ]);
  const pj = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(EV, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const probeW = pj('probe-write.json');
  const probeR = pj('probe-read.json');
  const probeD = pj('probe-delete.json');
  const probeAD = pj('probe-after-delete.json');
  const probeDR = pj('probe-dir-remove.json');
  const probeDAR = pj('probe-dir-after-remove.json');

  const cmdRun = runCarrierRetry(
    'cmd-redirect',    CMD,
    ['/c', NODE, '--version', '>', targets.c6cmd, '&', 'type', targets.c6cmd],
    { childTimeoutMs: 60000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  const psCommand =
    `$p='${targets.c6ps}'; & '${NODE}' --version > $p; ` +
    `$b=[System.IO.File]::ReadAllBytes($p); $hex=[System.BitConverter]::ToString($b).Replace('-',''); ` +
    `$txt=[System.IO.File]::ReadAllText($p).Trim(); Write-Output ($hex + '|' + $txt)`;
  const psRun = runCarrierRetry(
    'ps-redirect',
    POWERSHELL,
    ['-NoProfile', '-Command', psCommand],
    { childTimeoutMs: 45000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  const psTruncCommand =
    `$p='${targets.c5t}'; $fs=[System.IO.File]::Open($p,[System.IO.FileMode]::Truncate,[System.IO.FileAccess]::Write); ` +
    `$fs.Close(); $b=[System.IO.File]::ReadAllBytes($p); ` +
    `Write-Output ('T|' + $b.Length + '|' + [System.BitConverter]::ToString($b))`;
  const psTruncRun = runCarrierRetry(
    'ps-truncate',
    POWERSHELL,
    ['-NoProfile', '-Command', psTruncCommand],
    { verbose: true, childTimeoutMs: 45000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  /* The Lead's canary shape: the read-back is guarded by an existence check, so
   * it exercises the overlay-aware GetFileAttributes* hooks, not CreateFileW. */
  const cmdCanaryRun = runCarrierRetry(
    'cmd-canary',
    CMD,
    [
      '/c', NODE, '--version', '>', targets.c6cmdcanary, '&',
      'if', 'exist', targets.c6cmdcanary, '(type', targets.c6cmdcanary, ')',
      'else', '(echo', 'CANARY-MISSING)',
    ],
    { childTimeoutMs: 60000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  const psCanaryCommand =
    `$p='${targets.c6pscanary}'; & '${NODE}' --version > $p; ` +
    `if (Test-Path -LiteralPath $p) { $t=(Get-Content -LiteralPath $p -Raw).Trim(); Write-Output ('CANARY|' + $t) } ` +
    `else { Write-Output 'CANARY|MISSING' }`;
  const psCanaryRun = runCarrierRetry(
    'ps-canary',
    POWERSHELL,
    ['-NoProfile', '-Command', psCanaryCommand],
    { childTimeoutMs: 45000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  /* Independent, PowerShell-free verification of the stat hooks: libuv's
   * uv_fs_stat goes through GetFileAttributesExW. Runs AFTER the probe delete so
   * the whiteout is visible too. */
  /* Stat verification through the API surface the shim actually hooks:
   * [System.IO.File]::Exists / Directory.Exists (GetFileAttributesEx), read back
   * in the SAME injected PowerShell. Uses no cmdlet, so a broken language mode
   * cannot mask a stat result. Runs last, when the overlay is final. */
  const statListPath = path.join(EV, 'stat-list.txt');
  fs.writeFileSync(statListPath, plan.statChecks.map((c) => c.path).join('\r\n') + '\r\n');
  const statCommand =
    `$l=[System.IO.File]::ReadAllLines('${statListPath}'); ` +
    `foreach ($p in $l) { if ($p) { $f=[System.IO.File]::Exists($p); $d=[System.IO.Directory]::Exists($p); $s=''; ` +
    `if ($f) { $s=[System.IO.FileInfo]::new($p).Length }; ` +
    `[Console]::Out.WriteLine($f.ToString()+'|'+$d.ToString()+'|'+$s+'|'+$p) } }`;
  const statRun = runCarrierRetry(
    'stat-check',
    POWERSHELL,
    ['-NoProfile', '-Command', statCommand],
    { verbose: true, childTimeoutMs: 45000 },
    ARGS.has('--no-retry') ? 1 : 5,
  );
  const statResults = new Map();
  for (const line of (statRun.stdout || '').split(/\r?\n/)) {
    const m = /^(True|False)\|(True|False)\|(\d*)\|(.+)$/.exec(line.trim());
    if (m) statResults.set(m[4].toLowerCase(), { file: m[1] === 'True', dir: m[2] === 'True', size: m[3] === '' ? null : Number(m[3]) });
  }

  /* --------------------------------------------------- host-side evidence */
  const logText = readIfExists(LOG)?.toString('utf8') ?? '';
  const reqs = parseCreateRequests(logText);
  const reqOf = (p) => reqs.get(path.resolve(p).toLowerCase()) ?? [];
  const dispNote = (p) => {
    const r = reqOf(p);
    return r.length ? `disp=[${r.map((x) => `${x.disp}(${DISP[x.disp] ?? '?'})`).join(' ')}] access=[${r.map((x) => x.access).join(' ')}]` : 'no CreateFile request logged';
  };
  const hasDisp = (p, disp) => reqOf(p).some((r) => r.disp === disp);
  const stagedBytes = (p, leaf = 'fs') => readIfExists(stagedOf(p, leaf));
  const realBytes = (p) => readIfExists(p);
  const whiteouts = walk(path.join(STAGE, 'wo'), '', []);
  const stagedFiles = walk(path.join(STAGE, 'fs'), '', []);

  const innerCases = innerJson?.cases ?? {};
  const cases = [];
  const knowngaps = [];
  /* A PowerShell carrier that cannot start (measured on this host: CLR init
   * 800700b7/0x8007054F, assembly load failures, or a hang killed by the
   * child-timeout) is an ENVIRONMENT failure of the carrier, not a shim result.
   * Cases that depend on such a carrier are reported as BLOCKED, never as a shim
   * failure -- but they are never silently green either: the run then exits 2. */
  const carrierFailure = (run) => {
    if (!run) return 'carrier did not run';
    const txt = `${run.stderr || ''}`.replace(/\u0000/g, '');
    if (/Starting the CLR failed|Could not load file or assembly|shell cannot be started|Failed to load/i.test(txt)) {
      return `PowerShell/CLR failed to start: ${txt.replace(/\s+/g, ' ').slice(0, 90)}`;
    }
    if ((run.attempts || []).some((a) => a.timedOut)) return 'carrier hung (killed by the child-timeout)';
    if (run.status !== 0 && !txt.trim()) return `carrier exited ${run.status} with no diagnostic output`;
    return null;
  };
  const add = (id, title, ok, detail, blocked) =>
    cases.push({ id, title, ok: !!ok, detail: detail || '', blocked: ok ? null : blocked || null });
  const gap = (id, title, present, detail) =>
    knowngaps.push({ id, title, present: !!present, ok: !present, strict: STRICT_GAPS, detail: detail || '' });
  const psBlock = carrierFailure(psRun);
  const psTruncBlock = carrierFailure(psTruncRun);
  const statBlock = carrierFailure(statRun);

  // ---- c1: CREATE_ALWAYS on a non-existent path.
  {
    const r = innerCases.c1;
    const staged = stagedBytes(targets.c1);
    const real = realBytes(targets.c1);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok = r && r.writeOk && sameBytes(read, contents.c1) && sameBytes(staged, contents.c1) && real === null && hasDisp(targets.c1, 2);
    add(
      'c1',
      'CREATE_ALWAYS on a non-existent path -> write, read back byte-exact',
      ok,
      `writeOk=${r?.writeOk} readback=${show(read)} staged=${show(staged)} real=${show(real)} ${dispNote(targets.c1)}`,
    );
  }

  // ---- c1p: same disposition through the shim's own probe exe.
  {
    const staged = stagedBytes(targets.c1p);
    const real = realBytes(targets.c1p);
    const ok =
      probeW && probeW.createOk && probeW.writeOk && probeW.bytesWritten === contents.c1p.length &&
      probeR && probeR.openOk && probeR.bytesRead === contents.c1p.length &&
      probeR.content === contents.c1p.toString('utf8') && sameBytes(staged, contents.c1p) && real === null &&
      hasDisp(targets.c1p, 2);
    add(
      'c1p',
      'CREATE_ALWAYS via winstage-probe.exe file-write/file-read -> byte-exact',
      ok,
      `createOk=${probeW?.createOk} wrote=${probeW?.bytesWritten}/${contents.c1p.length} ` +
        `readOk=${probeR?.openOk} read=${probeR?.bytesRead}/${contents.c1p.length} ` +
        `contentMatch=${probeR?.content === contents.c1p.toString('utf8')} staged=${show(staged)} real=${show(real)} ${dispNote(targets.c1p)}`,
    );
  }

  // ---- c2: CREATE_NEW on a non-existent path.
  {
    const r = innerCases.c2;
    const staged = stagedBytes(targets.c2);
    const real = realBytes(targets.c2);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok =
      r && r.writeOk && sameBytes(read, contents.c2) && sameBytes(staged, contents.c2) && real === null && hasDisp(targets.c2, 1);
    add(
      'c2',
      'CREATE_NEW on a non-existent path -> write, read back byte-exact',
      ok,
      `writeOk=${r?.writeOk} readback=${show(read)} staged=${show(staged)} real=${show(real)} ${dispNote(targets.c2)}`,
    );
  }

  // ---- c3: CREATE_NEW on an existing real path.
  {
    const r = innerCases.c3;
    const staged = stagedBytes(targets.c3);
    const real = realBytes(targets.c3);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok =
      r && r.writeOk === false && r.writeCode === 'EEXIST' &&
      sameBytes(real, contents.c3real) && staged === null && sameBytes(read, contents.c3real) && hasDisp(targets.c3, 1);
    add(
      'c3',
      'CREATE_NEW on an EXISTING real path -> ERROR_FILE_EXISTS, real + overlay untouched',
      ok,
      `failed=${r?.writeOk === false} code=${r?.writeCode}/errno=${r?.errno} expected=EEXIST ` +
        `real=${show(real)} staged=${show(staged)} readbackThroughOverlay=${show(read)} ${dispNote(targets.c3)}`,
    );
  }

  // ---- c4: OPEN_ALWAYS + GENERIC_WRITE on an existing real file (CoW).
  {
    const r = innerCases.c4;
    const staged = stagedBytes(targets.c4);
    const real = realBytes(targets.c4);
    const pre = r?.preRead?.ok ? unb64(r.preRead.b64) : null;
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const cowLog = logText.toLowerCase().includes(('CreateFileW copy-on-write ' + stagedOf(targets.c4)).toLowerCase());
    const ok =
      r && r.openOk && sameBytes(pre, contents.c4real) && sameBytes(read, contents.c4new) &&
      sameBytes(staged, contents.c4new) && sameBytes(real, contents.c4real) && cowLog && hasDisp(targets.c4, 4);
    add(
      'c4',
      'OPEN_ALWAYS+GENERIC_WRITE on an existing real file (CoW) -> new bytes in overlay, real unchanged',
      ok,
      `preRead(=real through the overlay)=${show(pre)} readback=${show(read)} staged=${show(staged)} real=${show(real)} ` +
        `realUnchanged=${sameBytes(real, contents.c4real)} log[CreateFileW copy-on-write]=${cowLog} ${dispNote(targets.c4)}`,
    );
  }

  // ---- c4b: the CoW copy itself is byte-exact.
  {
    const r = innerCases.c4b;
    const staged = stagedBytes(targets.c4b);
    const real = realBytes(targets.c4b);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok =
      r && r.openOk && sameBytes(staged, contents.c4breal) && sameBytes(read, contents.c4breal) &&
      sameBytes(real, contents.c4breal) && hasDisp(targets.c4b, 4);
    add(
      'c4b',
      'CoW copy is byte-exact (OPEN_ALWAYS, no write) and the real file is unchanged',
      ok,
      `staged=${show(staged)} real=${show(real)} readback=${show(read)} bytesEqual=${sameBytes(staged, contents.c4breal)} ${dispNote(targets.c4b)}`,
    );
  }

  // ---- c4d: a failed CoW fails closed.
  {
    const r = innerCases.c4d;
    const stagedStat = (() => {
      try {
        return fs.statSync(stagedOf(targets.c4d));
      } catch {
        return null;
      }
    })();
    const realDir = (() => {
      try {
        return fs.statSync(targets.c4d).isDirectory();
      } catch {
        return false;
      }
    })();
    const cowFailLog = logText.includes('fail-closed CreateFileW (copy-on-write failed)');
    const ok =
      r && r.openOk === false && r.openCode === 'EPERM' && stagedStat === null && realDir && cowFailLog && hasDisp(targets.c4d, 4);
    add(
      'c4d',
      'a FAILED CoW fails closed (real directory target) -> ACCESS_DENIED, no staging artifact',
      ok,
      `openOk=${r?.openOk} code=${r?.openCode}/errno=${r?.errno} expected=EPERM stagedArtifact=${stagedStat === null ? 'none' : 'created'} ` +
        `realDirIntact=${realDir} log[fail-closed copy-on-write failed]=${cowFailLog} ${dispNote(targets.c4d)}`,
    );
  }

  // ---- c5: CREATE_ALWAYS on an existing real file.
  {
    const r = innerCases.c5;
    const staged = stagedBytes(targets.c5);
    const real = realBytes(targets.c5);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok =
      r && r.writeOk && sameBytes(staged, contents.c5new) && sameBytes(read, contents.c5new) &&
      sameBytes(real, contents.c5real) && hasDisp(targets.c5, 2);
    add(
      'c5',
      'CREATE_ALWAYS (truncate) on an existing real file -> overlay becomes the new content, real unchanged',
      ok,
      `staged=${show(staged)} readback=${show(read)} real=${show(real)} realUnchanged=${sameBytes(real, contents.c5real)} ${dispNote(targets.c5)}`,
    );
  }

  // ---- c5c: LastError must survive the shim's own logging.
  {
    const r = innerCases.c5c;
    const staged = stagedBytes(targets.c5c);
    const real = realBytes(targets.c5c);
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok =
      r && r.openOk === false && r.openCode === c5cHost.code &&
      sameBytes(real, contents.c5creal) && sameBytes(read, contents.c5creal) &&
      sameBytes(c5cHostRealBytes, contents.c5creal) && hasDisp(targets.c5c, 5);
    add(
      'c5c',
      "libuv TRUNCATE_EXISTING mask: the sandboxed error equals the uninjected host's error (LastError preserved)",
      ok,
      `sandboxed code=${r?.openCode}/errno=${r?.errno} host code=${c5cHost.code}/errno=${c5cHost.errno} ` +
        `real=${show(real)} readback=${show(read)} stagedCopyLeftBehind=${staged === null ? 'none' : `${staged.length}B (identical to real: ${sameBytes(staged, contents.c5creal)})`} ${dispNote(targets.c5c)}`,
    );
  }

  // ---- c5t: a valid TRUNCATE_EXISTING (PowerShell FileMode.Truncate) on a real-only file.
  {
    const staged = stagedBytes(targets.c5t);
    const real = realBytes(targets.c5t);
    const line = (psTruncRun.stdout || '').split(/\r?\n/).find((l) => l.startsWith('T|')) ?? '';
    const parts = line.split('|');
    const len = Number(parts[1]);
    const hex = parts[2];
    const ok =
      psTruncRun.status === 0 && parts.length === 3 && len === 0 && hex === '' &&
      staged !== null && staged.length === 0 && sameBytes(real, contents.c5treal) &&
      hasDisp(targets.c5t, 5) && !(parseInt(reqOf(targets.c5t).find((r) => r.disp === 5)?.access ?? '0xffffffff', 16) & 0x4);
    add(
      'c5t',
      'TRUNCATE_EXISTING (PowerShell FileMode.Truncate) on a real-only file -> empty overlay, real unchanged',
      ok,
      `psExit=${psTruncRun.status} attempts=${psTruncRun.attempts.length} inProcessRead=[len=${len} hex="${hex}"] ` +
        `stagedOverlay=${show(staged)} real=${show(real)} realUnchanged=${sameBytes(real, contents.c5treal)} ` +
        `stderr=${JSON.stringify((psTruncRun.stderr || '').replace(/\s+/g, ' ').slice(0, 120))} ${dispNote(targets.c5t)}`,
      psTruncBlock,
    );
  }

  // ---- c6cmd: cmd.exe `>` redirect, read back in the same injected process.
  {
    const staged = stagedBytes(targets.c6cmd);
    const real = realBytes(targets.c6cmd);
    const expect = Buffer.from(`${expectVersion}\r\n`, 'utf8');
    const outBytes = Buffer.from(cmdRun.stdout || '', 'utf8');
    const ok = cmdRun.status === 0 && sameBytes(outBytes, expect) && sameBytes(staged, expect) && real === null;
    add(
      'c6cmd',
      'cmd.exe /c "<node> --version > <f>" + `type` in the same injected cmd -> byte-exact',
      ok,
      `exit=${cmdRun.status} attempts=${cmdRun.attempts.length} inProcessRead=${show(outBytes)} staged=${show(staged)} ` +
        `real=${show(real)} expect=${show(expect)}`,
    );
  }

  // ---- c6ps: PowerShell `>` redirect, read back in the same injected PowerShell.
  {
    const staged = stagedBytes(targets.c6ps);
    const real = realBytes(targets.c6ps);
    const line = (psRun.stdout || '').trim().split(/\r?\n/).pop() ?? '';
    const [hex, text] = line.split('|');
    const hexOk = !!hex && /^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0;
    const psBytes = hexOk ? Buffer.from(hex, 'hex') : null;
    const ok =
      psRun.status === 0 && text === expectVersion && hexOk && staged !== null && staged.length > 0 &&
      sameBytes(staged, psBytes) && real === null;
    add(
      'c6ps',
      'PowerShell "& <node> --version > <f>" + in-process byte read-back -> version text present',
      ok,
      `exit=${psRun.status} attempts=${psRun.attempts.length} inProcessRead=${show(psBytes)} decoded="${text}" ` +
        `expect="${expectVersion}" staged=${show(staged)} stagedEqualsInProcessRead=${sameBytes(staged, psBytes)} real=${show(real)}`,
      psBlock,
    );
  }

  // ---- c6cmd-canary: cmd's own existence check (`if exist`) -- NOT covered by the
  // GetFileAttributes* hooks; recorded as a gap instead of asserted (see below).
  {
    const staged = stagedBytes(targets.c6cmdcanary);
    const outBytes = Buffer.from(cmdCanaryRun.stdout || '', 'utf8');
    const covered = sameBytes(outBytes, Buffer.from(`${expectVersion}\r\n`, 'utf8'));
    gap(
      'c6cmd-canary',
      'cmd.exe `if exist <f>` still does not see a staged file (it uses a different API than GetFileAttributesW/ExW)',
      !covered,
      `exit=${cmdCanaryRun.status} out=${show(outBytes)} staged=${show(staged)} ` +
        `("CANARY-MISSING" => cmd's existence check consulted the real filesystem; \`type\` in the same process DOES read the overlay)`,
    );
  }

  // ---- c6ps-canary: the Lead's canary shape (`if (Test-Path ...) { Get-Content }`).
  {
    const staged = stagedBytes(targets.c6pscanary);
    const real = realBytes(targets.c6pscanary);
    const out = (psCanaryRun.stdout || '').trim();
    const idx = out.lastIndexOf('CANARY|');
    const textAfter = idx >= 0 ? out.slice(idx + 'CANARY|'.length).trim() : '';
    const ok =
      psCanaryRun.status === 0 && textAfter === expectVersion && staged !== null && staged.length > 0 && real === null;
    add(
      'c6ps-canary',
      'PowerShell `if (Test-Path -LiteralPath $f) { Get-Content $f }` after its own redirect -> overlay-aware existence check',
      ok,
      `exit=${psCanaryRun.status} attempts=${psCanaryRun.attempts.length} reported="${textAfter}" expect="${expectVersion}" ` +
        `staged=${show(staged)} real=${show(real)}`,
      psBlock,
    );
  }

  // ---- c9: the stat hooks, verified through .NET/PowerShell (GetFileAttributesExW).
  {
    const bad = [];
    for (const chk of plan.statChecks.filter((c) => c.key !== 'ancestor-not-whiteouted')) {
      const got = statResults.get(chk.path.toLowerCase());
      if (!got) {
        bad.push(`${chk.id}: not reported`);
        continue;
      }
      if (chk.expectDir !== undefined) {
        if (got.dir !== chk.expectDir) bad.push(`${chk.id}: Directory.Exists=${got.dir} expected ${chk.expectDir}`);
        continue;
      }
      if (got.file !== !!chk.expectExists) {
        bad.push(`${chk.id}: File.Exists=${got.file} expected ${!!chk.expectExists}`);
        continue;
      }
      if (chk.expectExists) {
        if (typeof chk.expectSize === 'number' && got.size !== chk.expectSize) bad.push(`${chk.id}: size=${got.size} expected ${chk.expectSize}`);
        if (typeof chk.minSize === 'number' && !(got.size >= chk.minSize)) bad.push(`${chk.id}: size=${got.size} < ${chk.minSize}`);
      }
    }
    const exwLines = logText.split(/\r?\n/).filter((l) => /GetFileAttributesExW mapped=.*staged=1/.test(l));
    const ok = statRun.status === 0 && statResults.size > 0 && bad.length === 0 && exwLines.length > 0;
    add(
      'c9',
      'overlay-aware existence/stat (GetFileAttributesExW): staged + whiteouted + real-only paths answer correctly',
      ok,
      `${plan.statChecks.length - 4} checks via [IO.File]::Exists/[IO.Directory]::Exists in the injected PS, failures=[${bad.join('; ')}] ` +
        `log[GetFileAttributesExW staged=1 lines]=${exwLines.length}`,
      statBlock,
    );
  }

  // ---- c10: the wo tree's ancestor directories must NOT whiteout real directories.
  {
    const bad = [];
    const watch = plan.statChecks.filter((c) => c.key === 'ancestor-not-whiteouted');
    for (const chk of watch) {
      const got = statResults.get(chk.path.toLowerCase());
      if (!got) bad.push(`${chk.id}: not reported`);
      else if (got.dir !== true) bad.push(`${chk.id}: Directory.Exists=${got.dir} (reported DELETED)`);
    }
    const ok = statRun.status === 0 && statResults.size > 0 && bad.length === 0;
    add(
      'c10',
      'a whiteout for a file must not hide its ancestor directories (C:\\, C:\\Users, ...)',
      ok,
      `${watch.length} ancestor directory checks (with a whiteout present in the stage): ` +
        (bad.length ? `FAILED -> ${bad.join('; ')}` : 'all still exist and are directories'),
      statBlock,
    );
  }

  // ---- c11: a directory whiteout marker is a FILE, hides the real dir, leaves it intact.
  {
    const markerPath = stagedOf(targets.c11, 'wo');
    const markerStat = (() => {
      try {
        return fs.statSync(markerPath);
      } catch {
        return null;
      }
    })();
    const realDir = (() => {
      try {
        return fs.statSync(targets.c11).isDirectory();
      } catch {
        return false;
      }
    })();
    const statCheck = statResults.get(targets.c11.toLowerCase());
    const ok =
      probeDR && probeDR.removeOk === true && realDir === true && markerStat !== null &&
      markerStat.isFile() && markerStat.size === 0 &&
      probeDAR && probeDAR.openOk === false && probeDAR.openError === 2 &&
      (statCheck ? statCheck.dir === false : true);
    add(
      'c11',
      'RemoveDirectoryW (real dir) -> marker FILE in wo, dir hidden in the overlay, real dir intact',
      ok,
      `removeOk=${probeDR?.removeOk}/err=${probeDR?.removeError} readBack=${probeDAR?.openOk}/${probeDAR?.openError} (2=ERROR_FILE_NOT_FOUND) ` +
        `marker=${markerStat ? `${markerStat.size}B ${markerStat.isFile() ? 'file' : 'directory'}` : 'absent'} realDirIntact=${realDir} ` +
        `Directory.Exists=${statCheck ? statCheck.dir : 'not measured'} wo=${path.relative(STAGE, markerPath)}`,
    );
  }

  // ---- c7: DeleteFileW -> whiteout.
  {
    const real = realBytes(targets.c7);
    const staged = stagedBytes(targets.c7);
    const woPath = stagedOf(targets.c7, 'wo');
    const wo = readIfExists(woPath);
    const deleteLogged = logText.includes(`DeleteFileW request raw=${targets.c7}`) ||
      logText.includes(`DeleteFileW request raw=\\\\?\\${targets.c7}`);
    const ok =
      probeD && probeD.deleteOk === true && probeD.deleteError === 0 &&
      probeAD && probeAD.openOk === false && probeAD.openError === 2 &&
      sameBytes(real, contents.c7real) && staged === null && wo !== null && wo.length === 0 && deleteLogged;
    add(
      'c7',
      'DeleteFileW (probe) of a real-only file -> whiteout marker, read-back ERROR_FILE_NOT_FOUND, real intact',
      ok,
      `deleteOk=${probeD?.deleteOk}/err=${probeD?.deleteError} readBackOk=${probeAD?.openOk}/err=${probeAD?.openError} (2=ERROR_FILE_NOT_FOUND) ` +
        `real=${show(real)} staged=${show(staged)} wo[${path.relative(STAGE, woPath)}]=${show(wo)} log[DeleteFileW request]=${deleteLogged}`,
    );
  }

  // ---- c7b: node's delete-by-handle route -> whiteout, real file intact (FIXED, strict).
  {
    const r = innerCases.c7b;
    const real = realBytes(targets.c7b);
    const staged = stagedBytes(targets.c7b);
    const wo = readIfExists(stagedOf(targets.c7b, 'wo'));
    const read = r?.read?.ok ? unb64(r.read.b64) : null;
    const ok = !!(
      r && r.deleteOk === true && wo !== null && wo.length === 0 && read === null &&
      sameBytes(real, contents.c7breal) && staged === null
    );
    add(
      'c7b',
      'node fs.unlinkSync (DELETE access + SetFileInformationByHandle) -> whiteout, read-back gone, real intact',
      ok,
      `deleteOk=${r?.deleteOk} whiteout=${wo === null ? 'none' : `${wo.length}B`} ` +
        `readBackAfterDelete=${show(read)} (must be absent) realIntact=${sameBytes(real, contents.c7breal)} ` +
        `stagedCopy=${show(staged)} ${dispNote(targets.c7b)}`,
    );
  }

  // ---- c8: staging provider unusable -> fail closed.
  {
    const r = innerCases.c8;
    const real = realBytes(targets.c8);
    const staged = stagedBytes(targets.c8);
    const resolveFail = logText.toLowerCase().includes(('stage parent unreachable ' + stagedOf(targets.c8)).toLowerCase());
    const ok = r && r.writeOk === false && r.writeCode === 'EPERM' && real === null && staged === null && resolveFail && hasDisp(targets.c8, 2);
    add(
      'c8',
      'staging provider unusable -> fail closed (ACCESS_DENIED), real target not created',
      ok,
      `writeOk=${r?.writeOk} code=${r?.writeCode}/errno=${r?.errno} expected=EPERM real=${show(real)} staged=${show(staged)} ` +
        `log[stage parent unreachable]=${resolveFail} ${dispNote(targets.c8)}`,
    );
  }

  /* --------------------------------------------------------------- output */
  const blockedCases = cases.filter((c) => !c.ok && c.blocked);
  const failedCases = cases.filter((c) => !c.ok && !c.blocked);
  const strictFails = failedCases.length + (STRICT_GAPS ? knowngaps.filter((g) => g.present).length : 0);
  const pass = cases.filter((c) => c.ok).length;
  const allOk = strictFails === 0 && blockedCases.length === 0;
  const exitCode = strictFails > 0 ? 1 : blockedCases.length > 0 ? 2 : 0;
  const verdict = strictFails > 0 ? 'FAILED' : blockedCases.length > 0 ? 'BLOCKED' : 'PASSED';

  const disposition = [];
  const addDisp = (id, p, note) => {
    const staged = stagedBytes(p);
    const wo = readIfExists(stagedOf(p, 'wo'));
    disposition.push({
      case: id,
      realPath: p,
      stagedPath: stagedOf(p),
      staged: staged === null ? null : { bytes: staged.length, hex: staged.subarray(0, 16).toString('hex') },
      whiteout: wo === null ? null : stagedOf(p, 'wo'),
      requests: reqOf(p),
      note,
    });
  };
  addDisp('c1', targets.c1, 'CREATE_ALWAYS creates the staged file');
  addDisp('c1p', targets.c1p, 'CREATE_ALWAYS via the probe (independent implementation)');
  addDisp('c2', targets.c2, 'CREATE_NEW creates the staged file');
  addDisp('c3', targets.c3, 'CREATE_NEW on an existing real path leaves no staged file');
  addDisp('c4', targets.c4, 'OPEN_ALWAYS+write: CoW copy, then the write lands in the overlay');
  addDisp('c4b', targets.c4b, 'OPEN_ALWAYS CoW only: an exact copy of the real bytes');
  addDisp('c4d', targets.c4d, 'CoW failure: nothing staged, ACCESS_DENIED');
  addDisp('c5', targets.c5, 'CREATE_ALWAYS replaces the staged content');
  addDisp('c5c', targets.c5c, 'libuv TRUNCATE_EXISTING mask: rejected by Windows');
  addDisp('c5t', targets.c5t, 'TRUNCATE_EXISTING: empty staged file, real file untouched');
  addDisp('c6cmd', targets.c6cmd, 'cmd `>` redirect -> CREATE_ALWAYS staged file');
  addDisp('c6cmd-canary', targets.c6cmdcanary, '`if exist` + `type` in the same injected cmd (existence check)');
  addDisp('c6ps', targets.c6ps, 'PowerShell `>` redirect -> staged file');
  addDisp('c6ps-canary', targets.c6pscanary, 'Test-Path + Get-Content in the same injected PowerShell (existence check)');
  addDisp('c7', targets.c7, 'DeleteFileW -> whiteout marker, no staged content');
  addDisp('c11', targets.c11, 'RemoveDirectoryW -> whiteout marker FILE for a directory, real dir untouched');
  addDisp('c7b', targets.c7b, 'delete-by-handle: CoW copy created, disposition whiteout written, real file intact');
  addDisp('c8', targets.c8, 'unusable staged parent: fail closed');

  const providerLines = logText
    .split(/\r?\n/)
    .filter((l) => /self import provider:|skip provider module/.test(l))
    .map((l) => l.replace(/^\[winstage-shim\]\[\d+\]\[\d+\] /, ''));

  const realTree = walk(REAL, '', []).sort();
  const report = {
    ok: allOk,
    runId,
    dll: DLL,
    stageRoot: STAGE,
    realDir: REAL,
    innerCarrier: { status: inner.status, signal: inner.signal, error: inner.error, parseError: innerParseError, result: innerJson },
    probe: {
      write: probeW,
      read: probeR,
      delete: probeD,
      afterDelete: probeAD,
      dirRemove: probeDR,
      dirAfterRemove: probeDAR,
    },
    cmdRedirect: { status: cmdRun.status, attempts: cmdRun.attempts, stdout: cmdRun.stdout, stderr: cmdRun.stderr.slice(0, 400) },
    cmdCanary: { status: cmdCanaryRun.status, attempts: cmdCanaryRun.attempts, stdout: cmdCanaryRun.stdout, stderr: cmdCanaryRun.stderr.slice(0, 400) },
    psRedirect: { status: psRun.status, attempts: psRun.attempts, stdout: psRun.stdout.slice(0, 400), stderr: psRun.stderr.slice(0, 400) },
    psCanary: { status: psCanaryRun.status, attempts: psCanaryRun.attempts, stdout: psCanaryRun.stdout.slice(0, 400), stderr: psCanaryRun.stderr.slice(0, 400) },
    psTruncate: { status: psTruncRun.status, attempts: psTruncRun.attempts, stdout: psTruncRun.stdout.slice(0, 400), stderr: psTruncRun.stderr.slice(0, 400) },
    c5cHostBaseline: c5cHost,
    statChecks: [...statResults.entries()].map(([path, v]) => ({ path, ...v })),
    blockedByCarrier: blockedCases.map((c) => ({ id: c.id, reason: c.blocked })),
    cases,
    knownGaps: knowngaps,
    stagingDispositions: disposition,
    whiteoutFiles: whiteouts,
    stagedFiles,
    realTreeAfter: realTree,
    seededReal,
    realTreeExtra: realTree.filter((p) => !seededReal.includes(p)),
    providerSkipEvidence: providerLines,
    shimLogLines: logText.split(/\r?\n/).length,
  };

  if (!JSON_OUT) {
    console.log(`[cow] shim=${DLL}`);
    console.log(`[cow] stage=${STAGE}`);
    console.log(`[cow] real=${REAL}`);
    if (innerParseError) console.log(`[cow] inner carrier problem: ${innerParseError}`);
    for (const c of cases) {
      console.log(`${c.ok ? 'PASS' : c.blocked ? 'BLOCK' : 'FAIL'} ${c.id.padEnd(13)} ${c.title}`);
      console.log(`      ${c.detail}`);
      if (c.blocked) console.log(`      BLOCKED BY CARRIER (environment, not a shim result): ${c.blocked}`);
    }
    console.log('\n--- file-layer staging dispositions (per case) ---');
    for (const d of disposition) {
      const req = d.requests.length
        ? `disp=[${d.requests.map((r) => `${r.disp}(${DISP[r.disp] ?? '?'})`).join(' ')}] access=[${d.requests.map((r) => r.access).join(' ')}]`
        : 'no request logged';
      console.log(
        `${d.case.padEnd(13)} ${req.padEnd(46)} staged=${d.staged ? `${d.staged.bytes}B [${d.staged.hex}]` : 'absent'} ` +
          `whiteout=${d.whiteout ? path.relative(STAGE, d.whiteout) : 'none'}`,
      );
      console.log(`      ${d.note}`);
    }
    console.log(`\nwhiteout files in <stage>\\wo: ${whiteouts.length ? whiteouts.join(', ') : '(none)'}`);
    console.log(`staged files in <stage>\\fs: ${stagedFiles.length}`);
    console.log(
      `real tree unchanged: ${report.realTreeExtra.length === 0}${report.realTreeExtra.length ? ' -> EXTRA: ' + report.realTreeExtra.join(', ') : ''} ` +
        `(seeded ${seededReal.length} entries)`,
    );
    console.log('\n--- provider-skip evidence (Lead ws_hook.c fix, verbose run) ---');
    for (const l of providerLines.slice(0, 6)) console.log(l);
    if (!providerLines.length) console.log('(no provider-skip lines found; verbose log missing?)');

    console.log('\n--- shell carrier stability (retries are recorded, not hidden) ---');
    for (const [label, r] of [['cmd-redirect', cmdRun], ['cmd-canary', cmdCanaryRun], ['ps-redirect', psRun], ['ps-canary', psCanaryRun], ['ps-truncate', psTruncRun]]) {
      console.log(
        `${label}: attempts=${r.attempts.length} ` +
          r.attempts.map((a) => `#${a.attempt}=exit:${a.status}${a.timedOut ? '(killed by child-timeout)' : ''}${a.stderr ? ` "${a.stderr.slice(0, 70)}"` : ''}`).join(' '),
      );
    }

    console.log('\n--- KNOWN GAPS (found during this audit; recorded, not fixed here) ---');
    for (const g of knowngaps) {
      console.log(`${g.present ? 'GAP  ' : 'CLOSED'} ${g.id.padEnd(5)} ${g.title}`);
      console.log(`      ${g.detail}`);
    }

    console.log(`\n${verdict} (${pass}/${cases.length}${blockedCases.length ? `, ${blockedCases.length} blocked by a carrier failure` : ''}${STRICT_GAPS ? `, strict-gaps: ${knowngaps.filter((g) => !g.ok).length} gap failure(s)` : ''})`);
    if (blockedCases.length) {
      console.log('blocked cases (environment, NOT shim failures; exit code 2):');
      for (const c of blockedCases) console.log(`  - ${c.id}: ${c.blocked}`);
    }
    console.log(`report: ${path.join(EV, 'cow-report.json')}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  try {
    fs.writeFileSync(path.join(EV, 'cow-report.json'), JSON.stringify(report, null, 2) + '\n');
  } catch {
    /* evidence write is best effort; the verdict does not depend on it */
  }

  if (!KEEP_STAGE) {
    for (const dir of [STAGE, REAL]) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          sleepMs(150 * attempt);
        }
      }
    }
  }
  process.exit(exitCode);
}

/* ------------------------------------------------------------------- entry */
if (process.argv[2] === 'inner') {
  try {
    runInner();
  } catch (e) {
    console.log(`WINSTAGE-COW-INNER-ERROR ${String(e && e.stack ? e.stack : e)}`);
    process.exit(3);
  }
} else if (process.argv[2] === 'stat') {
  /* retired: existence is now verified through .NET/PowerShell (c9/c10), which
   * uses the APIs the shim hooks; node's fs.existsSync goes through libuv and
   * does not reflect the hooked surface. */
  console.log('WINSTAGE-COW-STAT-ERROR retired mode');
  process.exit(3);
} else {
  try {
    main();
  } catch (e) {
    console.error(`[cow] FAILED: ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  }
}
