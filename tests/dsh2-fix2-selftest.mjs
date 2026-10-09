#!/usr/bin/env node
/**
 * WinStage 方向 2 验证脚本（自包含，零依赖，只读产品代码 + 在系统临时目录里造夹具）
 *
 * 覆盖两个**负路径判据**，它们跑不进 `autotest`（回归门只覆盖旧路径）：
 *   A. `src/store.mjs` 的 `writeFileAtomic()` 在 rename 失败时**必须清掉自己的 tmp**
 *      —— 这是 `review-service.publish()` 现在所依赖的语义。
 *   B. `dsh-plugin/review-service.mjs` 的 `publish()` **必须**委托给 `writeFileAtomic`
 *      （判据：失败时残留的 tmp 名形如 `<target>.tmp-<pid>-<8hex>`，**不是**旧的
 *      `<target>.tmp-<pid>`），且**原错误仍上抛**（不吞、不降级）。
 *
 * 为什么 A 需要夹具：`writeFileAtomic` 的 tmp 名以 target 为前缀
 * （`${path}.tmp-${pid}-${rnd}`）。若把 target 改名/改成目录，tmp 会**跟着一起被挪走**，
 * 于是 `unlinkSync(tmp)` 静默失败、断言变假阳性。因此这里让 rename 对**已存在的非空目录**
 * 失败（NTFS 上 MoveFile 会失败），此时 tmp 留在**同一目录**里，可被确定性地观测。
 *
 * 跑法（任意普通终端）：
 *   node C:\Users\Administrator\Desktop\dsh-winstage-sandbox\docs\dsh2-fix2-selftest.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox'
const results = []

function check(name, ok, detail) {
  results.push({ name, ok: ok === true, detail: detail ?? '' })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail ? `  —— ${detail}` : ''}`)
}

/** 递归找临时残留（bounded） */
function findTmp(root, depth = 0) {
  if (!existsSync(root) || depth > 4) return []
  let out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) out = out.concat(findTmp(p, depth + 1))
    else if (entry.name.includes('.tmp-')) out.push(p)
  }
  return out
}

console.log('='.repeat(64))
console.log(' WinStage 方向2 验证：writeFileAtomic 清理 + publish() 委托')
console.log('='.repeat(64))

// ─────────────────────────────────────────────────────────────
// A. writeFileAtomic：rename 失败 ⇒ 抛错 + 不留 tmp；成功 ⇒ 内容正确
// ─────────────────────────────────────────────────────────────
console.log('\n── A. writeFileAtomic（src/store.mjs）──')
const { writeFileAtomic } = await import(pathToFileURL(join(REPO, 'src', 'store.mjs')).href)

// A1 成功路径
{
  const dir = join(tmpdir(), `wstage-A1-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'ok.json')
  writeFileAtomic(target, '{"a":1}')
  const tmp = findTmp(dir)
  check('A1 成功后内容正确', readFileSync(target, 'utf8') === '{"a":1}')
  check('A1 成功后无 tmp 残留', tmp.length === 0, tmp.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// A2 失败路径（目标是个非空目录 ⇒ rename 失败）
{
  const dir = join(tmpdir(), `wstage-A2-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'blocked.json')
  mkdirSync(target)
  writeFileSync(join(target, 'occupied.txt'), 'x') // 非空目录：MoveFile 必须失败
  let threw = false
  let code = ''
  try {
    writeFileAtomic(target, '{"b":2}')
  } catch (error) {
    threw = true
    code = error?.code ?? ''
  }
  const tmp = findTmp(dir)
  check('A2 rename 失败时抛错', threw, `code=${code}`)
  check('A2 失败后 tmp 已清理', tmp.length === 0, tmp.join(' | '))
  check('A2 目标未被破坏（仍是目录）', existsSync(join(target, 'occupied.txt')))
  rmSync(dir, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// B. review-service.publish()：委托 writeFileAtomic + 错误上抛
// ─────────────────────────────────────────────────────────────
console.log('\n── B. ReviewService.publish()（dsh-plugin/review-service.mjs）──')
const { ReviewService } = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'review-service.mjs')).href)

