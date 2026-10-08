#!/usr/bin/env node
/* WinStageSandbox -- 缺陷①b 回归套件：白障（whiteout）标记必须变成"真实路径的删除候选"
 * ============================================================================
 * 收口说明（finisher 本轮）：本文件由 `.t\shim-delete\test-whiteout-capture.mjs`
 * **原样提升**进离线门禁（`src\testrunner.mjs::OFFLINE_SUITES` 与 `verify.cmd`
 * 循环列表两处逐项同序），只做三处机械改动：
 *   1. 路径根：`HERE` 由 `.t\shim-delete` 变为 `tests`，`REPO` 因此改为上一层；
 *   2. 临时目录：从套件同级挪到 `.t\whiteout-candidate-capture\`（不往 `tests\` 里写产物）；
 *   3. 检查标记改为 `✓`/`✗`，让运行器 `countChecks()` 的标记计数口径与其余离线套件一致
 *      （判定本身仍严格来自 exit code，见 `src\testrunner.mjs::runSuite`）。
 * 断言与判据一字未改（29 项）。历史产物仍留在 `.t\shim-delete\raw\`。
 *
 * WHY THIS EXISTS
 *   `src/workspace.mjs::captureAfterExecution()` used to walk the whole staging tree as a
 *   content tree, so a shim whiteout marker at `<staged>\wo\C\a\b` was reported as a CREATE
 *   of `wo\C\a\b`, while a deletion of a file that was never staged produced no delta at all
 *   (the pre-exec snapshot is taken before the command, `src/cli.mjs`), i.e. `删除 0 项`.
 *
 *   This script needs NO shim and NO sandbox: it drives the Workspace API directly and
 *   fakes the shim's on-disk layout. It has teeth in both directions:
 *     - it fails if a whiteout marker is ever emitted as a `wo\...` create;
 *     - it fails if a whiteout is NOT turned into exactly one deletion of the real path;
 *     - it fails if the normal content path (create/modify) changes behaviour;
 *     - it fails if `apply` does not actually delete the approved real file.
 *   The shim-side end-to-end proof stays in `tests\delete-capture.mjs`
 *   (the promoted copy of `.t\shim-delete\test-delete-capture.mjs`, SANDBOX_SUITES).
 *
 * USAGE: node tests\whiteout-candidate-capture.mjs     (exit 0 = all checks pass)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const { Workspace } = await import(pathToFileURL(path.join(REPO, 'src', 'workspace.mjs')).href)

const stamp = `${Date.now().toString(36)}-${process.pid.toString(36)}`
const RUN = path.join(REPO, '.t', 'whiteout-candidate-capture', `run-wo-${stamp}`)
const WS = path.join(RUN, 'ws')
const EXT = path.join(RUN, 'ext')
const STAGED = path.join(WS, '.dshstage', 'staged')

const failures = []
let checks = 0
function check(ok, label, detail) {
  checks += 1
  if (!ok) failures.push(`${label}${detail ? ` -- ${detail}` : ''}`)
  console.log(`${ok ? '  ✓' : '  ✗'} ${label.padEnd(38)} ${detail || ''}`)
}

/** 逻辑绝对路径 -> 白障标记路径（与 shim\src\ws_stage.c 的 ws_fs_map 同构） */
function whiteoutPath(logical) {
  const norm = logical.replace(/\//g, '\\')
  const drive = norm.slice(0, 2)
  const rest = norm.slice(2).replace(/^\\/, '')
  return path.join(STAGED, 'wo', drive[0], ...rest.split('\\'))
}
function writeMarker(logical) {
  const marker = whiteoutPath(logical)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, '')
  return marker
}
const byPath = (changes) => new Map(changes.map((c) => [c.path, c]))

