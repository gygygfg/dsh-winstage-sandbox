#!/usr/bin/env node
/**
 * sandbox-audit —— CLI 包装：把 shim 的结构化审计（`WINSTAGE_AUDIT_LOG`，JSONL）读成
 * `sandbox-audit.json`。纯函数层在 `src/audit-report.mjs`（CLI 与宿主插件共用）。
 *
 * 用法：
 *   node tools/sandbox-audit.mjs --audit <audit.jsonl> [--audit <more.jsonl>] \
 *                                [--root <workspaceRoot>] [--out <out.json>] [--json]
 *
 * 退出码：0 成功 / 1 用法错误。非法行不静默忽略（计入 malformed 并留样本）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateAudit, buildAuditReport, summarizeAudit } from '../src/audit-report.mjs'

export { aggregateAudit, buildAuditReport, summarizeAudit, AUDIT_PREFIX } from '../src/audit-report.mjs'

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
  const report = buildAuditReport(lines, { root, audits })
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, text)
  if (asJson) {
    process.stdout.write(text)
  } else {
    process.stdout.write(`${summarizeAudit(report.summary)} (lines=${report.source.lines} parsed=${report.source.parsed} malformed=${report.source.malformed})\n`)
    if (out) process.stdout.write(`wrote ${out}\n`)
  }
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
