#!/usr/bin/env node
// WinStageSandbox T4 -- minimal closed-loop evidence for the shim.
//
// Proves, end to end and with artifacts on disk:
//   E1  the DLL exists, is a valid x64 PE32+ DLL, and exports the shim ABI;
//       a short-lived process can load it and reports initialized=true.
//   E2  after injection, a target process writes an out-of-bounds path
//       (C:\Windows\Temp\winstage-shim-probe.txt) and the API RETURNS SUCCESS,
//       while the real path stays absent and the staging tree receives the file.
//   E3  after injection, the *real, unmodified* Windows binary reg.exe runs
//       `reg add HKCU\Software\WinstageShimProbe` and reports success, while the
//       real hive is unchanged and the overlay contains the value.
//   E4  fail-closed: with the staging subtree broken, a write fails with
//       ERROR_ACCESS_DENIED and the real system is still untouched.
//   E5  overlay read-back (file + registry) and read-through of a real file.
//
// Everything is re-runnable; all probe artifacts are cleaned up. Native
// processes are launched with output redirected to FILES (never pipes).
//
// Usage: node tools/run-shim-closedloop.mjs [--json] [--keep-stage]
//
// Exit codes: 0 = all checks passed, 1 = a product check failed, 2 = unexpected
// error, 3 = environment unavailable (missing/corrupt shim artifact; reported by
// the preflight, never counted as a product check failure).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePe } from './pe-exports.mjs';
import { artifactNames, checkArtifactIntegrity } from './build-shim.mjs';
import { createRegistryStage, decodeJournalRecords } from '../src/registry-stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = process.env.WINSTAGE_SHIM_OUT ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : path.join(REPO, 'shim', 'out');
const DLL = path.join(OUT, 'winstage-shim.dll');
const INJECTOR = path.join(OUT, 'winstage-inject.exe');
const PROBE = path.join(OUT, 'winstage-probe.exe');
const REGEXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
const STAGE = path.join(REPO, 'shim', '.stage', `run-${RUN_ID}`);
const EVIDENCE = path.join(STAGE, 'evidence');
const REPORT = path.join(OUT, 'closedloop-report.json');

const PROBE_FILE = 'C:\\Windows\\Temp\\winstage-shim-probe.txt';
const PROBE_MOVED = 'C:\\Windows\\Temp\\winstage-shim-probe-moved.txt';
const PROBE_DIR = 'C:\\Windows\\Temp\\winstage-shim-probe-dir';
const FAILCLOSED_DIR = 'C:\\Windows\\Temp\\winstage-failclosed';
const FAILCLOSED_FILE = 'C:\\Windows\\Temp\\winstage-failclosed\\probe.txt';
const REG_KEY = 'Software\\WinstageShimProbe';
const REG_VALUE = 'T4Probe';

const PROBE_CONTENT = `t4-shim-probe-${RUN_ID}`;
const REG_DATA = `t4-probe-${RUN_ID}`;

const JSON_OUT = process.argv.includes('--json');
const T0 = Date.now();
const checks = [];
const evidence = {};
const ENV_UNAVAILABLE_EXIT = 3;

// Preflight: an absent winstage-inject.exe (Defender) or a truncated artifact
// would fail the checks below as if the product were broken. Reuse build-shim's
// integrity helper and fail as ENVIRONMENT (exit 3) up front.
function preflightArtifacts() {
  const rep = checkArtifactIntegrity(OUT, artifactNames('full'));
  if (!rep.ok) {
    const bad = [...rep.missing, ...rep.malformed.map((m) => m.name)];
    console.error(`ENVIRONMENT UNAVAILABLE: missing/corrupt ${bad.join(', ')}; run node tools/build-shim.mjs`);
    process.exit(ENV_UNAVAILABLE_EXIT);
  }
}

const log = (...a) => { if (!JSON_OUT) console.log('[closedloop]', ...a); };

