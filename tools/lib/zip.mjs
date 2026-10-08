// Minimal, dependency-free ZIP reader/writer-free extractor.
// Used by tools/fetch-toolchain.mjs to unpack the official zig .zip distribution
// without shelling out (PowerShell pipes around native exes are unreliable here,
// and no unzip/7z/tar is guaranteed present).
//
// Supports: stored (0) and deflate (8) entries, ZIP64 EOCD locator,
// path-traversal rejection. Not supported: encryption, multi-disk, zstd/bzip2.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD_LOC = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;

/** Read the last `max` bytes of a file (EOCD lives at the tail). */
function readTail(fd, size, max) {
  const len = Math.min(max, size);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  return buf;
}

function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parse the central directory.
 * @returns {{name:string, method:number, compSize:number, uncompSize:number, localOffset:number, crc:number, isDir:boolean}[]}
 */
export function listZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = readTail(fd, size, 66 * 1024);
    const eocdIdx = findEocd(tail);
    if (eocdIdx < 0) throw new Error(`not a zip (no EOCD signature in last 64KiB): ${zipPath}`);
    let cdCount = tail.readUInt16LE(eocdIdx + 10);
    let cdSize = tail.readUInt32LE(eocdIdx + 12);
    let cdOffset = tail.readUInt32LE(eocdIdx + 16);

    // ZIP64 promotion: look for the locator 20 bytes before EOCD.
    const locIdx = eocdIdx - 20;
    if (locIdx >= 0 && tail.readUInt32LE(locIdx) === SIG_Z64_EOCD_LOC) {
      const z64Off = Number(tail.readBigUInt64LE(locIdx + 8));
      const hdr = Buffer.alloc(56);
      fs.readSync(fd, hdr, 0, 56, z64Off);
      if (hdr.readUInt32LE(0) !== SIG_Z64_EOCD) throw new Error('bad ZIP64 EOCD');
      cdCount = Number(hdr.readBigUInt64LE(32));
      cdSize = Number(hdr.readBigUInt64LE(40));
      cdOffset = Number(hdr.readBigUInt64LE(48));
    }

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let n = 0; n < cdCount; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CDH) {
        throw new Error(`central directory entry ${n} is malformed at offset ${p}`);
      }
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      // ZIP64 extended info: 0xFFFFFFFF placeholders in the fixed fields.
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const sz = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(r)); r += 8; }
          }
          q += 4 + sz;
        }
      }
      entries.push({ name, method, crc, compSize, uncompSize, localOffset, isDir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function safeJoin(destDir, name) {
  const norm = name.replace(/\\/g, '/');
  const resolved = path.resolve(destDir, norm);
  const root = path.resolve(destDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`zip entry escapes destination: ${name}`);
  }
  return resolved;
}

/**
 * Extract all entries.
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{onProgress?:(done:number,total:number,name:string)=>void}} [opts]
 * @returns {{files:number, dirs:number, bytes:number}}
 */
export function extractZip(zipPath, destDir, opts = {}) {
  const entries = listZip(zipPath);
  fs.mkdirSync(destDir, { recursive: true });
  const whole = fs.readFileSync(zipPath);
  let files = 0, dirs = 0, bytes = 0;
  {
    let i = 0;
    for (const e of entries) {
      i++;
      opts.onProgress?.(i, entries.length, e.name);
      const target = safeJoin(destDir, e.name);
      if (e.isDir) {
        fs.mkdirSync(target, { recursive: true });
        dirs++;
        continue;
      }
      const lh = e.localOffset;
      if (whole.readUInt32LE(lh) !== SIG_LFH) throw new Error(`bad local header for ${e.name}`);
      const nameLen = whole.readUInt16LE(lh + 26);
      const extraLen = whole.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + nameLen + extraLen;
      const comp = whole.subarray(dataStart, dataStart + e.compSize);
      let out;
      if (e.method === 0) out = comp;
      else if (e.method === 8) out = zlib.inflateRawSync(comp);
      else throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
      if (out.length !== e.uncompSize) {
        throw new Error(`size mismatch for ${e.name}: expected ${e.uncompSize}, got ${out.length}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      files++;
      bytes += out.length;
    }
  }
  return { files, dirs, bytes };
}
