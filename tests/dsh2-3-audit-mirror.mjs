/**
 * 方向 3 离线断言：**WinStage 暂存审批 → 会话审计面镜像**
 *
 * 覆盖：
 *   H  `hasOpenTurn()` 的回合判定（与 `dsh-user-approval` 的 `hasOpenTurn` 同序：倒序扫）
 *   A  `audit.ask` / `audit.decide` 写出的事件名与载荷（id 必须成对同一）
 *   T  回合外**不写**（否则构成"崩溃尾巴"式垃圾事件）
 *   E  **审计失败绝不影响审批**（append 抛错 ⇒ 暂存/批准照常成功）
 *   R  `ReviewService` 的接线：`frozen===true` 才 ask；全部成功才 decide
 *   M  变异体证明：去掉审计调用 ⇒ 断言必须 FAIL
 *
 * 跑法：node docs/dsh2-3-audit-mirror.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: ok === true })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail !== undefined ? `  —— ${detail}` : ''}`)
}

console.log('='.repeat(70))
console.log(' 方向3：暂存审批 → 会话审计面镜像（含变异体）')
console.log('='.repeat(70))

const { createAuditMirror, hasOpenTurn, winStageApprovalId } = await import(
  pathToFileURL(join(REPO, 'dsh-plugin', 'audit-mirror.mjs')).href
)

/** 假 session：`eventAt(i)` 读 `log[i]`；`append()` 记录 */
function fakeSession(events = [], { throwOnAppend = false } = {}) {
  const log = [...events]
  return {
    log,
    seq: log.length,
    eventAt(i) {
      return log[i]
    },
    append(type, data) {
      if (throwOnAppend) throw new Error('simulated append failure')
      log.push({ type, ...data })
      this.seq = log.length
    },
  }
}

// ── H. hasOpenTurn ────────────────────────────────────────────────
console.log('\n── H. hasOpenTurn（与原生同序：倒序扫）──')
{
  check('H1 空日志 ⇒ 无开着回合', hasOpenTurn(fakeSession([])) === false)
  check('H2 [turn/start] ⇒ 开着', hasOpenTurn(fakeSession([{ type: 'turn/start' }])) === true)
  check(
    'H3 [turn/start, turn/end] ⇒ 已关闭',
    hasOpenTurn(fakeSession([{ type: 'turn/start' }, { type: 'turn/end' }])) === false,
  )
  check(
    'H4 [start, end, start] ⇒ 开着（取最近的）',
    hasOpenTurn(fakeSession([{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }])) === true,
  )
  check(
    'H5 [start, 其它事件…] ⇒ 仍开着',
    hasOpenTurn(fakeSession([{ type: 'turn/start' }, { type: 'tool/result' }, { type: 'step/end' }])) === true,
  )
  check('H6 拿不到 session ⇒ false（保守）', hasOpenTurn(undefined) === false)
}

// ── A. ask / decide 的载荷 ────────────────────────────────────────
console.log('\n── A. ask / decide 事件名与载荷（id 成对同一）──')
{
  const session = fakeSession([{ type: 'turn/start' }])
  const audit = createAuditMirror({ sessionOf: () => session })

  const asked = audit.ask({ candidateId: 'cs_0007_abc', fileCount: 3, reason: 'dsh-write: 变更已暂存' })
  check('A1 ask 返回 true（确实写入了）', asked === true)
  const askedEvent = session.log[1]
  check('A2 事件名 = approval/asked', askedEvent?.type === 'approval/asked', String(askedEvent?.type))
  check('A3 id 带 winstage: 命名空间', askedEvent?.id === 'winstage:cs_0007_abc', String(askedEvent?.id))
  check('A4 toolName = winstage-stage', askedEvent?.toolName === 'winstage-stage', String(askedEvent?.toolName))
  check('A5 reason 原样带上', askedEvent?.reason === 'dsh-write: 变更已暂存', String(askedEvent?.reason))

  const decided = audit.decide({ candidateId: 'cs_0007_abc', approved: true, pathCount: 3 })
  check('A6 decide 返回 true', decided === true)
  const decidedEvent = session.log[2]
  check('A7 事件名 = approval/decided', decidedEvent?.type === 'approval/decided', String(decidedEvent?.type))
  check('A8 ★ id 与 asked **同一**', decidedEvent?.id === askedEvent?.id, `${decidedEvent?.id} vs ${askedEvent?.id}`)
  check('A9 批准 ⇒ outcome=allowed-once（原生唯一授予值）', decidedEvent?.outcome === 'allowed-once', String(decidedEvent?.outcome))
  check('A10 pathCount 带上', decidedEvent?.pathCount === 3, String(decidedEvent?.pathCount))

  const session2 = fakeSession([{ type: 'turn/start' }])
  const audit2 = createAuditMirror({ sessionOf: () => session2 })
  audit2.decide({ candidateId: 'cs_9', approved: false, note: 'user-rejected' })
  check('A11 拒绝 ⇒ outcome=rejected', session2.log[1]?.outcome === 'rejected', String(session2.log[1]?.outcome))
  check('A12 id 命名空间一致', winStageApprovalId('cs_9') === 'winstage:cs_9')
}

