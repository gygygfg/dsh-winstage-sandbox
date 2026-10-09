#!/usr/bin/env node
/**
 * 缺陷③ 回归套件 —— "T0 污染让 T1 暂存写永久失效 + 静默降级" 的 fail-closed 与修复路径
 *
 * ── 被钉死的三件事（对应任务书的 Fix A / B / C）────────────────────────────────
 *   Fix A（安全）：`init()` 的自检已经测出"暂存根写不进去"，执行器**必须拒绝运行**
 *                  （typed error + 非零退出），绝不"照跑命令并返回 0"。
 *   Fix B（恢复）：`init` 侧的修复路径必须能发现并摘掉上一次 T0 留在暂存根上的
 *                  AppContainer 包 SID ACE（`S-1-15-2-…:(OI)(CI)(M)`），让 T1 重新可写；
 *                  摘不干净 / 读不到 DACL 要**如实报**，不许假装修好。
 *   Fix C（预防）：授予这条 ACE 的调用点（`executor.mjs::AppContainerLauncher.attachRuntime`）
 *                  必须注册退出兜底撤销 —— 因为 `src/cli.mjs` 在 `try` 里直接
 *                  `process.exit()`，`finally { dispose() }` 根本不会执行。
 *
 * ── 判据来自哪里（不许在本文件重写）─────────────────────────────────────────────
 *   - SDDL 判据：`src/appcontainer.mjs::findStaleAppContainerAces`
 *   - 判定闸门：`src/executor.mjs::WindowsStageExecutor.stagingWriteEnforceability`
 *   - 修复落地：`src/executor.mjs::repairStaleAppContainerAces`
 *   本套件只**喂输入、断言输出**；重复实现判据会让"测的"和"跑的"漂移。
 *
 * ── 两段结构 ────────────────────────────────────────────────────────────────────
 *   A 段（离线确定性）：纯 SDDL 解析 + 判定 + 用替身 `icacls` 跑修复命令 +
 *                       用替身执行器端到端验证"降级 ⇒ run() 拒绝且未 spawn"。
 *                       零真实 ACL 写入、零真实子进程 ⇒ 任何会话都能跑（进 verify.cmd）。
 *   B 段（真机 ACL）：真的往临时暂存根注入一条"不存在的包 SID"ACE，确认
 *                     ① 它真的会让受限令牌写不进去（复现污染形态）
 *                     ② 修复路径真的摘得掉（自愈）
 *                     ③ 污染态下真 `run()` 真的拒绝执行（Fix A 端到端）
 *                     本段**只在未受限会话**里跑；决定不了就如实 SKIP 并打印原因
 *                     （本项目纪律：读不到 ≠ 挡住了，测不了 ≠ 通过）。
 *
 * 用法：
 *   node tests\boundary-degraded-failclosed.mjs            # 常跑
 *   node tests\boundary-degraded-failclosed.mjs --plant    # 反向验证：本套件能不能检出缺陷
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APPCONTAINER_PACKAGE_SID_PREFIX,
  findStaleAppContainerAces,
  isAppContainerPackageSid,
  listAppContainerSids,
  parseSddlDaclAces,
} from '../src/appcontainer.mjs'
import { WindowsStageExecutor, readDaclSddl, repairStaleAppContainerAces } from '../src/executor.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLANT = process.argv.includes('--plant')

let assertions = 0
let failures = 0
const skips = []

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}
function check(label, condition, evidence) {
  assertions += 1
  if (condition) {
    process.stdout.write(`  [OK  ] ${label}\n`)
  } else {
    failures += 1
    process.stdout.write(`  [FAIL] ${label}\n`)
  }
  if (evidence !== undefined) {
    process.stdout.write(`      证据: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}\n`)
  }
}
function skip(label, reason) {
  skips.push(label)
  process.stdout.write(`  SKIP ${label} — ${reason}\n`)
}

// ───────────────────────────────────────────────────────────────────────────
// A 段：离线确定性（判据 + 判定 + 修复命令构造 + run() 闸门）
// ───────────────────────────────────────────────────────────────────────────

/** 与审计现场同形的 SDDL（取自实测输出 `.t\fix3-repro\diag-acl-broken.txt`） */
const ACE_GOOD = '(A;OICI;0x110156;;;S-1-4-133677122-514748127)'
const ACE_STALE =
  '(A;OICI;0x1301bf;;;S-1-15-2-2541843839-1445201769-316974988-186645399-2929155336-2163906706-1690789193)'
const ACE_STALE_2 =
  '(A;OICI;0x1301bf;;;S-1-15-2-1111111111-2222222222-3333333333-4444444444-5555555555-6666666666-7777777777)'
const ACE_INHERITED_STALE =
  '(A;OICIID;0x1301bf;;;S-1-15-2-9999999999-8888888888-7777777777-6666666666-5555555555-4444444444-3333333333)'