function check(id, ok, detail) {
  checks.push({ id, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' -- ' + detail : ''}`);
  return !!ok;
}

/** Run a native exe with output to a file (no pipes: the host breaks on them). */
function runNative(exe, argv, { tag, timeout = 60000, cwd = REPO, env = process.env } = {}) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const outFile = path.join(EVIDENCE, `${tag}.stdout.txt`);
  const errFile = path.join(EVIDENCE, `${tag}.stderr.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(exe, argv, {
      stdio: ['ignore', outFd, errFd],
      cwd,
      env,
      windowsHide: true,
      timeout,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: res.status,
    signal: res.signal,
    error: res.error ? String(res.error) : null,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
    outFile,
    errFile,
    argv,
  };
}

function inject(tag, exe, args, extraSets = []) {
  const report = path.join(EVIDENCE, `${tag}.inject.json`);
  const argv = [
    '--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    ...extraSets.flatMap((s) => ['--set-env', s]),
    '--report', report,
    '--timeout-ms', '30000',
    '--',
    exe,
    ...args,
  ];
  const r = runNative(INJECTOR, argv, { tag: `${tag}.injector` });
  let injectReport = null;
  try { injectReport = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* ignored */ }
  return { ...r, injectReport, reportPath: report };
}

function probeInjected(tag, args) {
  const out = path.join(EVIDENCE, `${tag}.json`);
  const r = inject(tag, PROBE, [...args, out]);
  let probeResult = null;
  try { probeResult = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignored */ }
  return { ...r, probeResult, probePath: out };
}

/* A host-token reader for T3's createRegistryStage: reads the REAL hive with
 * reg.exe (never through the shim). An unknown value type is a hard error rather
 * than a silently-skipped value -- "unreadable" must not look like "unchanged". */
function makeRegReader() {
  return {
    read(canonical) {
      const r = runNative(REGEXE, ['query', canonical], { tag: `reader-${crypto.randomBytes(3).toString('hex')}` });
      if (r.status !== 0) {
        return { exists: false, errorCode: 2 };
      }
      const values = {};
      const subKeys = [];
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line) continue;
        if (!/^\s/.test(line)) {
          const base = line.trim();
          if (base.toLowerCase() !== canonical.toLowerCase()) subKeys.push(base.split('\\').pop());
          continue;
        }
        const m = line.match(/^\s{2,}(.*?)\s{4,}(REG_[A-Z_]+)(?:\s{0,4}(.*))?$/);
        if (!m) continue;
        const name = m[1] === '(Default)' ? '' : m[1];
        const type = m[2];
        const data = (m[3] ?? '').trim();
        if (type === 'REG_SZ' || type === 'REG_EXPAND_SZ') values[name] = { type, data };
        else if (type === 'REG_DWORD') values[name] = { type, data };
        else if (type === 'REG_BINARY') values[name] = { type, data: data.replace(/\s+/g, '') };
        else throw new Error(`reader: unsupported value type ${type} for ${name} in ${canonical}`);
      }
      return { exists: true, subKeys, values };
    },
  };
}

function regQueryReal(args) {
  return runNative(REGEXE, args, { tag: `regquery-${crypto.randomBytes(3).toString('hex')}` });
}

function regKeyExists() {
  const r = regQueryReal(['query', `HKCU\\${REG_KEY}`]);
  return r.status === 0;
}

function safeDeleteFileExact(p) {
  // Only ever called with the literal probe paths declared above.
  const allow = [
    PROBE_FILE, PROBE_MOVED, FAILCLOSED_FILE,
  ].map((s) => s.toLowerCase());
  if (!allow.includes(p.toLowerCase())) throw new Error(`refusing to delete non-probe path: ${p}`);
  if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); return true; }
  return false;
}

function rmDirExact(p) {
  const allow = [PROBE_DIR, FAILCLOSED_DIR].map((s) => s.toLowerCase());
  if (!allow.includes(p.toLowerCase())) throw new Error(`refusing to remove non-probe dir: ${p}`);
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); return true; }
  return false;
}

