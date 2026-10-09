#!/usr/bin/env node
/**
 * baseline-integrity —— **源码封印守门套件**：未跟踪文件的静默漂移必须变红
 * ============================================================================
 * 存在理由（项目的两条"无法证伪的说法"，见 tools/baseline-sha256.mjs 文件头）：
 *   1) `.gitignore` 曾整体忽略 `tests/`、`tools/` 未跟踪、`src/limits.mjs` 等源码从未入版本库
 *      ⇒ "只改了注释、行为一字未动"这句话**没有基线可比**；
 *   2) 未跟踪文件被改动时 `git status` 依旧干净 ⇒ 漂移**看不见**。
 *   整理轮（测试套件入库）已把收录面全部纳入版本库，但封印仍是硬判据：它同时钉住
 *   **内容**（逐条哈希）与**覆盖面**（清单条数 == 磁盘受封印文件数），后者 `git diff` 给不出。
 *   本套件把 `docs/源码基线.sha256` 变成硬判据：受封印文件（`src/*.mjs`、`tests/*.mjs`、
 *   `dsh-plugin/*.mjs`、`tools/*.mjs` 与四个根入口）必须逐条与清单相符；一旦有人改了源码
 *   而没**有意识地**刷新清单，本套件立刻判红，并打印确切的修复指令。
 *
 * 检查项：
 *   1. 收录面自洽（四类目录都有条目、哈希形状合法、路径严格排序、排除面真的被排除）
 *   2. 清单与磁盘逐条一致（内容变化 / 清单缺失 / 已不存在 / 清单格式非法，四类分别点名）
 *   3. 清单**缺失 / 不可读 / 为空 ＝ 未封印 ＝ 失败**（fail-closed，退出码 1，并打印修复指令）。
 *      只有显式逃生口 `WINSTAGE_ALLOW_UNSEALED=1` 或 `--allow-unsealed` 才允许 SKIP
 *      （打印原因、退出码 0）—— 逃生口必须显式写出来，不会被顺手触发。
 *
 * 为什么第 3 条必须 fail-closed（独立复核 §8.7 的高危缺陷）：
 *   本分支之前只有 §1 的 6 条"收录面"断言，它们**根本不碰清单**，在健康仓库里恒绿；
 *   于是旧版"清单缺失 ⇒ SKIP + 退出码 0"意味着**把 `docs\源码基线.sha256` 删掉或移走，
 *   封印就静默失效，而 `verify.cmd` 依旧打印 `RESULT: ALL PASS`**。封印存在的唯一理由是
 *   "清单不见了"必须变响，所以默认必须判红；`tools\baseline-sha256.mjs --check` 本来就是
 *   fail-closed（exit 2），被登记进关口的这个套件必须同样 fail-closed。
 *
 * 用法：
 *   node tests\baseline-integrity.mjs           # 正常，应当全绿，退出码 0
 *   node tests\baseline-integrity.mjs --plant   # 只在内存里伪造四种清单损坏，应当见红，退出码 1
 *   node tests\baseline-integrity.mjs --allow-unsealed   # 逃生口：清单不在时 SKIP（不是 PASS）
 */

import {
  MANIFEST_REL,
  collectEntries,
  diffManifest,
  isExcluded,
  parseManifest,
  readManifestText,
  remediation,
  renderManifest,
} from '../tools/baseline-sha256.mjs'

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

// ── 1. 收录面自洽 ──────────────────────────────────────────────────────────

section('1. 收录面自洽（任务书给定的范围与排除面）')
const entries = collectEntries()
const dirs = new Set(entries.map((entry) => entry.path.split('/')[0]))
check('收录非空，且 src/ tests/ dsh-plugin/ tools/ 四类都有条目', entries.length > 0 && ['src', 'tests', 'dsh-plugin', 'tools'].every((dir) => dirs.has(dir)), `${entries.length} 条；目录=${[...dirs].sort().join(',')}`)
const badHash = entries.filter((entry) => !/^[0-9a-f]{64}$/.test(entry.sha256))
check('每条记录的 sha256 都是 64 位小写十六进制', badHash.length === 0, badHash.map((entry) => entry.path).join(', ') || `${entries.length} 条合法`)

const sortedOk = entries.every((entry, index) => index === 0 || entries[index - 1].path < entry.path)
check('路径严格按字典序排序且无重复', sortedOk, sortedOk ? `${entries[0]?.path} … ${entries[entries.length - 1]?.path}` : '存在乱序或重复')

