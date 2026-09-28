/**
 * testrunner.mjs — 测试运行核心（可复用）
 *
 * 为什么抽成模块：`autotest.mjs`（CLI）与 `testservice.mjs`（HTTP 服务）必须使用
 * **同一份套件清单与同一份判定逻辑**。否则两处会漂移，出现"CLI 说通过、服务说失败"
 * 这种最难查的不一致（手册第 2 章"唯一权威"的同一道理：
 * 两条消费路径必须走同一份投影）。
 *
 * 关于子进程输出捕获（重要，见残余边界 R10/#15）：
 *   受限令牌下 `spawnSync` 默认的 `stdio: 'pipe'` 走**命名管道**，客户端打开请求需要
 *   受限 SID 未被授予的写权限 → 子进程创建直接 EPERM。
 *   因此这里把 stdout/stderr **重定向到文件描述符**，完全绕开命名管道。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 离线确定性套件：不需要沙箱、不需要管理员，任何会话都能跑 */
export const OFFLINE_SUITES = [
  { id: 'selftest', script: 'tests/selftest.mjs', title: '手册不变量（统一视图/删除权威/候选冻结/选择性应用/遮蔽/返回语义）' },
  { id: 'e2e-flow', script: 'tests/e2e-flow.mjs', title: '端到端链路（捕获→冻结→diff→选择性提交）' },
  { id: 'struct-layout', script: 'tests/struct-layout.mjs', title: '结构体布局（大小/偏移/越界/扩展限制/环境块编码）' },
  { id: 'appcontainer-layout', script: 'tests/appcontainer-layout.mjs', title: 'AppContainer 布局（STARTUPINFOEX/SECURITY_CAPABILITIES/创建标志）' },
  { id: 'resolve-exec', script: 'tests/resolve-exec.mjs', title: '可执行文件解析（PATHEXT/相对与绝对路径/失败显式化）' },
  { id: 'executor-stub', script: 'tests/executor-stub.mjs', title: '执行器编排（装配/spawn 契约/0x400/Job 配额/结果收集/fail-closed）' },
  { id: 'audit-parse', script: 'tests/audit-parse.mjs', title: '审计解析（哨兵/空输出必须判 fail/单引号转义）' },
  // 元测试：反证"运行器真的能检出失败"。永远报绿的运行器比没有运行器更糟。
  { id: 'meta-runner', script: 'tests/meta-runner.mjs', title: '元测试（运行器能否检出失败）' },
]

/** 需要未受限会话的套件 */
export const SANDBOX_SUITES = [
  { id: 'diag-bindings', script: 'tests/diag-bindings.mjs', title: '绑定表契约 + 完整 init' },
]

/** 全部套件（含沙箱段），供白名单与文档使用 */
export const ALL_SUITE_IDS = [...OFFLINE_SUITES, ...SANDBOX_SUITES].map((s) => s.id)

/**
 * 运行一个子进程并捕获输出（fd 重定向，绕开命名管道）。
 * @returns {{status:number|null, signal:string|null, error:Error|undefined, text:string, durationMs:number}}
 */
export function runCaptured(command, argv, options = {}) {
  const outFile = options.outFile
  mkdirSync(dirname(outFile), { recursive: true })
  const fd = openSync(outFile, 'w')
  const started = Date.now()
  let result
  try {
    result = spawnSync(command, argv, {
      cwd: options.cwd ?? REPO,
      timeout: options.timeout ?? 600000,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: options.env,
    })
  } finally {
    closeSync(fd)
  }
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    text,
    durationMs: Date.now() - started,
  }
}

function countChecks(text) {
  return {
    ok: (text.match(/✓/g) ?? []).length,
    bad: (text.match(/✗/g) ?? []).length,
  }
}

function verdictLineOf(text) {
  return (
    text
      .split(/\r?\n/)
      .filter((l) => /RESULT|判定:|全部通过|诊断结论|元测试：/.test(l))
      .pop() ?? ''
  )
}

/**
 * 运行一个普通套件。
 * @param {{id:string,script:string,title:string}} suite
 * @param {{outDir:string, workspace:string, kind?:string, timeout?:number, onEvent?:(e:object)=>void}} ctx
 */
