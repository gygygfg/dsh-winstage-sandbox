/**
 * 2a：**越界暂存隔离不变式**钉死断言（离线、自包含、零依赖）
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────────────
 * Lead 本轮曾误判"越界 fs 写在批准前就落到真实磁盘（泄漏）"，后用**单变量实验推翻**
 * （10 秒窗口内真实磁盘零变化，对象在 `staged-ext/`）。为防同类误判复发，
 * 这里把那条不变式**钉死成可执行断言**，并给出**变异体证明**它不空转。
 *
 * ── 钉死的不变量（对 external 条目）─────────────────────────────────────────────
 *   I1  经 `Workspace.writeFile(外部绝对路径)` 后，**真实磁盘上该路径不存在**
 *   I2  该条目进入清单、带 `external: true`、`baseHash=absent`
 *   I3  内容对象落在 `<store>/staged-ext/`，且内容一致
 *   A   只有**批准之后**才允许落真实磁盘
 *
 * ── 判据要点（Lead 本轮踩过的坑，写在这里防复发）──────────────────────────────
 *   ★ 判"真实磁盘"必须用**绝对路径**。沙箱 shell 的 cwd 是**暂存树**，
 *     相对路径恒假 ⇒ 会产生"文件不存在"的假象（这正是 Lead 误判的成因）。
 *     本脚本在 Node 进程里跑、全程绝对路径，不经过那层歧义。
 *
 * ── 变异体（证明断言能 FAIL）──────────────────────────────────────────────────
 *   M1  变异前：不变量成立（真实磁盘不存在）
 *   M2  把暂存内容直接写到真实目标（= 被推翻的旧行为）⇒ I1 判据**变成 FAIL**
 *   M3  两者结果不同 ⇒ 断言非空转
 *
 * 跑法：node docs/dsh2-2a-outside-isolation.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: ok === true })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail !== undefined ? `  —— ${detail}` : ''}`)
}

/**
 * 路径归一化。**必须用 `realpathSync.native()`**：
 * `%TEMP%` 常给出 8.3 **短名**（实测 `...\ADMINI~1\...`），而清单里记的是长名
 * `...\Administrator\...` —— 同一目录的两种写法。`path.resolve()` **不会**展开短名，
 * 直接 `===` 必然假失败。这正是 Lead 本轮踩到的判据坑。
 */
const norm = (p) => {
  if (p == null) return undefined
  const s = String(p)
  try {
    return realpathSync.native(s).replace(/[\\/]+$/, '').toLowerCase()
  } catch {
    // 目标可能尚不存在：把**最近的已存在祖先**展开后拼回剩余段
    try {
      let dir = s
      const rest = []
      for (;;) {
        const parent = dirname(dir)
        if (parent === dir) break
        rest.unshift(basename(dir))
        dir = parent
        if (existsSync(dir)) return join(realpathSync.native(dir), ...rest).toLowerCase()
      }
    } catch {
      /* 落到下面的兜底 */
    }
    return resolve(s).replace(/[\\/]+$/, '').toLowerCase()
  }
}
const samePath = (a, b) => norm(a) !== undefined && norm(a) === norm(b)

/** 递归列文件（bounded） */
function walk(dir, depth = 0) {
  if (!existsSync(dir) || depth > 4) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, depth + 1))
    else out.push(p)
  }
  return out
}

console.log('='.repeat(70))
console.log(' 2a：越界暂存隔离不变式（含变异体证明）')
console.log('='.repeat(70))

const { Workspace } = await import(pathToFileURL(join(REPO, 'src', 'workspace.mjs')).href)

/**
 * 隔离夹具：`<tmp>/ws` 是工作区，`<tmp>/outside` 是"工作区之外"的目标目录。
 * ★ 根用 `realpathSync.native()` 展开：从源头消除 `%TEMP%` 的 8.3 短名，
 *   免得后续每处比较都要处理"同一路径两种写法"。
 */
