#!/usr/bin/env node
/**
 * sbx-extract.mjs -- turn one sbx-thread.cmd run directory into manifest-style
 * evidence (no bulk copies).
 *
 * Inputs (written by sbx-thread.cmd):
 *   <outDir>/stdout.ndjson        raw NDJSON run events
 *   <outDir>/stage-root-path.txt  the pinned WINSTAGE_STAGE_ROOT
 *   <outDir>/workspace-path.txt   the real workspace dir
 *
 * Outputs:
 *   session-id.txt           session id(s) parsed out of the events
 *   stage-root-inventory.txt path + size + sha256[0:12] for every file in the
 *                            stage root, plus a summary line
 *   stage-root-meta.txt      manifest.json / review.json / queue.json excerpts
 *   workspace-inventory.txt  path + size + sha256[0:12] for the REAL workspace
 *
 * Pure stdlib. Hashing is capped per file so a runaway blob cannot stall the
 * report; capped files are marked `hash=SKIPPED(size>`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  process.stderr.write('usage: sbx-extract.mjs <outDir>\n')
  process.exit(2)
}

const readText = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const readLine1 = (p) => readText(p).split(/\r?\n/)[0].trim()

// ── 1. session ids out of the NDJSON events ────────────────────────────────
const ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ids = new Set()
let lines = 0
let parsed = 0
let bad = 0

function walk(node, keyHint) {
  if (typeof node === 'string') {
    if (ID_RE.test(node) && /session/i.test(keyHint)) ids.add(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, keyHint)
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walk(value, key)
  }
}

const ndjson = readText(join(outDir, 'stdout.ndjson'))
for (const raw of ndjson.split(/\r?\n/)) {
  const line = raw.trim()
  if (line === '') continue
  lines += 1
  let event
  try {
    event = JSON.parse(line)
  } catch {
    bad += 1
    continue
  }
  parsed += 1
  walk(event, '')
}

const ordered = [...ids]
const sessionReport = [`# parsed_lines=${parsed} unparsable_lines=${bad} total_lines=${lines}`]
sessionReport.push(ordered.length ? ordered[0] : '# NO SESSION ID FOUND -- inspect stdout.ndjson manually')
if (ordered.length > 1) sessionReport.push(`# other_ids=${ordered.slice(1).join(',')}`)
writeFileSync(join(outDir, 'session-id.txt'), sessionReport.join('\n') + '\n', 'utf8')

// ── 2. inventory helper (path + size + sha256 prefix) ─────────────────────
const HASH_CAP_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 4000

function inventory(root) {
  const rows = []
  const summary = { files: 0, dirs: 0, bytes: 0, truncated: false }
  const visit = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      rows.push(`${relative(root, dir) || '.'}\t<unreadable:${error.code ?? 'ERR'}>`)
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_ENTRIES) {
        summary.truncated = true
        return
      }
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        summary.dirs += 1
        rows.push(`${relative(root, abs)}\t<dir>`)
        if (depth < 24) visit(abs, depth + 1)
        continue
      }
      let size = -1
      try {
        size = statSync(abs).size
      } catch {
        /* keep -1 */
      }
      summary.files += 1
      if (size > 0) summary.bytes += size
      let hash = 'hash=SKIPPED(size>' + HASH_CAP_BYTES + ')'
      if (size >= 0 && size <= HASH_CAP_BYTES) {
        try {
          hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12)
        } catch (error) {
          hash = `hash=ERR(${error.code ?? 'ERR'})`
        }
      }
      rows.push(`${relative(root, abs)}\t${size}\t${hash}`)
    }
  }
  if (!existsSync(root)) return { rows: ['(missing)'], summary }
  visit(root, 0)
  return { rows, summary }
}

// ── 3. stage root inventory + state-file excerpts ─────────────────────────
const stageRoot = readLine1(join(outDir, 'stage-root-path.txt'))
const { rows: stageRows, summary: stageSummary } = inventory(stageRoot)
writeFileSync(
  join(outDir, 'stage-root-inventory.txt'),
  [
    `# stage_root=${stageRoot}`,
    `# files=${stageSummary.files} dirs=${stageSummary.dirs} bytes=${stageSummary.bytes}` +
      (stageSummary.truncated ? ` TRUNCATED_AT=${MAX_ENTRIES}` : ''),
    '# columns: path<TAB>size<TAB>sha256[0:12]',
    ...stageRows,
  ].join('\n') + '\n',
  'utf8',
)

