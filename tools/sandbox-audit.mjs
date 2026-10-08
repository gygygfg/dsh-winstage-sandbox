#!/usr/bin/env node
/**
 * sandbox-audit —— 把 shim 的结构化审计（WINSTAGE_AUDIT_LOG，JSONL）聚合成一份
 * `sandbox-audit.json`：AI 在沙箱内**读了/改了/删了哪些文件**、**读了/改了哪些注册表键**，
 * 供沙箱外程序直接消费（统计、分类、呈现、决定是否覆盖到宿主机）。
 *
 * 数据来源（Method A，主线）：shim 运行期钩住进程树的文件/注册表 API，逐操作写 JSONL；
 * 由 `WINSTAGE_AUDIT_LOG` 打开，见 `src/executor.mjs`（launcher 自动设置）与
 * `shim/src/ws_util.c`（`ws_audit`）。
 *
 * 用法：
 *   node tools/sandbox-audit.mjs --audit <audit.jsonl> [--audit <more.jsonl>] \
 *                                [--root <workspaceRoot>] [--out <out.json>] [--json]
 *
 * `--root` 给出工作区根：文件条目会带 `scope: 'workspace' | 'outside'`，
 * 便于把"AI 的改动"与"系统/沙箱自身噪音"分开统计。
 *
 * 退出码：0 成功 / 1 用法错误。非法行**不静默忽略**：计入 malformed 并保留样本。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIT_PREFIX = /^\[winstage-audit\]\[\d+\]\[\d+\]\s*/

/**
 * 纯函数：把一批审计原始行聚合成报告（不碰文件系统，可离线单测）。
 * @param {string[]} lines 原始 JSONL 行（可带 shim 前缀）
 * @param {{root?: string}} [opts]
 */
export function aggregateAudit(lines, opts = {}) {
  const root = opts.root
  const rootNorm = typeof root === 'string' && root.length > 0 ? root.replace(/[\\/]+$/, '').toLowerCase() : null
  const scopeOf = (p) =>
    rootNorm !== null && typeof p === 'string' && p.toLowerCase().startsWith(rootNorm) ? 'workspace' : 'outside'

  const files = { read: new Map(), written: new Map(), deleted: new Map(), moved: [] }
  const registry = { read: new Map(), written: new Map() }
  let parsed = 0
  let malformed = 0
  const malformedSamples = []

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)

  for (const raw of lines) {
    if (raw.length === 0) continue
    const body = AUDIT_PREFIX.test(raw) ? raw.replace(AUDIT_PREFIX, '') : raw
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
        bump(registry.read, e.value ? `${e.key}#${e.value}` : e.key)
        break
      case 'reg.create':
      case 'reg.set':
      case 'reg.deleteKey':
      case 'reg.deleteValue':
        bump(registry.written, e.value ? `${e.key}#${e.value}` : e.key)
        break
      default:
        break
    }
  }

  const toArr = (map) =>
    [...map.entries()].map(([path, count]) => ({ path, count, scope: scopeOf(path) })).sort((a, b) => a.path.localeCompare(b.path))
  const toArrReg = (map) => [...map.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path))
  const countScope = (arr, scope) => arr.filter((e) => e.scope === scope).length

  const writtenArr = toArr(files.written)
  const deletedArr = toArr(files.deleted)
  return {
    files: {
      read: toArr(files.read),
      written: writtenArr,
      deleted: deletedArr,
      moved: files.moved.map((m) => ({ ...m, scope: scopeOf(m.to) })),
    },
    registry: { read: toArrReg(registry.read), written: toArrReg(registry.written) },
    counts: { parsed, malformed, malformedSamples },
    summary: {
      filesRead: files.read.size,
      filesWritten: files.written.size,
      filesDeleted: files.deleted.size,
      filesMoved: files.moved.length,
      registryRead: registry.read.size,
      registryWritten: registry.written.size,
      filesWrittenInWorkspace: countScope(writtenArr, 'workspace'),
      filesWrittenOutside: countScope(writtenArr, 'outside'),
      filesDeletedInWorkspace: countScope(deletedArr, 'workspace'),
    },
  }
}

function readLines(file) {
  if (!file || !existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/)
}

function main(argv) {
  const audits = []
  let out
  let root
  let asJson = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--audit') audits.push(argv[++i])
    else if (a === '--out') out = argv[++i]
    else if (a === '--root') root = argv[++i]
    else if (a === '--json') asJson = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: node tools/sandbox-audit.mjs --audit <audit.jsonl> [--audit <more>] [--root <workspaceRoot>] [--out <out.json>] [--json]\n')
      return 0
    }
  }
  if (audits.length === 0) {
    process.stderr.write('usage: node tools/sandbox-audit.mjs --audit <audit.jsonl> [--root <workspaceRoot>] [--out <out.json>] [--json]\n')
    return 1
  }
  const lines = []
  for (const f of audits) lines.push(...readLines(f))
  const agg = aggregateAudit(lines, { root })
  const report = {
    generatedAt: new Date().toISOString(),
    root: root ?? null,
    source: { audits, lines: lines.length, parsed: agg.counts.parsed, malformed: agg.counts.malformed, malformedSamples: agg.counts.malformedSamples },
    files: agg.files,
    registry: agg.registry,
    summary: agg.summary,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, text)
  if (asJson) {
    process.stdout.write(text)
  } else {
    const s = agg.summary
    process.stdout.write(
      `sandbox-audit: files read=${s.filesRead} written=${s.filesWritten} (in-workspace=${s.filesWrittenInWorkspace} outside=${s.filesWrittenOutside}) ` +
        `deleted=${s.filesDeleted}; registry read=${s.registryRead} written=${s.registryWritten} ` +
        `(lines=${lines.length} parsed=${agg.counts.parsed} malformed=${agg.counts.malformed})\n`,
    )
    if (out) process.stdout.write(`wrote ${out}\n`)
  }
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