function fixture(tag) {
  const rawBase = join(tmpdir(), `wstage-2a-${tag}-${process.pid}-${Date.now()}`)
  mkdirSync(rawBase, { recursive: true })
  const base = realpathSync.native(rawBase)
  const wsRoot = join(base, 'ws')
  const outDir = join(base, 'outside')
  mkdirSync(wsRoot, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  return { base, wsRoot, outDir }
}

/**
 * 清单条目：读**内存中的清单**（`ws.manifest.entries`，权威），
 * 而不是磁盘上的 `manifest.json` —— 后者在 `writeFile()` 之后可能尚未落盘，
 * 会得到"条目缺失"的假失败（Lead 本轮踩到的第三个判据坑）。
 */
const entriesOf = (ws) => Object.values(ws.manifest?.entries ?? {})

// ─────────────────────────────────────────────────────────────
// I. 不变量：越界写必须"只入暂存、不碰真实磁盘"
// ─────────────────────────────────────────────────────────────
console.log('\n── I. 越界写隔离（经 Workspace.writeFile）──')
{
  const f = fixture('main')
  const target = join(f.outDir, 'outside-target.txt')
  const content = 'OUTSIDE-CONTENT-v1\n'

  const ws = new Workspace({ workspaceRoot: f.wsRoot, sessionId: '2a-outside' })
  ws.init()
  ws.writeFile(target, content, { origin: 'dsh-tool' })

  check('I1 越界写后真实磁盘上目标不存在', existsSync(target) === false, `exists=${existsSync(target)}`)
  check('I4 再次确认（同一绝对路径判据一致）', existsSync(target) === false)

  const entries = entriesOf(ws)
  // ★ 取字段方式：外部条目的清单**键 = 规范化绝对路径**，并带 `absPath` 字段
  //   （`src/workspace.mjs:263-278` 的 `keyOf()`：越过工作区根 ⇒ 绝对键 + external:true）。
  // ★ 比较必须走 `samePath`（大小写不敏感 + 短名化容忍）：实测 `%TEMP%` 会给出
  //   `...\ADMINI~1\...`，而清单里是 `...\Administrator\...`，`===` 会假失败。
  const entry = entries.find((e) => e && samePath(e.absPath, target))
  check('I2 清单里有该路径的条目（samePath 匹配）', !!entry, `entries=${entries.length}`)
  check('I2b 该条目标记为 external', entry?.external === true, `external=${entry?.external}`)
  check(
    'I2c 条目记录 baseHash 含 absent（= 新建）',
    String(entry?.baseHash ?? '').includes('absent'),
    `baseHash=${entry?.baseHash}`,
  )
  check('I2d 条目带 absPath 且指向目标', samePath(entry?.absPath, target), String(entry?.absPath))

  const extFiles = walk(ws.store.stagedExtDir)
  check('I3 对象物化在 staged-ext/ 下', extFiles.length > 0, `files=${extFiles.length}`)
  check(
    'I3b staged-ext 里内容与写入一致',
    extFiles.some((p) => {
      try {
        return readFileSync(p, 'utf8') === content
      } catch {
        return false
      }
    }),
    extFiles.map((p) => p.replace(f.base, '')).join(' | '),
  )
  const plainFiles = walk(ws.store.stagedDir).filter((p) => p.endsWith('.txt'))
  check('I3c 阴性对照：没有误放进 staged/', plainFiles.length === 0, plainFiles.join(' | '))

  rmSync(f.base, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// N. 阴性对照：工作区**内**写 → 相对键、落 `staged/`、同样不碰真实磁盘
//    （★ 这一段的判据是本轮最"值钱"的发现：只有在夹具根经 `realpathSync.native()`
//      展开、与 `workspaceRoot` 完全同形之后，`keyOf()` 才会把该路径判为**界内**。
//      此前用短名 `%TEMP%` 时它被误判为界外 —— 判据错会直接导致结论错。）
// ─────────────────────────────────────────────────────────────
console.log('\n── N. 阴性对照：工作区内写 → 相对键 + staged/ ──')
{
  const f = fixture('inside')
  const target = join(f.wsRoot, 'inside-target.txt')
  const ws = new Workspace({ workspaceRoot: f.wsRoot, sessionId: '2a-inside' })
  ws.init()
  ws.writeFile(target, 'INSIDE-v1\n', { origin: 'dsh-tool' })

  check('N1 工作区内写后真实磁盘不存在', existsSync(target) === false, `exists=${existsSync(target)}`)

  const entries = entriesOf(ws)
  const entry = entries.find((e) => e && e.path === 'inside-target.txt')
  check('N2 条目以**相对键**记录（界内语义）', !!entry, `entries=${entries.length}`)
  check('N2b 界内条目**不带** external/absPath', entry?.external !== true && entry?.absPath === undefined, `external=${entry?.external} absPath=${entry?.absPath}`)
  check('N3 对象落在 staged/（界内）', walk(ws.store.stagedDir).length > 0, `staged=${walk(ws.store.stagedDir).length}`)
  check('N3b 阴性对照：staged-ext/ 为空', walk(ws.store.stagedExtDir).length === 0, `staged-ext=${walk(ws.store.stagedExtDir).length}`)
  check('N4 再次确认真实磁盘不存在', existsSync(target) === false)
  rmSync(f.base, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// A. 对照：**批准之后**才允许落真实磁盘
// ─────────────────────────────────────────────────────────────
console.log('\n── A. 对照：批准后才落盘（证明 I1 测的是"批准前"）──')
{
  const f = fixture('approve')
  const target = join(f.outDir, 'approved-target.txt')
  const content = 'APPROVED-CONTENT\n'
  const ws = new Workspace({ workspaceRoot: f.wsRoot, sessionId: '2a-approve' })
  ws.init()
  ws.writeFile(target, content, { origin: 'dsh-tool' })
  check('A1 批准前真实磁盘不存在', existsSync(target) === false)

  let appliedCount = 0
  let appliedError
  try {
    const frozen = typeof ws.freezeIfNeeded === 'function' ? ws.freezeIfNeeded({ source: '2a' }) : undefined
    let id = frozen?.candidate?.id
    if (!id && typeof ws.listReviews === 'function') {
      const list = ws.listReviews()
      id = Array.isArray(list) && list.length > 0 ? list[list.length - 1].id : undefined
    }
    if (!id) throw new Error('拿不到候选 id')
    const r = ws.applyCandidate(id, {})
    appliedCount = Array.isArray(r?.applied) ? r.applied.length : 0
  } catch (e) {
    appliedError = e?.message ?? String(e)
  }
  check('A2 批准确实应用了该条目', appliedCount > 0, appliedError ? `error=${appliedError}` : `applied=${appliedCount}`)
  check('A3 批准后真实磁盘出现该文件', existsSync(target), `exists=${existsSync(target)}`)
  if (existsSync(target)) check('A4 落盘内容与暂存一致', readFileSync(target, 'utf8') === content)
  rmSync(f.base, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// M. 变异体：模拟"暂存期即写真实磁盘"的旧行为
// ─────────────────────────────────────────────────────────────
console.log('\n── M. 变异体：暂存期即落盘 ⇒ I1 判据必须 FAIL ──')
{
  const f = fixture('mutant')
  const target = join(f.outDir, 'mutant-target.txt')
  const ws = new Workspace({ workspaceRoot: f.wsRoot, sessionId: '2a-mutant' })
  ws.init()
  ws.writeFile(target, 'MUTANT\n', { origin: 'dsh-tool' })

  const beforeMutation = existsSync(target) // 修复后应为 false
  writeFileSync(target, 'MUTANT\n') // ↓ 变异：直接写真实目标（= 被推翻的旧行为）
  const afterMutation = existsSync(target)

  check('M1 变异前不变量成立（真实磁盘不存在）', beforeMutation === false, `exists=${beforeMutation}`)
  check('M2 变异后 I1 判据**变成 FAIL** ⇒ 断言能抓到落盘', afterMutation === true, `exists=${afterMutation}`)
  check('M3 变异体与修复体结果不同（断言非空转）', beforeMutation !== afterMutation)
  rmSync(f.base, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(70))
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