const excludedLeaks = entries.filter((entry) => isExcluded(entry.path) || entry.path === MANIFEST_REL)
check('清单自身与被排除目录（.t/node_modules/shim/esc/filemod/retest/.dshstage）都不在收录里', excludedLeaks.length === 0, excludedLeaks.map((entry) => entry.path).join(', ') || `排除面生效（收录 ${entries.length} 条）`)

const subDirLeaks = entries.filter((entry) => entry.path.split('/').length > 2)
check('收录面是"深度 1"（tools/lib、tools/toolchain 这类子目录不收；根入口是单段路径）', subDirLeaks.length === 0, subDirLeaks.map((entry) => entry.path).join(', ') || '全部为 <文件> 或 <目录>/<文件> 形状')

const mustSeal = ['src/limits.mjs', 'tests/suite-wiring.mjs', 'tools/baseline-sha256.mjs', 'tools/dsh-patches.mjs', 'verify.cmd']
const sealedPaths = new Set(entries.map((entry) => entry.path))
const missingMust = mustSeal.filter((path) => !sealedPaths.has(path))
check('动机所指的文件确实被封印（src/limits.mjs、tests/*、tools/*、verify.cmd）', missingMust.length === 0, missingMust.join(', ') || mustSeal.join(', '))

// ── 2. 清单校验 ────────────────────────────────────────────────────────────

section(`2. 清单与磁盘逐条一致（${MANIFEST_REL}）`)

/**
 * 显式逃生口：默认 **fail-closed**（清单缺失 / 不可读 / 为空 ⇒ 判红）。
 * 只有显式写出环境变量或 argv 才允许 SKIP —— 故意做成"不会被顺手触发"。
 */
const ALLOW_UNSEALED = process.argv.includes('--allow-unsealed') || process.env.WINSTAGE_ALLOW_UNSEALED === '1'

/**
 * 读清单：把"缺失 / 不可读 / 为空"三种情形都收成一句可读的原因。
 * 三者都不是"通过"：`text` 有值才允许进一致性判定。
 */
const manifestRead = (() => {
  let text
  try {
    text = readManifestText()
  } catch (error) {
    return { text: undefined, unsealed: `${MANIFEST_REL} 存在但读不出来（${error?.code ?? 'UNKNOWN'}: ${error?.message ?? error}）` }
  }
  if (text === undefined) return { text: undefined, unsealed: `找不到 ${MANIFEST_REL}（尚未封印，或被人删除 / 移走）` }
  if (text.trim().length === 0) return { text: undefined, unsealed: `${MANIFEST_REL} 存在但为空（0 字节，或只有空白行）` }
  return { text, unsealed: undefined }
})()

