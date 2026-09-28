#!/usr/bin/env node
/**
 * testservice.mjs — 自动测试服务
 *
 * 收到请求就开始测试，完成后返回输出。
 *
 * ── API ─────────────────────────────────────────────────────────────────────
 *   GET  /health                    → 服务状态（无需鉴权，便于探活）
 *   GET  /suites                    → 可用套件清单
 *   POST /run                       → **同步**跑一轮，跑完直接返回完整报告
 *   POST /run?...                   → 同上，参数也可走 query string
 *   POST /jobs                      → **异步**启动一轮，立即返回 jobId
 *   GET  /jobs                      → 列出全部 job
 *   GET  /jobs/<id>                 → 查询单个 job（含进度与最终报告）
 *   GET  /jobs/<id>/log             → 纯文本日志（逐套件结果）
 *   DELETE /jobs/<id>               → 取消进行中的 job（若尚未开始则直接标记取消）
 *   GET  /report/latest             → 最近一次完成的报告
 *   GET  /report/latest/<suiteId>   → 某套件的原始输出
 *
 *   请求体（JSON，可选）：{ workspace, skipAudit, only: ["selftest", ...] }
 *   同步 /run 支持 `?wait=0` 立即返回 202 + jobId（等同 POST /jobs）。
 *
 * ── 安全边界（必须明确声明，不能假装没有）────────────────────────────────────
 *   本服务**按请求执行本机测试套件**，本质上是"本机代码执行入口"。因此：
 *     R13 只监听 127.0.0.1，绝不对外暴露。
 *     R14 默认要求 Bearer 令牌（启动时随机生成并打印，或用 --token 指定）；
 *         未带令牌的请求一律 401。
 *     R15 只允许运行白名单内的固定套件 id，**不接受任意命令或脚本路径**。
 *     R16 串行执行：同一时刻只允许一轮测试，避免并发互相污染状态
 *         （手册第 17.2 节：套件必须隔离配置、cwd、缓存与持久状态）。
 *   这四条不是可选项；去掉任何一条都会让它变成远程代码执行面。
 *
 * ── 为什么用 Node 内置 http ─────────────────────────────────────────────────
 *   零依赖，且与测试自身同栈，便于直接复用 src/testrunner.mjs 的套件清单与判定逻辑。
 *
 * 用法：
 *   node src/testservice.mjs                      # 默认 127.0.0.1:8737
 *   node src/testservice.mjs --port 8800 --token mytoken
 *   node src/testservice.mjs --once               # 处理一次 /run 后退出（便于脚本化）
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { REPO, ALL_SUITE_IDS, runAll } from './testrunner.mjs'

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 8737, token: undefined, once: false, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--port') out.port = Number(argv[++i])
    else if (t === '--host') out.host = String(argv[++i])
    else if (t === '--token') out.token = String(argv[++i])
    else if (t === '--once') out.once = true
    else if (t === '--quiet') out.quiet = true
    else if (t === '--help' || t === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(
    'usage: node src/testservice.mjs [--port 8737] [--host 127.0.0.1] [--token <t>] [--once] [--quiet]\n' +
      `\nsuites: ${ALL_SUITE_IDS.join(', ')}, audit\n`,
  )
  process.exit(0)
}

// 默认强制令牌：不生成令牌就启动，等于开了一个无鉴权的代码执行入口。
const TOKEN = args.token ?? randomBytes(16).toString('hex')
const log = (...a) => {
  if (!args.quiet) process.stdout.write(`${a.join(' ')}\n`)
}

// ── job 状态 ────────────────────────────────────────────────────────────────
const jobs = new Map()
let seq = 0
let runningJobId = null // 当前进行中的 jobId（串行执行）

function newJob(params) {
  seq += 1
  const id = `job_${String(seq).padStart(4, '0')}_${randomBytes(3).toString('hex')}`
  const job = {
    id,
    seq,
    createdAt: new Date().toISOString(),
    startedAt: undefined,
    finishedAt: undefined,
    status: 'queued', // queued | running | done | failed | cancelled
    params,
    progress: [], // [{ type, id, status, at }]
    report: undefined,
    error: undefined,
  }
  jobs.set(id, job)
  return job
}

async function executeJob(job) {
  if (job.status === 'cancelled') return
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  runningJobId = job.id
  log(`[${job.id}] 开始测试  params=${JSON.stringify(job.params)}`)

  try {
    const report = await runAll({
      workspace: job.params.workspace,
      outDir: job.params.outDir,
      skipAudit: job.params.skipAudit,
      only: job.params.only,
      onEvent: (e) => {
        if (e.type === 'suite-end') {
          job.progress.push({ type: e.type, id: e.id, status: e.status, at: new Date().toISOString() })
          const s = job.report?.suites?.find((x) => x.id === e.id)
          log(`[${job.id}]   ${e.id} -> ${e.status}${s ? ` (${s.checksOk} ok / ${s.checksBad} bad)` : ''}`)
        }
      },
    })
    job.report = report
    job.status = 'done'
    for (const s of report.suites) {
      if (!job.progress.some((p) => p.id === s.id)) {
        job.progress.push({ type: 'suite-end', id: s.id, status: s.status, at: new Date().toISOString() })
      }
    }
    log(`[${job.id}] 完成  总判定=${report.overall}  断言 ${report.checksOk} ok / ${report.checksBad} bad`)
  } catch (error) {
    job.status = 'failed'
    job.error = String(error?.message ?? error)
    log(`[${job.id}] 失败: ${job.error}`)
  } finally {
    job.finishedAt = new Date().toISOString()
    if (runningJobId === job.id) runningJobId = null
    if (args.once) {
      log('--once：测试完成，服务退出')
      setTimeout(() => process.exit(job.status === 'failed' ? 1 : 0), 50)
    }
  }
}

/**
 * 串行排队：同一时刻只跑一轮（R16）。
 *
 * **这里曾经有个并发缺陷**：早先的实现检查 `if (running)` 后才启动，
 * 但 `executeJob` 的第一个 await 之前只是同步地设置 `runningJobId = job.id`；
 * 两个请求几乎同时到达时，二者都可能在对方设置 `running` 之前通过检查，
 * 于是**同时开跑**（实测两个 job 都显示 running），把 R16 变成了空话。
 *
 * 正确做法：用一个**显式 FIFO 队列 + 单一泵**（pump）。入队是同步操作，
 * 泵只在空闲时取出下一个，从结构上排除竞态 —— 而不是靠"检查再设置"。
 */
