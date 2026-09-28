#!/usr/bin/env node
/**
 * testclient.mjs — 测试服务的命令行客户端
 *
 * 用途：不想记 curl 语法时，用它触发一轮测试并打印结果。
 *
 * 用法：
 *   node src/testclient.mjs                                  # 跑全部，等完成后打印
 *   node src/testclient.mjs --url http://127.0.0.1:8737
 *   node src/testclient.mjs --token <t>
 *   node src/testclient.mjs --only selftest,audit
 *   node src/testclient.mjs --skip-audit
 *   node src/testclient.mjs --async                          # 立即返回 jobId，后台跑
 *   node src/testclient.mjs --watch <jobId>                  # 跟踪一个已有 job
 *   node src/testclient.mjs --log <jobId>                    # 打印纯文本日志
 *
 * 退出码：0 = overall 不是 FAIL；1 = FAIL；2 = 通信/用法错误
 */

import { ALL_SUITE_IDS } from './testrunner.mjs'

function parseArgs(argv) {
  const out = {
    url: process.env.TEST_SERVICE_URL ?? 'http://127.0.0.1:8737',
    token: process.env.TEST_SERVICE_TOKEN,
    only: undefined,
    skipAudit: false,
    async: false,
    watch: undefined,
    log: undefined,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--url') out.url = argv[++i]
    else if (t === '--token') out.token = argv[++i]
    else if (t === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (t === '--skip-audit') out.skipAudit = true
    else if (t === '--async') out.async = true
    else if (t === '--watch') out.watch = argv[++i]
    else if (t === '--log') out.log = argv[++i]
    else if (t === '--json') out.json = true
    else if (t === '--help' || t === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(
    'usage: node src/testclient.mjs [--url U] [--token T] [--only a,b] [--skip-audit] [--async] [--watch id] [--log id] [--json]\n' +
      `\nsuites: ${[...ALL_SUITE_IDS, 'audit'].join(', ')}\n` +
      '\n环境变量：TEST_SERVICE_URL, TEST_SERVICE_TOKEN\n',
  )
  process.exit(0)
}

const base = args.url.replace(/\/+$/, '')
if (!args.token) {
  process.stderr.write('缺少令牌：用 --token 或 TEST_SERVICE_TOKEN 指定（服务启动时会打印）\n')
  process.exit(2)
}
const headers = { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' }
const say = (l = '') => process.stdout.write(`${l}\n`)

async function api(path, init = {}) {
  let res
  try {
    res = await fetch(`${base}${path}`, { headers, ...init })
  } catch (error) {
    process.stderr.write(`无法连接 ${base}：${error.message}\n`)
    process.exit(2)
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok && res.status !== 202) {
    process.stderr.write(`HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}\n`)
    process.exit(2)
  }
  return body
}

function renderReport(report) {
  say(`overall = ${report.overall}`)
  say(
    `套件 ${report.suitesPassed} 通过 / ${report.suitesFailed} 失败 / ${report.suitesSkipped} 跳过   ` +
      `断言 ${report.checksOk} ok / ${report.checksBad} bad   ${report.durationMs} ms`,
  )
  say('')
  for (const s of report.suites) {
    say(
      `  [${String(s.status).padEnd(22)}] ${s.id.padEnd(16)} ${String(s.durationMs).padStart(6)} ms  ` +
        `${s.checksOk} ok / ${s.checksBad} bad` +
        (s.coverage !== undefined ? `  coverage=${s.coverage}%` : ''),
    )
    for (const f of s.failDetails ?? []) say(`      ✗ ${f.id}: ${f.detail}`)
    if (s.status === 'FAIL') for (const l of (s.tail ?? []).slice(-12)) say(`      | ${l}`)
  }
  if (report.guaranteesNotProvided?.length) {
    say('')
    say('仍未提供的保证：')
    for (const g of report.guaranteesNotProvided) say(`  - ${g}`)
  }
}

async function pollUntilDone(id, everyMs = 500) {
  for (;;) {
    const v = await api(`/jobs/${id}`)
    if (v.status !== 'running' && v.status !== 'queued') return v
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

// ── --log ───────────────────────────────────────────────────────────────────
if (args.log) {
  const res = await fetch(`${base}/jobs/${args.log}/log`, { headers })
  process.stdout.write(await res.text())
  process.exit(res.ok ? 0 : 2)
}

// ── --watch ─────────────────────────────────────────────────────────────────
if (args.watch) {
  const v = await pollUntilDone(args.watch)
  if (args.json) say(JSON.stringify(v, null, 2))
  else if (v.report) renderReport(v.report)
  else say(`status=${v.status}  ${v.error ?? ''}`)
  process.exit(v.status === 'failed' ? 1 : 0)
}

// ── 触发一轮 ────────────────────────────────────────────────────────────────
const body = {}
if (args.only) body.only = args.only
if (args.skipAudit) body.skipAudit = true

if (args.async) {
  body.await = false
  const created = await api('/run', { method: 'POST', body: JSON.stringify(body) })
  say(`jobId = ${created.jobId}`)
  say(`status = ${created.view.status}`)
  say(`查询   = GET ${base}/jobs/${created.jobId}`)
  say(`日志   = GET ${base}/jobs/${created.jobId}/log`)
  process.exit(0)
}

say(`请求 ${base}/run  ${JSON.stringify(body)}`)
const job = await api('/run', { method: 'POST', body: JSON.stringify(body) })
if (args.json) {
  say(JSON.stringify(job, null, 2))
} else if (job.report) {
  renderReport(job.report)
} else {
  say(`status=${job.status}  ${job.error ?? ''}`)
}
process.exit(job.report?.overall === 'FAIL' || job.status === 'failed' ? 1 : 0)