const ACE_DENY_PACKAGE =
  '(D;OICI;0x10000000;;;S-1-15-2-2541843839-1445201769-316974988-186645399-2929155336-2163906706-1690789193)'

function sddl(...aces) {
  return `O:BAG:S-1-5-21-1478766094-322448298-344569854-513D:AI(D;CI;DT;;;WD)${aces.join('')}`
}

function healthyReport() {
  return {
    checks: [
      { name: 'inside-staging-write-allowed', status: 'pass', detail: 'ok' },
      { name: 'outside-staging-write-denied', status: 'pass', detail: 'denied' },
      { name: 'system-dir-write-denied', status: 'pass', detail: 'denied' },
      { name: 'temp-rewritten-to-private', status: 'pass', detail: 'TEMP=…' },
      { name: 'sensitive-env-not-inherited', status: 'pass', detail: 'present=false' },
      { name: 'system-file-read', status: 'documented-residual', detail: '读取成功（手册 #16.10 残余）' },
      { name: 'job-object-accounting', status: 'pass', detail: 'active=0' },
    ],
    enforcement: 'partial',
    observed: { inside: 'ok', outside: 'denied', system: 'denied', readSystem: 'ok', secret: true },
  }
}

function degradedReport() {
  const report = healthyReport()
  report.checks[0] = { name: 'inside-staging-write-allowed', status: 'fail', detail: 'denied' }
  report.enforcement = 'degraded'
  report.observed.inside = 'denied'
  return report
}

section('A1. SDDL 判据：只认"显式写入的 AppContainer 包 SID 允许 ACE"')
{
  const parsed = parseSddlDaclAces(sddl(ACE_GOOD, ACE_STALE))
  check('SDDL 解析出 3 条 ACE（DACL 控制位不误判成 ACE）', parsed.aces.length === 3, parsed.aces.map((a) => a.source))
  const found = findStaleAppContainerAces(sddl(ACE_GOOD, ACE_STALE))
  check('陈旧包 SID ACE 被点名', found.stale.length === 1 && found.stale[0].sid.endsWith('1690789193'), found.stale.map((a) => a.sid))
  check('非包 SID 的普通 ACE 不被误判', findStaleAppContainerAces(sddl(ACE_GOOD)).stale.length === 0, findStaleAppContainerAces(sddl(ACE_GOOD)).stale)
  check(
    '继承来的包 SID ACE 不动（那不属于本次污染）',
    findStaleAppContainerAces(sddl(ACE_INHERITED_STALE)).stale.length === 0,
    findStaleAppContainerAces(sddl(ACE_INHERITED_STALE)).stale,
  )
  check(
    'DENY 型包 SID ACE 不动（本仓库从不写 DENY，删了会改变别人的意图）',
    findStaleAppContainerAces(sddl(ACE_DENY_PACKAGE)).stale.length === 0,
    findStaleAppContainerAces(sddl(ACE_DENY_PACKAGE)).stale,
  )
  check(
    'S-1-15-3-*（能力 SID）与段数不对的 SID 都不算包 SID',
    !isAppContainerPackageSid('S-1-15-3-1') &&
      !isAppContainerPackageSid('S-1-15-1-1-2-3-4-5-6-7') &&
      // 真实包 SID 是前缀 + **7** 段（这里用 off-by-one 抓过一次真实缺陷，别改成 8 段）
      isAppContainerPackageSid(`${APPCONTAINER_PACKAGE_SID_PREFIX}1-2-3-4-5-6-7`),
    {
      capability: isAppContainerPackageSid('S-1-15-3-1'),
      realShape: isAppContainerPackageSid(`${APPCONTAINER_PACKAGE_SID_PREFIX}1-2-3-4-5-6-7`),
    },
  )
  check(
    'listAppContainerSids 连继承 ACE 一起列出（供报告如实写出）',
    listAppContainerSids(sddl(ACE_STALE, ACE_INHERITED_STALE)).length === 2,
    listAppContainerSids(sddl(ACE_STALE, ACE_INHERITED_STALE)),
  )
  const multi = findStaleAppContainerAces(sddl(ACE_STALE, ACE_STALE_2))
  check('多条陈旧 ACE 全部被点名（不只看第一条）', multi.stale.length === 2, multi.stale.map((a) => a.sid))
}

