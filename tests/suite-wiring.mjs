#!/usr/bin/env node
/**
 * suite-wiring —— **治理套件**：把"套件注册表漂移"本身变成可执行断言
 * ============================================================================
 * 存在理由（本项目的反复缺陷，见 `src/testrunner.mjs:35-53, 58-63` 与 README §8.2）：
 *   `registry-guard`、`appcontainer-runtime`、`wfp-layout` 三个套件都出现过同一种形态 ——
 *   "文件存在、手动跑是绿的、但既不在 `verify.cmd` 的循环里、也不在 `OFFLINE_SUITES` 里，
 *   所以改坏了没有任何东西会注意到"。上一轮靠人工发现、人工补登记，这一轮把它变成机器检查。
 *
 * NeoAI 实践对齐：**已知残余要冻结成基线断言**。这里的"残余"是注册表缺口 ——
 * 允许存在未登记的套件文件，但**必须显式列名并写明理由**（`KNOWN_UNREGISTERED`），
 * 不允许"悄悄消失"。一个文件从注册表里被删掉、又没进这个显式名单，本套件必须判红。
 *
 * 检查项（每条一个 ✓/✗）：
 *   1. 注册表本身可解析（两张表字段齐全、id/script 非空）
 *   2. `verify.cmd` 的 `for %%S in (...)` 列表 == `OFFLINE_SUITES` 脚本，**逐项同序同数**
 *   3. `verify.cmd` 里不得出现 `SANDBOX_SUITES` 的脚本（verify 只跑离线档）
 *   4. `verify.cmd` 纯 ASCII（残余边界 R11：非 ASCII 注释会被 cmd.exe 当命令执行）
 *   5. 仓库内其它 `.cmd` 也必须纯 ASCII（同 R11，同一个坑不踩第二次）
 *   6. 无重复 id（跨两张表）；7. 无重复 script
 *   8. id == 脚本 basename（服务白名单 `/suites` 按 id 取用，脱钩会静默跑错文件）
 *   9. 每个 script 都在 `tests/` 下、以 `.mjs` 结尾（防路径逃逸进白名单）
 *  10. 所有已注册脚本都存在于磁盘（**没有豁免**：注册了却不存在，一律判红）
 *  11. 每个 `tests/*.mjs`（非 `_` 前缀辅助文件）要么已登记，要么在 `KNOWN_UNREGISTERED` 里
 *  12. `KNOWN_UNREGISTERED` 不得有僵尸条目（文件已消失、或其实已经登记了）
 *  13. `KNOWN_UNREGISTERED` 的理由必须是一句真话（非空、去掉空白后 ≥ 8 字符）
 *
 * 证据分层：本文件只做**静态**检查（读源码文本 / 列目录），不跑任何子进程、不碰系统状态，
 * 因此结论是 `[实测]`（跑的就是本机当前文件内容）而不是推断。
 *
 * 用法：
 *   node tests\suite-wiring.mjs            # 正常，应当全绿，退出码 0
 *   node tests\suite-wiring.mjs --plant    # 只动测试这一侧的输入（改副本），应当见红，退出码 1
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { OFFLINE_SUITES, SANDBOX_SUITES, REPO } from '../src/testrunner.mjs'

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

/**
 * 显式豁免的未登记套件（诚实逃生口）。
 *
 * 规则：key = `tests/` 下的相对文件名；value = **一句真话**说明为什么它不进自动关口。
 * 任何"文件在磁盘上但既不在这里也不在注册表里"的情况都必须判红 —— 这正是本套件的全部意义。
 */
