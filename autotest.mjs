#!/usr/bin/env node
/**
 * autotest.mjs — 命令行测试入口
 *
 * 本文件只做三件事：解析参数、调用 `src/testrunner.mjs`、渲染输出并写报告。
 * 套件清单与判定逻辑全部在 testrunner 里，**与 HTTP 测试服务共用同一份**，
 * 避免"CLI 说通过、服务说失败"这类漂移。
 *
 * 用法：
 *   node autotest.mjs                     # 全部
 *   node autotest.mjs --skip-audit         # 只跑离线
 *   node autotest.mjs --only selftest,audit
 *   node autotest.mjs --workspace .t\ws --report .t\r.json
 *   node autotest.mjs --verbose
 *   node autotest.mjs --json
 *
 * 退出码：0 = 无失败（含因机制边界跳过沙箱段）；1 = 存在失败；2 = 环境错误
 */

import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { REPO, runAll, OFFLINE_SUITES, SANDBOX_SUITES } from './src/testrunner.mjs'

function parseArgs(argv) {
  const out = { skipAudit: false, verbose: false, json: false, only: undefined, workspace: undefined, report: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--skip-audit') out.skipAudit = true
    else if (t === '--verbose' || t === '-v') out.verbose = true
    else if (t === '--json') out.json = true
    else if (t === '--workspace') out.workspace = argv[++i]
    else if (t === '--report') out.report = argv[++i]
    else if (t === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (t === '--help' || t === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(
    'usage: node autotest.mjs [--skip-audit] [--only a,b] [--verbose] [--json] [--workspace <dir>] [--report <file>]\n' +
      `\nsuites: ${[...OFFLINE_SUITES, ...SANDBOX_SUITES].map((s) => s.id).join(', ')}, audit\n`,
  )
  process.exit(0)
}

const WORKSPACE = resolve(args.workspace ? join(REPO, args.workspace) : join(REPO, '.t', 'ws'))
const REPORT = resolve(args.report ? join(REPO, args.report) : join(REPO, '.t', 'test-report.json'))

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (c) => (s) => (COLOR ? `\u001b[${c}m${s}\u001b[0m` : String(s))
const dim = paint('90')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')
const bold = paint('1')
const say = (l = '') => process.stdout.write(`${l}\n`)

const MARK = { PASS: green(' PASS '), FAIL: red(' FAIL '), SKIPPED: yellow(' SKIP ') }
const markOf = (status) => MARK[String(status).startsWith('SKIPPED') ? 'SKIPPED' : status] ?? status

say(cyan('================================================================'))
say(bold(` WinStageSandbox 自动测试   ${new Date().toISOString()}`))
say(dim(` node      = ${process.execPath}`))
say(dim(` repo      = ${REPO}`))
say(dim(` workspace = ${WORKSPACE}`))
say(cyan('================================================================'))

mkdirSync(join(REPO, '.t'), { recursive: true })

const report = await runAll({
  workspace: WORKSPACE,
  outDir: join(REPO, '.t'),
  skipAudit: args.skipAudit,
  only: args.only,
})

// 渲染（runAll 完成后统一输出，保证与报告内容完全一致）
say('')
say(cyan('── 套件结果 ──'))
for (const s of report.suites) {
  say(
    `  [${markOf(s.status)}] ${s.id.padEnd(16)} ${String(s.durationMs).padStart(6)} ms   ` +
      `checks: ${String(s.checksOk).padStart(3)} ok / ${String(s.checksBad).padStart(2)} bad` +
      (s.coverage !== undefined ? `   coverage=${s.coverage}%` : ''),
  )
  if (s.status === 'FAIL') {
    if (s.spawnError) say(red(`  子进程启动失败: ${s.spawnError}`))
    if (s.failDetails) for (const f of s.failDetails) say(red(`  ✗ ${f.id}: ${f.detail}`))
    const tail = s.tail ?? []
    if (tail.length) {
      say(dim('  ---- 输出尾 ----'))
      for (const l of args.verbose ? tail : tail.slice(-18)) say(dim(`  ${l}`))
      say(dim('  ----------------'))
    }
  }
  if (String(s.status).startsWith('SKIPPED')) {
    say(yellow('         原因：当前会话已受限，无法建立嵌套沙箱（机制边界，非缺陷）。'))
    say(yellow('         请在**未受限**的 PowerShell 中重跑以取得沙箱内实测证据。'))
  }
}

writeFileSync(REPORT, JSON.stringify(report, null, 2))

say('')
say(cyan('================================================================'))
const oc = report.overall === 'PASS' ? green(report.overall) : report.overall === 'FAIL' ? red(report.overall) : yellow(report.overall)
say(
  ` 总判定: ${oc}   套件 ${report.suitesPassed} 通过 / ${report.suitesFailed} 失败 / ${report.suitesSkipped} 跳过   ` +
    `断言 ${report.checksOk} ok / ${report.checksBad} bad`,
)
say(dim(` 报告: ${REPORT}`))
say(cyan('================================================================'))

if (report.suitesFailed > 0) {
  say('')
  say(red('失败套件：'))
  for (const f of report.suites.filter((s) => s.status === 'FAIL')) say(red(`  - ${f.id} (${f.title})\n      ${f.outputFile}`))
}

if (args.json) say(`\n${JSON.stringify(report, null, 2)}`)

process.exit(report.overall === 'FAIL' ? 1 : 0)