const queue = []
let pumping = false

function enqueue(job) {
  queue.push(job)
  void pump()
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (job.status === 'cancelled') continue
      await executeJob(job)
    }
  } finally {
    pumping = false
  }
}

// ── HTTP 助手 ───────────────────────────────────────────────────────────────
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 64) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        resolvePromise({ __parseError: text.slice(0, 200) })
      }
    })
    req.on('error', () => resolvePromise({}))
  })
}

/**
 * 从 body + query 合并参数，并对套件白名单做校验（R15）。
 *
 * 注意类型：JSON body 里 `only` 是数组、`skipAudit` 是布尔；
 * 而 query string 里两者都是字符串。**必须分开处理**，不能一把 `String()` 了事 ——
 * 早先版本把布尔 `false` 也 `String()` 成 "false" 塞进 only 列表，
 * 于是 `{"skipAudit":false}` 会报 "unknown suite id(s): false"。
 */
function buildParams(url, body) {
  const params = {}
  const q = url.searchParams
  /**
   * 合并取值并把"缺失"统一成 undefined。
   *
   * **必须显式处理**：`URLSearchParams.get()` 对不存在的参数返回 **null**，
   * 而 JSON body 缺失字段是 **undefined**。早先只判 `!== undefined`，
   * 于是 query 缺失时拿到 null 仍被当成"传了值"，触发类型校验报
   * "only must be an array... got object" —— 一个纯粹的缺失语义混淆。
   */
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null)

  const workspace = pick(body.workspace, q.get('workspace'))
  if (workspace) params.workspace = resolve(join(REPO, String(workspace)))

  const skip = pick(body.skipAudit, q.get('skipAudit'), q.get('skip-audit'))
  if (skip !== undefined) params.skipAudit = skip === true || skip === '1' || skip === 'true'

  const rawOnly = pick(body.only, q.get('only'))
  if (rawOnly !== undefined) {
    let list
    if (Array.isArray(rawOnly)) {
      list = rawOnly
    } else if (typeof rawOnly === 'string') {
      list = rawOnly.split(',')
    } else {
      return { error: `only must be an array or a comma-separated string, got ${typeof rawOnly}` }
    }
    const cleaned = list.map((s) => String(s).trim()).filter(Boolean)
    if (cleaned.length === 0) return { error: 'only must not be empty' }
    const allowed = new Set([...ALL_SUITE_IDS, 'audit'])
    const bad = cleaned.filter((id) => !allowed.has(id))
    // 只接受白名单内的固定套件 id —— 绝不接受路径或命令（R15）
    if (bad.length > 0) return { error: `unknown suite id(s): ${bad.join(', ')}`, allowed: [...allowed] }
    params.only = cleaned
  }

  if (body.__parseError !== undefined) return { error: `invalid JSON body: ${body.__parseError}` }
  return { params }
}

  const jobView = (job, includeReport) => ({
    id: job.id,
    status: job.status,
    // 队列积压长度：确定性、可断言。
    // （曾试图报"前面还有几个未完成 job"，但短套件会在响应构造前就跑完，
    //   该值随查询时机变化，既不稳定也无法断言，故改为直接暴露队列长度。）
    queueDepth: queue.length,
    running: runningJobId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    params: job.params,
    progress: job.progress,
    error: job.error,
    summary: job.report
      ? {
          overall: job.report.overall,
          suitesPassed: job.report.suitesPassed,
          suitesFailed: job.report.suitesFailed,
          suitesSkipped: job.report.suitesSkipped,
          checksOk: job.report.checksOk,
          checksBad: job.report.checksBad,
          durationMs: job.report.durationMs,
          guaranteesNotProvided: job.report.guaranteesNotProvided,
        }
      : undefined,
    report: includeReport ? job.report : undefined,
  })