const metaParts = [`# stage_root=${stageRoot}`]

/* ── 第 4 条致命判据：lane 才是"沙箱真的按 TS 档在跑"的唯一真话 ────────────────
 * 背景（task-9 复核者实测，2026-10-08）：把 WINSTAGE_SHIM_INJECTOR 指向不存在的路径
 * （等价于 Defender 隔离掉注入器之后的形态）时，stderr 为空、staged/ 与 candidates/ 都有、
 * 真实 workspace 也只有 seed —— 前三条判据 **3/3 全绿**，而同 run 的 sandbox-lane.json
 * 写的是 tierEffective=T1 / degraded=true / artifact-missing / shimCount=0。
 * 也就是说：暂存面在工作 ≠ 沙箱按 TS 档在工作。lane 必须单独判、单独致命。 */
const laneRaw = readText(join(stageRoot, 'sandbox-lane.json'))
let laneOk = false
let laneReport = []
if (laneRaw.trim() === '') {
  laneReport = ['lane_file=(missing) sandbox-lane.json 不存在 ⇒ 无法证明 TS 档生效', 'LANE_OK=false']
} else {
  let lane
  try {
    lane = JSON.parse(laneRaw)
  } catch {
    lane = undefined
  }
  if (!lane) {
    laneReport = ['lane_file=(unparsable) sandbox-lane.json 不是合法 JSON', 'LANE_OK=false']
  } else {
    const summary = lane.summary ?? {}
    laneOk = lane.degraded === false && lane.tierEffective === 'TS'
    laneReport = [
      `tierEffective=${lane.tierEffective}`,
      `degraded=${lane.degraded}`,
      `launchMode=${lane.launchMode}`,
      `requestedTier=${lane.requestedTier}`,
      `fallbackClass=${lane.fallbackClass}`,
      `fallbackReason=${lane.fallbackReason === null || lane.fallbackReason === undefined ? 'null' : JSON.stringify(lane.fallbackReason)}`,
      `shimCount=${lane.history?.shimCount}`,
      `degradeCount=${lane.history?.degradeCount}`,
      `status=${summary.status}`,
      `conclusion=${JSON.stringify(summary.conclusion ?? '')}`,
      `at=${lane.at}`,
      `LANE_OK=${laneOk}   (判据：degraded===false 且 tierEffective==='TS')`,
    ]
  }
}
writeFileSync(join(outDir, 'lane.txt'), laneReport.join('\n') + '\n', 'utf8')
metaParts.push(`\n## sandbox-lane.json (${laneRaw.length} bytes)\n${laneRaw.slice(0, 4000)}`)
metaParts.push(`\n## lane verdict\n${laneReport.join('\n')}`)

for (const name of ['manifest.json', 'review.json', 'queue.json']) {
  const p = join(stageRoot, name)
  if (!existsSync(p)) {
    metaParts.push(`\n## ${name}: (absent)`)
    continue
  }
  const text = readText(p)
  metaParts.push(`\n## ${name} (${text.length} bytes, first 4000 chars)\n${text.slice(0, 4000)}`)
}
// staged tree: list the staged/ and staged-ext/ roots explicitly, they are the
// model-visible face of the sandbox and the reason the workspace stays clean.
const stagedDir = join(stageRoot, 'staged')
if (existsSync(stagedDir)) {
  const { rows } = inventory(stagedDir)
  metaParts.push(`\n## staged/ tree (${rows.length} rows)\n${rows.slice(0, 400).join('\n')}`)
}
writeFileSync(join(outDir, 'stage-root-meta.txt'), metaParts.join('\n') + '\n', 'utf8')

// ── 4. real workspace inventory (pollution proof) ─────────────────────────
const workspace = readLine1(join(outDir, 'workspace-path.txt'))
const { rows: wsRows, summary: wsSummary } = inventory(workspace)
writeFileSync(
  join(outDir, 'workspace-inventory.txt'),
  [
    `# workspace=${workspace}`,
    `# files=${wsSummary.files} dirs=${wsSummary.dirs} bytes=${wsSummary.bytes}`,
    '# columns: path<TAB>size<TAB>sha256[0:12]',
    ...wsRows,
  ].join('\n') + '\n',
  'utf8',
)

process.stdout.write(
  `[sbx-extract] session=${ordered[0] ?? '(none)'} stage_files=${stageSummary.files} stage_bytes=${stageSummary.bytes} ws_files=${wsSummary.files} lane_ok=${laneOk}\n`,
)