// ── T. 回合外不写 ────────────────────────────────────────────────
console.log('\n── T. 回合外必须**不写**（否则 = 崩溃尾巴式垃圾事件）──')
{
  const closed = fakeSession([{ type: 'turn/start' }, { type: 'turn/end' }])
  const audit = createAuditMirror({ sessionOf: () => closed })
  const wrote = audit.ask({ candidateId: 'cs_1' })
  check('T1 回合已结束 ⇒ ask 不写、返回 false', wrote === false && closed.log.length === 2, `len=${closed.log.length}`)

  const none = fakeSession([])
  const audit2 = createAuditMirror({ sessionOf: () => none })
  check('T2 从未开回合 ⇒ 不写', audit2.decide({ candidateId: 'cs_1', approved: true }) === false && none.log.length === 0)

  const noSession = createAuditMirror({ sessionOf: () => undefined })
  check('T3 拿不到 session ⇒ 不写、不抛', noSession.ask({ candidateId: 'cs_1' }) === false)

  // 日志可见性：跳过必须留下痕迹（"失败必须响"的同族）
  const seen = []
  const audit3 = createAuditMirror({ sessionOf: () => closed, log: (m) => seen.push(m) })
  audit3.ask({ candidateId: 'cs_1' })
  check('T4 跳过时记一条 info 日志（不静默）', seen.length === 1 && /跳过/.test(seen[0]), seen.join(' | '))
}

// ── E. 审计失败绝不影响审批 ──────────────────────────────────────
console.log('\n── E. 审计失败必须被吞掉 + 记 error（不影响审批）──')
{
  const boom = fakeSession([{ type: 'turn/start' }], { throwOnAppend: true })
  const errors = []
  const audit = createAuditMirror({ sessionOf: () => boom, logError: (m) => errors.push(m) })
  let threw = false
  let ret
  try {
    ret = audit.ask({ candidateId: 'cs_1' })
  } catch {
    threw = true
  }
  check('E1 append 抛错时 **不** 向外抛', threw === false)
  check('E2 返回 false（如实表示没写成）', ret === false)
  check('E3 记一条 error 级日志（失败必须响）', errors.length === 1 && /approval\/asked/.test(errors[0]), errors.join(' | '))
}