section('A2. Fix A 判定：fail / unmeasured 一律不是 pass')
{
  const healthy = WindowsStageExecutor.stagingWriteEnforceability(healthyReport(), { lane: 'sandbox' })
  check('干净自检 ⇒ verdict=pass', healthy.verdict === 'pass', healthy)
  check('pass 时不带 failedChecks', healthy.failedChecks.length === 0, healthy.failedChecks)

  const bad = WindowsStageExecutor.stagingWriteEnforceability(degradedReport(), { lane: 'sandbox' })
  check('自检测出 denied ⇒ verdict=fail', bad.verdict === 'fail', bad)
  check('fail 时指明是哪条判据', bad.failedChecks[0]?.name === 'inside-staging-write-allowed', bad.failedChecks)
  check('fail 的原因里带 detail=denied', /denied/.test(bad.reason), bad.reason)

  const empty = WindowsStageExecutor.stagingWriteEnforceability(
    { checks: [{ name: 'job-object-accounting', status: 'pass' }], enforcement: 'degraded' },
    { lane: 'sandbox' },
  )
  check('没有任何相关判据 ⇒ verdict=unmeasured（绝不默认放行）', empty.verdict === 'unmeasured', empty)
  check('unmeasured 时点名缺哪条判据', empty.missingChecks.includes('inside-staging-write-allowed'), empty.missingChecks)

  const noReport = WindowsStageExecutor.stagingWriteEnforceability(undefined, { lane: 'sandbox' })
  check('完全没有自检报告 ⇒ verdict=unmeasured', noReport.verdict === 'unmeasured', noReport)

  const residualOnly = healthyReport()
  residualOnly.checks = residualOnly.checks.filter((c) => c.name !== 'inside-staging-write-allowed')
  residualOnly.checks.push({ name: 'system-file-read', status: 'documented-residual', detail: '残余边界' })
  const missing = WindowsStageExecutor.stagingWriteEnforceability(residualOnly, { lane: 'sandbox' })
  check('只有 documented-residual 不算 pass（那条判据根本没测）', missing.verdict === 'unmeasured', missing)

  const shimMissing = WindowsStageExecutor.stagingWriteEnforceability(
    { checks: [{ name: 'outside-write-staged-not-real', status: 'pass', detail: 'ok' }], enforcement: 'shim-user-mode' },
    { lane: 'shim' },
  )
  check('shim 通道按 shim 判据清单判定（不误用沙箱清单）', shimMissing.verdict === 'unmeasured', shimMissing)

  const shimOk = WindowsStageExecutor.stagingWriteEnforceability(
    {
      checks: [
        { name: 'transparent-capability-canary', status: 'pass', detail: 'ok' },
        { name: 'outside-write-staged-not-real', status: 'pass', detail: 'ok' },
        { name: 'no-dsh-sandbox-trace', status: 'pass', detail: 'ok' },
      ],
      enforcement: 'shim-user-mode',
    },
    { lane: 'shim' },
  )
  check('shim 通道判据齐了 ⇒ pass', shimOk.verdict === 'pass', shimOk)
}

section('A3. Fix B 修复落地：命令形状正确 + 幂等 + 失败如实上报')
{
  const before = sddl(ACE_GOOD, ACE_STALE)
  const after = sddl(ACE_GOOD)
  const calls = []
  let reads = 0
  const result = repairStaleAppContainerAces('X:\\fake\\staged', {
    readSddl: () => {
      reads += 1
      return { ok: true, sddl: reads === 1 ? before : after }
    },
    runIcacls: (args) => {
      calls.push(args)
      return { ok: true, detail: 'processed file' }
    },
  })
  check('修复真的调用 icacls /remove:g', calls.length === 1 && calls[0][1] === '/remove:g', calls)
  check(
    '命令里带 `*<包 SID>`（不带 * 会被当账户名解析）',
    calls[0][2] === `*${findStaleAppContainerAces(before).stale[0].sid}`,
    calls[0][2],
  )
  check('修复后 repaired=true 且 removed 记下 SID', result.repaired === true && result.removed.length === 1, result)
  check('修复前读了 DACL、修复后复读验证（2 次）', reads === 2, reads)

  const clean = repairStaleAppContainerAces('X:\\fake\\staged', {
    readSddl: () => ({ ok: true, sddl: after }),
    runIcacls: () => {
      throw new Error('干净目录不该调用 icacls')
    },
  })
  check('干净目录：一条命令都不发', clean.repaired === false && clean.sddlAvailable === true, clean)

  const unreadable = repairStaleAppContainerAces('X:\\fake\\staged', { readSddl: () => ({ ok: false, detail: 'access denied' }) })
  check('读不到 DACL：sddlAvailable=false + 带原因（不假装干净）', unreadable.sddlAvailable === false && /access denied/.test(unreadable.reason), unreadable)

  const stuck = repairStaleAppContainerAces('X:\\fake\\staged', {
    readSddl: () => ({ ok: true, sddl: before }),
    runIcacls: () => ({ ok: false, detail: 'Access is denied.' }),
  })
  check('摘不掉：repaired=false 且 remaining 非空（fail-closed 的上游证据）', stuck.repaired === false && stuck.remaining.length === 1, stuck)

  let n = 0
  const multi = repairStaleAppContainerAces('X:\\fake\\staged', {
    readSddl: () => {
      n += 1
      return { ok: true, sddl: n === 1 ? sddl(ACE_STALE, ACE_STALE_2) : after }
    },
    runIcacls: () => ({ ok: true, detail: 'ok' }),
  })
  check('多条陈旧 ACE 逐条摘（不是只摘第一条）', multi.removed.length === 2 && multi.repaired === true, multi.removed)
}