const KNOWN_UNREGISTERED = Object.freeze({
  'tests/acceptance-transparent.mjs':
    'Lead 侧端到端验收台（暂存透明性 8 项），须在"沙箱已开启"的会话里手动跑，不属于自动关口',
  'tests/registry-apply-e2e.mjs':
    '会临时写真实 HKCU（文件头明确要求不许进 verify）；需未受限会话单独跑，判据是真实 hive 副作用',
  'tests/registry-conformance.mjs':
    '断言对象是**真实产物**（shim DLL + 闭环节报告 + 真实 WAL）；产物缺失时整段如实 SKIP，需构建后单独跑',
  'tests/registry-stage.mjs':
    '独立入口仅供定位；同一批断言已由 registry-guard（已登记）在既有关口内覆盖，重复登记只会加长关口',
  'tests/dsh2-2a-outside-isolation.mjs': 'dsh2 轮次一次性诊断脚本（越界写隔离不变式），结论已归档 docs/dsh2-*.md',
  'tests/dsh2-2c-selftest.mjs': 'dsh2 轮次一次性复核脚本（NO-DEFECT 复现），结论已归档 docs/dsh2-2c-NO-DEFECT.md',
  'tests/dsh2-3-audit-mirror.mjs': 'dsh2 轮次一次性诊断脚本（审批审计镜像），结论已归档 docs/dsh2-方向3-*.md',
  'tests/dsh2-fix2-selftest.mjs': 'dsh2 轮次一次性复核脚本（writeFileAtomic 负路径），结论已归档 docs/dsh2-修复报告.md',
  'tests/dsh2-select-shell-feasibility.mjs': 'dsh2 轮次一次性可行性脚本（装配层择一装载求值器），结论已归档 docs/dsh2-需求与验收.md',
  'tests/dsh2-select-shell-verify.mjs': 'dsh2 轮次一次性验证脚本（择一装载真实 yaml + !!js），结论已归档 docs/dsh2-需求与验收.md',
  'tests/dsh2-shell-fallback-verify.mjs': 'dsh2 轮次一次性静态验证脚本（交还与降级修复），结论已归档 docs/dsh2-shell-交还与降级-修复报告.md',
})

/**
 * 这里曾经有一张 `PENDING_REGISTRATIONS` 豁免表：允许"已登记但尚未落盘"的脚本存在，
 * 条目是并行开发期临时挂上的 `tests/integration-wiring.mjs`。
 *
 * 该文件**现在已经在磁盘上**，所以这张表连同消费它的分支一起删除 —— 不保留空表，也不保留
 * "注册了却不存在也能全绿"的静默通道：那正是本套件存在的意义所在。从今往后，注册表里写了
 * 一个脚本、磁盘上却没有，就是**硬失败**（见第 6 节），没有任何豁免可言。
 */

/** `--plant` 用的输入副本扰动（绝不修改 src/、verify.cmd 或任何真实文件） */
function omitKey(object, key) {
  const copy = { ...object }
  delete copy[key]
  return copy
}

// ── 读取真实输入 ────────────────────────────────────────────────────────────

const verifyPath = join(REPO, 'verify.cmd')
const verifyText = readFileSync(verifyPath, 'utf8')

/** 从 `for %%S in (...) do (` 里取出脚本列表（统一成 `/` 分隔，便于与注册表比较） */
function parseVerifyLoop(text) {
  const match = /for\s+%%[A-Za-z]\s+in\s*\(([^)]*)\)/i.exec(text)
  if (!match) return null
  return match[1]
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => item.replace(/\\/g, '/'))
}

const verifyScripts = parseVerifyLoop(verifyText)

/** 目录里真实的套件文件（`_` 前缀是辅助文件，例如 `_planted-failure.mjs`） */
function listTestFiles() {
  return readdirSync(join(REPO, 'tests'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `tests/${name}`)
    .sort()
}

/** 仓库内所有 `.cmd`（跳过 node_modules/.git/.t：那些不是本仓库的判据面） */
const scanSkipped = []
function listCmdFiles(dir = REPO, depth = 0, out = []) {
  if (depth > 3) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // 受限 ACL 下某些目录（例如历史产物 retest\*）不可枚举。**不静默**：记下来在证据里列出。
    scanSkipped.push(`${dir.slice(REPO.length + 1) || '.'} (${error.code})`)
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.t') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listCmdFiles(full, depth + 1, out)
    else if (entry.name.toLowerCase().endsWith('.cmd')) out.push(full)
  }
  return out
}

const isPureAscii = (text) => ![...text].some((char) => char.codePointAt(0) > 0x7f)

// ── `--plant`：只扰动测试这一侧 ─────────────────────────────────────────────

// 1) verify 列表：把 netpolicy 换成 wfp-layout（既缺项又重复 ⇒ 序/数/内容三重不符）
const plantedVerifyText = PLANT ? verifyText.replace('tests\\netpolicy.mjs', 'tests\\wfp-layout.mjs') : verifyText
const effectiveVerifyScripts = parseVerifyLoop(plantedVerifyText)

// 2) 未登记名单：抹掉一个条目 ⇒ 该文件必须被判红
const effectiveKnown = PLANT ? omitKey(KNOWN_UNREGISTERED, 'tests/acceptance-transparent.mjs') : KNOWN_UNREGISTERED

// 3) 注册表副本：加一个磁盘上不存在的脚本 + 一个重复 id + 一个 id 与 basename 不符
const effectiveOffline = PLANT
  ? [
      ...OFFLINE_SUITES,
      { id: 'ghost-suite', script: 'tests/ghost-suite.mjs', title: '（--plant 伪造）磁盘上不存在' },
      { id: OFFLINE_SUITES[0].id, script: 'tests/duplicated-id.mjs', title: '（--plant 伪造）重复 id' },
      { id: 'id-mismatch', script: 'tests/id-does-not-match.mjs', title: '（--plant 伪造）id 与 basename 不符' },
    ]
  : OFFLINE_SUITES

