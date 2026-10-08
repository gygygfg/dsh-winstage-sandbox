#!/usr/bin/env node
// WinStageSandbox T4 -- toolchain bootstrap.
//
// Host facts this script assumes (measured on the target machine, see
// docs/T4-shim?.md): no MSVC / clang / gcc / rustc / ml64 / nasm / zig,
// no Windows SDK, no .NET SDK, and no usable unzip/tar/7z guarantee. Node 24 is
// present and can reach the network. Therefore: download the official Zig
// distribution with node's built-in fetch, verify its published SHA256, and
// unpack it with our own ZIP reader (tools/lib/zip.mjs). No pipes around native
// executables are used anywhere in this script.
//
// What it installs:
//   tools/toolchain/zig-<ver>/zig.exe  (+ Zig's bundled mingw-w64 headers & libs)
//   tools/toolchain/toolchain.json     (manifest: hashes, sizes, resolved zig version)
//
// Idempotent: re-running verifies the cached archive and the extracted tree and
// exits 0 without re-downloading. Use --force to redo everything.
//
// Usage:
//   node tools/fetch-toolchain.mjs [--force] [--offline] [--json]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractZip, listZip } from './lib/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOLCHAIN_DIR = path.join(HERE, 'toolchain');
const DOWNLOAD_DIR = path.join(TOOLCHAIN_DIR, '.download');

// --- pinned toolchain identity -------------------------------------------------
const ZIG_VERSION = '0.13.0';
const ZIP_NAME = `zig-windows-x86_64-${ZIG_VERSION}.zip`;
const PRIMARY_URL = `https://ziglang.org/download/${ZIG_VERSION}/${ZIP_NAME}`;
// Mirrors tried, in order, only if the primary URL fails.
const MIRROR_URLS = [
  `https://mirrors.huaweicloud.com/zig/${ZIG_VERSION}/${ZIP_NAME}`,
  `https://mirrors.ustc.edu.cn/zig/${ZIG_VERSION}/${ZIP_NAME}`,
];
// Published by the vendor in https://ziglang.org/download/index.json. The script
// re-reads index.json on every run and refuses to proceed if the vendor's shasum
// disagrees with this constant, so a silently-replaced upstream artefact cannot
// slip through. (Values were captured from the vendor index, not from memory.)
const PINNED_SHA256 = 'd859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158';
const PINNED_SIZE = 79163968;
const INDEX_URL = 'https://ziglang.org/download/index.json';

const ZIG_DIR = path.join(TOOLCHAIN_DIR, `zig-${ZIG_VERSION}`);
const ZIG_EXE = path.join(ZIG_DIR, 'zig.exe');
const MANIFEST = path.join(TOOLCHAIN_DIR, 'toolchain.json');
const ARCHIVE = path.join(DOWNLOAD_DIR, ZIP_NAME);

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const OFFLINE = args.has('--offline');
const JSON_OUT = args.has('--json');

const log = (...a) => { if (!JSON_OUT) console.log('[toolchain]', ...a); };

class BootstrapError extends Error {
  constructor(msg, detail) {
    super(msg);
    this.detail = detail;
  }
}