function renderLog(job) {
  const lines = [`job ${job.id}  status=${job.status}`]
  if (job.error) lines.push(`error: ${job.error}`)
  if (job.report) {
    lines.push(`overall=${job.report.overall}  checks ${job.report.checksOk} ok / ${job.report.checksBad} bad`)
    lines.push('')
    for (const s of job.report.suites) {
      lines.push(
        `[${String(s.status).padEnd(22)}] ${s.id.padEnd(16)} ${String(s.durationMs).padStart(6)} ms  ` +
          `${s.checksOk} ok / ${s.checksBad} bad` +
          (s.coverage !== undefined ? `  coverage=${s.coverage}%` : ''),
      )
      if (s.status === 'FAIL') {
        if (s.spawnError) lines.push(`      spawnError: ${s.spawnError}`)
        for (const f of s.failDetails ?? []) lines.push(`      ✗ ${f.id}: ${f.detail}`)
        for (const l of (s.tail ?? []).slice(-12)) lines.push(`      | ${l}`)
      }
    }
    lines.push('')
    lines.push('仍未提供的保证：')
    for (const g of job.report.guaranteesNotProvided) lines.push(`  - ${g}`)
  } else if (job.progress.length > 0) {
    lines.push('progress:')
    for (const p of job.progress) lines.push(`  ${p.id} -> ${p.status}`)
  }
  return `${lines.join('\n')}\n`
}

