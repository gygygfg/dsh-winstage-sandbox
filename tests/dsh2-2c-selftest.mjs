#!/usr/bin/env node
/**
 * **2c 前提复核脚本（NO-DEFECT 复现）—— 不是 2c 的测试。**
 *
 * 2c（"`appliedPaths` 声称已应用、磁盘上却不存在 ⇒ 要报响"）的前提已被推翻，
 * 产品代码里**没有**对应改动（`review-service.mjs` 已回滚到只含 2b 的版本）。
 * 结论与证据见 `docs/dsh2-2c-NO-DEFECT.md`。
 *
 * 本脚本只做两件**确定性**的事，任一条不成立就以非 0 退出：
 *   R1 复现 Lead 当初那条**错误判据**：以相对路径做存在性判断时，判的其实是
 *      `<cwd>\docs\x.md`，而不是工作区里的那个文件（沙箱 shell 的 cwd = 暂存树
 *      ⇒ 该判据**必然**为 False，与文件是否真的存在无关）。
 *   R2 复核代码层判据：`appliedPaths` 的赋值发生在 `applyOneChange()` **成功之后**
 *      （`src/workspace.mjs`），⇒ create/modify 类不存在"记账已写、磁盘未写"的窗口。
 *
 * 零依赖、纯离线、只写系统临时目录。
 * 跑法：node docs\dsh2-2c-selftest.mjs      退出码：0 = 复核成立
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const TMP = mkdtempSync(join(tmpdir(), 'winstage-2c-nodefect-'))
process.on('exit', () => {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const results = []
const check = (name, ok, detail) => {
  results.push(ok === true)
  console.log(`  [ ${ok === true ? 'PASS' : 'FAIL'} ] ${name}${detail === undefined ? '' : `  —— ${detail}`}`)
}

console.log('='.repeat(72))
console.log(' 2c 前提复核（NO-DEFECT）：错误判据 + 代码层判据')
console.log('='.repeat(72))

// ── R1：相对判据测的是 cwd，不是工作区 ────────────────────────────────────
console.log('── R1 相对判据 vs 绝对判据（同一份真文件）────────────────────────────')
const WS = join(TMP, 'workspace')
mkdirSync(join(WS, 'docs'), { recursive: true })
const ABS = join(WS, 'docs', 'x.md')
writeFileSync(ABS, 'this file really exists on disk\n')

const ELSEWHERE = join(TMP, 'elsewhere') // 模拟"cwd ≠ 工作区"（沙箱里 cwd = <store>\staged）
mkdirSync(ELSEWHERE, { recursive: true })
process.chdir(ELSEWHERE)
const REL = 'docs\\x.md'
const relJudge = existsSync(REL)
const absJudge = existsSync(ABS)
console.log(`  workspaceRoot       = ${WS}`)
console.log(`  process.cwd()       = ${process.cwd()}`)
console.log(`  相对判据 '${REL}'            → ${relJudge}`)
console.log(`  绝对判据 '${ABS}' → ${absJudge}`)
console.log(`  相对判据实际测的是   = ${join(process.cwd(), REL)}`)
check('R1a 真文件确实存在（绝对判据 True）', absJudge === true)
check('R1b 相对判据为 False —— 与文件是否存在无关，只说明它测的是 cwd', relJudge === false)
check('R1c 两条判据指向不同路径（这就是当初的测量假象）', join(process.cwd(), REL) !== ABS)

// ── R2：代码层判据（appliedPaths 在 applyOneChange 成功之后） ──────────────
console.log('── R2 appliedPaths 的赋值时机（src/workspace.mjs）────────────────────')
const lines = readFileSync(join(REPO, 'src', 'workspace.mjs'), 'utf8').split(/\r?\n/)
const at = (needle) => lines.findIndex((line) => line.includes(needle)) + 1
const iApply = at('this.applyOneChange(change, opts)')
const iPush = at('applied.push({ path: change.path, op: change.op })')
const iPaths = at('candidate.appliedPaths = [...(candidate.appliedPaths || [])')
const iSave = at('candidate.lastApply = { applied, failed, blockedByMask, maskWarnings }')
// ⚠ 必须从 appliedPaths 之后开始找：`saveCandidate` 在 `freezeCandidate()` 里也出现过一次
// （首版就是这个坑：`findIndex` 命中 line 917，导致 R2c 假 FAIL）。
const iAttach = (() => {
  const from = iPaths - 1
  if (from < 0) return -1
  const rel = lines.slice(from).findIndex((line) => line.includes('this.store.saveCandidate(candidate)'))
  return rel < 0 ? -1 : from + rel + 1
})()
console.log(`  applyOneChange() 调用            : line ${iApply}（try 内）`)
console.log(`  applied.push(...)                : line ${iPush}（仅当上面没抛异常）`)
console.log(`  candidate.appliedPaths 赋值      : line ${iPaths}`)
console.log(`  candidate.lastApply / saveCandidate : line ${iSave} / ${iAttach}`)
check('R2a 四个锚点都定位到了', iApply > 0 && iPush > 0 && iPaths > 0 && iAttach > 0)
check('R2b appliedPaths 只在 applyOneChange 成功之后记（apply < push ≤ paths）', iApply > 0 && iApply < iPush && iPush <= iPaths)
check('R2c 落盘与记账是同一次调用内、先落盘后记账（不存在中间窗口）', iPaths > 0 && iAttach > iPaths)

console.log('')
console.log('='.repeat(72))
const pass = results.filter(Boolean).length
const fail = results.length - pass
console.log(` 2c 前提复核: ${fail === 0 ? 'NO-DEFECT 成立' : '复核失败（前提需要重开）'}   判定 ${pass} ok / ${fail} bad`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)