export function runSuite(suite, ctx) {
  const outFile = join(ctx.outDir, `run-${suite.id}.txt`)
  const run = runCaptured(process.execPath, [join(REPO, suite.script)], {
    cwd: REPO,
    timeout: ctx.timeout ?? 300000,
    outFile,
    // 有些套件需要显式工作区根（diag-bindings 用 STAGING）。
    // 不传会让它因"未指定 stagingRoot"跳过，从而**掩盖**真正的嵌套边界原因。
    env: { ...process.env, STAGING: join(ctx.workspace, '.dshstage', 'staged') },
  })
  const { ok, bad } = countChecks(run.text)
  const status = run.error || run.status !== 0 ? 'FAIL' : 'PASS'
  ctx.onEvent?.({ type: 'suite-start', id: suite.id })
  return {
    id: suite.id,
    title: suite.title,
    kind: ctx.kind ?? 'offline',
    status,
    exitCode: run.status,
    spawnError: run.error ? String(run.error.code || run.error.message) : undefined,
    signal: run.signal ?? undefined,
    durationMs: run.durationMs,
    checksOk: ok,
    checksBad: bad,
    verdictLine: verdictLineOf(run.text),
    outputFile: outFile,
    tail: run.text.split(/\r?\n/).filter(Boolean).slice(-25),
  }
}

/**
 * 运行沙箱内审计（结构化 JSON）。
 *
 * 判定规则（重要）：
 *   - 有 fail ⇒ FAIL
 *   - 覆盖度极低且全是 not-run ⇒ SKIPPED-NESTING-LIMIT（机制边界，不算失败也不算通过）
 *   - 否则 PASS
 * 把"跳过"与"通过"分开，是手册第 17 章要求的诚实性：
 *   0% 覆盖的"无 fail"不构成任何保证。
 */
export function runAudit(ctx) {
  const jsonFile = join(ctx.outDir, 'run-audit.json')
  const run = runCaptured(
    process.execPath,
    [join(REPO, 'src', 'cli.mjs'), 'audit', '--workspace', ctx.workspace, '--json'],
    { cwd: REPO, timeout: ctx.timeout ?? 600000, outFile: jsonFile },
  )

  let audit
  const i = run.text.indexOf('{')
  const j = run.text.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      audit = JSON.parse(run.text.slice(i, j + 1))
    } catch {
      audit = undefined
    }
  }

  if (!audit) {
    return {
      id: 'audit',
      title: '沙箱内真实攻击探针',
      kind: 'insandbox',
      status: 'FAIL',
      exitCode: run.status,
      spawnError: run.error ? String(run.error.code || run.error.message) : undefined,
      durationMs: run.durationMs,
      checksOk: 0,
      checksBad: 0,
      verdictLine: 'audit produced no parsable JSON',
      outputFile: jsonFile,
      tail: run.text.split(/\r?\n/).filter(Boolean).slice(-25),
    }
  }

  const s = audit.summary ?? {}
  const nestingLimited =
    audit.verdict === 'inconclusive-no-evidence' ||
    (audit.coverage <= 20 && (s['not-run'] ?? 0) > 0 && (s.fail ?? 0) === 0)
  const status = (s.fail ?? 0) > 0 ? 'FAIL' : nestingLimited ? 'SKIPPED-NESTING-LIMIT' : 'PASS'
  const fails = (audit.findings ?? []).filter((f) => f.status === 'fail')

  return {
    id: 'audit',
    title: '沙箱内真实攻击探针',
    kind: 'insandbox',
    status,
    exitCode: run.status,
    durationMs: run.durationMs,
    checksOk: s.pass ?? 0,
    checksBad: s.fail ?? 0,
    coverage: audit.coverage,
    verdict: audit.verdict,
    residual: s.residual ?? 0,
    notRun: s['not-run'] ?? 0,
    sandboxUsable: audit.sandboxUsable,
    verdictLine: `coverage=${audit.coverage}% verdict=${audit.verdict}`,
    outputFile: jsonFile,
    failDetails: fails.map((f) => ({ id: f.id, detail: String(f.detail).slice(0, 300) })),
  }
}

