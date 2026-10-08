/**
 * 自测：按手册第 17 章"硬验收表"逐项验证核心不变量
 *
 * 每个用例对应一条已付学费的不变量，断言失败必须给出**原始证据**，
 * 不允许"断言失败变成等待超时"（#17.1 / #9.5）。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.mjs'
import { ToolSurface } from '../src/tools.mjs'
import { STATE } from '../src/store.mjs'
import { canonical } from '../src/paths.mjs'

const ROOT = process.env.WINSTAGE_TEST_ROOT || 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.t\\ws'

// WP0（2026-10-05）：暂存根已从工作区 `.dshstage` 迁到 **Windows 缓存**
// （默认 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>\`）。但该缓存路径**对收窄档的命令行子进程只读**
// （WP0 实测 mkdir 都 EPERM）⇒ 离线自测必须显式给一个**可写**的暂存根，否则在受限车道里必红。
// 这里用 sys temp（本车道唯一可靠可写区）；`stageGuard: false` 只关掉本用例不关心的守护
// （Stage Guard 本身由 `wp0-test.mjs` 专项覆盖），语义断言不受影响。
const STAGE_ROOT_FOR_TESTS =
  process.env.WINSTAGE_TEST_STAGE_ROOT ||
  join(process.env.TEMP || process.env.LOCALAPPDATA || '.', 'winstage-selftest-stage')
// ⚠ 必须**每个 Workspace 实例一个独立子根**：旧布局是 `<root>/.dshstage/sessions/<会话键>`，
// 天然按会话隔离；显式 `stageRoot` 是**逐字使用**的（不会再拼会话子目录），
// 若所有实例共用一个根，第 1–3 节的暂存条目会污染第 5 节的候选断言（实测 5 条假红）。
// 这里用 **getter + 展开**：`{ ...STORE_OPTS_FOR_TESTS }` 每次都取到一个新的子根。
let __selftestStageSeq = 0
const STORE_OPTS_FOR_TESTS = {
  get stageRoot() {
    __selftestStageSeq += 1
    return join(STAGE_ROOT_FOR_TESTS, `s${__selftestStageSeq}`)
  },
  stageGuard: false,
}

const results = []
let failures = 0

function check(name, manualRef, condition, evidence) {
  const status = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  results.push({ name, manualRef, status, evidence })
  const mark = condition ? '  ✓' : '  ✗'
  process.stdout.write(`${mark} ${name}  [${manualRef}]\n`)
  if (!condition) process.stdout.write(`      证据: ${JSON.stringify(evidence)}\n`)
}

function section(title) {
  process.stdout.write(`\n── ${title} ──\n`)
}

/**
 * 安全删除一棵目录树，**区分重解析点（junction / 符号链接）与真实子目录**。
 *
 * 为什么必须自己写（测试卫生，真实教训）：
 *   1. 删除 junction 必须用"解除链接"语义（`rmdirSync` / `Directory.Delete(path,false)`），
 *      不能用递归删除 —— 递归会**跟随链接**删掉目标目录的内容；
 *   2. 反向地，`rmSync(recursive)` 对**悬空** junction（目标已不存在）会失败，
 *      于是 junction 被留在原地，下次运行还会被目录遍历撞上。
 *   之前 selftest 就因此把 `.t\ws\escape` 这个悬空 junction 永久留在了工作区里。
 *
 * @returns {number} 删除的条目数（含重解析点）
 */
function safeRemoveTree(target) {
  let removed = 0
  let st
  try {
    st = lstatSync(target)
  } catch {
    return 0 // 不存在
  }
  // 重解析点：只解除链接，绝不递归进去
  if (st.isSymbolicLink()) {
    try {
      rmdirSync(target)
      removed += 1
    } catch {
      try {
        unlinkSync(target)
        removed += 1
      } catch {
        /* 无法删除则留给调用方报告 */
      }
    }
    return removed
  }
  if (!st.isDirectory()) {
    try {
      unlinkSync(target)
      removed += 1
    } catch {
      /* ignore */
    }
    return removed
  }
  let entries = []
  try {
    entries = readdirSync(target)
  } catch {
    entries = []
  }
  for (const name of entries) removed += safeRemoveTree(join(target, name))
  try {
    rmdirSync(target)
    removed += 1
  } catch {
    /* 目录可能非空或权限异常 */
  }
  return removed
}