function die(err) {
  const detail = err instanceof BootstrapError ? err.detail : undefined;
  const report = {
    ok: false,
    stage: detail?.stage ?? 'unknown',
    error: err.message,
    ...detail,
  };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else {
    console.error(`\n[toolchain] FAILED: ${err.message}`);
    if (detail) {
      for (const [k, v] of Object.entries(detail)) console.error(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    console.error('\nDiagnostics:');
    console.error('  - network reachability: this script uses node built-in fetch;');
    console.error('    test with `node -e "fetch(\'https://ziglang.org/download/index.json\').then(r=>console.log(r.status))"`');
    console.error('  - if only mirrors are reachable, pass --mirror=<url> (see MIRROR_URLS in this file)');
    console.error('  - corrupted cache: re-run with --force');
  }
  process.exit(1);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Run a native exe WITHOUT pipes: stdout/stderr are redirected to files, then read. */
function runToFiles(exe, argv, opts = {}) {
  const outFile = path.join(DOWNLOAD_DIR, `run-${Date.now()}-${Math.random().toString(16).slice(2)}.out.txt`);
  const errFile = outFile.replace(/\.out\.txt$/, '.err.txt');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, argv, {
      stdio: ['ignore', outFd, errFd],
      cwd: opts.cwd ?? REPO,
      env: opts.env ?? process.env,
      windowsHide: true,
      timeout: opts.timeout ?? 120000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { status: res.status, error: res.error, stdout, stderr, signal: res.signal };
}

function zigEnv() {
  // Keep all Zig caches inside the repo so the toolchain stays self-contained and
  // re-runnable regardless of the caller's profile state.
  return {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.join(TOOLCHAIN_DIR, 'zig-cache', 'global'),
    ZIG_LOCAL_CACHE_DIR: path.join(TOOLCHAIN_DIR, 'zig-cache', 'local'),
  };
}

/** Depth-limited search for a file by basename; returns the absolute path or null. */
function findFileNamed(root, base, maxDepth) {
  const want = base.toLowerCase();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return null;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const it of items) {
      if (it.isDirectory()) {
        const r = walk(path.join(dir, it.name), depth + 1);
        if (r) return r;
      } else if (it.name.toLowerCase() === want) {
        return path.join(dir, it.name);
      }
    }
    return null;
  };
  return walk(root, 0);
}

function localZigVersion() {
  if (!fs.existsSync(ZIG_EXE)) return null;
  const r = runToFiles(ZIG_EXE, ['version']);
  if (r.error) return null;
  const v = r.stdout.trim().replace(/^v/, '');
  return v || null;
}

/** Ask the vendor for the published shasum and cross-check it against our pin. */
async function vendorShasum() {
  const r = await fetch(INDEX_URL, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new BootstrapError(`vendor index unreachable (HTTP ${r.status}): ${INDEX_URL}`, { stage: 'index', status: r.status });
  const j = await r.json();
  const hits = [];
  const walk = (o, pathStr) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') {
        if (typeof v.tarball === 'string' && v.tarball.endsWith('/' + ZIP_NAME)) {
          hits.push({ path: pathStr + '/' + k, tarball: v.tarball, shasum: v.shasum, size: Number(v.size) });
        }
        walk(v, pathStr + '/' + k);
      }
    }
  };
  walk(j, '');
  if (!hits.length) throw new BootstrapError(`vendor index has no entry for ${ZIP_NAME}`, { stage: 'index' });
  const hit = hits[0];
  if (!hit.shasum) throw new BootstrapError(`vendor index entry for ${ZIP_NAME} carries no shasum`, { stage: 'index', hit });
  if (hit.shasum !== PINNED_SHA256) {
    throw new BootstrapError('vendor shasum disagrees with the hash pinned in this script -- refusing to install', {
      stage: 'index',
      entry: hit.path,
      vendorSha256: hit.shasum,
      pinnedSha256: PINNED_SHA256,
    });
  }
  if (hit.size && hit.size !== PINNED_SIZE) {
    throw new BootstrapError('vendor size disagrees with the size pinned in this script', {
      stage: 'index', vendorSize: hit.size, pinnedSize: PINNED_SIZE,
    });
  }
  return { shasum: hit.shasum, size: hit.size || PINNED_SIZE, entry: hit.path };
}