function main() {
  fs.mkdirSync(EXT, { recursive: true })
  fs.mkdirSync(WS, { recursive: true })
  const extDel = path.join(EXT, 'ext-del.txt')
  const inDel = path.join(WS, 'in-del.txt')
  const inStagedDel = path.join(WS, 'staged-del.txt')
  fs.writeFileSync(extDel, 'real-ext-content\n')
  fs.writeFileSync(inDel, 'real-in-content\n')
  fs.writeFileSync(inStagedDel, 'real-staged-content\n')

  const ws = new Workspace({ workspaceRoot: WS })
  ws.init()

  /* ---- 1. normal path (no shim): a tool-staged entry + a staged tree write ------------- */
  ws.writeFile(inStagedDel, 'staged-v2\n')
  const before = ws.snapshotStagedTree()
  check(!fs.existsSync(path.join(STAGED, 'wo')), 'no-wo-tree-yet', 'fresh workspace has no wo\\ subtree')

  /* a plain content object appears (what a non-shim command would leave behind) */
  const stagedNew = path.join(STAGED, 'plain-new.txt')
  fs.writeFileSync(stagedNew, 'plain-content\n')

  /* ---- 2. fake the shim: three deletion forms end up as wo\ markers -------------------- */
  const wo1 = writeMarker(extDel)
  const wo2 = writeMarker(inDel)
  writeMarker(inStagedDel) // same logical path ALSO loses its workspace staged object
  fs.rmSync(path.join(STAGED, 'staged-del.txt'), { force: true })
  /* wo\_unc\... -> \\server\share\x */
  const uncMarker = path.join(STAGED, 'wo', '_unc', 'server', 'share', 'unc-del.txt')
  fs.mkdirSync(path.dirname(uncMarker), { recursive: true })
  fs.writeFileSync(uncMarker, '')
  /* a wo tree ancestor DIRECTORY must never count as a marker */
  check(fs.existsSync(path.join(STAGED, 'wo', 'C')), 'wo-ancestor-dir-exists', 'wo\\C is the parent chain of the markers')

  const captured = ws.captureAfterExecution(before)
  const map = byPath(captured)

  check(!captured.some((c) => /^wo[\\/]/.test(c.path)), 'no-wo-pseudo-create', `paths=${JSON.stringify(captured.map((c) => c.path))}`)
  const extChange = map.get(extDel)
  check(!!extChange && extChange.deleted === true && extChange.hash === 'absent',
    'ext-delete-candidate', JSON.stringify(extChange))
  const inChange = map.get('in-del.txt')
  check(!!inChange && inChange.deleted === true, 'internal-delete-uses-relative-key', JSON.stringify(inChange))
  const stagedChange = map.get('staged-del.txt')
  check(!!stagedChange && stagedChange.deleted === true, 'staged-object-delete-candidate', JSON.stringify(stagedChange))
  const uncChange = map.get('\\\\server\\share\\unc-del.txt')
  check(!!uncChange && uncChange.deleted === true, 'unc-delete-candidate', JSON.stringify(uncChange))
  const plain = map.get('plain-new.txt')
  check(!!plain && plain.created === true && plain.hash !== 'absent', 'plain-create-unchanged', JSON.stringify(plain))
  check(fs.existsSync(wo1) && fs.existsSync(wo2), 'markers-on-disk', path.relative(REPO, wo1))
  const deletions = captured.filter((c) => c.deleted === true)
  check(deletions.length === 4, 'exactly-four-deletions', `deletions=${deletions.map((c) => c.path).join(' | ')}`)
  const dup = deletions.filter((c) => c.path === 'staged-del.txt').length
  check(dup === 1, 'no-duplicate-for-two-signals', `staged-del.txt reported ${dup}x`)

  /* ---- 3. snapshot口径 is consistent: old markers are NOT re-reported ------------------ */
  const after = ws.snapshotStagedTree()
  check(after.whiteouts instanceof Map && after.whiteouts.size === 4,
    'snapshot-whiteouts', `size=${after.whiteouts instanceof Map ? after.whiteouts.size : 'n/a'}`)
  const again = ws.captureAfterExecution(after)
  check(again.length === 0, 'second-capture-is-empty', `changes=${JSON.stringify(again.map((c) => c.path))}`)

  /* ---- 4. unmappable marker is recorded, not guessed ----------------------------------- */
  const weird = path.join(STAGED, 'wo', 'notadrive', 'x.txt')
  fs.mkdirSync(path.dirname(weird), { recursive: true })
  fs.writeFileSync(weird, '')
  const weirdSnap = ws.snapshotStagedTree()
  check(weirdSnap.skipped.some((s) => s.reason === 'whiteout-unmappable'),
    'unmappable-recorded', JSON.stringify(weirdSnap.skipped.slice(0, 4)))
  const weirdCapture = ws.captureAfterExecution(after)
  check(weirdCapture.length === 0, 'unmappable-not-emitted', JSON.stringify(weirdCapture.map((c) => c.path)))
  fs.rmSync(path.join(STAGED, 'wo', 'notadrive'), { recursive: true, force: true })

  /* ---- 5. the sandbox's own store is not user content ----------------------------------- */
  const storeMarker = writeMarker(path.join(WS, '.dshstage', 'blobs', 'aa', 'deadbeef'))
  const storeCapture = ws.captureAfterExecution(after)
  check(storeCapture.length === 0, 'store-internal-marker-ignored', path.relative(REPO, storeMarker))
  fs.rmSync(storeMarker, { force: true })

  /* ---- 6. ingest -> candidate -> review -> apply (the approval face) -------------------- */
  /* Negative control inside the positive one: `\\server\share\unc-del.txt` has NO real file
   * (it is only a marker, this host has no such share) -> it must NOT become a candidate
   * ("delete something that never existed" is not a net change). 3 of the 4 deletions land. */
  check(!fs.existsSync('\\\\server\\share\\unc-del.txt'), 'unc-target-absent-control',
    'the UNC marker maps to a path with no real file')
  const ingest = ws.ingestCapturedChanges(captured)
  check(ingest.deletions === 4, 'ingest-deletion-count', JSON.stringify(ingest))
  check(ingest.ingested === 1, 'ingest-create-count', JSON.stringify(ingest))
  const frozen = ws.freezeIfNeeded({ source: 'exec' })
  check(frozen.frozen === true, 'candidate-frozen', `reason=${frozen.reason}`)
  const byOp = frozen.candidate?.summary?.byOp ?? {}
  check(byOp.delete === 3 && byOp.create === 1, 'candidate-byOp',
    `${JSON.stringify(byOp)} (3 = 4 removals minus the ghost UNC path)`)
  const review = ws.listReviews()
  const delRows = review.flatMap((c) => c.changes).filter((c) => c.op === 'delete')
  check(delRows.length === 3, 'review-shows-deletions', delRows.map((c) => c.path).join(' | '))
  check(delRows.every((c) => c.after?.hash === 'absent' && typeof c.before?.hash === 'string'),
    'review-before-after-frozen', JSON.stringify(delRows.map((c) => ({ p: c.path, b: c.before?.hash, a: c.after?.hash }))))

  const applied = ws.applyCandidate(frozen.candidate.id)
  check(applied.failed.length === 0, 'apply-no-failures', JSON.stringify(applied.failed))
  check(applied.applied.filter((a) => a.op === 'delete').length === 3, 'apply-deletions', JSON.stringify(applied.applied))
  check(!fs.existsSync(extDel), 'apply-removed-real-ext-file', extDel)
  check(!fs.existsSync(inDel), 'apply-removed-real-in-file', inDel)
  check(!fs.existsSync(inStagedDel), 'apply-removed-real-staged-file', inStagedDel)
  check(fs.existsSync(path.join(WS, 'plain-new.txt')), 'apply-created-plain-file', 'plain-new.txt')
}

try {
  main()
} catch (error) {
  console.error(`harness error: ${error.stack}`)
  process.exitCode = 2
} finally {
  try {
    if (process.exitCode !== 2) fs.rmSync(RUN, { recursive: true, force: true })
    else console.log(`run dir kept: ${path.relative(REPO, RUN)}`)
  } catch {
    /* leftovers are harmless */
  }
}

if (failures.length) {
  console.log(`\nRESULT: FAIL (${failures.length}/${checks})`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log(`\nRESULT: PASS (${checks} checks)`)
}