const registeredEntries = [...effectiveOffline, ...SANDBOX_SUITES]
const registeredScripts = registeredEntries.map((suite) => suite.script)

// ── 1. 注册表可解析 ─────────────────────────────────────────────────────────

section('1. 注册表可解析（src/testrunner.mjs）')
check(
  'OFFLINE_SUITES / SANDBOX_SUITES 均为非空数组',
  Array.isArray(OFFLINE_SUITES) && OFFLINE_SUITES.length > 0 && Array.isArray(SANDBOX_SUITES) && SANDBOX_SUITES.length > 0,
  `offline=${OFFLINE_SUITES.length} sandbox=${SANDBOX_SUITES.length}`,
)
const malformed = registeredEntries.filter(
  (suite) => !suite || typeof suite.id !== 'string' || suite.id.length === 0 || typeof suite.script !== 'string' || suite.script.length === 0,
)
check('每条注册项都有非空 id 与 script', malformed.length === 0, `malformed=${malformed.length}`)
check(
  '每条注册项都有非空 title（报告与 /suites 依赖它）',
  registeredEntries.every((suite) => typeof suite.title === 'string' && suite.title.length > 0),
  `offline+${SANDBOX_SUITES.length} 项`,
)

// ── 2. verify.cmd 列表 == OFFLINE_SUITES ────────────────────────────────────

section('2. verify.cmd 循环列表 == OFFLINE_SUITES（逐项、同序、同数）')
check('解析到了 verify.cmd 的 for 循环列表', effectiveVerifyScripts !== null, `len=${effectiveVerifyScripts?.length ?? 'null'}`)
const expectedScripts = effectiveOffline.map((suite) => suite.script)
const firstDiff = (() => {
  const a = effectiveVerifyScripts ?? []
  const b = expectedScripts
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `index ${i}: verify.cmd=${a[i] ?? '(缺)'} OFFLINE_SUITES=${b[i] ?? '(缺)'}`
  }
  return null
})()
check(
  'verify.cmd 列表与 OFFLINE_SUITES 脚本完全一致（id-for-id）',
  firstDiff === null,
  firstDiff ?? `count=${expectedScripts.length}，逐项一致`,
)
check(
  '两侧数量一致',
  (effectiveVerifyScripts ?? []).length === expectedScripts.length,
  `verify=${(effectiveVerifyScripts ?? []).length} offline=${expectedScripts.length}`,
)

section('3. verify.cmd 只跑离线档')
const sandboxScripts = SANDBOX_SUITES.map((suite) => suite.script)
const leakedSandbox = sandboxScripts.filter((script) => (effectiveVerifyScripts ?? []).includes(script))
check('verify.cmd 里没有 SANDBOX_SUITES 的脚本', leakedSandbox.length === 0, leakedSandbox.join(', ') || '无')

// ── 4/5. R11：.cmd 纯 ASCII ─────────────────────────────────────────────────

section('4. 残余边界 R11：.cmd 必须纯 ASCII')
check('verify.cmd 纯 ASCII', isPureAscii(plantedVerifyText), PLANT ? '（--plant 未扰动该字节面，见 5）' : `bytes=${Buffer.byteLength(verifyText)}`)
const cmdFiles = listCmdFiles()
const nonAscii = cmdFiles.filter((file) => !isPureAscii(readFileSync(file, 'utf8')))
check(
  `仓库内 ${cmdFiles.length} 个 .cmd 全部纯 ASCII`,
  nonAscii.length === 0,
  (nonAscii.length > 0
    ? nonAscii.map((file) => file.slice(REPO.length + 1)).join(', ')
    : cmdFiles.map((f) => f.slice(REPO.length + 1)).join(' ')) +
    (scanSkipped.length > 0 ? `\n      未枚举（ACL 拒绝，R11 面存在盲区，须人工确认）：${scanSkipped.join(', ')}` : ''),
)

// ── 6/7/8/9. 注册表自洽 ─────────────────────────────────────────────────────

