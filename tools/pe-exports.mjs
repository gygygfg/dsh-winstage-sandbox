#!/usr/bin/env node
// Minimal PE parser used instead of dumpbin (which does not exist on this
// machine). Reports the machine type, DLL flag, and the export table.
//
// Usage:
//   node tools/pe-exports.mjs <file.dll|exe> [--json] [--require a,b,c]

import fs from 'node:fs';

const MACHINE = {
  0x014c: 'i386',
  0x8664: 'x86_64',
  0xaa64: 'arm64',
};

export function parsePe(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${file}: not a PE file (bad MZ signature)`);
  }
  const eLfanew = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(eLfanew) !== 0x00004550) {
    throw new Error(`${file}: bad PE signature`);
  }
  const coff = eLfanew + 4;
  const machine = buf.readUInt16LE(coff);
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const is64 = magic === 0x20b;
  if (magic !== 0x20b && magic !== 0x10b) {
    throw new Error(`${file}: unsupported optional header magic 0x${magic.toString(16)}`);
  }
  const dataDirOffset = opt + (is64 ? 112 : 96);
  const sectionTable = opt + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections; i++) {
    const s = sectionTable + i * 40;
    sections.push({
      name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      sizeOfRawData: buf.readUInt32LE(s + 16),
      pointerToRawData: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.sizeOfRawData);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        return s.pointerToRawData + (rva - s.virtualAddress);
      }
    }
    return -1;
  };

  const info = {
    file,
    machine: MACHINE[machine] || `0x${machine.toString(16)}`,
    machineRaw: machine,
    is64,
    isDll: (characteristics & 0x2000) !== 0,
    sections: sections.map((s) => s.name),
    exports: [],
    exportDllName: null,
    importDlls: [],
  };

  // Export directory is data directory entry 0.
  const expRva = buf.readUInt32LE(dataDirOffset + 0);
  const expSize = buf.readUInt32LE(dataDirOffset + 4);
  if (expRva && expSize) {
    const d = rvaToOffset(expRva);
    if (d < 0) throw new Error(`${file}: export directory RVA 0x${expRva.toString(16)} is not mapped`);
    const nameRva = buf.readUInt32LE(d + 12);
    const numberOfNames = buf.readUInt32LE(d + 24);
    const addressOfNames = buf.readUInt32LE(d + 32);
    const addressOfNameOrdinals = buf.readUInt32LE(d + 36);
    if (nameRva) {
      const n = rvaToOffset(nameRva);
      info.exportDllName = buf.toString('latin1', n, buf.indexOf(0, n));
    }
    const namesOff = rvaToOffset(addressOfNames);
    const ordsOff = rvaToOffset(addressOfNameOrdinals);
    for (let i = 0; i < numberOfNames; i++) {
      const nr = buf.readUInt32LE(namesOff + i * 4);
      const off = rvaToOffset(nr);
      const end = buf.indexOf(0, off);
      info.exports.push(buf.toString('latin1', off, end));
    }
    // Keep ordinal order deterministic and readable.
    info.exports.sort();
  }

  // Import directory is data directory entry 1 -- used to show which libraries
  // the artefact actually depends on (evidence for the deployment story).
  const impRva = buf.readUInt32LE(dataDirOffset + 8);
  if (impRva) {
    let d = rvaToOffset(impRva);
    while (d > 0) {
      const nameRva = buf.readUInt32LE(d + 12);
      if (!nameRva) break;
      const n = rvaToOffset(nameRva);
      info.importDlls.push(buf.toString('latin1', n, buf.indexOf(0, n)));
      d += 20;
    }
  }
  return info;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const requireIdx = args.indexOf('--require');
  const required = requireIdx >= 0 && args[requireIdx + 1] ? args[requireIdx + 1].split(',').filter(Boolean) : [];
  const asJson = args.includes('--json');
  if (!files.length) {
    console.error('usage: node tools/pe-exports.mjs <file> [--json] [--require a,b,c]');
    process.exit(2);
  }
  let failed = false;
  const results = [];
  for (const f of files) {
    try {
      const info = parsePe(f);
      results.push(info);
      if (!asJson) {
        console.log(`== ${f}`);
        console.log(`   machine=${info.machine} is64=${info.is64} isDll=${info.isDll} sections=[${info.sections.join(',')}]`);
        console.log(`   imports: ${info.importDlls.join(', ') || '(none)'}`);
        console.log(`   exports(${info.exports.length}): ${info.exports.join(', ') || '(none)'}`);
      }
      for (const r of required) {
        if (!info.exports.includes(r)) {
          console.error(`   MISSING required export: ${r}`);
          failed = true;
        }
      }
    } catch (e) {
      console.error(`parse failed: ${e.message}`);
      failed = true;
    }
  }
  if (asJson) console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('pe-exports.mjs')) {
  main();
}