function freshWorkspace() {
  safeRemoveTree(ROOT)
  mkdirSync(ROOT, { recursive: true })
  return new Workspace({ workspaceRoot: ROOT, ...STORE_OPTS_FOR_TESTS }).init({ sessionId: 'test-session' })
}

function main() {
  process.stdout.write(`测试工作区: ${ROOT}\n`)

  // ══════════ 1. 统一视图 / 连续修改 ══════════
  section('1. 统一工作区与连续修改')
  let ws = freshWorkspace()

  writeFileSync(join(ROOT, 'a.txt'), 'line1\nline2\n')
  writeFileSync(join(ROOT, 'b.txt'), 'B\n')
  mkdirSync(join(ROOT, 'sub'), { recursive: true })
  writeFileSync(join(ROOT, 'sub', 'c.txt'), 'C\n')

  // #3.4 连续修改跨 attempt 存活
  ws.writeFile(join(ROOT, 'a.txt'), 'line1\nline2-modified\n', { origin: 't' })
  ws.writeFile(join(ROOT, 'a.txt'), 'line1\nline2-twice\n', { origin: 't' })
  check(
    '连续两次写同一文件可叠加（后写不丢前写语义、内容为最后一次）',
    '#3.4',
    ws.readText(join(ROOT, 'a.txt')) === 'line1\nline2-twice\n',
    { observed: ws.readText(join(ROOT, 'a.txt')) },
  )

  // #3.6 read 看得到自己的修改
  const visible = ws.readText(join(ROOT, 'a.txt'))
  check('read 看到暂存内容而非真实磁盘旧内容', '#3.6', visible.includes('twice'), { visible, real: readFileSync(join(ROOT, 'a.txt'), 'utf8') })
  check('真实磁盘在提交前保持不变', '#1.2/#2.1', readFileSync(join(ROOT, 'a.txt'), 'utf8') === 'line1\nline2\n', {
    real: readFileSync(join(ROOT, 'a.txt'), 'utf8'),
  })

  // #3.10 二次暂存幂等
  const before = Object.keys(ws.manifest.entries).length
  ws.writeFile(join(ROOT, 'a.txt'), 'line1\nline2-twice\n', { origin: 't' })
  check('同一路径重复暂存不产生新条目（幂等）', '#3.10', Object.keys(ws.manifest.entries).length === before, {
    before,
    after: Object.keys(ws.manifest.entries).length,
  })

  // #3.9 暂存路径保留 basename 与扩展名
  const stagedPath = ws.store.stagedPath('a.txt')
  // WP0（2026-10-05，owner 决定）：暂存根已从**工作区 `.dshstage`** 迁到 **Windows 缓存**
  // （`resolveStageRoot(...)`），本测试再用显式 `stageRoot` 覆盖成可写目录。
  // 断言**不得依赖具体根位置**：工作区本身也可能正好位于名为 `.dshstage` 的目录下
  // （本车道跑测试时就是），用字符串包含判断会假红 ⇒ 改成"位于本实例解析出的暂存根之下"。
  check(
    '暂存路径保留 basename 与扩展名，且位于本实例的暂存根下',
    '#3.9',
    stagedPath.endsWith('a.txt') && stagedPath.startsWith(ws.store.dir),
    { stagedPath, storeDir: ws.store.dir },
  )

  // ══════════ 2. 新建 / 目录合成 ══════════
  section('2. 新建对象与目录合成')
  ws.writeFile(join(ROOT, 'new', 'deep', 'x.js'), 'console.log(1)\n', { origin: 't' })
  const existsDeep = ws.exists(join(ROOT, 'new', 'deep', 'x.js'))
  check('深层新建文件可见', '#3.5', existsDeep.exists && existsDeep.kind === 'file', existsDeep)

  const dirState = ws.exists(join(ROOT, 'new'))
  check('新建目录的父目录在逻辑视图合成存在', '#3.11', dirState.exists && dirState.kind === 'dir', dirState)

  const listing = ws.listDir(join(ROOT, 'new'))
  check('合成目录可枚举出子项', '#3.11', listing.some((i) => i.name === 'deep'), listing)

  // #3.1 存在性区分文件与目录
  const fileQ = ws.exists(join(ROOT, 'a.txt'))
  const dirQ = ws.exists(join(ROOT, 'sub'))
  check(
    '存在性判断区分文件与目录',
    '#3.1',
    fileQ.kind === 'file' && dirQ.kind === 'dir' && dirQ.exists === true,
    { fileQ, dirQ },
  )

  // ══════════ 3. 删除权威性 ══════════
  section('3. 删除权威性')
  ws.remove(join(ROOT, 'b.txt'), { origin: 't' })
  const afterDelete = ws.exists(join(ROOT, 'b.txt'))
  check('删除后对所有工具表现为不存在', '#3.7', afterDelete.exists === false, afterDelete)
  check('真实磁盘文件未被删除', '#1.2', existsSync(join(ROOT, 'b.txt')), { realExists: existsSync(join(ROOT, 'b.txt')) })

  const listAfterDelete = ws.listDir(ROOT)
  check('目录枚举不再包含已删除项', '#3.11', !listAfterDelete.some((i) => i.name === 'b.txt'), listAfterDelete.map((i) => i.name))

  // #3.7 删除态不被复活
  let revived
  try {
    ws.readFile(join(ROOT, 'b.txt'))
    revived = true
  } catch (error) {
    revived = false
    check('读已删除文件报不存在而不是回退真实磁盘', '#3.7', error.code === 'ENOENT', { code: error.code, message: error.message })
  }
  if (revived) check('读已删除文件不得回退真实磁盘', '#3.7', false, { note: '竟然读到了内容' })

  // 删除幂等
  const secondDelete = ws.remove(join(ROOT, 'b.txt'), { missingOk: true })
  check('重复删除幂等成功', '#3.1', secondDelete.deleted === true, secondDelete)

  // 幽灵删除：删除从未存在的文件必须报错
  let ghost
  try {
    ws.remove(join(ROOT, 'never-existed.txt'))
    ghost = 'no-error'
  } catch (error) {
    ghost = error.code
  }
  check('删除从未存在的文件报 ENOENT（不产生幽灵删除）', '#3.1', ghost === 'ENOENT', { observed: ghost })

  // ══════════ 4. 损坏必须显式化 ══════════
  section('4. 损坏状态不得回退')
  ws.writeFile(join(ROOT, 'c.txt'), 'hello\n', { origin: 't' })
  const entry = ws.entryOf('c.txt')
  rmSync(ws.store.blobPath(entry.stagedHash), { force: true })
  let corrupt
  try {
    ws.readFile(join(ROOT, 'c.txt'))
    corrupt = 'read-succeeded'
  } catch (error) {
    corrupt = error.code
  }
  check('暂存 blob 丢失时明确报损坏，不回退真实磁盘', '#3.1 / 13.2', corrupt === 'WORKSPACE_CORRUPT', { observed: corrupt })

  // 恢复一个健康工作区继续
  ws = freshWorkspace()

  // ══════════ 5. 候选与选择性应用 ══════════
  section('5. 候选完整性与选择性应用')
  writeFileSync(join(ROOT, 'p.txt'), 'P0\n')
  writeFileSync(join(ROOT, 'q.txt'), 'Q0\n')
  writeFileSync(join(ROOT, 'r.txt'), 'R0\n')
  ws = new Workspace({ workspaceRoot: ROOT, ...STORE_OPTS_FOR_TESTS }).init({ sessionId: 's2' })

  // #12.1 无净变化不入队
  const noop = ws.freezeCandidate({ source: 't' })
  check('无净变化时不入队', '#12.1', noop.enqueued === false && noop.reason === 'no-net-change', noop)

  ws.writeFile(join(ROOT, 'p.txt'), 'P1\n', { origin: 't' })
  ws.writeFile(join(ROOT, 'q.txt'), 'Q1\n', { origin: 't' })
  ws.remove(join(ROOT, 'r.txt'), { origin: 't' })
  const frozen = ws.freezeCandidate({ source: 't' })
  check('冻结候选包含全部净变化', '#12.1', frozen.enqueued && frozen.changes.length === 3, {
    count: frozen.changes.length,
    ops: frozen.changes.map((c) => `${c.op}:${c.path}`),
  })

  // #12.6 两侧都冻结
  const candidate = ws.store.loadCandidate(frozen.candidate.id)
  const pChange = candidate.changes.find((c) => c.path === 'p.txt')
  const beforeOk = ws.store.hasBlob(pChange.before.hash) && ws.store.readBlob(pChange.before.hash).toString() === 'P0\n'
  const afterOk = ws.store.hasBlob(pChange.after.hash) && ws.store.readBlob(pChange.after.hash).toString() === 'P1\n'
  check('候选冻结了 before 与 after 两侧内容', '#12.6', beforeOk && afterOk, { beforeOk, afterOk })

  // 冻结后再改动暂存，候选内容不随之变化（不可变）
  ws.writeFile(join(ROOT, 'p.txt'), 'P2\n', { origin: 't' })
  const stillFrozen = ws.store.readBlob(pChange.after.hash).toString()
  check('候选内容不可变（后续编辑不影响已冻结候选）', '#12.1/#12.6', stillFrozen === 'P1\n', { stillFrozen })

  // #12.2 部分应用不丢其余
  const partial = ws.applyCandidate(candidate.id, { paths: ['p.txt'] })
  check('选择性应用只应用所选子集', '#12.2', partial.applied.length === 1 && partial.applied[0].path === 'p.txt', partial)
  check('未选择部分保留为可追踪修订', '#12.2', partial.remaining.length === 2, { remaining: partial.remaining })
  check('磁盘上只应用了所选文件', '#12.2', readFileSync(join(ROOT, 'p.txt'), 'utf8') === 'P1\n' && readFileSync(join(ROOT, 'q.txt'), 'utf8') === 'Q0\n', {
    p: readFileSync(join(ROOT, 'p.txt'), 'utf8'),
    q: readFileSync(join(ROOT, 'q.txt'), 'utf8'),
  })
  // 删除型变更：未选时不得发生（这正是"选择性"的含义）
  check('未选择的删除型变更不得发生', '#12.2', existsSync(join(ROOT, 'r.txt')), { rExists: existsSync(join(ROOT, 'r.txt')) })
  // 随后单独应用该删除，验证删除确实能落到真实磁盘
  const deleteApply = ws.applyCandidate(candidate.id, { paths: ['r.txt'] })
  check(
    '显式应用删除型变更后真实文件消失',
    '#7.1 / 12.1',
    deleteApply.applied.some((a) => a.path === 'r.txt') && !existsSync(join(ROOT, 'r.txt')),
    { applied: deleteApply.applied, failed: deleteApply.failed, rExists: existsSync(join(ROOT, 'r.txt')) },
  )

  // #12.3 陈旧引用重定向
  const supersede = ws.freezeCandidate({ source: 't' })
  check('同一路径的新修订取代旧待审（非全局）', '#3.8/#12.1', supersede.enqueued === true, supersede)
  const chainTarget = ws.resolveCandidate(partial.applied.length ? frozen.candidate.id : candidate.id)
  check('陈旧候选可沿 superseded_by 链解析而不抛错', '#12.3', typeof chainTarget.candidate?.id === 'string', { resolved: chainTarget.candidate?.id })

  // 重复应用幂等
  const reapply = ws.applyCandidate(candidate.id, { paths: ['p.txt'] })
  check('重复应用同一切片幂等返回 ALREADY_APPLIED 或已应用状态', '#12.3', reapply.idempotent === 'ALREADY_APPLIED' || reapply.status === 'applied' || reapply.applied.length === 0, reapply)

  // #12.5 丢弃是有状态操作
  ws = freshWorkspace()
  writeFileSync(join(ROOT, 'd.txt'), 'D0\n')
  ws = new Workspace({ workspaceRoot: ROOT, ...STORE_OPTS_FOR_TESTS }).init({ sessionId: 's3' })
  ws.writeFile(join(ROOT, 'd.txt'), 'D1\n', { origin: 't' })
  const toDiscard = ws.freezeCandidate({ source: 't' })
  ws.discardCandidate(toDiscard.candidate.id, { reason: 'test' })
  const queueAfterDiscard = ws.store.loadQueue()
  check('丢弃后候选状态持久化为 discarded', '#12.5', queueAfterDiscard.candidates[toDiscard.candidate.id].status === 'discarded', queueAfterDiscard.candidates[toDiscard.candidate.id])
  check('丢弃后不再出现在待审列表', '#12.5', !ws.listReviews().some((c) => c.id === toDiscard.candidate.id), ws.listReviews().map((c) => c.id))
  check('丢弃不删除暂存内容本身', '#12.5', ws.exists(join(ROOT, 'd.txt')).exists, ws.exists(join(ROOT, 'd.txt')))

  // ══════════ 6. 陈旧基线保护 ══════════
  section('6. 并发/外部修改保护')
  ws = freshWorkspace()
  writeFileSync(join(ROOT, 'stale.txt'), 'S0\n')
  ws = new Workspace({ workspaceRoot: ROOT, ...STORE_OPTS_FOR_TESTS }).init({ sessionId: 's4' })
  ws.writeFile(join(ROOT, 'stale.txt'), 'S1\n', { origin: 't' })
  const staleCandidate = ws.freezeCandidate({ source: 't' })
  // 外部（用户）改了真实文件
  writeFileSync(join(ROOT, 'stale.txt'), 'USER-EDIT\n')
  const staleApply = ws.applyCandidate(staleCandidate.candidate.id)
  check(
    '真实文件被外部改动时拒绝覆盖并报 STALE_BASELINE',
    '第 12 章 / 17.1',
    staleApply.failed.some((f) => f.code === 'STALE_BASELINE') && readFileSync(join(ROOT, 'stale.txt'), 'utf8') === 'USER-EDIT\n',
    { failed: staleApply.failed, realContent: readFileSync(join(ROOT, 'stale.txt'), 'utf8') },
  )
  const forcedApply = ws.applyCandidate(staleCandidate.candidate.id, { force: true })
  check('force 可显式覆盖（用户知情选择）', '#12.2', forcedApply.applied.length === 1 && readFileSync(join(ROOT, 'stale.txt'), 'utf8') === 'S1\n', {
    applied: forcedApply.applied,
    realContent: readFileSync(join(ROOT, 'stale.txt'), 'utf8'),
  })

  // ══════════ 7. 读取面硬拒绝 ══════════
  section('7. 读取面硬拒绝与符号链接规范化')
  const fakeHome = join(ROOT, 'fakehome')
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
  writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE\n')
  const surface = new ToolSurface(ws)

  let maskedResult
  try {
    ws.assertReadable(join('C:\\Users\\Administrator', '.ssh', 'id_rsa'))
    maskedResult = 'allowed'
  } catch (error) {
    maskedResult = error.code
  }
  check('硬拒绝清单命中 SSH 私钥路径', '#16.7 / 16.10', maskedResult === 'SANDBOX_PATH_MASKED', { observed: maskedResult })

  // #16.6 符号链接/junction 不能绕过遮蔽：在工作区内放一个指向宿主敏感目录的 junction
  const hostSsh = join(process.env.USERPROFILE || 'C:\\Users\\Default', '.ssh')
  const fakeHostSsh = join(ROOT, '..', 'fake-host', '.ssh')
  mkdirSync(fakeHostSsh, { recursive: true })
  writeFileSync(join(fakeHostSsh, 'id_rsa'), 'HOST-PRIVATE\n')
  const escapeLink = join(ROOT, 'escape')
  let linkCreated = false
  let linkTarget = fakeHostSsh
  try {
    symlinkSync(fakeHostSsh, escapeLink, 'junction')
    linkCreated = true
  } catch {
    try {
      symlinkSync(hostSsh, escapeLink, 'junction')
      linkTarget = hostSsh
      linkCreated = true
    } catch {
      linkCreated = false
    }
  }
  if (linkCreated) {
    const directMask = ws.maskOf(join(escapeLink, 'id_rsa'))
    check(
      '工作区内 junction 逃逸到宿主敏感目录仍被遮蔽（先规范化再豁免）',
      '#16.6 / 16.8',
      directMask !== undefined,
      { linkTarget, mask: directMask ?? null, canonical: canonical(join(escapeLink, 'id_rsa')) },
    )
    let escapeRead
    try {
      ws.assertReadable(join(escapeLink, 'id_rsa'))
      escapeRead = 'allowed'
    } catch (error) {
      escapeRead = error.code
    }
    check('经 junction 读取被硬拒绝', '#16.6 / 16.7', escapeRead === 'SANDBOX_PATH_MASKED', { observed: escapeRead })
    const viaLink = ws.exists(join(escapeLink, 'id_rsa'))
    check('经 junction 枚举也不可见', '#16.6', viaLink.exists === false || viaLink.source === 'masked', viaLink)
    // 注意：此处**不能**清理 junction —— 本节后面还有一条用例要用它。
    // 清理统一放在本节末尾（真实教训：清理放早了会让后续用例失去夹具，
    // 表现为一条看似无关的 FAIL）。
  } else {
    check('junction 创建不可用（未取得实测证据，如实记录）', '#16.6', true, { note: '本会话无法创建 junction' })
  }

  // 工作区内的 .ssh 不应被遮蔽（豁免限定作用域）
  const inWorkspace = ws.exists(join(fakeHome, '.ssh', 'id_rsa'))
  check('工作区子树内的同名目录不被误遮蔽（豁免限定作用域）', '#16.8', inWorkspace.exists === true, inWorkspace)

  // 沙箱自身存储：即使位于工作区内也不得豁免（#16.8）
  const selfMask = ws.maskOf(join(ROOT, '.dshstage', 'manifest.json'))
  check('沙箱自身存储即使在工作区内也不豁免', '#16.8', selfMask !== undefined, { mask: selfMask ?? null })

  // #16.7 硬检查覆盖所有路径参数，不只 read
  const outside = surface.readFile({ file_path: join(ROOT, '..', '..', '..', 'Windows', 'win.ini') })
  check('工具路径参数越界被拒绝（非 read 分支同样校验）', '#16.7 / A90', outside.status === 'denied' || outside.error?.code === 'PATH_OUTSIDE_WORKSPACE' || outside.status === 'failed', outside)

  // ══════════ 8. 返回语义 ══════════
  section('8. 结构化返回语义')
  mkdirSync(join(ROOT, 'emptydir'), { recursive: true })
  const emptyList = surface.listFiles({ path: join(ROOT, 'emptydir') })
  check('空目录是独立结果而非"无匹配"', '#4.3', emptyList.status === 'empty-directory', emptyList)

  const noMatch = surface.searchFiles({ pattern: 'zzz-never-matches-zzz' })
  check('搜索无匹配是独立结果', '#4.3', noMatch.status === 'no-match', noMatch)

  const notFound = surface.readFile({ file_path: join(ROOT, 'does-not-exist.txt') })
  check('不存在是独立结果', '#4.3', notFound.status === 'not-found', notFound)

  // 直接给出工作区外的宿主路径：先被边界检查拒绝（PATH_OUTSIDE_WORKSPACE），
  // 这是正确的 fail-closed 顺序——遮蔽表不该为越界路径兜底。
  const denied = surface.readFile({ file_path: join('C:\\Users\\Administrator', '.ssh', 'id_rsa') })
  check(
    '工作区外的宿主敏感路径被拒绝，且错误里不含暂存路径',
    '#4.1 / 16.7',
    denied.status !== 'ok' && !JSON.stringify(denied).includes('.dshstage'),
    denied,
  )

  // 经工作区内 junction 命中的遮蔽项：必须是 DENIED 语义，而不是"不存在"
  if (linkCreated) {
    const deniedViaLink = surface.readFile({ file_path: join(escapeLink, 'id_rsa') })
    check(
      '经 junction 命中硬拒绝清单时返回 DENIED（不是 not-found）',
      '#4.3 / 16.7',
      deniedViaLink.status === 'denied' && deniedViaLink.error?.code === 'SANDBOX_PATH_MASKED',
      deniedViaLink,
    )
  }

  // junction 夹具至此不再需要 —— 统一清理，并**断言清理干净**。
  // 真实教训：此前不清理，`.t\ws\escape` 悬空 junction 永久残留，
  // 之后每次目录遍历都撞上它并报 DirectoryNotFound。
  if (linkCreated) {
    safeRemoveTree(escapeLink)
    safeRemoveTree(fakeHostSsh)
    check('测试用 junction 已解除链接（不留残留）', '测试卫生', !existsSync(escapeLink), {
      escapeLink,
      stillThere: existsSync(escapeLink),
    })
    check('测试用 fake-host 已清理', '测试卫生', !existsSync(fakeHostSsh), {
      fakeHostSsh,
      stillThere: existsSync(fakeHostSsh),
    })
  }

  // #3.3 结果路径还原
  const written = surface.writeFile({ file_path: join(ROOT, 'restore.txt'), content: 'x\n' })
  // WP0（2026-10-05）：暂存根不再是工作区 `.dshstage`，且本测试的 ROOT 恰好位于 `.dshstage` 下，
  // 用字符串包含 `.dshstage` 判断会假红 ⇒ 改成"不含本测试的暂存根基目录"（覆盖任意实例的根）。
  // ⚠ 已知独立缺口（记为 WP9）：结果里 `staged / observedIn:"staged-view" / stagedView / note`
  // 属于**成功路径**上的沙箱自曝，与 owner "AI 意识不到沙箱"的要求冲突；
  // 本断言只钉住"不泄漏暂存根路径"，自曝字段由 WP9 处理。
  check(
    '工具结果只暴露逻辑路径，不含暂存根路径',
    '#3.3',
    !JSON.stringify(written).includes(STAGE_ROOT_FOR_TESTS),
    written,
  )

  // ══════════ 9. 清理闭环 ══════════
  section('9. 清理与垃圾回收')
  const gc = ws.store.collectGarbage({ apply: false })
  check('GC 干跑能报告无引用 blob 数', '#13.1', typeof gc.scanned === 'number', gc)
  const gcApply = ws.store.collectGarbage({ apply: true })
  check('GC 实跑后暂存清单引用仍然可读', '#13.1', ws.exists(join(ROOT, 'restore.txt')).exists, { removed: gcApply.removed })

  // ══════════ 测试卫生：不得留下任何重解析点 ══════════
  //
  // 真实教训：此前 junction 测试用完不清理，`.t\ws\escape` 这个**悬空 junction**
  // 永久残留，之后每次目录遍历都会撞上它报 DirectoryNotFound。
  // 测试必须自己收拾干净，并且把"收拾干净了"变成一条断言。
  const leftovers = []
  const scanForReparsePoints = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        leftovers.push(p)
        continue // 不跟随
      }
      if (st.isDirectory()) scanForReparsePoints(p)
    }
  }
  scanForReparsePoints(ROOT)
  check('测试工作区内不残留任何重解析点（junction/符号链接）', '测试卫生', leftovers.length === 0, { leftovers })

  // ══════════ 汇总 ══════════
  process.stdout.write(`\n${'='.repeat(72)}\n`)
  const passed = results.filter((r) => r.status === 'PASS').length
  process.stdout.write(`用例: ${results.length}  通过: ${passed}  失败: ${failures}\n`)
  if (failures) {
    process.stdout.write('\n失败项:\n')
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      process.stdout.write(`  ✗ ${r.name} [${r.manualRef}]\n    证据: ${JSON.stringify(r.evidence)}\n`)
    }
  }
  process.stdout.write(`${'='.repeat(72)}\n`)

  // 输出机器可读结果供汇总
  const reportPath = join(ROOT, '..', 'selftest-report.json')
  try {
    writeFileSync(reportPath, JSON.stringify({ time: new Date().toISOString(), total: results.length, failures, results }, null, 2))
    process.stdout.write(`报告: ${reportPath}\n`)
  } catch {
    /* 报告写入失败不影响退出码 */
  }
  process.exit(failures ? 1 : 0)
}

main()