/**
 * 按手册第 17 章汇总"仍未提供的保证"。
 * 版本出口必须同时给出实际结果**与**仍未提供的保证，不能只报通过。
 */
export function summarise(suites, audit) {
  const checksOk = suites.reduce((n, s) => n + (s.checksOk ?? 0), 0)
  const checksBad = suites.reduce((n, s) => n + (s.checksBad ?? 0), 0)
  const failed = suites.filter((s) => s.status === 'FAIL')
  const skipped = suites.filter((s) => String(s.status).startsWith('SKIPPED'))
  const passed = suites.filter((s) => s.status === 'PASS')

  const overall = failed.length > 0 ? 'FAIL' : audit?.status === 'SKIPPED-NESTING-LIMIT' ? 'PASS-OFFLINE-ONLY' : 'PASS'

  const guaranteesNotProvided = []
  if (audit?.status === 'SKIPPED-NESTING-LIMIT') {
    guaranteesNotProvided.push('沙箱内读/写/删边界的实测证据（当前会话受限，无法嵌套；需未受限会话复跑）')
  }
  if ((audit?.residual ?? 0) > 0) {
    guaranteesNotProvided.push(`读取面收敛：本后端限制写/删但不限制读取，${audit.residual} 项属残余边界 R1`)
  }
  guaranteesNotProvided.push(
    '网络硬阻断（受限令牌与 ACL 均不涉及网络；需 WFP 或 AppContainer 能力管控）',
    '操作系统级一次性隔离（本机为 Server 血统，Containers-DisposableClientVM 不存在）',
  )

  return {
    overall,
    suitesTotal: suites.length,
    suitesPassed: passed.length,
    suitesFailed: failed.length,
    suitesSkipped: skipped.length,
    checksOk,
    checksBad,
    guaranteesNotProvided,
  }
}

/**
 * 运行全部套件。
 * @param {{workspace?:string, outDir?:string, skipAudit?:boolean, only?:string[], timeout?:number, onEvent?:(e:object)=>void}} options
 * @returns {Promise<object>} 报告对象（与 CLI 的 test-report.json 同构）
 */
export async function runAll(options = {}) {
  const workspace = resolve(options.workspace ?? join(REPO, '.t', 'ws'))
  const outDir = resolve(options.outDir ?? join(REPO, '.t'))
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  const wanted = options.only && options.only.length > 0 ? new Set(options.only) : undefined
  const startedAt = Date.now()
  const suites = []

  const selected = (list) => (wanted ? list.filter((s) => wanted.has(s.id)) : list)
  const offline = selected(OFFLINE_SUITES)
  const sandbox = selected(SANDBOX_SUITES)
  const wantAudit = !options.skipAudit && (!wanted || wanted.has('audit'))

  for (const suite of offline) {
    options.onEvent?.({ type: 'suite-begin', id: suite.id, title: suite.title })
    const r = runSuite(suite, { outDir, workspace, kind: 'offline', timeout: options.timeout, onEvent: options.onEvent })
    suites.push(r)
    options.onEvent?.({ type: 'suite-end', id: suite.id, status: r.status })
  }
  for (const suite of sandbox) {
    options.onEvent?.({ type: 'suite-begin', id: suite.id, title: suite.title })
    const r = runSuite(suite, { outDir, workspace, kind: 'insandbox', timeout: options.timeout, onEvent: options.onEvent })
    suites.push(r)
    options.onEvent?.({ type: 'suite-end', id: suite.id, status: r.status })
  }

  let audit
  if (wantAudit) {
    options.onEvent?.({ type: 'suite-begin', id: 'audit', title: '沙箱内真实攻击探针' })
    audit = runAudit({ outDir, workspace, timeout: options.timeout })
    suites.push(audit)
    options.onEvent?.({ type: 'suite-end', id: 'audit', status: audit.status })
  }

  const summary = summarise(suites, audit)
  return {
    tool: 'WinStageSandbox test runner',
    time: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    node: process.execPath,
    repo: REPO,
    workspace,
    ...summary,
    suites,
  }
}