function main() {
  const report = {
    ok: false,
    runId: RUN_ID,
    stageRoot: STAGE,
    artifacts: { dll: DLL, injector: INJECTOR, probe: PROBE },
    preconditions: {},
    evidence,
    checks,
    cleanup: {},
    ms: 0,
  };

  // ---------------------------------------------------------------- setup
  preflightArtifacts();
  // Refuse to run if our probe names already exist: we must never delete or
  // overwrite a pre-existing object that this task did not create.
  const preExisting = [PROBE_FILE, PROBE_MOVED, PROBE_DIR, FAILCLOSED_DIR].filter((p) => fs.existsSync(p));
  report.preconditions.preExistingPaths = preExisting;
  if (preExisting.length) {
    throw new Error(`probe artifacts already exist, refusing to run: ${preExisting.join(', ')}`);
  }
  const regExistedBefore = regKeyExists();
  report.preconditions.regKeyExistedBefore = regExistedBefore;
  if (regExistedBefore) {
    throw new Error(`registry key HKCU\\${REG_KEY} already exists; refusing to touch it`);
  }

  fs.mkdirSync(EVIDENCE, { recursive: true });
  for (const sub of ['fs', 'wo', 'reg']) fs.mkdirSync(path.join(STAGE, sub), { recursive: true });
  const configPath = path.join(STAGE, 'winstage-shim.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stageRoot: STAGE,
    logPath: path.join(STAGE, 'shim.log'),
    failClosed: true,
    readThrough: true,
    verbose: false,
    traceStagedOps: true,
  }, null, 2) + '\n');

  // ------------------------------------------------------- E1: DLL + selftest
  const pe = parsePe(DLL);
  evidence.dll = {
    path: DLL,
    bytes: fs.statSync(DLL).size,
    machine: pe.machine,
    is64: pe.is64,
    isDll: pe.isDll,
    exports: pe.exports,
    imports: pe.importDlls,
  };
  const required = ['WinstageShimInit', 'WinstageShimShutdown', 'WinstageShimAbiVersion',
    'WinstageShimBindStageApi', 'WinstageShimOriginal', 'WinstageShimRefreshHooks', 'WinstageShimStatsJson'];
  check('E1.dll-pe-x64', pe.machine === 'x86_64' && pe.is64 && pe.isDll, `machine=${pe.machine} isDll=${pe.isDll}`);
  check('E1.dll-exports', required.every((r) => pe.exports.includes(r)),
    `missing=${required.filter((r) => !pe.exports.includes(r)).join(',') || 'none'}`);

  const selfOut = path.join(EVIDENCE, 'selftest.json');
  const self = runNative(PROBE, ['selftest', DLL, selfOut], {
    tag: 'selftest',
    env: { ...process.env, WINSTAGE_STAGE_ROOT: STAGE, WINSTAGE_SHIM_LOG: path.join(STAGE, 'shim.log') },
  });
  let selfJson = null;
  try { selfJson = JSON.parse(fs.readFileSync(selfOut, 'utf8')); } catch { /* ignored */ }
  evidence.selftest = { exitCode: self.status, result: selfJson, stderr: self.stderr.slice(0, 2000) };
  check('E1.selftest-loads', !!selfJson && selfJson.loaded === true && selfJson.abiVersion === 1,
    `loaded=${selfJson?.loaded} abi=${selfJson?.abiVersion}`);
  const stats = (() => { try { return JSON.parse(selfJson.statsRaw); } catch { return null; } })();
  evidence.selftestStats = stats;
  check('E1.selftest-initialized', !!stats && stats.initialized === true && stats.hooksInstalled === true && stats.hooks.iatSites > 0,
    `initialized=${stats?.initialized} iatSites=${stats?.hooks?.iatSites}`);

  // ------------------------------------------------- E2: file write redirect
  const w = probeInjected('probe-file-write', ['file-write', PROBE_FILE, PROBE_CONTENT]);
  const stagedFile = path.join(STAGE, 'fs', 'C', 'Windows', 'Temp', 'winstage-shim-probe.txt');
  evidence.fileWrite = {
    injector: w.injectReport,
    injectorExit: w.status,
    probe: w.probeResult,
    realPathExists: fs.existsSync(PROBE_FILE),
    stagedPath: stagedFile,
    stagedExists: fs.existsSync(stagedFile),
    stagedContent: fs.existsSync(stagedFile) ? fs.readFileSync(stagedFile, 'utf8') : null,
  };
  check('E2.injector-ok', w.injectReport?.ok === true, `childExit=${w.injectReport?.childExitCode}`);
  check('E2.api-returned-success', w.probeResult?.apiReturnedSuccess === true,
    `createOk=${w.probeResult?.createOk} createError=${w.probeResult?.createError}`);
  check('E2.real-path-absent', !fs.existsSync(PROBE_FILE), `real=${PROBE_FILE}`);
  check('E2.staged-file-present', fs.existsSync(stagedFile) && fs.readFileSync(stagedFile, 'utf8') === PROBE_CONTENT,
    `staged=${stagedFile}`);

  // readability by an uninjected process is not needed; read-back is done via the shim
  const r1 = probeInjected('probe-file-read', ['file-read', PROBE_FILE]);
  evidence.fileReadBack = { probe: r1.probeResult };
  check('E2.overlay-read-back', r1.probeResult?.openOk === true && r1.probeResult?.content === PROBE_CONTENT,
    `content=${r1.probeResult?.content}`);

  const r2 = probeInjected('probe-file-readthrough', ['file-read', 'C:\\Windows\\win.ini']);
  evidence.fileReadThrough = { probe: r2.probeResult };
  check('E5.read-through-real-file', r2.probeResult?.openOk === true && (r2.probeResult?.bytesRead ?? 0) > 0,
    `bytes=${r2.probeResult?.bytesRead}`);

  // ------------------------------------- E2b: directory / move / delete / whiteout
  const d1 = probeInjected('probe-dir-create', ['dir-create', PROBE_DIR]);
  evidence.dirCreate = { probe: d1.probeResult, realExists: fs.existsSync(PROBE_DIR), stagedExists: fs.existsSync(path.join(STAGE, 'fs', 'C', 'Windows', 'Temp', 'winstage-shim-probe-dir')) };
  check('E2b.dir-create-staged', d1.probeResult?.createOk === true && !fs.existsSync(PROBE_DIR) && evidence.dirCreate.stagedExists,
    `createError=${d1.probeResult?.createError}`);

  const m1 = probeInjected('probe-move', ['move', PROBE_FILE, PROBE_MOVED]);
  const stagedMoved = path.join(STAGE, 'fs', 'C', 'Windows', 'Temp', 'winstage-shim-probe-moved.txt');
  evidence.move = {
    probe: m1.probeResult,
    realSrcExists: fs.existsSync(PROBE_FILE),
    realDstExists: fs.existsSync(PROBE_MOVED),
    stagedSrcExists: fs.existsSync(stagedFile),
    stagedDstExists: fs.existsSync(stagedMoved),
  };
  check('E2b.move-redirected', m1.probeResult?.moveOk === true && fs.existsSync(stagedMoved) && !fs.existsSync(stagedFile) && !fs.existsSync(PROBE_MOVED),
    `moveError=${m1.probeResult?.moveError}`);

  const del1 = probeInjected('probe-file-delete', ['file-delete', PROBE_MOVED]);
  const woMarker = path.join(STAGE, 'wo', 'C', 'Windows', 'Temp', 'winstage-shim-probe-moved.txt');
  evidence.delete = {
    probe: del1.probeResult,
    stagedStillExists: fs.existsSync(stagedMoved),
    whiteoutMarker: woMarker,
    whiteoutExists: fs.existsSync(woMarker),
    realExists: fs.existsSync(PROBE_MOVED),
  };
  check('E2b.delete-whiteout', del1.probeResult?.deleteOk === true && !fs.existsSync(stagedMoved) && fs.existsSync(woMarker),
    `deleteError=${del1.probeResult?.deleteError}`);

  const r3 = probeInjected('probe-file-read-after-delete', ['file-read', PROBE_MOVED]);
  evidence.readAfterDelete = { probe: r3.probeResult };
  check('E2b.whiteout-hides-object', r3.probeResult?.openOk === false && r3.probeResult?.openError === 2,
    `openError=${r3.probeResult?.openError} (2 = ERROR_FILE_NOT_FOUND)`);

  evidence.stageTree = listTree(STAGE);

  // ------------------------------------------------ E3: registry via reg.exe
  const regAdd = runNative(INJECTOR, [
    '--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    '--report', path.join(EVIDENCE, 'regadd.inject.json'),
    '--timeout-ms', '30000',
    '--',
    REGEXE, 'add', `HKCU\\${REG_KEY}`, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', REG_DATA, '/f',
  ], { tag: 'regadd' });
  if (!fs.existsSync(regAdd.outFile)) {
    fs.writeFileSync(regAdd.outFile, '');
  }
  let regAddInject = null;
  try { regAddInject = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'regadd.inject.json'), 'utf8')); } catch { /* ignored */ }

  // The overlay for the registry is T3's WAL, not a per-key file. Decode it with
  // T3's own decoder so the two sides cannot drift apart.
  const journalPath = path.join(STAGE, 'registry', 'overlay.journal');
  const journalBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0;
  let journalRecords = [];
  let journalDecodeError = null;
  try {
    if (journalBytes) {
      const decoded = decodeJournalRecords(fs.readFileSync(journalPath));
      journalRecords = decoded.records;
      if (decoded.torn) journalDecodeError = 'journal has a torn tail';
    }
  } catch (e) {
    journalDecodeError = `${e.code || 'error'}: ${e.message}`;
  }
  const setValueRecord = journalRecords.find((r) => r.kindName === 'SET_VALUE' &&
    /WinstageShimProbe$/i.test(r.path) && r.valueName === REG_VALUE);
  const realKeyNow = regKeyExists();
  evidence.regAdd = {
    injector: regAddInject,
    regExeExitCode: regAdd.status,
    regExeStdout: regAdd.stdout,
    regExeStderr: regAdd.stderr,
    realKeyExistsAfter: realKeyNow,
    journalPath,
    journalBytes,
    journalDecodeError,
    journalRecords,
    setValueRecord,
  };
  check('E3.injector-ok', regAddInject?.ok === true, `childExit=${regAddInject?.childExitCode}`);
  // ASCII-only on purpose: an earlier batch-encoding script ate the non-ASCII
  // alternative in this literal (`/?|successfully/i`) which made the whole module
  // fail to load. Never put non-ASCII inside a regex literal or a source string.
  //
  // IMPORTANT -- the predicate must be LOCALE-INDEPENDENT. On a Chinese-locale
  // Windows the localized `reg.exe` prints its success line in Chinese, so the old
  // English-text requirement (`/completed successfully|operation completed/i`) made
  // this check fail spuriously even though the exit code was 0. "The add succeeded"
  // is proven by the exit code plus two locale-free assertions that already exist:
  //   * E3.real-hive-unchanged    -- the real hive was NOT touched
  //   * E3.journal-has-set-value  -- the overlay journal recorded the SET_VALUE
  // (Do not compare stdout text here: this file must stay ASCII-only in source.)
  check('E3.reg-add-success', regAdd.status === 0,
    `exit=${regAdd.status} stdout=${JSON.stringify(regAdd.stdout.slice(0, 120))}`);
  check('E3.real-hive-unchanged', realKeyNow === false, `HKCU\\${REG_KEY} present=${realKeyNow}`);
  check('E3.journal-grew', journalBytes > 0 && !journalDecodeError,
    `journal=${journalBytes} bytes, decodeError=${journalDecodeError}`);
  check('E3.journal-has-set-value',
    !!setValueRecord && setValueRecord.typeName === 'REG_SZ' && !!setValueRecord.data,
    setValueRecord ? `path=${setValueRecord.path} name=${setValueRecord.valueName} type=${setValueRecord.typeName} data=${setValueRecord.data}` : 'no SET_VALUE record for the probe value');
  check('E3.no-bare-root-create-key',
    !journalRecords.some((r) => r.kindName === 'CREATE_KEY' && !/\\/.test(r.path)),
    `bare-root CREATE_KEY records: ${journalRecords.filter((r) => r.kindName === 'CREATE_KEY' && !/\\/.test(r.path)).map((r) => r.path).join(',') || 'none'}`);

  const rr = probeInjected('probe-reg-read', ['reg-read', 'HKCU', REG_KEY, REG_VALUE]);
  evidence.regReadBack = { probe: rr.probeResult };
  check('E5.registry-read-back',
    rr.probeResult?.openRc === 0 && rr.probeResult?.queryRc === 0 && rr.probeResult?.data === REG_DATA &&
    rr.probeResult?.type === 1 && rr.probeResult?.allCallsSucceeded === true,
    `openRc=${rr.probeResult?.openRc} queryRc=${rr.probeResult?.queryRc} data=${rr.probeResult?.data} allCallsSucceeded=${rr.probeResult?.allCallsSucceeded}`);

  // A value that was never staged must be reported as MISSING through the shim.
  // This is the anti-"empty result is not a rejection" assertion: a mutation that
  // breaks the read path makes this check red (verified by E7 below, which
  // breaks the staging write path and requires the write to fail).
  const miss = probeInjected('probe-reg-read-missing', ['reg-read', 'HKCU', REG_KEY, 'T4DefinitelyAbsentValue']);
  evidence.regReadMissing = { probe: miss.probeResult };
  // ------------------------- E9: the HOST can consume the WAL and freeze a candidate
  // This is the closure that matters: if the host cannot turn the staged write into
  // a candidate, "the sandbox said success" never reaches the approval panel.
  let hostStageResult = null;
  let hostCandidate = null;
  let hostError = null;
  try {
    const stage = createRegistryStage({
      sessionDir: STAGE,
      sessionId: 't4-closedloop',
      reader: makeRegReader(),
      workspaceRoot: REPO,
    });
    const opened = stage.open();
    const diff = stage.diff();
    const frozen = stage.freezeCandidate();
    hostStageResult = {
      opened: { resumedRecords: opened.resumedRecords, torn: opened.torn },
      diff: { changes: diff.changes?.length ?? 0, roots: diff.roots ?? null, unreadable: diff.unreadable ?? null },
      enqueued: frozen?.enqueued === true,
      reason: frozen?.reason ?? null,
      changePaths: (frozen?.candidate?.changes ?? []).map((c) => `${c.path}|${c.op}|${c.diffKind ?? ''}`),
    };
    hostCandidate = frozen?.candidate ?? null;
  } catch (e) {
    hostError = `${e.code || 'error'}: ${e.message}`;
  }
  evidence.hostCandidate = { result: hostStageResult, error: hostError, candidateSummary: hostCandidate?.summary ?? null };
  check('E9.host-can-freeze-candidate',
    !!hostStageResult && hostStageResult.enqueued === true &&
    hostStageResult.changePaths.some((p) => /WinstageShimProbe/i.test(p) && /T4Probe/i.test(p)),
    hostError ? `error=${hostError}` : `enqueued=${hostStageResult?.enqueued} changes=${hostStageResult?.changePaths?.join(' ; ')}`);

  check('E6.overlay-miss-is-a-failure',
    miss.probeResult?.openRc === 0 && miss.probeResult?.queryRc !== 0 && miss.probeResult?.allCallsSucceeded === false,
    `queryRc=${miss.probeResult?.queryRc} (2 = ERROR_FILE_NOT_FOUND) allCallsSucceeded=${miss.probeResult?.allCallsSucceeded}`);

  // ------------------------------------------------------------ E4 fail-closed
  const brokenParent = path.join(STAGE, 'fs', 'C', 'Windows', 'Temp', 'winstage-failclosed');
  fs.writeFileSync(brokenParent, 'this file stands in for a directory so that staging cannot create the parent\n');
  const fc = probeInjected('probe-failclosed', ['file-write', FAILCLOSED_FILE, 'must-not-land']);
  evidence.failClosed = {
    probe: fc.probeResult,
    brokenParent,
    realDirExists: fs.existsSync(FAILCLOSED_DIR),
    realFileExists: fs.existsSync(FAILCLOSED_FILE),
  };
  check('E4.fail-closed-denied', fc.probeResult?.createOk === false && fc.probeResult?.createError === 5,
    `createOk=${fc.probeResult?.createOk} createError=${fc.probeResult?.createError} (5 = ERROR_ACCESS_DENIED)`);
  check('E4.real-system-untouched', !fs.existsSync(FAILCLOSED_DIR) && !fs.existsSync(FAILCLOSED_FILE),
    `realDir=${fs.existsSync(FAILCLOSED_DIR)}`);
  fs.rmSync(brokenParent, { force: true });

  // ------------------------------- E7: registry write path is load-bearing
  // Mutation proof: make the WAL unwritable, then require reg.exe to FAIL and the
  // real hive to stay untouched. If E3 and E7 are both green, the staging layer is
  // genuinely what makes the write "succeed".
  const journalDir = path.join(STAGE, 'registry');
  const journalFile = path.join(journalDir, 'overlay.journal');
  const journalBackup = path.join(journalDir, 'overlay.journal.bak');
  fs.renameSync(journalFile, journalBackup);
  fs.mkdirSync(journalFile); /* a directory where the WAL file must be */
  const broken = runNative(INJECTOR, [
    '--dll', DLL,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    '--report', path.join(EVIDENCE, 'regadd-broken.inject.json'),
    '--timeout-ms', '30000',
    '--',
    REGEXE, 'add', `HKCU\\${REG_KEY}`, '/v', 'T4MutationProbe', '/t', 'REG_SZ', '/d', 'must-not-land', '/f',
  ], { tag: 'regadd-broken' });
  const mutationRealKey = regKeyExists();
  evidence.regWriteMutation = {
    regExeExitCode: broken.status,
    regExeStdout: broken.stdout,
    regExeStderr: broken.stderr,
    realKeyExists: mutationRealKey,
  };
  check('E7.reg-write-fail-closed', broken.status !== 0,
    `reg.exe exit=${broken.status} stdout=${JSON.stringify(broken.stdout.slice(0, 120))}`);
  check('E7.mutation-real-hive-unchanged', mutationRealKey === false, `HKCU\\${REG_KEY} present=${mutationRealKey}`);
  fs.rmSync(journalFile, { recursive: true, force: true });
  fs.renameSync(journalBackup, journalFile);

  // ---------------------------------- E8: carrier gate (real runtimes start)
  // Every shell command in this project is a PowerShell/node child, so "the shim
  // does not break the runtime" is a hard prerequisite. Historically:
  //   node   -> WSAStartup 10107 (RegQueryValueExA forwarded to the W API)
  //   ps     -> InitialSessionState / 0x80131623 (CONOUT$ staged, no file CoW)
  const carriers = [
    { id: 'cmd', exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/c', 'echo OK'], expect: /OK/ },
    { id: 'node', exe: process.execPath, args: ['-e', "process.stdout.write('NODEOK')"], expect: /NODEOK/ },
    { id: 'powershell', exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-Command', "Write-Output ('PSOK'+(1+1))"], expect: /PSOK2/ },
  ];
  evidence.carriers = [];
  for (const c of carriers) {
    const r = inject(`carrier-${c.id}`, c.exe, c.args);
    const ok = r.status === 0 && c.expect.test(r.stdout);
    evidence.carriers.push({ id: c.id, ok, exitCode: r.status, stdout: r.stdout.slice(0, 120), stderr: r.stderr.slice(0, 200) });
    check(`E8.carrier-${c.id}`, ok, `exit=${r.status} out=${JSON.stringify(r.stdout.slice(0, 40))} err=${JSON.stringify(r.stderr.slice(0, 80))}`);
  }

  // ---------------------------------------------------------------- cleanup
  const cleanup = {};
  cleanup.deletedRealProbeFile = safeDeleteFileExact(PROBE_FILE);
  cleanup.deletedRealMovedFile = safeDeleteFileExact(PROBE_MOVED);
  cleanup.deletedRealFailclosedDir = rmDirExact(FAILCLOSED_DIR);
  cleanup.deletedRealProbeDir = rmDirExact(PROBE_DIR);
  cleanup.regKeyExistedBefore = regExistedBefore;
  cleanup.regKeyExistsAfter = regKeyExists();
  if (cleanup.regKeyExistsAfter && !regExistedBefore) {
    const del = runNative(REGEXE, ['delete', `HKCU\\${REG_KEY}`, '/f'], { tag: 'regdelete-cleanup' });
    cleanup.regDeleteExit = del.status;
    cleanup.regKeyExistsAfterDelete = regKeyExists();
  }
  cleanup.removedStagingTree = false;
  if (!process.argv.includes('--keep-stage')) {
    // Keep the evidence copies, drop the staging tree itself.
    const keep = path.join(OUT, 'closedloop-evidence-latest.json');
    fs.writeFileSync(keep, JSON.stringify({ stageRoot: STAGE, evidence, checks }, null, 2) + '\n');
    cleanup.evidenceCopy = keep;
    cleanup.removedStagingTree = true;
    cleanup.stageRootRemoved = STAGE;
  }
  report.cleanup = cleanup;
  report.ok = checks.every((c) => c.ok);
  report.ms = Date.now() - T0;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');

  if (!process.argv.includes('--keep-stage')) {
    fs.rmSync(STAGE, { recursive: true, force: true });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(`\n${report.ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length}) in ${report.ms} ms`);
    log(`report: ${REPORT}`);
    if (!report.ok) {
      for (const c of checks.filter((x) => !x.ok)) log(`  FAILED ${c.id}: ${c.detail}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

function listTree(root, max = 200) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= max) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      const r = path.join(rel, it.name);
      if (it.isDirectory()) {
        out.push(r + '/');
        walk(p, r);
      } else {
        out.push(r);
      }
      if (out.length >= max) return;
    }
  };
  walk(root, '');
  return out;
}

try {
  main();
} catch (e) {
  console.error(`[closedloop] FAILED: ${e.message}`);
  process.exit(2);
}