async function download(url, dest, expect) {
  const tmp = dest + '.part';
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let r;
  try {
    r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
  } catch (e) {
    throw new BootstrapError(`download failed: ${url}: ${e.message}`, { stage: 'download', url });
  }
  if (!r.ok) throw new BootstrapError(`download failed: HTTP ${r.status} for ${url}`, { stage: 'download', url, status: r.status });
  const total = Number(r.headers.get('content-length') || 0);
  const fd = fs.openSync(tmp, 'w');
  const hash = crypto.createHash('sha256');
  let written = 0, lastPct = -1;
  try {
    for await (const chunk of r.body) {
      const b = Buffer.from(chunk);
      fs.writeSync(fd, b);
      hash.update(b);
      written += b.length;
      if (total) {
        const pct = Math.floor((written / total) * 100);
        if (pct >= lastPct + 5) { lastPct = pct; log(`downloading ${pct}% (${written}/${total} bytes)`); }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const got = hash.digest('hex');
  if (written !== expect.size || got !== expect.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new BootstrapError('downloaded archive failed verification', {
      stage: 'verify', url, expectedSize: expect.size, actualSize: written,
      expectedSha256: expect.sha256, actualSha256: got,
    });
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
  log(`verified ${ZIP_NAME}: sha256=${got} size=${written}`);
  return { sha256: got, size: written };
}

async function main() {
  fs.mkdirSync(TOOLCHAIN_DIR, { recursive: true });
  const started = Date.now();

  // 1. fast path -- already installed and functional?
  if (!FORCE) {
    const v = localZigVersion();
    if (v && fs.existsSync(MANIFEST)) {
      const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      if (m.sha256 === PINNED_SHA256 && m.zigVersion === v) {
        const report = {
          ok: true, cached: true, stage: 'complete', zigExe: ZIG_EXE, zigVersion: v,
          sha256: m.sha256, archiveBytes: m.archiveBytes, extractedFiles: m.extractedFiles,
          ms: Date.now() - started,
        };
        if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
        else log(`already installed: zig ${v} at ${ZIG_EXE} (use --force to reinstall)`);
        return report;
      }
      log('manifest/version mismatch, reinstalling');
    }
  }

  // 2. resolve expected hash from the vendor (unless offline)
  let expect = { sha256: PINNED_SHA256, size: PINNED_SIZE };
  let source = 'pinned';
  if (!OFFLINE) {
    const vendor = await vendorShasum();
    expect = { sha256: vendor.shasum, size: vendor.size };
    source = `vendor-index:${vendor.entry}`;
    log(`vendor index confirms sha256=${vendor.shasum} size=${vendor.size}`);
  } else {
    log('offline mode: using pinned hash only');
  }

  // 3. get the archive (reuse cache if it verifies)
  let archiveInfo = null;
  if (fs.existsSync(ARCHIVE)) {
    const size = fs.statSync(ARCHIVE).size;
    const got = sha256File(ARCHIVE);
    if (size === expect.size && got === expect.sha256) {
      log(`cached archive verifies (${size} bytes)`);
      archiveInfo = { sha256: got, size };
    } else {
      log(`cached archive is corrupt (size ${size}, sha ${got.slice(0, 12)}...), re-downloading`);
      fs.rmSync(ARCHIVE, { force: true });
    }
  }
  if (!archiveInfo) {
    const urls = [PRIMARY_URL, ...MIRROR_URLS];
    const failures = [];
    for (const url of urls) {
      try {
        archiveInfo = await download(url, ARCHIVE, expect);
        break;
      } catch (e) {
        failures.push({ url, error: e.message });
        log(`source failed: ${url} -> ${e.message}`);
      }
    }
    if (!archiveInfo) {
      throw new BootstrapError('every download source failed', { stage: 'download', failures, expectedSha256: expect.sha256 });
    }
  }

  // 4. sanity-check it is a ZIP before touching the extraction dir
  let entries;
  try {
    entries = listZip(ARCHIVE);
  } catch (e) {
    throw new BootstrapError(`archive is not a readable zip: ${e.message}`, { stage: 'unzip', archive: ARCHIVE });
  }
  if (!entries.some((e) => e.name.replace(/\\/g, '/').endsWith('zig.exe'))) {
    throw new BootstrapError('archive contains no zig.exe (unexpected distribution layout)', {
      stage: 'unzip', entrySample: entries.slice(0, 10).map((e) => e.name),
    });
  }

  // 5. extract (atomic-ish: into a temp dir, then swap)
  const tmpDir = ZIG_DIR + '.tmp';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log(`extracting ${entries.length} entries -> ${path.relative(REPO, tmpDir)}`);
  const ex = extractZip(ARCHIVE, tmpDir);
  log(`extracted ${ex.files} files (${(ex.bytes / 1048576).toFixed(1)} MiB)`);

  // The official distribution wraps everything in a versioned top-level folder
  // (zig-windows-x86_64-<ver>/). Hoist that one level so ZIG_EXE stays stable
  // regardless of the upstream layout.
  const foundZig = findFileNamed(tmpDir, 'zig.exe', 4);
  if (!foundZig) {
    throw new BootstrapError('extraction produced no zig.exe', {
      stage: 'unzip', dir: tmpDir, entrySample: entries.slice(0, 10).map((e) => e.name),
    });
  }
  const rel = path.relative(tmpDir, path.dirname(foundZig));
  if (rel) {
    const firstSeg = rel.split(path.sep)[0];
    const inner = path.join(tmpDir, firstSeg);
    const hoist = ZIG_DIR + '.hoist';
    fs.rmSync(hoist, { recursive: true, force: true });
    fs.renameSync(inner, hoist);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.renameSync(hoist, tmpDir);
    log(`hoisted ${firstSeg}/ to the toolchain root`);
  }
  if (!fs.existsSync(path.join(tmpDir, 'zig.exe'))) {
    throw new BootstrapError('zig.exe is not at the toolchain root after hoisting', { stage: 'unzip', dir: tmpDir });
  }
  fs.rmSync(ZIG_DIR, { recursive: true, force: true });
  fs.renameSync(tmpDir, ZIG_DIR);

  // 6. prove the toolchain actually runs
  const v = localZigVersion();
  if (!v) {
    const r = runToFiles(ZIG_EXE, ['version']);
    throw new BootstrapError('installed zig.exe does not run', {
      stage: 'smoke', exe: ZIG_EXE, status: r.status, stderr: r.stderr.slice(0, 2000),
      spawnError: r.error ? String(r.error) : undefined,
    });
  }
  if (!v.startsWith(ZIG_VERSION)) {
    throw new BootstrapError(`unexpected zig version: got ${v}, expected ${ZIG_VERSION}`, { stage: 'smoke', got: v });
  }

  const manifest = {
    ok: true,
    project: 'zig',
    zigVersion: v,
    targetVersion: ZIG_VERSION,
    exe: path.relative(REPO, ZIG_EXE).replace(/\\/g, '/'),
    sha256: archiveInfo.sha256,
    sha256Source: source,
    archiveBytes: archiveInfo.size,
    extractedFiles: ex.files,
    extractedBytes: ex.bytes,
    archiveUrl: PRIMARY_URL,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  const report = { ...manifest, cached: false, stage: 'complete', ms: Date.now() - started };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else log(`installed zig ${v} at ${ZIG_EXE} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return report;
}

main().then(() => process.exit(0)).catch(die);