if (manifestRead.unsealed !== undefined) {
  if (ALLOW_UNSEALED) {
    W('')
    W('  ! SKIP（**显式逃生口已开启**：WINSTAGE_ALLOW_UNSEALED=1 / --allow-unsealed）')
    W(`    原因: ${manifestRead.unsealed}`)
    W('    判定: 本套件在此状态下**不给出任何一致性结论**；正常关口绝不会走到这里。')
    W('    修复: node tools\\baseline-sha256.mjs --write，然后复核清单 diff。')
    W('')
    W('='.repeat(72))
    W(`源码基线封印（收录面已查，清单校验 SKIP：显式未封印逃生口）：断言 ${assertions} 项，失败 ${failures} 项`)
    W(`RESULT: SKIP manifest-unsealed-allowed checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)
    process.exitCode = failures > 0 ? 1 : 0
  } else {
    assertions += 1
    failures += 1
    W(`  ✗ 基线清单存在、可读且非空（${MANIFEST_REL}）`)
    W(`      原因: ${manifestRead.unsealed}`)
    W('      判定: 未封印 ≠ 通过 —— 删掉 / 移走清单就能让封印静默失效，正是本套件要防的事。')
    W('      修复: node tools\\baseline-sha256.mjs --write')
    W('            然后复核 docs\\源码基线.sha256 的 diff（每一行变化都应对应一次你确实想做的改动）')
    W('            再跑 node tools\\baseline-sha256.mjs --check 与整仓关口 verify.cmd')
    W('      逃生口（必须显式写出，不会被顺手触发）:')
    W('            set WINSTAGE_ALLOW_UNSEALED=1   （或） node tests\\baseline-integrity.mjs --allow-unsealed')
    W('            只有显式给出逃生口时才 SKIP（打印原因、退出码 0），默认一律判红。')
    W('')
    W('='.repeat(72))
    W(`源码基线封印（fail-closed：清单缺失 / 不可读 / 为空）：断言 ${assertions} 项，失败 ${failures} 项`)
    W(`RESULT: FAIL manifest-unsealed checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)
    process.exitCode = 1
  }
} else {
  const realText = manifestRead.text
  // `--plant`：只伪造**内存里**的清单文本（磁盘清单一字不动）。
  //   构造口径：以真清单的第一行为基准翻一位哈希（a 内容变化），砍掉最后一行（b 清单缺失），
  //   再补一条幽灵路径（c 僵尸行）与一条缺两个空格的非法行（d 格式错误）。
  const plantedText = (() => {
    if (!PLANT) return realText
    const realParsed = parseManifest(realText)
    const firstLinePath = [...realParsed.map.keys()][0]
    const realFirstHash = realParsed.map.get(firstLinePath)
    const flipped = `${realFirstHash.slice(0, 63)}${realFirstHash.endsWith('0') ? '1' : '0'}`
    const body = realText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(0, -1) // (b) 砍掉最后一行
    return [
      ...body.map((line, index) => (index === 0 ? `${flipped}  ${firstLinePath}` : line)), // (a) 翻一位哈希
      `${'b'.repeat(64)}  src/ghost-planted-by-plant-mode.mjs`, // (c) 幽灵条目
      `c${'c'.repeat(63)} src/malformed-planted.mjs`, // (d) 缺少 sha256sum 要求的两个空格
      '',
    ].join('\n')
  })()

  const parsed = parseManifest(plantedText)
  const diff = diffManifest(entries, plantedText)

  check('清单每一行都符合 `<64 位十六进制><两个空格><路径>`', diff.malformed.length === 0, diff.malformed.length === 0 ? `${parsed.map.size} 行全部合法` : `非法行: ${diff.malformed.map((line) => JSON.stringify(line)).join(', ')}`)
  check('清单条数 == 磁盘受封印文件数', parsed.map.size === entries.length, `清单 ${parsed.map.size} / 磁盘 ${entries.length}`)
  check('没有"内容变化"的受封印文件', diff.changed.length === 0, diff.changed.length === 0 ? `${entries.length} 条哈希逐条相符` : diff.changed.join(' | '))
  check('没有"清单缺失"的受封印文件', diff.added.length === 0, diff.added.length === 0 ? '清单覆盖全部受封印文件' : diff.added.join(', '))
  check('没有"已不存在"的清单条目（僵尸行）', diff.removed.length === 0, diff.removed.length === 0 ? '无僵尸行' : diff.removed.join(', '))
  check('每条清单路径都在收录面内（不含排除目录）', [...parsed.map.keys()].every((path) => !isExcluded(path) && path !== MANIFEST_REL), '排除面未被写进清单')
  const regenerated = parseManifest(renderManifest(entries))
  check('renderManifest(磁盘现状) 能被 --check 解析回同一集合（写/读同一格式）', regenerated.malformed.length === 0 && regenerated.map.size === entries.length, `条数=${regenerated.map.size} 非法行=${regenerated.malformed.length}`)
  check('汇总判定 diff.ok', diff.ok, diff.ok ? '四种损坏（变化/缺失/僵尸/非法）全部为零' : `changed=${diff.changed.length} added=${diff.added.length} removed=${diff.removed.length} malformed=${diff.malformed.length}\n      修复:\n${remediation()}`)

  if (PLANT) {
    W('')
    W('=== 3. --plant 反证（四种清单损坏必须各自被抓到） ===')
    check('--plant (a)：翻掉一位哈希 ⇒ 判为内容变化', diff.changed.length >= 1, diff.changed.join(' | ') || '（没抓到 —— 说明哈希比对是空断言）')
    check('--plant (b)：删掉一条记录 ⇒ 判为清单缺失', diff.added.length >= 1, diff.added.join(', ') || '（没抓到 —— 说明"漏收文件"是盲区）')
    check('--plant (c)：多一条幽灵路径 ⇒ 判为僵尸行', diff.removed.length >= 1, diff.removed.join(', ') || '（没抓到 —— 说明"清单里有磁盘没有"是盲区）')
    check('--plant (d)：格式非法行 ⇒ 被判为非法而不是静默忽略', diff.malformed.length >= 1, diff.malformed.map((line) => JSON.stringify(line)).join(', ') || '（没抓到 —— 说明格式错误会被吞掉）')
    check('--plant：失败项 ≥ 3（非空转）', failures >= 3, `failures=${failures}`)
  }

  W('')
  W('='.repeat(72))
  W(
    `源码基线封印（${PLANT ? '--plant 模式：伪造四种清单损坏，应当失败' : '收录面 + 逐条哈希'}）：断言 ${assertions} 项，失败 ${failures} 项`,
  )
  W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)
  process.exitCode = failures > 0 ? 1 : 0
}
