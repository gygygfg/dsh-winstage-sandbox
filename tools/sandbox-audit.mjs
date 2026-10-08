#!/usr/bin/env node
/**
 * sandbox-audit —— 把 shim 的结构化审计（WINSTAGE_AUDIT_LOG，JSONL）聚合成一份
 * `sandbox-audit.json`：AI 在沙箱内**读了/改了/删了哪些文件**、**读了/改了哪些注册表键**，
 * 供沙箱外程序直接消费（统计、分类、呈现、决定是否覆盖到宿主机）。
 *
 * 数据来源（两层，互补）：
 *   1) shim 的审计 JSONL —— 运行期每一次被 hook 的文件/注册表操作（读+写都记）；
 *      由 `WINSTAGE_AUDIT_LOG=<path>` 打开，见 shim/src/ws_util.c `ws_audit`。
 *   2) （可选）项目自己的暂存清单 —— 权威的“待提交候选”（文件 before/after、注册表 WAL 候选）。
 *
 * 用法：
 *   node tools/sandbox-audit.mjs --audit <audit.jsonl> [--audit <more.jsonl>] \
 *                                [--out <sandbox-audit.json>] [--json]
 *
 * 退出码：0 成功 / 1 用法错误。审计行格式非法**不静默忽略**：计入 malformed。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const audits = []
let out
let asJson = false
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]
  if (a === '--audit') audits.push(args[++i])
  else if (a === '--out') out = args[++i]
  else if (a === '--json') asJson = true
  else if (a === '--help' || a === '-h') {
    console.log('usage: node tools/sandbox-audit.mjs --audit <audit.jsonl> [--audit <more>] [--out <out.json>] [--json]')
    process.exit(0)
  }
}
if (audits.length === 0) {
  console.error('usage: node tools/sandbox-audit.mjs --audit <audit.jsonl> [--out <out.json>] [--json]')
  process.exit(1)
}

const PREFIX = /^\[winstage-audit\]\[\d+\]\[\d+\]\s*/

const files = { read: new Map(), written: new Map(), deleted: new Map(), moved: [] }
const registry = { read: new Map(), written: new Map() }
let lines = 0
let parsed = 0
let malformed = 0
const malformedSamples = []

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)
const keyOf = (e) => (e.value ? `${e.key}#${e.value}` : e.key)

for (const file of audits) {
  if (!file || !existsSync(file)) continue
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (raw.length === 0) continue
    lines += 1
    const body = PREFIX.test(raw) ? raw.replace(PREFIX, '') : raw
    let e
    try {
      e = JSON.parse(body)
    } catch {
      malformed += 1
      if (malformedSamples.length < 5) malformedSamples.push(raw.slice(0, 120))
      continue
    }
    parsed += 1
    switch (e.op) {
      case 'file.open':
        bump(e.mode === 'write' ? files.written : files.read, e.path)
        break
      case 'file.delete':
        bump(files.deleted, e.path)
        break
      case 'file.move':
        files.moved.push({ from: e.from, to: e.to })
        break
      case 'reg.open':
      case 'reg.query':
        bump(registry.read, keyOf(e))
        break
      case 'reg.create':
      case 'reg.set':
      case 'reg.deleteKey':
      case 'reg.deleteValue':
        bump(registry.written, keyOf(e))
        break
      default:
        break
    }
  }
}

const toArr = (map) => [...map.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path))

const report = {
  generatedAt: new Date().toISOString(),
  source: { audits, lines, parsed, malformed, malformedSamples },
  files: {
    read: toArr(files.read),
    written: toArr(files.written),
    deleted: toArr(files.deleted),
    moved: files.moved,
  },
  registry: { read: toArr(registry.read), written: toArr(registry.written) },
  summary: {
    filesRead: files.read.size,
    filesWritten: files.written.size,
    filesDeleted: files.deleted.size,
    filesMoved: files.moved.length,
    registryRead: registry.read.size,
    registryWritten: registry.written.size,
  },
}

const text = `${JSON.stringify(report, null, 2)}\n`
if (out) writeFileSync(out, text)
if (asJson) {
  process.stdout.write(text)
} else {
  const s = report.summary
  console.log(
    `sandbox-audit: files read=${s.filesRead} written=${s.filesWritten} deleted=${s.filesDeleted} moved=${s.filesMoved}; ` +
      `registry read=${s.registryRead} written=${s.registryWritten} (lines=${lines} parsed=${parsed} malformed=${malformed})`,
  )
  if (out) console.log(`wrote ${out}`)
}