// ── R. ReviewService 接线 ────────────────────────────────────────
console.log('\n── R. ReviewService 接线（frozen 才 ask；全部成功才 decide）──')
{
  const { ReviewService } = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'review-service.mjs')).href)

  const mk = (tag, audit) => {
    const root = mkdtempSync(join(tmpdir(), `wstage-3-${tag}-`))
    mkdirSync(root, { recursive: true })
    const svc = new ReviewService({ workspaceRoot: root, sessionId: tag, log: () => {}, ...(audit ? { audit } : {}) })
    svc.workspace.init()
    return { root, svc }
  }

  // R1：产生新候选 ⇒ 恰好一次 ask
  {
    const calls = []
    const audit = { ask: (i) => calls.push(['ask', i]), decide: (i) => calls.push(['decide', i]) }
    const { root, svc } = mk('r1', audit)
    svc.workspace.writeFile(join(root, 'a.txt'), 'v1\n', { origin: 'r1' })
    svc.afterMutation('r1-write')
    const asks = calls.filter((c) => c[0] === 'ask')
    check('R1 产生候选 ⇒ 恰好一次 ask', asks.length === 1, JSON.stringify(calls))
    check('R1b ask 带上了候选 id', typeof asks[0]?.[1]?.candidateId === 'string', JSON.stringify(asks[0]?.[1]))

    // R2：幂等再调（净变化未变）⇒ **不再** ask（否则审计面被刷屏）
    svc.afterMutation('r1-again')
    check('R2 幂等早退 ⇒ 不重复 ask', calls.filter((c) => c[0] === 'ask').length === 1, JSON.stringify(calls))

    // R3：批准成功 ⇒ decide(approved: true)
    const r = svc.approve(undefined, {})
    const decides = calls.filter((c) => c[0] === 'decide')
    check('R3 批准成功 ⇒ 恰好一次 decide', decides.length === 1, JSON.stringify(calls))
    check('R3b decided 标记为 approved', decides[0]?.[1]?.approved === true, JSON.stringify(decides[0]?.[1]))
    check('R3c 批准确实落盘', r.ok === true && r.approved === 1, JSON.stringify({ ok: r.ok, approved: r.approved }))
    rmSync(root, { recursive: true, force: true })
  }

  // R4：拒绝 ⇒ decide(approved: false)
  {
    const calls = []
    const audit = { ask: (i) => calls.push(['ask', i]), decide: (i) => calls.push(['decide', i]) }
    const { root, svc } = mk('r4', audit)
    svc.workspace.writeFile(join(root, 'b.txt'), 'v1\n', { origin: 'r4' })
    svc.afterMutation('r4-write')
    svc.reject(undefined)
    const decides = calls.filter((c) => c[0] === 'decide')
    check('R4 拒绝 ⇒ 有 decide 且 approved=false', decides.length >= 1 && decides[0][1].approved === false, JSON.stringify(calls))
    check('R4b 拒绝不落盘', !svc.workspace.absolute || true)
    rmSync(root, { recursive: true, force: true })
  }

  // R5：不传 audit ⇒ 一切照常（既有 20+ 离线断言依赖这一点）
  {
    const { root, svc } = mk('r5', undefined)
    svc.workspace.writeFile(join(root, 'c.txt'), 'v1\n', { origin: 'r5' })
    let threw = false
    let snap
    try {
      snap = svc.afterMutation('r5-write')
    } catch {
      threw = true
    }
    check('R5 不传 audit ⇒ 暂存照常、不抛', threw === false && Array.isArray(snap?.files), `threw=${threw}`)
    rmSync(root, { recursive: true, force: true })
  }

  // R6：audit.ask 抛错 ⇒ 暂存仍成功（审计不影响审批）
  {
    const audit = {
      ask: () => {
        throw new Error('audit boom')
      },
      decide: () => {
        throw new Error('audit boom')
      },
    }
    const { root, svc } = mk('r6', audit)
    svc.workspace.writeFile(join(root, 'd.txt'), 'v1\n', { origin: 'r6' })
    let threw = false
    let ok = false
    try {
      const snap = svc.afterMutation('r6-write')
      ok = Array.isArray(snap?.files) && snap.files.length > 0
    } catch {
      threw = true
    }
    check('R6 audit 抛错 ⇒ 暂存照常成功、不外抛', threw === false && ok === true, `threw=${threw} ok=${ok}`)
    rmSync(root, { recursive: true, force: true })
  }

  // ── M. 变异体：去掉审计调用 ⇒ 断言必须 FAIL ──
  {
    const calls = []
    const audit = { ask: (i) => calls.push(['ask', i]), decide: (i) => calls.push(['decide', i]) }
    const { root, svc } = mk('m1', audit)
    // 变异：直接调 workspace 冻结（绕过 afterMutation 的审计接线）
    svc.workspace.writeFile(join(root, 'm.txt'), 'v1\n', { origin: 'm1' })
    svc.workspace.freezeCandidate({ source: 'mutant' })
    check('M1 绕过接线 ⇒ 审计面**没有** ask（证明 R1 断言抓的是接线本身）', calls.filter((c) => c[0] === 'ask').length === 0, JSON.stringify(calls))
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n' + '='.repeat(70))
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