// B1 正常 publish：写成合法 JSON、无 tmp 残留
{
  const ws = join(tmpdir(), `wstage-B1-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  const svc = new ReviewService({ workspaceRoot: ws, sessionId: 'fix2-selftest', log: () => {} })
  svc.workspace.init()
  const snap = svc.publish()
  const reviewPath = svc.reviewPath()
  const onDisk = JSON.parse(readFileSync(reviewPath, 'utf8'))
  const tmp = findTmp(dirname(reviewPath))
  check('B1 publish 写出合法 JSON', typeof onDisk === 'object' && onDisk !== null)
  check('B1 publish 返回值与落盘一致', onDisk.workspaceRoot === snap.workspaceRoot, String(onDisk.workspaceRoot))
  check('B1 publish 无 tmp 残留', tmp.length === 0, tmp.join(' | '))
  rmSync(ws, { recursive: true, force: true })
}

// B2 失败路径：把 review.json 换成非空目录 ⇒ publish 必须抛错，且**失败后的 tmp 命名**
//    能区分新旧实现：新 = `<target>.tmp-<pid>-<8hex>`（且已被清理，故不可见）；
//    旧 = `<target>.tmp-<pid>`（且**不清理**，会留下）。
{
  const ws = join(tmpdir(), `wstage-B2-${process.pid}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  const svc = new ReviewService({ workspaceRoot: ws, sessionId: 'fix2-selftest', log: () => {} })
  svc.workspace.init()
  const reviewPath = svc.reviewPath()
  rmSync(reviewPath, { force: true })
  mkdirSync(reviewPath, { recursive: true })
  writeFileSync(join(reviewPath, 'occupied.txt'), 'x')
  let threw = false
  try {
    svc.publish()
  } catch {
    threw = true
  }
  const tmp = findTmp(dirname(reviewPath)).filter((p) => p.includes('review.json'))
  check('B2 publish 失败时抛错（仍可见，不吞）', threw)
  check('B2 失败后无 tmp 残留（证明已委托 writeFileAtomic）', tmp.length === 0, tmp.join(' | '))
  // 额外的**变异体式**判据：若残留存在，其命名必须**不是**旧形态
  const legacy = tmp.filter((p) => new RegExp(`review\\.json\\.tmp-${process.pid}$`).test(p))
  check('B2 无旧形态 tmp（<target>.tmp-<pid>）', legacy.length === 0, legacy.join(' | '))
  rmSync(ws, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// C. shell-executor：开关关闭 ⇒ 交还原生执行器（结构判据，不启动任何进程）
// ─────────────────────────────────────────────────────────────
// C. shell-executor：**最终实现**（"降级而非失效"）的静态判据
//    ★ 已作废的旧断言（曾期望 execute() 委托平台原生执行器）已移除：
//      "交还平台"三次实测均不可行（服务名重复注册 / subprocess 未注入 / 报错逸出），
//      代码已标注为取证保留、不再调用。详见
//      docs/dsh2-shell-交还与降级-修复报告.md §2。
// ─────────────────────────────────────────────────────────────
console.log('\n── C. WinStageShellExecutor「降级而非失效」静态判据 ──')
{
  const source = readFileSync(join(REPO, 'dsh-plugin', 'shell-executor.mjs'), 'utf8')
  const execStart = source.indexOf('async execute(spec) {')
  const execEnd = source.indexOf('async executeConfined(spec, context = {}) {')
  const execBody = execStart >= 0 && execEnd > execStart ? source.slice(execStart, execEnd) : ''

  check('C0 能切出 execute() 方法体', execBody.length > 0, `len=${execBody.length}`)
  check(
    'C1 execute() 内不再因档位不匹配而抛错（这正是"shell 全废"的成因）',
    !/requestedMode\s*!==\s*undefined[\s\S]{0,160}?throw shellFailure\(/.test(execBody),
  )
  check('C2 档位不匹配必须报响（error 级日志）', /const mismatched\s*=/.test(execBody) && /this\.logError\(/.test(execBody))
  check('C3 档位不匹配随返回带出 degradeNote', /degradeNote/.test(execBody))
  check('C4 降级注记进 notes（用户可见）', /context\.degradeNote[\s\S]{0,120}?warn\(context\.degradeNote\)/.test(source))
  check('C5 execute() 不再调用已废弃的 nativeExecutorFor()', !execBody.includes('nativeExecutorFor'))
  check(
    'C6 三次失败取证已记录（服务名重复注册 / subprocess / 逸出）',
    /has been registered/.test(source) && /without inject/.test(source),
  )
}

// ─────────────────────────────────────────────────────────────
// A'. 变异体：还原**旧**实现 ⇒ A2 的"不留 tmp"断言**必须**失败
//     （证明该断言不是空转；这正是 publish() 修复前在盘上留下
//      `review.json.tmp-6892` 的那个形态）
// ─────────────────────────────────────────────────────────────
console.log('\n── A\'. 变异体证明（旧实现必须让断言 FAIL）──')
{
  const dir = join(tmpdir(), `wstage-M-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'blocked.json')
  mkdirSync(target)
  writeFileSync(join(target, 'occupied.txt'), 'x')
  // ↓↓↓ 旧实现原样：无 try/catch、无 unlink 清理
  const legacyTmp = `${target}.tmp-${process.pid}`
  writeFileSync(legacyTmp, '{"c":3}')
  let legacyThrew = false
  try {
    const { renameSync } = await import('node:fs')
    renameSync(legacyTmp, target)
  } catch {
    legacyThrew = true
  }
  const leftover = findTmp(dir)
  check('M1 旧实现确实抛错（与 A2 同因）', legacyThrew)
  check('M2 旧实现**留下** tmp ⇒ 说明"不留残留"这条断言能 FAIL', leftover.length > 0, leftover.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64))
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(64))
process.exit(fail === 0 ? 0 : 1)