section('A4. Fix C 预防：授予 ACE 的那条路径注册了退出兜底撤销')
{
  const source = readFileSync(join(REPO, 'src', 'executor.mjs'), 'utf8')
  // --plant：模拟"没接兜底"（grant 走了却没人撤销）⇒ 本段必须变红。
  //   与 tests/appcontainer-runtime.mjs 的 `PLANTED_CB` 同一手法：把变异喂给**被测判据本身**，
  //   而不是让断言无条件失败（后者只证明"断言会红"，不证明"缺了兜底会被发现"）。
  const plantedSource = PLANT ? source.replace(/process\.once\('exit', this\.exitHook\)/g, '/* planted: no exit hook */') : source
  check(
    "`attachRuntime()` 注册了 `process.once('exit', …)` 兜底",
    /process\.once\('exit', this\.exitHook\)/.test(plantedSource),
    'src/executor.mjs',
  )
  check('兜底实现是 `_revokeGrantsOnExit()`', /_revokeGrantsOnExit\(\)\s*\{/.test(source), 'src/executor.mjs')
  check('`dispose()` 会摘掉兜底监听器（幂等，不二次撤销）', /process\.removeListener\('exit', this\.exitHook\)/.test(source), 'src/executor.mjs')
  check(
    '源码注释点名了真正的病根（cli.mjs 的 process.exit 跳过 finally）',
    /不跑 `finally`/.test(source) || /process\.exit\(\)[\s\S]{0,300}finally/.test(source),
    'src/executor.mjs',
  )
}

section('A5. Fix A 端到端（替身执行器）：降级 ⇒ run() 抛 typed error 且命令没被 spawn')
{
  /**
   * 用替身绑定表把 `init()` 跑通：`selfTest()` 的探针子进程由替身返回指定 stdout，
   * 因此可以**确定性**地构造出"自检测出 inside=denied"与"inside=ok"两种现场，
   * 再断言 `run()` 的行为。零真实 Win32、零真实 ACL 写。
   */
  function makeStubs(options = {}) {
    const record = { spawnCalls: [] }
    const stdout = Buffer.from(options.stdout ?? '')
    const stderr = Buffer.from(options.stderr ?? '')
    const lowLevel = {
      createProcessAsUserW: () => 1,
      createJobObjectW: () => `JOB#${record.spawnCalls.length + 1}`,
      createPipe: () => 1,
      assignProcessToJobObject: () => 1,
      setInformationJobObject: () => 1,
      queryInformationJobObject(job, cls, out, len) {
        if (len !== 48) return 0
        out.writeUInt32LE(0, 32)
        out.writeUInt32LE(0, 36)
        out.writeUInt32LE(0, 40)
        out.writeUInt32LE(0, 44)
        return 1
      },
      terminateJobObject: () => 1,
      waitForSingleObject: () => 0,
      getExitCodeProcess(process, out) {
        if (Buffer.isBuffer(out)) out.writeUInt32LE(0, 0)
        else out.exitCode = 0
        return 1
      },
      closeHandle: () => 1,
      allocUint32: () => Buffer.alloc(4),
      decodeUint32: (slot) => (Buffer.isBuffer(slot) ? slot.readUInt32LE(0) : Number(slot)),
      freeNative() {},
      getLastError: () => 2,
      formatMessageW: () => 0,
    }
    const spawnPipedProcess = (api, spawnOptions) => {
      record.spawnCalls.push({ command: String(spawnOptions.command), args: spawnOptions.args ?? [] })
      return { pid: 4242 + record.spawnCalls.length, process: `proc-${record.spawnCalls.length}`, stdoutRead: 'o', stderrRead: 'e' }
    }
    const drainPipe = async (api, handle) => (String(handle).endsWith('-e') ? stderr : stdout)
    const waitForProcessExit = () => 0
    class FakeAclSandbox {
      constructor(opts) {
        this.writableDirs = opts.writableDirs
        this.api = lowLevel
        this.token = 'RESTRICTED_TOKEN'
      }
      async init() {}
      dispose() {}
    }
    return {
      record,
      spawnPipedProcess,
      overrides: {
        AclSandbox: FakeAclSandbox,
        processBindings: lowLevel,
        spawnPipedProcess,
        processLibrary: { drainPipe, waitForProcessExit },
        workspaceWriteSid: () => 'S-1-4-1-1-fake',
        tempWriteSid: () => 'S-1-4-1-1-2-fake',
        assertPrivateTempDisjoint: () => {},
      },
    }
  }

  const scratch = join(REPO, '.t', 'fix3-repro', 'suite-stub-staging')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  const makeExecutor = (stubs, options = {}) =>
    new WindowsStageExecutor({
      stagingRoot: scratch,
      tempDir: join(scratch, '.tmp'),
      ...options,
      overrides: { ...stubs.overrides, ...(options.overrides ?? {}) },
      // 修复路径本身另有专测（A3 / B 段）；这里不让它去碰真 ACL
      repairStaleAcesImpl: () => ({ checked: true, repaired: false, removed: [], remaining: [], present: [], reason: 'stub' }),
    })

  // ① 健康：自检 JSON 说 inside=ok ⇒ run() 放行，命令真的被 spawn
  {
    const selfTestJson = JSON.stringify({
      inside: 'ok',
      outside: 'denied',
      system: 'denied',
      readSystem: 'ok',
      temp: join(scratch, '.tmp'),
      user: 'x',
      secret: true,
    })
    const stubs = makeStubs({ stdout: selfTestJson })
    const ex = makeExecutor(stubs)
    await ex.init()
    const verdict = ex.stagingWriteEnforceability()
    check('健康自检 ⇒ verdict=pass', verdict.verdict === 'pass', verdict)
    const before = stubs.record.spawnCalls.length
    const result = await ex.run({ command: 'cmd.exe', args: ['/c', 'echo', 'ok'], cwd: scratch })
    check('健康 ⇒ run() 真的执行了命令', stubs.record.spawnCalls.length === before + 1 && result.exitCode === 0, {
      spawns: stubs.record.spawnCalls.length,
      exitCode: result.exitCode,
    })
    ex.dispose()
  }

  // ② 降级（缺陷③ 现场）：自检 JSON 说 inside=denied ⇒ run() 必须拒绝，且不 spawn
  {
    const selfTestJson = JSON.stringify({
      inside: 'denied',
      outside: 'denied',
      system: 'denied',
      readSystem: 'ok',
      temp: join(scratch, '.tmp'),
      user: 'x',
      secret: true,
    })
    const stubs = makeStubs({ stdout: selfTestJson })
    const ex = makeExecutor(stubs)
    // --plant：模拟"闸门被拿掉"——判定换成永远 pass（= 缺陷③ 的静默降级形态）。
    //   注意：这里让**被测对象**变了，而不是让断言变成恒假 ——
    //   后者只能证明"断言会红"，不能证明"降级会被发现"。
    if (PLANT) {
      ex.stagingWriteEnforceability = () => ({
        verdict: 'pass',
        lane: 'sandbox',
        enforcement: 'degraded',
        failedChecks: [],
        measuredChecks: [],
        missingChecks: [],
        reason: 'planted: gate removed',
      })
    }
    await ex.init()
    const verdict = ex.stagingWriteEnforceability()
    check('污染态自检 ⇒ verdict=fail 且点名 inside-staging-write-allowed', verdict.verdict === 'fail' && verdict.failedChecks[0]?.name === 'inside-staging-write-allowed', verdict)
    // BUG-4（2026-10-05）后的契约：闸门**只覆盖有风险的那一条命令**，不得闩锁整条会话。
    // 因此这里分两次探测：
    //   ① 只读命令（`cmd /c echo …`：echo 在 READ_ONLY_BARE_VERBS 里）⇒ 应被豁免并真的执行；
    //   ② 写类命令（带 `>` 重定向 ⇒ COMMAND_RISK.WRITE）⇒ 仍必须被拒且不 spawn。
    // 旧版本只探测 ① 并期望"被拒"，那编码的是 BUG-4 要废掉的闩锁契约。
    const before = stubs.record.spawnCalls.length
    let readOnlyError
    try {
      await ex.run({ command: 'cmd.exe', args: ['/c', 'echo', 'READ-ONLY-OK'], cwd: scratch })
    } catch (caught) {
      readOnlyError = caught
    }
    check(
      '降级 + 只读命令 ⇒ 不再被拒（拒绝面只覆盖有风险的那一条命令）',
      readOnlyError === undefined,
      readOnlyError ? `${readOnlyError.code}` : undefined,
    )
    check('降级 + 只读命令 ⇒ 命令确实被执行了', stubs.record.spawnCalls.length > before, {
      before,
      after: stubs.record.spawnCalls.length,
    })

    const beforeWrite = stubs.record.spawnCalls.length
    let error
    try {
      await ex.run({ command: 'cmd.exe', args: ['/c', 'echo MUST-NOT-RUN > must-not-run.txt'], cwd: scratch })
    } catch (caught) {
      error = caught
    }
    check('降级 + 写类命令 ⇒ run() 抛错（不是返回 exitCode=0）', error !== undefined, error ? `${error.code}` : 'NO ERROR (silent degradation!)')
    check('错误类型是 STAGING_WRITE_UNVERIFIED', error?.code === 'STAGING_WRITE_UNVERIFIED', error?.code)
    check('写类命令**没有**被 spawn（拒绝发生在执行之前）', stubs.record.spawnCalls.length === beforeWrite, {
      before: beforeWrite,
      after: stubs.record.spawnCalls.length,
    })
    check('错误带可执行的修复动作（remediation 非空）', Array.isArray(error?.remediation) && error.remediation.length > 0, error?.remediation)
    check('错误带结构化的人读通道载荷', error?.humanChannel?.verdict === 'fail', error?.humanChannel)
    check('错误消息点名"返回 0 的静默降级形态"', /exit code 0/.test(error?.message ?? ''), error?.message?.slice(0, 200))
    ex.dispose()
  }

  // ③ 判据拿到的是"探针输出无法解析" ⇒ 一律当 fail（不猜、不放行）
  {
    const stubs = makeStubs({ stdout: 'not json at all' })
    const ex = makeExecutor(stubs)
    await ex.init()
    const verdict = ex.stagingWriteEnforceability()
    check('自检输出解析不了 ⇒ verdict=fail（不是 pass，也不默认放行）', verdict.verdict === 'fail', verdict)
    check('原因里保留探针的原始 detail（可归因）', /not json at all/.test(verdict.failedChecks[0]?.detail ?? ''), verdict.failedChecks)
    // 同 ② 的契约（BUG-4 后）：只读命令豁免、写类命令仍 fail-closed。
    const before = stubs.record.spawnCalls.length
    let readOnlyError
    try {
      await ex.run({ command: 'cmd.exe', args: ['/c', 'echo', 'READ-ONLY-OK'], cwd: scratch })
    } catch (caught) {
      readOnlyError = caught
    }
    check(
      '不可测 + 只读命令 ⇒ 不被拒（拒绝面不闩锁会话）',
      readOnlyError === undefined,
      readOnlyError ? `${readOnlyError.code}` : undefined,
    )

    const beforeWrite = stubs.record.spawnCalls.length
    let error
    try {
      await ex.run({ command: 'cmd.exe', args: ['/c', 'echo MUST-NOT-RUN > must-not-run.txt'], cwd: scratch })
    } catch (caught) {
      error = caught
    }
    check('不可测 + 写类命令 ⇒ 仍然拒绝（fail-closed，不猜）', error?.code === 'STAGING_WRITE_UNVERIFIED', error?.code)
    check('不可测 + 写类命令 ⇒ 同样没有被 spawn', stubs.record.spawnCalls.length === beforeWrite, {
      before: beforeWrite,
      after: stubs.record.spawnCalls.length,
    })
    ex.dispose()
  }

  rmSync(scratch, { recursive: true, force: true })
}

// ───────────────────────────────────────────────────────────────────────────
// B 段：真机 ACL 复现与自愈（未受限会话）
// ───────────────────────────────────────────────────────────────────────────

async function liveSection() {
  section('B. 真机复现 + 自愈（T1 写 → 注入陈旧包 SID ACE → 写失败 → init 修复 → 再写成功）')

  if (process.platform !== 'win32') {
    skip('B 段全部', 'not win32')
    return
  }
  // 判据：能不能铸受限令牌（不能就测不了 —— 如实 SKIP，不假装通过）
  let capabilities
  try {
    const { probe } = await import('../src/capability.mjs')
    const report = probe({ root: REPO, cacheDir: undefined, useCache: false })
    capabilities = report
    if (report.win32?.checks?.tokenRights?.status !== 'pass' && !report.tier?.nesting?.viable) {
      skip('B 段全部', `本会话铸不出受限令牌（tokenRights=${report.win32?.checks?.tokenRights?.status}）⇒ 测不了写边界`)
      return
    }
  } catch (error) {
    skip('B 段全部', `能力探测失败：${error.message}`)
    return
  }

  const scratch = join(REPO, '.t', 'fix3-repro', 'suite-live-ws')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const staged = join(scratch, '.dshstage', 'staged')
  // 用"不存在的包 SID"代替真实 AppContainer 包 SID：
  //   `[实测]` 因果与具体 SID 值无关（A/B 翻转实验证明：删掉这条 ⇒ OK，加回这条 ⇒ denied），
  //   而伪造值不需要创建/删除真实 AppContainer profile，测试因此无残留。
  //   ⚠ 各段必须 < 2^32：`[实测]` `S-1-15-2-…-4444444444-…` 写进 ACL 再读回来会被
  //   Windows 规范化成 `4294967295`，断言"摘掉的正是我注入的那个 SID"就会对不上。
  const fakeSid = 'S-1-15-2-111111111-222222222-333333333-444444444-555555555-666666666-777777777'

  try {
    mkdirSync(staged, { recursive: true })

    // ① 注入污染前：健康（直接查 DACL，不需要写探针）
    const healthyAcl = repairStaleAppContainerAces(staged, { runIcacls: () => ({ ok: false, detail: 'must not run' }) })
    check('B1 修复前：暂存根上没有陈旧包 SID ACE', healthyAcl.sddlAvailable === true && healthyAcl.removed.length === 0, healthyAcl)

    // ② 注入污染（与 T0 的 `/grant *<sid>:(OI)(CI)M` 同形）
    const granted = await runIcaclsAsync([staged, '/grant', `*${fakeSid}:(OI)(CI)M`])
    check('B2 注入陈旧包 SID ACE（icacls /grant *<sid>:(OI)(CI)M）', granted.code === 0, granted.detail)

    // ③ 检测（只判据、不动 ACL：replace 型 icacls 替身返回成功但不改真实 ACL）
    const detectOnly = repairStaleAppContainerAces(staged, { runIcacls: () => ({ ok: true, detail: 'detect-only (no real change)' }) })
    check(
      'B3 注入后：判据在**真 SDDL** 上认出这条 ACE（`S-1-15-2-*` 显式允许 ACE）',
      detectOnly.removed.includes(fakeSid),
      { removed: detectOnly.removed, reason: detectOnly.reason },
    )
    const stillPolluted = readDaclSddl(staged)
    check(
      'B3b 检测步骤没有副作用（ACE 仍在盘上）',
      stillPolluted.ok && stillPolluted.sddl.includes(fakeSid),
      stillPolluted.ok ? stillPolluted.sddl.slice(0, 160) : stillPolluted.detail,
    )

    // ④ 污染态：T1 真的写不进去 + 真 run() 必须拒绝（Fix A 端到端）
    //
    // ⚠ 这里必须 `repairStaleAces: false`：生产路径在 `init()` 顶部会**先修再测**，
    //   于是永远看不到"污染态被拒"这一幕（那是 Fix B 的功劳，见 ⑤/⑥）。
    //   要证明 Fix A 单独成立，就得把修复关掉、让污染原样留在盘上。
    const executor = new WindowsStageExecutor({
      stagingRoot: staged,
      mode: 'workspace-write',
      tier: 'T1',
      repairStaleAces: false,
    })
    let degraded = false
    let degradeEvidence = ''
    try {
      const report = await executor.init()
      const verdict = executor.stagingWriteEnforceability()
      degraded = verdict.verdict === 'fail'
      degradeEvidence = `enforcement=${report.enforcement} inside=${report.observed?.inside} verdict=${verdict.verdict}`
      /* 2026-10-08 夹具定因（见 docs/round10/shim/报告.md §B4）：旧夹具用的是
       * `cmd /c echo MUST-NOT-RUN`（**纯只读**），而闸门**刻意**放行"正向判定为只读"的
       * 命令（BUG-4：拒绝面只覆盖有风险的那一条命令，`assertStagingWriteEnforceable` 的
       * ② 分支 `allowed-read-only-bypass`）。实测
       * `classifyCommandRisk('cmd.exe',['/c','echo','MUST-NOT-RUN']) === 'read-only'`
       * ⇒ 旧断言把"设计上的豁免"读成了"未 fail-closed"（夹具假红）。
       * 现在两条都断言：写类命令必须被拒；只读命令必须被**放行但记账**。 */
      const writeProbe = join(staged, 'b4-must-not-run.txt')
      let refusal
      try {
        await executor.run({ command: 'cmd.exe', args: ['/c', 'echo', 'MUST-NOT-RUN', '>', writeProbe], cwd: staged })
      } catch (error) {
        refusal = error
      }
      check(
        'B4 污染态：写类命令 run() 被 STAGING_WRITE_UNVERIFIED 拒绝（命令未执行）',
        refusal?.code === 'STAGING_WRITE_UNVERIFIED',
        refusal?.code ?? 'NOT REFUSED',
      )
      check('B4a 被拒命令确实没有执行（目标文件未生成）', !existsSync(writeProbe), `probe=${writeProbe}`)
      check(
        'B4b 拒绝信息带具体原因与可执行修复动作（人读通道）',
        /inside-staging-write-allowed/.test(refusal?.message ?? '') && (refusal?.remediation?.length ?? 0) > 0,
        { reason: refusal?.humanChannel?.reason, remediation: refusal?.remediation },
      )
      /* 只读豁免必须**显式**成立且被记账：那才证明闸门只拦有风险的那一条命令。 */
      let readOnlyResult
      let readOnlyError
      try {
        readOnlyResult = await executor.run({ command: 'cmd.exe', args: ['/c', 'echo', 'READONLY-OK'], cwd: staged })
      } catch (error) {
        readOnlyError = error
      }
      check(
        'B4c 正向只读命令被放行（BUG-4 只读豁免）但闸门记了账',
        readOnlyError === undefined &&
          readOnlyResult?.exitCode === 0 &&
          (executor.stagingWriteGate?.trips ?? []).some((t) => t.action === 'allowed-read-only-bypass'),
        readOnlyError
          ? `unexpected refusal ${readOnlyError.code}`
          : `exitCode=${readOnlyResult?.exitCode} trips=${JSON.stringify((executor.stagingWriteGate?.trips ?? []).map((t) => t.action))}`,
      )
    } catch (error) {
      // init 自己抛错也算"没有静默放行"，但要记下来
      degraded = true
      degradeEvidence = `init 抛错：${error.code ?? ''} ${error.message.slice(0, 160)}`
      check('B4 污染态：init/run 没有静默放行（抛错或被拒）', true, degradeEvidence)
    } finally {
      try {
        executor.dispose()
      } catch {
        /* 清理失败不影响判定 */
      }
    }
    check('B5 污染态被自检如实测出（verdict=fail / enforcement=degraded / init 拒绝）', degraded, degradeEvidence)

    // ⑤ 修复：摘掉陈旧 ACE（真实 icacls）
    const repaired = repairStaleAppContainerAces(staged, {})
    check('B6 修复路径摘掉了陈旧包 SID ACE', repaired.repaired === true && repaired.removed.includes(fakeSid), repaired)
    check('B7 复读 DACL 确认已摘净（verifyAvailable=true）', repaired.verifyAvailable === true && repaired.remaining.length === 0, {
      remaining: repaired.remaining,
      commands: repaired.commands,
    })

    // ⑥ 修复后：T1 又能写了（审计的三步复现闭环）
    const healed = new WindowsStageExecutor({ stagingRoot: staged, mode: 'workspace-write', tier: 'T1' })
    try {
      const report = await healed.init()
      const verdict = healed.stagingWriteEnforceability()
      check('B8 修复后：自检 inside-staging-write-allowed=pass', verdict.verdict === 'pass', {
        enforcement: report.enforcement,
        inside: report.observed?.inside,
        checks: verdict.measuredChecks,
      })
      const result = await healed.run({ command: 'cmd.exe', args: ['/c', 'echo', 'HEALED'], cwd: staged })
      check('B9 修复后：run() 真的执行了命令（不再被闸门拒绝）', result.exitCode === 0, {
        exitCode: result.exitCode,
        stdout: String(result.stdout ?? '').trim().slice(0, 40),
      })
      check(
        'B11 修复路径是**幂等**的：再跑一次不再有任何清理动作',
        (() => {
          const again = repairStaleAppContainerAces(staged, {})
          return again.repaired === false && again.removed.length === 0 && again.commands.length === 0
        })(),
        repairStaleAppContainerAces(staged, {}),
      )
    } finally {
      try {
        healed.dispose()
      } catch {
        /* 同上 */
      }
    }
  } finally {
    // 无论成败都恢复干净：先摘 ACE（幂等），再删临时工作区
    try {
      await runIcaclsAsync([staged, '/remove:g', `*${fakeSid}`])
    } catch {
      /* 目录可能已不存在 */
    }
    rmSync(scratch, { recursive: true, force: true })
    check('B10 测试工作区已清理（不留污染 ACL）', !existsSync(scratch), scratch)
  }
}

/** 用 cmd 重定向而不是管道捕获：本仓库实测 `icacls` 在受限会话里经管道会 EPERM/丢输出 */
async function runIcaclsAsync(args) {
  const { spawn } = await import('node:child_process')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-fix3-icacls-'))
  const outFile = join(dir, 'out.txt')
  const errFile = join(dir, 'err.txt')
  const code = await new Promise((resolveCode) => {
    const out = fs.openSync(outFile, 'w')
    const err = fs.openSync(errFile, 'w')
    const child = spawn('icacls', args, { stdio: ['ignore', out, err], windowsHide: true })
    child.on('error', () => resolveCode(-1))
    child.on('close', (c) => resolveCode(c ?? -1))
  })
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8').replace(/\r?\n/g, ' | ').trim()
    } catch {
      return ''
    }
  }
  const detail = `${read(outFile)}${read(errFile) ? ` | ${read(errFile)}` : ''}`
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  return { code, detail: detail.slice(0, 300) }
}

async function main() {
  await liveSection()

  const mode = PLANT ? 'plant' : 'normal'
  process.stdout.write(`\n${'='.repeat(64)}\n`)
  process.stdout.write('缺陷③回归（T0 污染 → T1 静默降级 / fail-closed / 修复）\n')
  process.stdout.write(`断言 ${assertions} 项，失败 ${failures} 项，SKIP ${skips.length} 项 mode=${mode}\n`)
  process.stdout.write(`${'='.repeat(64)}\n`)
  process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips.length} mode=${mode}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stdout.write(`\n未捕获错误: ${error?.stack ?? error}\n`)
  process.exit(1)
})