section('5. 注册表自洽（重复 / 命名 / 路径）')
const idCounts = new Map()
for (const suite of registeredEntries) idCounts.set(suite.id, (idCounts.get(suite.id) ?? 0) + 1)
const duplicatedIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`)
check('无重复 id（跨两张表）', duplicatedIds.length === 0, duplicatedIds.join(', ') || `${idCounts.size} 个唯一 id`)

const scriptCounts = new Map()
for (const script of registeredScripts) scriptCounts.set(script, (scriptCounts.get(script) ?? 0) + 1)
const duplicatedScripts = [...scriptCounts.entries()].filter(([, n]) => n > 1).map(([script, n]) => `${script}×${n}`)
check('无重复 script', duplicatedScripts.length === 0, duplicatedScripts.join(', ') || `${scriptCounts.size} 个唯一脚本`)

const idMismatch = registeredEntries
  .filter((suite) => suite.script.startsWith('tests/'))
  .filter((suite) => basename(suite.script, '.mjs') !== suite.id)
  .map((suite) => `${suite.id} != ${basename(suite.script, '.mjs')}`)
check('id == 脚本 basename（白名单按 id 取用，脱钩会跑错文件）', idMismatch.length === 0, idMismatch.join(', ') || '全部一致')

const badPaths = registeredScripts.filter((script) => !script.startsWith('tests/') || !script.endsWith('.mjs') || script.includes('..'))
check('所有 script 都在 tests/ 下且以 .mjs 结尾（防路径逃逸）', badPaths.length === 0, badPaths.join(', ') || `${registeredScripts.length} 项合法`)

// ── 10. 已注册脚本必须在磁盘上 ──────────────────────────────────────────────

section('6. 已注册脚本必须存在于磁盘（没有豁免：注册了却不存在即判红）')
const missing = registeredScripts.filter((script) => !existsSync(join(REPO, script)))
check(
  '没有"注册了但磁盘上不存在"的脚本',
  missing.length === 0,
  missing.join(', ') || `已注册 ${registeredScripts.length} 项`,
)

// ── 11. 未登记文件必须显式列名 ──────────────────────────────────────────────

section('7. tests/*.mjs 必须"已登记"或"显式列名"（辅助文件 `_` 前缀除外）')
const allTestFiles = listTestFiles()
const registeredSet = new Set(registeredScripts)
const unregistered = allTestFiles.filter((file) => !basename(file).startsWith('_') && !registeredSet.has(file))
const unexplained = unregistered.filter((file) => !(file in effectiveKnown))
check(
  `未登记文件全部有显式理由（${unregistered.length} 个未登记）`,
  unexplained.length === 0,
  unexplained.length === 0
    ? unregistered.map((file) => basename(file)).join(', ') || '无'
    : `未解释：${unexplained.map((file) => basename(file)).join(', ')}`,
)
for (const file of unregistered) {
  const reason = effectiveKnown[file]
  check(
    `未登记 ${basename(file)} 已列名`,
    typeof reason === 'string' && reason.trim().length >= 8,
    reason ?? '（无理由：文件在磁盘上但既不在注册表也不在 KNOWN_UNREGISTERED）',
  )
}
check(
  '辅助文件 `_` 前缀不参与登记（如 tests/_planted-failure.mjs）',
  allTestFiles.some((file) => basename(file).startsWith('_')),
  allTestFiles.filter((file) => basename(file).startsWith('_')).join(', ') || '（辅助文件不见了，元测试将无法运行）',
)

// ── 12/13. 僵尸条目与理由质量 ───────────────────────────────────────────────

section('8. KNOWN_UNREGISTERED 不得有僵尸条目，理由必须是一句真话')
const zombie = []
for (const [file, reason] of Object.entries(KNOWN_UNREGISTERED)) {
  if (!existsSync(join(REPO, file))) zombie.push(`${file}（文件已不存在）`)
  else if (registeredSet.has(file)) zombie.push(`${file}（其实已经登记）`)
  if (typeof reason !== 'string' || reason.trim().length < 8) zombie.push(`${file}（理由过短/为空）`)
}
check('KNOWN_UNREGISTERED 每条都指向真实存在的未登记文件且带理由', zombie.length === 0, zombie.join('; ') || `${Object.keys(KNOWN_UNREGISTERED).length} 条全部有效`)

// ── 收尾 ────────────────────────────────────────────────────────────────────

if (PLANT) {
  check('--plant 模式下失败项 ≥3（证明本套件的判定真的能红，而不是恒绿）', failures >= 3, `failures=${failures}`)
}

W('')
W('='.repeat(72))
W(
  PLANT
    ? `套件接线治理（--plant 模式：伪造缺项/重复 id/幽灵脚本，应当失败）：断言 ${assertions} 项，失败 ${failures} 项`
    : `套件接线治理（离线静态检查）：断言 ${assertions} 项，失败 ${failures} 项`,
)
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)

process.exitCode = failures > 0 ? 1 : 0