// ── 路由 ────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  // R13：只接受本机来源（即使被代理也不放行外部地址）
  const remote = req.socket.remoteAddress ?? ''
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!isLocal) {
    return send(res, 403, { error: 'forbidden: this service only serves loopback clients' })
  }

  // 健康检查不需要令牌，便于探活
  if (path === '/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      service: 'WinStageSandbox test service',
      running: runningJobId,
      queueDepth: queue.length,
      jobs: jobs.size,
      suites: [...ALL_SUITE_IDS, 'audit'],
      uptimeMs: Math.round(process.uptime() * 1000),
    })
  }

  // R14：其余全部要求 Bearer 令牌
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: 'unauthorized: pass "Authorization: Bearer <token>"' })
  }

  if (path === '/suites' && req.method === 'GET') {
    return send(res, 200, { suites: [...ALL_SUITE_IDS, 'audit'] })
  }

  if (path === '/run' && req.method === 'POST') {
    const body = await readBody(req)
    const built = buildParams(url, body)
    if (built.error) return send(res, 400, built)
    mkdirSync(join(REPO, '.t'), { recursive: true })

    const async_ = body.await === false || url.searchParams.get('wait') === '0'
    const job = newJob(built.params)
    // 在入队**之前**取快照：`pump()` 是异步的，入队后可能立刻把该 job 转成 running，
    // 于是 POST 的响应会显示 running 而非 queued（曾造成"并发保护失效"的误判）。
    const createdView = jobView(job, false)
    enqueue(job)
    if (async_) return send(res, 202, { jobId: job.id, statusUrl: `/jobs/${job.id}`, view: createdView })

    // 同步等待完成（轮询 job 状态；与 executeJob 解耦，避免竞态）
    await waitForJob(job)
    return send(res, job.status === 'failed' ? 500 : 200, jobView(job, true))
  }

  if (path === '/jobs' && req.method === 'POST') {
    const body = await readBody(req)
    const built = buildParams(url, body)
    if (built.error) return send(res, 400, built)
    const job = newJob(built.params)
    // 同上：先取快照再入队
    const createdView = jobView(job, false)
    enqueue(job)
    return send(res, 202, { jobId: job.id, statusUrl: `/jobs/${job.id}`, view: createdView })
  }

  if (path === '/jobs' && req.method === 'GET') {
    const list = [...jobs.values()].map((j) => jobView(j, false))
    return send(res, 200, { count: list.length, jobs: list })
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)$/)
  if (jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) return send(res, 404, { error: `no such job: ${jobMatch[1]}` })
    if (req.method === 'GET') return send(res, 200, jobView(job, true))
    if (req.method === 'DELETE') {
      if (job.status === 'running') {
        // 不强行 kill 子进程（避免留下半个沙箱），只标记；当前套件跑完后不再继续
        job.status = 'cancelled'
        return send(res, 202, { jobId: job.id, status: 'cancelled (in-flight suite will finish)' })
      }
      job.status = 'cancelled'
      job.finishedAt = job.finishedAt ?? new Date().toISOString()
      return send(res, 200, jobView(job, false))
    }
    return send(res, 405, { error: 'method not allowed' })
  }

  const logMatch = path.match(/^\/jobs\/([^/]+)\/log$/)
  if (logMatch && req.method === 'GET') {
    const job = jobs.get(logMatch[1])
    if (!job) return send(res, 404, { error: `no such job: ${logMatch[1]}` })
    return send(res, 200, renderLog(job), 'text/plain; charset=utf-8')
  }

  if (path === '/report/latest' && req.method === 'GET') {
    const done = [...jobs.values()].filter((j) => j.report).pop()
    if (!done) return send(res, 404, { error: 'no completed report yet' })
    return send(res, 200, done.report)
  }

  const suiteReportMatch = path.match(/^\/report\/latest\/([^/]+)$/)
  if (suiteReportMatch && req.method === 'GET') {
    const done = [...jobs.values()].filter((j) => j.report).pop()
    if (!done) return send(res, 404, { error: 'no completed report yet' })
    const suite = done.report.suites.find((s) => s.id === suiteReportMatch[1])
    if (!suite) return send(res, 404, { error: `no such suite in latest report: ${suiteReportMatch[1]}` })
    return send(res, 200, suite)
  }

  return send(res, 404, { error: `not found: ${req.method} ${path}` })
})

function waitForJob(job, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        clearInterval(timer)
        resolvePromise()
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolvePromise()
      }
    }, 150)
  })
}

server.listen(args.port, args.host, () => {
  log('================================================================')
  log(' WinStageSandbox 自动测试服务')
  log(` 监听    : http://${args.host}:${args.port}`)
  log(` 令牌    : ${TOKEN}`)
  log(` 套件    : ${[...ALL_SUITE_IDS, 'audit'].join(', ')}`)
  log(' 安全边界: 仅回环 (R13) · 强制令牌 (R14) · 套件白名单 (R15) · 串行执行 (R16)')
  log('================================================================')
  log('')
  log('示例：')
  log(`  curl -s -H "Authorization: Bearer ${TOKEN}" \\`)
  log(`       -H "content-type: application/json" \\`)
  log(`       -d '{}' http://${args.host}:${args.port}/run`)
  log('')
})

process.on('SIGINT', () => {
  log('\n收到 SIGINT，退出')
  process.exit(0)
})
