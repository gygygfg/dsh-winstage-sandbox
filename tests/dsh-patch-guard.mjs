#!/usr/bin/env node
/**
 * dsh-patch-guard —— **补丁守门套件**：把"补丁悄悄丢了 / harness 悄悄漂了"变成红灯
 * ============================================================================
 * 存在理由（与 `registry-guard`、`suite-wiring` 同族，只是对象换成了 DSH 安装树）：
 *   `patches/dsh/` 里的三处修复是打在 **npx 缓存安装树**上的（编译产物，没有源码与构建工具）。
 *   缓存树的宿命是：`npm i` / 升级 / 清缓存之后**无声回退**；上游一升级，行号与文案也会漂。
 *   没有这条守门测试时，两种失效都表现为"看起来一切正常"——这正是本仓反复记录的缺陷形态
 *   （README §8.2 的 `registry-guard` 缺口）。本套件把判据钉成一句话：
 *
 *     **受补丁文件的现场哈希，必须恰好等于 before（未打）或 after（已打）；第三个数就是漂移。**
 *
 * 检查项（每条一个 ✓/✗）：
 *   1. 清单可解析、schema 正确、字段齐全（id/target/pristine/upstream.directory/rationale）
 *   2. 补丁包**离线自洽**（不依赖 harness）：原样副本哈希 == beforeSha256、
 *      `before` 锚点在副本里恰好出现一次、由副本派生的 after 哈希 == afterSha256
 *   3. 现场安装文件哈希 ∈ {before, after}（**这条是红灯的主要来源**），且锚点确实在文件里
 *   4. 定位不到 harness 时**如实 SKIP**（打印原因、退出码 0）—— 绝不是假 PASS
 *
 * 证据分层：1/2 是纯离线静态结论（`[实测]`：跑的就是本机当前文件内容）；
 * 3 只在 harness 存在时才是 `[实测]`，否则整段不给出结论。
 *
 * 用法：
 *   node tests\dsh-patch-guard.mjs           # 正常，应当全绿（未打补丁也算绿），退出码 0
 *   node tests\dsh-patch-guard.mjs --plant   # 只扰动**副本**：清单哈希 + 临时目录里的现场文件，
 *                                            # 应当见红（证明判定真的能红），退出码 1
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MANIFEST_PATH,
  REPO,
  applyPatch,
  auditManifest,
  backupPath,
  checkEntries,
  countOccurrences,
  locateHarnessRoot,
  pristinePath,
  readManifest,
  revertPatch,
  sha256,
} from '../tools/dsh-patches.mjs'

const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// ── 读取真实输入 ────────────────────────────────────────────────────────────

const manifest = readManifest()
W(`补丁清单: ${MANIFEST_PATH.slice(REPO.length + 1)}（${manifest.patches.length} 个文件级 entry${PLANT ? '，--plant 模式' : ''}）`)

// ── `--plant`：只扰动输入副本，绝不碰真实文件 ───────────────────────────────
//
//   (a) 清单副本：把第一条 entry 的 beforeSha256 改成一个假哈希 ⇒ 离线自洽性必须变红；
//   (b) 现场副本：在临时目录里按 target 摆出全部原样副本，再把其中**一个字节**翻掉
//       ⇒ 现场哈希既不是 before 也不是 after，漂移判定必须变红。
//   两者都不写 harness 根、不写真清单。

let effectivePatches = manifest.patches
let plantedManifest = manifest

// (a) 清单副本：假哈希（保持长度，避免"格式非法"掩盖"内容不符"）
if (PLANT) {
  const first = manifest.patches[0]
  const bogus = `${first.beforeSha256.slice(0, 63)}${first.beforeSha256.endsWith('0') ? '1' : '0'}`
  plantedManifest = { ...manifest, patches: [{ ...first, beforeSha256: bogus }, ...manifest.patches.slice(1)] }
  effectivePatches = plantedManifest.patches
}

// (b) 现场副本：临时目录 + 逐 target 摆文件，翻掉第二个 entry 的一个字节
let plantedRoot
if (PLANT) {
  plantedRoot = mkdtempSync(join(tmpdir(), 'dsh-patch-guard-plant-'))
  for (const entry of manifest.patches) {
    const target = join(plantedRoot, entry.target)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(pristinePath(entry), target)
  }
  const victim = manifest.patches[1]
  const victimPath = join(plantedRoot, victim.target)
  const text = readFileSync(victimPath, 'utf8')
  writeFileSync(victimPath, text.replace('const escalationModes', 'const escalationModez'), 'utf8')
}

// ── 1. 清单可解析 / 字段齐全 / 唯一性 ───────────────────────────────────────

section('1. 清单可解析与字段齐全（patches/dsh/manifest.json）')
check('schema=1 且 kind=dsh-harness-patch-kit', manifest.schema === 1 && manifest.kind === 'dsh-harness-patch-kit', `schema=${manifest.schema} kind=${manifest.kind}`)
check('entry 数 ≥ 4（P1/P2/P3 宿主 + P3 客户端）', manifest.patches.length >= 4, `patches=${manifest.patches.length}`)
const ids = effectivePatches.map((entry) => entry.id)
const duplicatedIds = ids.filter((id, index) => ids.indexOf(id) !== index)
check('id 唯一', duplicatedIds.length === 0, duplicatedIds.join(', ') || `${ids.length} 个唯一 id`)
const targets = effectivePatches.map((entry) => entry.target)
const duplicatedTargets = targets.filter((target, index) => targets.indexOf(target) !== index)
check('target（harness 相对路径）唯一', duplicatedTargets.length === 0, duplicatedTargets.join(', ') || `${targets.length} 个唯一 target`)
const incomplete = effectivePatches.filter(
  (entry) =>
    typeof entry.title !== 'string' ||
    entry.title.length === 0 ||
    typeof entry.rationale !== 'string' ||
    entry.rationale.trim().length < 8 ||
    typeof entry.upstream?.package !== 'string' ||
    typeof entry.upstream?.directory !== 'string' ||
    typeof entry.upstream?.version !== 'string' ||
    !Array.isArray(entry.verified) ||
    !Array.isArray(entry.unverified) ||
    !Array.isArray(entry.residuals),
)
check('每条 entry 都有 title / rationale / upstream / verified / unverified / residuals', incomplete.length === 0, incomplete.map((entry) => entry.id).join(', ') || '全部齐全')
check('存在 status=draft（[未验证]）的条目被显式标注', effectivePatches.every((entry) => entry.status === 'verified' || entry.status === 'draft'), effectivePatches.map((entry) => `${entry.id}=${entry.status}`).join(', '))

// ── 2. 补丁包离线自洽（不需要 harness） ─────────────────────────────────────

section('2. 补丁包离线自洽（原样副本 + 锚点 + 可复算的 after 哈希）')
for (const entry of effectivePatches) {
  const label = entry.id
  if (!existsSync(pristinePath(entry))) {
    check(`${label}: 原样副本存在`, false, `缺 ${entry.pristine}`)
    check(`${label}: before 锚点在副本里恰好一次`, false, '副本缺失，无法判定')
    check(`${label}: 由副本派生的 after 哈希 == afterSha256`, false, '副本缺失，无法判定')
    continue
  }
  const text = readFileSync(pristinePath(entry), 'utf8')
  const actualBefore = sha256(Buffer.from(text, 'utf8'))
  check(
    `${label}: 原样副本哈希 == beforeSha256`,
    actualBefore === entry.beforeSha256,
    actualBefore === entry.beforeSha256 ? `${actualBefore.slice(0, 16)}…` : `副本 ${actualBefore} != 清单 ${entry.beforeSha256}`,
  )
  const anchors = countOccurrences(text, entry.before)
  check(`${label}: before 锚点在副本里恰好一次`, anchors === 1, `出现 ${anchors} 次`)
  const derived = anchors === 1 ? text.replace(entry.before, entry.after) : text
  const actualAfter = sha256(Buffer.from(derived, 'utf8'))
  check(
    `${label}: 由副本派生的 after 哈希 == afterSha256`,
    actualAfter === entry.afterSha256,
    actualAfter === entry.afterSha256 ? `${actualAfter.slice(0, 16)}…` : `派生 ${actualAfter} != 清单 ${entry.afterSha256}`,
  )
}
const audit = auditManifest(plantedManifest)
check(
  'auditManifest() 汇总无自洽性错误',
  audit.errors.length === 0,
  audit.errors.length === 0 ? `${audit.details.length} 条 entry 全部自洽` : audit.errors.join(' | '),
)

// ── 3. 现场判定：安装文件必须恰好是 before 或 after ─────────────────────────

section('3. 现场判定（harness 安装文件 == before 或 == after；第三个数即漂移）')
const located = PLANT ? { root: plantedRoot, source: 'plant-temp-copy' } : locateHarnessRoot(plantedManifest)
if (located.root === null) {
  W('')
  W('  ! SKIP（诚实跳过，不是通过）：定位不到 DSH harness 根，现场判定这一整段没有结论。')
  W('    已尝试:')
  for (const line of located.tried) W(`      - ${line}`)
  W('    修复: 设置 DSH_HARNESS_ROOT 指向 npx 缓存根（其下应有 node_modules\\@deepseek-ai\\dsh-sandbox），或先安装 dsh。')
  W('')
  W('='.repeat(72))
  W(`DSH 补丁守门（清单自洽已查，现场判定 SKIP）：断言 ${assertions} 项，失败 ${failures} 项`)
  W(`RESULT: SKIP harness-not-found checks=${assertions} failures=${failures} mode=normal`)
  // 清单自洽都没过时不掩盖：失败即红，成功且缺 harness 才是"诚实跳过"。
  process.exitCode = failures > 0 ? 1 : 0
} else {
  W(`harness 根: ${located.root}（来源 ${located.source}）`)
  const { results, drift } = checkEntries({ patches: plantedManifest.patches }, located.root)
  for (const entry of effectivePatches) {
    const result = results.find((item) => item.id === entry.id)
    const expected = `before=${entry.beforeSha256.slice(0, 16)}… after=${entry.afterSha256.slice(0, 16)}…`
    check(
      `${entry.id}: 现场哈希 ∈ {before, after}（判定 ${result.status}）`,
      result.status === 'NOT-APPLIED' || result.status === 'APPLIED',
      result.status === 'DRIFT'
        ? `harness drifted — re-validate the patch\n      文件: ${result.file}\n      期望: ${expected}\n      实际: ${result.actualSha256 ?? '(读不到)'}\n      说明: ${result.detail}`
        : `${result.status} / ${result.detail}`,
    )
  }
  const applied = results.filter((item) => item.status === 'APPLIED').length
  const notApplied = results.filter((item) => item.status === 'NOT-APPLIED').length
  check(
    '总体口径可判定（未应用 + 已应用 + 漂移 == entry 总数）',
    notApplied + applied + drift === results.length,
    `未应用 ${notApplied} / 已应用 ${applied} / 漂移 ${drift} / 合计 ${results.length}`,
  )

  // ── 4. `--apply` / `--revert` 的行为（**只在临时副本上跑，绝不写 harness 根**） ──
  // 为什么需要这一段：`--apply` 在本任务期间被明令禁止执行（不许写 harness 根），
  // 但"不许执行"不等于"可以不验证"。这里把清单里的原样副本摆进临时目录，对**副本**
  // 执行与 `--apply`/`--revert` 完全相同的函数，钉死四件事：写入结果、备份、幂等、拒绝漂移。
  section('4. --apply / --revert 的行为（临时副本；harness 根一字未写）')
  const applyRoot = mkdtempSync(join(tmpdir(), 'dsh-patch-apply-'))
  try {
    for (const entry of manifest.patches) {
      const path = join(applyRoot, entry.target)
      mkdirSync(dirname(path), { recursive: true })
      copyFileSync(pristinePath(entry), path)
    }
    const target = manifest.patches[0]
    const file = join(applyRoot, target.target)
    const first = applyPatch(target, applyRoot)
    check('apply 后文件哈希 == afterSha256', sha256(readFileSync(file)) === target.afterSha256, `${first.action} ⇒ ${sha256(readFileSync(file)).slice(0, 16)}…`)
    check(
      'apply 会留下 <file>.dsh-patch-backup，且它等于 before',
      existsSync(backupPath(file)) && sha256(readFileSync(backupPath(file))) === target.beforeSha256,
      backupPath(file).slice(applyRoot.length + 1),
    )
    const second = applyPatch(target, applyRoot)
    check('apply 幂等（第二次报 already-applied，不重复备份）', second.action === 'already-applied', second.action)
    const reverted = revertPatch(target, applyRoot)
    check('revert 从备份回滚后哈希 == beforeSha256', reverted.action === 'reverted-from-backup' && sha256(readFileSync(file)) === target.beforeSha256, reverted.action)
    // 备份缺失时的回落通路（原样副本）：先应用，再把备份删掉（模拟"备份被人清了/换了机器"）
    applyPatch(target, applyRoot)
    rmSync(backupPath(file), { force: true })
    const fallback = revertPatch(target, applyRoot)
    check('备份缺失时 revert 回落原样副本', fallback.action === 'reverted-from-pristine' && sha256(readFileSync(file)) === target.beforeSha256, fallback.action)
    // 漂移必须被拒绝（这是本套件存在的意义：绝不"照写不误"）
    const victim = manifest.patches[1]
    const victimFile = join(applyRoot, victim.target)
    writeFileSync(victimFile, readFileSync(victimFile, 'utf8').replace('const escalationModes', 'const escalationModez'), 'utf8')
    let refused = false
    let refusal = ''
    try {
      applyPatch(victim, applyRoot)
    } catch (error) {
      refused = true
      refusal = String(error?.message ?? error)
    }
    check('现场漂移时 apply 必须**拒绝**（而不是照写不误）', refused, refusal || '（没有抛错 —— 说明漂移守卫是空断言）')
  } finally {
    rmSync(applyRoot, { recursive: true, force: true })
  }

  if (PLANT) {
    W('')
    W('=== 5. --plant 反证（证明上面两条判定真的能红） ===')
    check('--plant：清单副本的假哈希被抓到（auditManifest 报错 ≥ 1）', audit.errors.length >= 1, audit.errors.join(' | ') || '（没有报错 —— 说明自洽性判定是恒绿的空断言）')
    check('--plant：临时现场副本的字节扰动被判漂移（drift ≥ 1）', drift >= 1, `drift=${drift}`)
    check('--plant：失败项 ≥ 2（非空转）', failures >= 2, `failures=${failures}`)
  }

  W('')
  W('='.repeat(72))
  W(
    `DSH 补丁守门（${PLANT ? '--plant 模式：伪造清单哈希 + 扰动现场副本，应当失败' : '清单自洽 + 现场哈希双判'}）：断言 ${assertions} 项，失败 ${failures} 项`,
  )
  W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)
  process.exitCode = failures > 0 ? 1 : 0
}

// 临时目录用完即删（`--plant` 只在 os.tmpdir() 下留过东西，绝不落在仓库里）
if (plantedRoot !== undefined) {
  try {
    rmSync(plantedRoot, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响判定 */
  }
}
