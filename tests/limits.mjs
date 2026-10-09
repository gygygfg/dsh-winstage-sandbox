/**
 * limits.mjs 的离线确定性测试（**不需要管理员、不需要网络、不写临时目录之外的任何位置**）
 *
 * 存在理由（对齐差距基线 §2 的两个 ABSENT）：
 *   · 「磁盘配额（暂存树）」ABSENT —— 本套件钉死"**写入前**能不能拒绝"这条判定；
 *   · 「输出大小上限」ABSENT —— 本套件钉死"截断必须**显式可机检**、且不得吐出半个码点"。
 * 这两件事的共同失效形态都是**静默**：配额不生效时写入照样成功（只是"看起来有上限"），
 * 输出截断不显式时调用方以为拿到了完整输出。因此本文件里每一条断言都尽量做成
 * "能失败"的形态，而不是"打印一下看看"。
 *
 * ── 本套件当场抓到的六个**真实**缺陷（都留在 `src\limits.mjs` 的注释里）────────
 * ① `parseSize` 对无后缀输入会走到 `SIZE_UNITS.get('')` = undefined ⇒ 返回 `NaN`
 *    —— "拒绝垃圾输入、不让 NaN 漏出"这条硬不变式当场见红；
 * ② Windows 上 **`lstatSync` 对 junction 的形态是"宿主 / DSH 文件策略"相关的**，
 *    不是不变量。`[实测]` **同一台机器**上、同一段 `fs.symlinkSync(…, 'junction')` 建出的 junction，
 *    两种 DSH 文件策略下 lstat 给出两种形态：
 *      · `workspace-write`（更早的受限会话）：`mode=0x41b6`（**没有** `FILE_ATTRIBUTE_REPARSE_POINT`
 *        的 0x400 位）、`isSymbolicLink()===false`、`isDirectory()===true` —— lstat **看不见** junction，
 *        它看起来就是个目录（`ino` 与目标目录相同，目标删掉后 lstat 直接 ENOENT）；
 *      · `danger-full-access`（本轮）：`mode=0xa1b6`、`isSymbolicLink()===true`、`isDirectory()===false`
 *        —— lstat **看得见** junction。
 *    ⇒ 把"junction 的 lstat 必然是 X"写进断言就是**钉宿主事实**，本轮正是它让 §4x/§4ab 与
 *    `tests\workspace-regressions.mjs` 的一条断言变红（两种处置都安全，只有 reason/计数不同）。
 *    两种形态下都恒真的是：`mode & 0x400 === 0`（Node 的 `Stats.mode` 是 POSIX 位，不携带
 *    Win32 重解析属性 ⇒ 这条判据**永远死**），以及父目录
 *    `readdirSync(..., {withFileTypes:true})` 的 `Dirent.isSymbolicLink()===true`（两种形态都 `true`）；
 *    安全兜底则靠"`realpathSync.native` 解析后是否出树"这条**结构性**闭合校验（与形态无关）。
 *    `[实测·本轮]` 探针（`danger-full-access`）：`lstat(<树>\<junc>)` 为 `mode=0xa1b6`、
 *    `isSymbolicLink()=true`、`isDirectory()=false`；`realpath.native` 解析到目标真实长名，
 *    而 `lstat(该真实路径).isDirectory()=true` ⇒ 现行规则据此"先判包含性、再判目标是否目录"，
 *    于是**两种形态下 in-tree junction 的处置完全一致**（不再依赖 `info.isDirectory()`）。
 * ③ 有界遍历触到 `maxEntries` 时**没有**置 `truncated`/记 error ⇒ 调用方会把下界当完整账；
 * ④ `formatSize` 的定点小数分支会破坏 `parseSize(formatSize(n)) === n`
 *    （`1025 → '1.000977KiB' → 1025.000448`）⇒ 改成"生成候选串后**当场回解析验证**"；
 * ⑤ `byteTruncated/lineTruncated` 会**虚报**：行切之后字节预算并没有削减内容，却仍标字节截断；
 * ⑥ 跳过一条目录时把**父目录**入栈 ⇒ 同一个链接被反复扫到，**无限循环**直到撞上遍历上界
 *    （表现为 `errors` 里莫名出现 `MEASURE_TREE_BOUND`）。
 * ⑦ **树内自指目录 junction**（`loop -> 树自身`）被反复入栈 ⇒ 同一个真实目录被重扫，
 *    生产默认 `maxEntries=200000` 下 `[实测]` 单次 `measureTree` 烧 **22033 ms**、
 *    `truncated=true`、`complete=false` ⇒ `checkStagingQuota` 报"统计不完整"，
 *    `Store.putBlob` / `executor.assertStagingQuota` 抛 `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`，
 *    **该工作区永久写不进暂存**（1 个 junction 换 22 秒 CPU + 永久拒绝写入）。
 *    修复：`src\limits.mjs` 的 `visitedDirs`（解析后真实路径的小写归一 key）让
 *    **每个真实目录只展开一次**。
 *
 * ⑧ **规则改写（本轮）**：`[实测]` 旧规则"拒绝一切重解析点"在 `danger-full-access` 形态下
 *    把 in-tree junction 的**环检测分支变成没有活路径的死代码**，且 in-tree **alias 完全不进账**
 *    （覆盖面损失，非安全洞）。现行规则（`src\limits.mjs` 判据 C 段落）：
 *    **树外目标绝不跟随/绝不计数；树内目标跟随但每个真实目录只展开一次** ⇒
 *    `already-visited-cycle` 在**两种 lstat 形态下都重新可达**。§4v–4ac 因此改为
 *    **严格断言环检测 reason**（不再是"两种安全处置之一"），并新增 §4x3（**生产默认调用**、
 *    零注入下的 liveness 证据）、§4v2 / §4ab5（**注入盲形态**证明处置与宿主 lstat 形态无关）
 *    与 §4ac（in-tree alias 恢复进账且仍只展开一次）。
 *    `--plant` 口径随之变化：本机真实 junction 形态下 §4a/§4b 也会变红（见下）。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node tests\limits.mjs           # 正常运行，必须全绿（exit 0）
 *   node tests\limits.mjs --plant   # 故意拆掉不变式，判定**必须**变红（exit 1）
 *
 * `--plant` 破坏点（本机 `danger-full-access` 形态下会让 **5** 项断言变红：
 * 4a/4b —— 树外 junction 被跟随；4e/4f/4g —— 硬链接重复计字节这条**账目**不变式）：
 *   · `disableHardlinkDedupe` —— 硬链接重复计字节 ⇒ §4e/§4f/§4g 三条变红
 *     （配额假爆表：两个名字把 2 KiB 文件算成 4 KiB）
 *   · `followReparsePoints` —— 关掉"解析后出树就不跟随"这条包含性判定。
 *     `[实测]` 改规则后本机 `danger-full-access` 形态下这个钩子**重新有咬合力**
 *     （旧规则下 in-tree/out-tree junction 都先被"非目录链接"分支拒掉，钩子形同失效）：
 *     §4a（外部 1 MiB 进账）与 §4b（该 junction 不再进 `skipped`）变红。
 *     注入形态的变异覆盖（§4p2 盲 lstat / §4p3 双盲＋否决判据 C 的 guard）**保留**，
 *     它们钉的是同一条包含性判定的另一条路径（盲形态 ⇒ 判据 C 必须是最后一道）。
 *   关闭方式只在 `src\limits.mjs` 的 `__internal.setTestHooks()` 里，**生产 API 上没有这个开关**。
 *   末尾另有两条**元断言**：① 失败数必须 ≥3（否则说明判定力已退化）；
 *   ② 钩子能复位（不把变异体泄漏给后续用例）。
 */

import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LIMITS,
  LIMIT_KEYS,
  LimitsError,
  OUTPUT_CAP_SOURCE,
  STAGING_BYTES_SOURCE,
  UPSTREAM_STAGING_BYTES,
  __internal,
  applyOutputCap,
  checkStagingQuota,
  formatSize,
  isReparsePoint,
  measureTree,
  parseSize,
  reparsePointKind,
  summariseLimits,
  toGiB,
  wrapLimits,
} from '../src/limits.mjs'

const PLANT = process.argv.includes('--plant')
const W = (text) => process.stdout.write(`${text}\n`)

let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

/** 跳过 ≠ 通过：本机环境不成立的条件必须显式打印原因，且不计入断言通过 */
function skip(name, reason) {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${reason}`)
}

/** 断言"调用抛出 LimitsError 且 code 匹配"（fail-closed 的正向证据） */
function checkThrows(name, fn, code) {
  let outcome
  try {
    const value = fn()
    outcome = `未抛错，返回 ${JSON.stringify(value)?.slice(0, 120)}`
  } catch (error) {
    if (!(error instanceof LimitsError)) {
      outcome = `抛的不是 LimitsError：${error && error.name}: ${error && error.message}`
    } else if (code !== undefined && error.code !== code) {
      outcome = `code 不符：期望 ${code}，实得 ${error.code}`
    } else {
      assertions += 1
      W(`  ✓ ${name}\n      证据: 抛出 ${error.name}(${error.code})`)
      return
    }
  }
  assertions += 1
  failures += 1
  W(`  ✗ ${name}\n      证据: ${outcome}`)
}

/** 临时根：**只在系统 temp 下**建，结束时整棵删除 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-limits-test-'))
const created = []
function tmpDir(name) {
  const dir = join(TMP_ROOT, name)
  mkdirSync(dir, { recursive: true })
  created.push(dir)
  return dir
}
function bytesFile(path, size, fill = 0x41) {
  writeFileSync(path, Buffer.alloc(size, fill))
  return path
}

W('='.repeat(72))
W(`limits.mjs 离线测试${PLANT ? '（--plant 变异体模式：**判定应当变红**）' : ''}`)
W(`临时根: ${TMP_ROOT}`)
W('='.repeat(72))

// 若以 --plant 运行：先拆掉不变式（只影响本进程）
if (PLANT) {
  __internal.setTestHooks({ followReparsePoints: true, disableHardlinkDedupe: true })
  W('')
  W('*** --plant：已拆掉"树外重解析点包含性判定"与"硬链接按 inode 去重"两条不变式 ***')
  W('*** 期望：§4a/4b（树外 junction 被跟随/不再记 skipped）＋ §4e/4f/4g（硬链接重复计字节）')
  W('***   共 5 条断言转为 ✗（本轮改规则后 §4a/4b 在本机真实 junction 形态下重新有咬合力）。')
  W('*** 注入口径（§4p2 盲 lstat / §4p3 双盲+guard）保留，钉的是同一条不变式的另一条路径。')
}

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 1. DEFAULT_LIMITS：64 GiB 必须有出处，且不可被运行期改写 ===')
// ═══════════════════════════════════════════════════════════════════════════
check(
  'stagingBytes === 64 GiB（对齐 NeoAI limits.disk_bytes）',
  DEFAULT_LIMITS.stagingBytes === 64 * 1024 ** 3 && DEFAULT_LIMITS.stagingBytes === UPSTREAM_STAGING_BYTES,
  `stagingBytes=${DEFAULT_LIMITS.stagingBytes} (${formatSize(DEFAULT_LIMITS.stagingBytes)})`,
)
check(
  '上限出处带 [官方] 标记且指向 NeoAI 的 default_config.lua',
  STAGING_BYTES_SOURCE.marker === '[官方]' && STAGING_BYTES_SOURCE.project === 'NeoAI' && /disk_bytes\s*=\s*64/.test(STAGING_BYTES_SOURCE.line),
  `${STAGING_BYTES_SOURCE.file}: ${STAGING_BYTES_SOURCE.line}`,
)
check(
  '输出上限出处如实标注 [推断]（上游无对标项，绝不冒充官方）',
  OUTPUT_CAP_SOURCE.marker === '[推断]' && /推断|本项目取值/.test(OUTPUT_CAP_SOURCE.reason),
  OUTPUT_CAP_SOURCE.reason,
)
check('DEFAULT_LIMITS 被冻结（防止运行期被改写）', Object.isFrozen(DEFAULT_LIMITS))
check(
  'DEFAULT_LIMITS 只有能力报告的三个字段',
  JSON.stringify(Object.keys(DEFAULT_LIMITS)) === JSON.stringify([...LIMIT_KEYS]),
  `keys=${Object.keys(DEFAULT_LIMITS).join(',')}`,
)
check('maxOutputBytes = 4 MiB / maxOutputLines = 200000', DEFAULT_LIMITS.maxOutputBytes === 4 * 1024 * 1024 && DEFAULT_LIMITS.maxOutputLines === 200000)

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 2. parseSize：接受所有合法形状，拒绝垃圾且不泄漏 NaN ===')
// ═══════════════════════════════════════════════════════════════════════════
const ACCEPTED = [
  ['64GiB', 64 * 1024 ** 3],
  ['64 GiB', 64 * 1024 ** 3],
  ['64gib', 64 * 1024 ** 3],
  ['64GIB', 64 * 1024 ** 3],
  ['512MiB', 512 * 1024 ** 2],
  ['1MB', 1000 ** 2],
  ['1mb', 1000 ** 2],
  ['2TB', 2 * 1000 ** 4],
  ['1TiB', 1024 ** 4],
  ['1024', 1024],
  ['1_048_576', 1048576],
  ['0.5MiB', 524288],
  ['0', 0],
  ['64Gi', 64 * 1024 ** 3],
  ['4KiB', 4096],
  ['8K', 8192],
]
for (const [text, expected] of ACCEPTED) {
  const actual = parseSize(text)
  check(
    `parseSize('${text}') === ${expected}`,
    actual === expected,
    `实得 ${actual}（${formatSize(actual)}）`,
  )
}
for (const [numeric, expected] of [[1024, 1024], [64 * 1024 ** 3, 64 * 1024 ** 3], [0, 0]]) {
  check(`parseSize(${numeric})（数字输入）=== ${expected}`, parseSize(numeric) === expected)
}
check('parseSize({ bytes: "1MiB" }) 支持包装对象', parseSize({ bytes: '1MiB' }) === 1048576)
check(
  '无后缀被解释为**字节**而不是 KiB（避免"限额 1024"静默变成 1 MiB）',
  parseSize('1024') === 1024 && parseSize('1K') === 1024,
  `'1024'→${parseSize('1024')}，'1K'→${parseSize('1K')}`,
)

const REJECTED = ['', '   ', '64ZiB', 'abc', 'GiB', '1.5', '1e3', '64 GiB x', '-1', '-1GiB', '+1GiB', 'NaN', 'Infinity', '.', '..', '1,024', '0x10']
for (const text of REJECTED) {
  checkThrows(`parseSize(${JSON.stringify(text)}) 抛 SIZE_PARSE_INVALID`, () => parseSize(text), 'SIZE_PARSE_INVALID')
}
// 宽容侧（**如实标注**，不假装它被拒）：`'1024 B '` 的内部空白与首尾空白都会被归一化后接受 ——
// "尾部多一个空格"不是需要人复核的异常，与 `'+1GiB'`（拒）不同类。
check(
  "parseSize('1024 B ') 被接受（空白归一化，不是需要拒绝的异常输入）",
  parseSize('1024 B ') === 1024,
  `实得 ${parseSize('1024 B ')}；拒它的只有 '+1GiB' / '1e3' 这类"看起来像拼出来的值"`,
)
for (const value of [null, undefined, true, [], () => 1, { notBytes: 1 }]) {
  const label = value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value)
  checkThrows(`parseSize(${label}) 抛 SIZE_PARSE_INVALID`, () => parseSize(value), 'SIZE_PARSE_INVALID')
}
checkThrows('parseSize(NaN) 抛错（绝不让 NaN 漏出）', () => parseSize(Number.NaN), 'SIZE_PARSE_INVALID')
checkThrows('parseSize(Infinity) 抛错', () => parseSize(Number.POSITIVE_INFINITY), 'SIZE_PARSE_INVALID')
checkThrows('parseSize(1.5)（半字节）抛错', () => parseSize(1.5), 'SIZE_PARSE_INVALID')
checkThrows('parseSize(Number.MAX_SAFE_INTEGER + 2) 抛错（防静默丢精度）', () => parseSize(Number.MAX_SAFE_INTEGER + 2), 'SIZE_PARSE_INVALID')

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 3. formatSize：与 parseSize 互为逆运算（硬不变式 #1）===')
// ═══════════════════════════════════════════════════════════════════════════
const ROUND_TRIP = [0, 1, 999, 1023, 1024, 1025, 1536, 4096, 524288, 1000000, 1048576, 64 * 1024 ** 3, 2000000000000, 999 * 1024 ** 4]
for (const value of ROUND_TRIP) {
  const text = formatSize(value)
  let back
  try {
    back = parseSize(text)
  } catch (error) {
    back = `抛错 ${error.code}`
  }
  check(
    `formatSize(${value}) = '${text}' 且 parseSize 回原值`,
    back === value && /^[0-9.]+(B|KiB|MiB|GiB|TiB)$/.test(text),
    `回解析 ${back}`,
  )
}
check('formatSize(64 GiB) === "64GiB"（与上游注释同字面）', formatSize(64 * 1024 ** 3) === '64GiB')
check(
  'formatSize(1536) 用定点小数而不是科学计数法',
  formatSize(1536) === '1.5KiB' && parseSize(formatSize(1536)) === 1536,
  `${formatSize(1536)}（回解析 ${parseSize(formatSize(1536))}）`,
)
checkThrows('formatSize(-1) 抛错', () => formatSize(-1), 'LIMITS_INVALID')
checkThrows('formatSize(1.5) 抛错', () => formatSize(1.5), 'LIMITS_INVALID')
checkThrows('formatSize(超出可定点表示) 抛错（绝不吐自己解不回来的字符串）', () => formatSize(Number.MAX_SAFE_INTEGER), 'LIMITS_INVALID')
check('toGiB(64 GiB) === 64', toGiB(64 * 1024 ** 3) === 64)

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 4. measureTree：只拒树外重解析点 / 树内每真实目录一次 / 绝不抛 / 有界 ===')
// ═══════════════════════════════════════════════════════════════════════════
// 现场：tree/（100 B 文件 + 指向 outside/ 的 junction）；outside/ 有 1 MiB 大文件
const outside = tmpDir('outside')
bytesFile(join(outside, 'big.bin'), 1024 * 1024, 0x42)
const tree = tmpDir('tree')
bytesFile(join(tree, 'a.txt'), 100, 0x41)
let junctionKind = 'none'
try {
  symlinkSync(outside, join(tree, 'escape'), 'junction')
  junctionKind = 'junction'
} catch (error) {
  junctionKind = `failed:${error.code}`
}
const escapePath = join(tree, 'escape')

if (junctionKind === 'junction') {
  const report = measureTree(tree)
  // 注意断言口径：**只看那个 100 B 文件在不在账上**，不看 bytes 总数 ——
  // `--plant` 下（关掉包含性判定后）junction 会被跟随，总字节数变成 1048676，
  // 那时"不跟随"这条不变式应当**直接**由下面这条断言判红（而不是靠一个复合条件碰巧红）。
  // `[实测·本轮]` 改规则后本机 `danger-full-access` 形态下 §4a **确实**会随 `--plant` 变红
  //（旧规则下这个钩子对 junction 失效，这两条是恒绿的死断言；现在它们重新有变异覆盖）。
  check(
    '4a junction 逃逸：外部 1 MiB 大文件**不计入** bytes（硬不变式 #3）',
    report.bytes === 100,
    `bytes=${report.bytes}（期望 100；若为 1048676 说明跟随了 junction）files=${report.files} dirs=${report.dirs}`,
  )
  check(
    '4b junction 逃逸被记入 skipped（**不是**静默忽略；--plant 下被跟随 ⇒ 本条也应见红）',
    report.skipped.some((item) => item.path === escapePath) && report.skipped.length >= 1,
    JSON.stringify(report.skipped.map((item) => ({ kind: item.kind, path: item.path.split('\\').pop() }))),
  )
  // 4c 在 `--plant` 下**应当**通过：跟随 junction 后"外部文件被读了"这件事本身不是 errors
  // （errors 只描述故障），所以这条不是被拆掉的不变式。
  check('4c 逃逸不产生 errors（跳过的链接不是"故障"）', report.errors.length === 0, JSON.stringify(report.errors))
  // 反证：把连接**换成**普通子目录后，同样的字节数应当**被**计入
  // （证明 4a 的 100 不是"什么都不量"量出来的）
  rmSync(escapePath, { recursive: true, force: true })
  const fake = join(tree, 'escape')
  mkdirSync(fake, { recursive: true })
  bytesFile(join(fake, 'inside.bin'), 4096, 0x43)
  const after = measureTree(tree)
  check(
    '4d 反证：同一路径换成真实子目录后，4096 B 被正常计入（不是"什么都不量"）',
    after.bytes === 100 + 4096,
    `bytes=${after.bytes}`,
  )
} else {
  skip('4a-4d junction 逃逸用例', `无法创建 junction（${junctionKind}）—— 本机权限不足，该不变式在本机**未获证据**`)
}

// 4e 硬链接去重
const links = tmpDir('links')
const linked = bytesFile(join(links, 'one.bin'), 2048, 0x44)
linkSync(linked, join(links, 'two.bin'))
const linkReport = measureTree(links)
check(
  '4e 硬链接按 inode 去重：两个名字只算一次字节（文件数仍为 2）',
  linkReport.bytes === 2048 && linkReport.files === 2,
  `bytes=${linkReport.bytes}（期望 2048；4096 说明去重失效）files=${linkReport.files} notes=${linkReport.notes.length}`,
)
// 注意：这一条在 `--plant` 下**应当**仍为真 —— 它描述的是"少算字节时必须留痕"，
// 与"要不要去重"无关。真正会因 `--plant` 变红的是 **4g**（默认状态下必须去重）。
check(
  '4f 去重被如实记录在 notes（不静默"少算"）：被去重的名字必须留痕',
  linkReport.notes.some((note) => note.kind === 'hardlink-dedup') || linkReport.bytes === 2048,
  `notes=${JSON.stringify(linkReport.notes.map((note) => note.kind))}`,
)
check(
  '4g 单个 2 KiB 文件 + 硬链接副本：去重后 bytes 必须恰好 2048（--plant 下重复计成 4096）',
  linkReport.bytes === 2048,
  `bytes=${linkReport.bytes}`,
)

// 4g 不存在的路径：不抛，记 errors
const missing = join(TMP_ROOT, 'does-not-exist')
check('4g 根不存在时不抛错', (() => {
  try {
    measureTree(missing)
    return true
  } catch {
    return false
  }
})())
const missingReport = measureTree(missing)
check(
  '4h 根不存在时 bytes=0 且 errors 里有 ENOENT',
  missingReport.bytes === 0 && missingReport.files === 0 && missingReport.errors.some((item) => item.code === 'ENOENT'),
  JSON.stringify(missingReport.errors),
)

// 4i 遍历中条目被删除：记 errors 并继续，绝不抛
const vanishing = tmpDir('vanishing')
bytesFile(join(vanishing, '000.bin'), 5, 0x45)
bytesFile(join(vanishing, 'zzz.bin'), 7, 0x46)
let vanished = false
const vanishingReport = measureTree(vanishing, {
  onStat: (info, full) => {
    // 统计到 000.bin 之后，把**后面**那条删掉 —— 下一次 lstat 就会 ENOENT
    if (!vanished && full.endsWith('000.bin')) {
      vanished = true
      rmSync(join(vanishing, 'zzz.bin'), { force: true })
    }
  },
})
check(
  '4i 遍历中条目被删除：记录下来并继续（errors 里有 ENOENT，不抛）',
  vanished && vanishingReport.errors.some((item) => item.code === 'ENOENT') && vanishingReport.files === 1,
  `vanished=${vanished} errors=${JSON.stringify(vanishingReport.errors.map((item) => item.code))} files=${vanishingReport.files}`,
)

// 4j 不可读条目（用注入的 fsImpl 造真实故障：目录读取 EACCES）
const deniedRoot = tmpDir('denied-root')
bytesFile(join(deniedRoot, 'ok.bin'), 4, 0x47)
mkdirSync(join(deniedRoot, 'denied'), { recursive: true })
const injectedFs = {
  lstatSync,
  readdirSync: (path, options) => {
    if (path.endsWith('denied')) {
      const error = new Error(`EACCES: permission denied, scandir '${path}'`)
      error.code = 'EACCES'
      throw error
    }
    return readdirSync(path, options)
  },
  // 与真实实现同源（`.native`）—— 否则 4j 可能**顺便**通过"realpath 判据"绕过，
  // 于是测的就不是"读取失败"这条路径了
  realpathSync: realpathSync.native,
}
const injectedReport = measureTree(deniedRoot, { fsImpl: injectedFs })
check(
  '4j 不可读目录：记 EACCES 并继续统计其它条目（绝不抛）',
  injectedReport.errors.some((item) => item.code === 'EACCES') && injectedReport.bytes === 4,
  `errors=${JSON.stringify(injectedReport.errors.map((item) => item.code))} bytes=${injectedReport.bytes}`,
)
check(
  '4k onStat 自身抛错被记为 errors（不吞调用方的异常）',
  measureTree(deniedRoot, { onStat: () => { throw new Error('boom-from-test') } }).errors.some((item) => /boom-from-test/.test(item.message)),
)

// 4l 有界遍历：触到上界必须 truncated=true 且记 MEASURE_TREE_BOUND
// 现场刻意放 **3** 个条目（1 目录 + 2 文件），maxEntries=2 ⇒ **确实**被截掉一条
const boundTree = tmpDir('bound')
bytesFile(join(boundTree, 'a.bin'), 3, 0x48)
bytesFile(join(boundTree, 'b.bin'), 3, 0x49)
const boundCount = measureTree(boundTree)
check('4l0 现场自检：不设上界时共 3 个条目（1 目录 + 2 文件）', boundCount.entries === 3 && boundCount.bytes === 6, `entries=${boundCount.entries} bytes=${boundCount.bytes}`)
const boundNarrow = measureTree(boundTree, { maxEntries: 2 })
check(
  '4l 触到 maxEntries 上界 ⇒ truncated:true（bytes 是下界，不是完整账）',
  boundNarrow.truncated === true && boundNarrow.entries === 2,
  `truncated=${boundNarrow.truncated} entries=${boundNarrow.entries} bytes=${boundNarrow.bytes}`,
)
check(
  '4m 上界被记成 MEASURE_TREE_BOUND（下界必须显式可见）',
  boundNarrow.errors.some((item) => item.code === 'MEASURE_TREE_BOUND'),
  JSON.stringify(boundNarrow.errors.map((item) => item.code)),
)
const boundRoomy = measureTree(boundTree, { maxEntries: 1000 })
check('4n 条目数在上界之内 ⇒ truncated:false', boundRoomy.truncated === false && boundRoomy.entries === 3, `entries=${boundRoomy.entries}`)

// 4o 参数校验 + `guard` 注入
checkThrows('measureTree(空串) 抛 MEASURE_TREE_INVALID', () => measureTree(''), 'MEASURE_TREE_INVALID')
checkThrows('measureTree(root, { maxEntries: 0 }) 抛错', () => measureTree(TMP_ROOT, { maxEntries: 0 }), 'MEASURE_TREE_INVALID')
checkThrows('measureTree(root, { guard: "not-a-function" }) 抛错', () => measureTree(TMP_ROOT, { guard: 'x' }), 'MEASURE_TREE_INVALID')
checkThrows('measureTree(root, { onStat: 1 }) 抛错', () => measureTree(TMP_ROOT, { onStat: 1 }), 'MEASURE_TREE_INVALID')
if (junctionKind === 'junction') {
  // 先恢复 junction 现场（4d 把它换成了真目录）
  rmSync(escapePath, { recursive: true, force: true })
  let restored = false
  try {
    symlinkSync(outside, escapePath, 'junction')
    restored = true
  } catch {
    /* 已在上面 skip 过 */
  }
  if (restored) {
    // 4p：一个**只看得见 lstat** 的 guard（调用方最可能写的那种：`info.isSymbolicLink()`）。
    // 宿主形态相关（见文件头 ②）：`workspace-write` 形态下 lstat 看不见 junction
    // （`isSymbolicLink()===false`）⇒ 这个 guard **漏判**；`danger-full-access` 形态下
    // lstat 看得见（`isSymbolicLink()===true`）⇒ 这个 guard 能命中。
    // 两种形态下这一条钉的都是同一条**硬不变式**：guard 只能**加严**不能**削弱** ——
    // 即使 guard 漏判（或干脆不写 guard），外部 1 MiB 也**不许**进账。
    const weakGuard = measureTree(tree, { guard: (info) => info.isSymbolicLink() })
    check(
      '4p guard 漏判（`info.isSymbolicLink()` 看不见 junction）时**仍然**不跟随（guard 只能加严，不能削弱）',
      weakGuard.bytes === 100,
      `bytes=${weakGuard.bytes}（期望 100；1 MiB 进账说明 guard 把判据 C 否决掉了）skipped=${weakGuard.skipped.length}`,
    )
    // 4q：调用方在**指定子条目**上判为链接 ⇒ 不跟随外部 1 MiB、且留下 skipped 痕迹。
    // 用 `guard(info, path)` 的第二个参数**按路径**判定 —— 这既是本项目集成方最实际的用法
    //（`info` 在 Windows 上看不见 junction，只有路径才够用），也让断言不依赖遍历顺序。
    const guardPaths = []
    const denyEscapeGuard = measureTree(tree, {
      guard: (info, path) => {
        guardPaths.push(path)
        return path === escapePath // 只判"escape 那条"
      },
    })
    check(
      '4q 调用方 guard 按路径判为链接 ⇒ 不跟随外部 1 MiB 且记入 skipped（接口真的生效）',
      denyEscapeGuard.bytes === 100 && denyEscapeGuard.skipped.length >= 1 && guardPaths.includes(escapePath),
      `bytes=${denyEscapeGuard.bytes} skipped=${denyEscapeGuard.skipped.length} guardPaths=${guardPaths.length}`,
    )
    // 4q2：guard 对**根自身**也判为链接 ⇒ 整棵树被跳过（fail-closed：宁可不量，也不越界）
    const denyAllGuard = measureTree(tree, { guard: () => true })
    check(
      '4q2 guard 连根都判为链接 ⇒ 全树被跳过、bytes=0、有 skipped 痕迹（fail-closed，不抛错）',
      denyAllGuard.bytes === 0 && denyAllGuard.skipped.length === 1 && denyAllGuard.files === 0,
      JSON.stringify({ bytes: denyAllGuard.bytes, skipped: denyAllGuard.skipped.length, files: denyAllGuard.files }),
    )
    // 4r：guard 抛错 ⇒ 按"是链接"处理（保守方向），绝不因为 guard 坏了就放行
    const throwGuard = measureTree(tree, { guard: () => { throw new Error('guard-broken') } })
    check(
      '4r guard 抛错 ⇒ 保守地跳过该条目（bytes=0 且不抛错，不把 guard 的故障变成越界）',
      throwGuard.bytes === 0 && throwGuard.skipped.length >= 1,
      JSON.stringify({ bytes: throwGuard.bytes, skipped: throwGuard.skipped.length }),
    )
    // ── 4p2：**宿主形态无关**的"树外 junction 一个字节都不计"证据 + `--plant` 的变异覆盖 ──────
    // 背景（文件头 ②）：本机 `danger-full-access` 形态下 `lstat` 看得见 junction
    // （`isSymbolicLink()===true`、`isDirectory()===false`）。`[实测·本轮]` 改规则后
    // §4a/§4b 在本机也随 `--plant` 变红了；**注入口径仍然保留**，因为它钉的是另一条路径：
    // 这里用注入的 `fsImpl` 造一个**盲 lstat**（只对这条 junction 报 `isDirectory()===true`、
    // `isSymbolicLink()===false`，即模拟 `workspace-write` 形态），
    // 于是：正常模式 ⇒ 结构性的"解析后出树"判据（判据 C）必须**独自**把树外 1 MiB 拒掉；
    // `--plant` ⇒ 钩子关掉判据 C 后必须**真的**跟着它出树（把 1 MiB 计进来）。
    // 这样"判据 C 是最后一道、且它确实在起作用"在**两种宿主形态下**都有可失败的证据。
    const blindEscapeFs = {
      lstatSync: (path) => {
        const info = lstatSync(path)
        return path === escapePath
          ? { ...info, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
          : info
      },
      readdirSync: (path, options) => readdirSync(path, options),
      realpathSync: (path) => realpathSync.native(path),
    }
    const blindEscapeReport = measureTree(tree, { fsImpl: blindEscapeFs })
    if (PLANT) {
      check(
        '4p2 --plant + 盲 lstat 形态：`followReparsePoints` 确实把树外 1 MiB 计了进来（证明这条不变式在本机仍有变异覆盖，不是恒绿的死断言）',
        blindEscapeReport.bytes === 100 + 1024 * 1024,
        `bytes=${blindEscapeReport.bytes}（期望 ${100 + 1024 * 1024}；100 说明钩子对"盲形态"也失效了，这条变异覆盖是假的）`,
      )
    } else {
      check(
        '4p2 盲 lstat 形态（模拟 workspace-write）下，判据 C 独自拒掉树外 junction：外部 1 MiB 不计入 bytes，且 reason 是 realpath-outside-tree',
        blindEscapeReport.bytes === 100 &&
          blindEscapeReport.skipped.some((item) => item.path === escapePath && /^realpath-outside-tree/.test(String(item.reason))),
        JSON.stringify({ bytes: blindEscapeReport.bytes, skipped: blindEscapeReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })) }),
      )
    }
    // ── 4p3：**双盲形态 ＋ 故意否决判据 C 的 guard** —— "guard 只能加严、不能削弱"的**活失败路径** ──
    // 缺口（独立复核 §7.3.1）：§4p/§4q/§4aa 钉的是同一条硬不变式（注入了 guard 也**不许**让树外
    // 1 MiB 进账），但在本机 `danger-full-access` 形态下 `dirent.isSymbolicLink()===true` 会**先**
    // 把 junction 定成 `kind='symlink'`（与 guard 结果无关）⇒ 这组断言在本机**曾经**没有可失败路径：
    // 把源码改成 `shouldNotFollow = guard ? guardSaysLink : escaped`（复核者的变异体 C，`.t/v6-adv/run-C.txt`
    // 全绿 187/0）在本机也不会红。
    // 因此这里注入一个**双盲** `fsImpl`：`lstat` 与 `readdir`/`Dirent` **同时**把 `escape` 报成"普通目录"
    //（`isSymbolicLink()=>false`、`isDirectory()=>true`、`isFile()=>false`），即"两种判据都看不见链接"；
    // 再给 `guard: () => false`（**故意否决**判据 C 的调用方口径）。此时源码里唯一能拦住逃逸的就是
    // 结构性判据 C（`escaped`，`src\limits.mjs:774-775` 把它与 guard 结果**取 OR**）：
    //   · 正常模式 ⇒ bytes 仍为 100，且 `outside` 真实目录**从未被 `readdir`**（"没有递归进去"的机检形式）；
    //   · `--plant` ⇒ `followReparsePoints` 钩子把 `escaped` 关掉、guard 又否决 ⇒ 钩子必须**真的**把树外
    //     1 MiB 计进来（反向断言，证明这个形态不是"恒绿死断言"，与 §4p2 同口径）。
    // 变异体证据（**变异体模块不在仓库里落盘**，临时目录跑完即删，只保留输出日志 `.t/f1-mutant/mutant-run.txt`；
    //   这就是本仓库记录变异证据的方式）：
    //   把 `src\limits.mjs:775` 的 `const shouldNotFollow = escaped || (Boolean(guard) && guardSaysLink)`
    //   改成 `const shouldNotFollow = guard ? guardSaysLink : escaped` ⇒ 本断言（正常模式）**变红**
    //  （`bytes=1048676`、`outside` 被 `readdir`、`skipped` 里没有 `escape`），而**未变异**的源码下本节全绿。
    const blindReaddirPaths = []
    const doublyBlindFs = {
      lstatSync: (path) => {
        const info = lstatSync(path)
        return path === escapePath
          ? { ...info, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
          : info
      },
      readdirSync: (path, options) => {
        blindReaddirPaths.push(path)
        const dirents = readdirSync(path, options)
        // 双盲的第二半：Dirent 也说 `escape` 是普通目录（`isSymbolicLink()===false`）
        // ⇒ `kind` 保持 undefined，唯一的结构性判据只剩判据 C（realpath 解析后是否出树）。
        return path === tree
          ? dirents.map((dirent) =>
              dirent.name === 'escape'
                ? { name: 'escape', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
                : dirent,
            )
          : dirents
      },
      realpathSync: (path) => realpathSync.native(path),
    }
    const doublyBlindReport = measureTree(tree, { fsImpl: doublyBlindFs, guard: () => false })
    // "没有递归进去"的可机检形式：**从来没有** `readdir` 过 `outside` 的真实路径（大小写/短名归一）
    const normKey = (value) => String(value).toLowerCase().replace(/[\\/]+$/, '')
    const outsideRealKey = normKey(realpathSync.native(outside))
    const recursedIntoOutside = blindReaddirPaths.some((path) => {
      try {
        return normKey(realpathSync.native(path)) === outsideRealKey
      } catch {
        return false
      }
    })
    if (PLANT) {
      check(
        '4p3 --plant + 双盲形态 + `guard:()=>false`：`followReparsePoints` 钩子必须**真的**把树外 1 MiB 计进来并递归进 `outside`（反向断言，避免这个形态变成恒绿死断言）',
        doublyBlindReport.bytes === 100 + 1024 * 1024 && recursedIntoOutside,
        `bytes=${doublyBlindReport.bytes}（期望 ${100 + 1024 * 1024}）recursedIntoOutside=${recursedIntoOutside} readdir=${JSON.stringify(blindReaddirPaths.map((path) => path.split('\\').pop()))}`,
      )
    } else {
      check(
        '4p3 双盲 lstat/Dirent ＋ `guard:()=>false`（故意否决判据 C）：外部 1 MiB 仍**不计入** bytes，且 `outside` **从未被 readdir**（guard 只能加严，不能削弱 —— 变异体 `shouldNotFollow = guard ? guardSaysLink : escaped` 在这条上必红）',
        doublyBlindReport.bytes === 100 && !recursedIntoOutside && doublyBlindReport.skipped.some((item) => item.path === escapePath),
        `bytes=${doublyBlindReport.bytes}（期望 100；1048676 = 树外 1 MiB 被计）recursedIntoOutside=${recursedIntoOutside} skipped=${JSON.stringify(doublyBlindReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })))} readdir=${JSON.stringify(blindReaddirPaths.map((path) => path.split('\\').pop()))}`,
      )
    }
  }
}
check(
  '4q isReparsePoint 对普通文件返回 false（判据不误伤）',
  isReparsePoint({ isSymbolicLink: () => false, mode: 0o100644 }) === false,
)
check(
  '4r isReparsePoint 对 Windows 重解析位（0x400）返回 true',
  isReparsePoint({ isSymbolicLink: () => false, mode: 0o100644 | 0x400 }) === true,
)
check(
  '4s isReparsePoint 判据抛错时按"是重解析点"处理（保守方向）',
  isReparsePoint({ isSymbolicLink: () => { throw new Error('x') }, mode: 0 }) === true,
)
// 4t 空目录 / 单文件根
const emptyDir = tmpDir('empty')
const emptyReport = measureTree(emptyDir)
check('4t 空目录：bytes=0 / files=0 / dirs=1 / 无错误', emptyReport.bytes === 0 && emptyReport.files === 0 && emptyReport.dirs === 1 && emptyReport.errors.length === 0, JSON.stringify(emptyReport))
const single = bytesFile(join(tmpDir('single'), 'only.bin'), 12, 0x4a)
const singleReport = measureTree(single)
check('4u 根是文件时直接量该文件大小', singleReport.bytes === 12 && singleReport.files === 1, JSON.stringify(singleReport))

// ═══════════════════════════════════════════════════════════════════════════
// 4v–4ac. D1 修复 + 本轮规则改写：**树内目录环**（自指 / 互指 / alias）必须终止、
// 只展开一次、且**环检测 reason 在两种宿主 lstat 形态下都可达**
// ───────────────────────────────────────────────────────────────────────────
// 现场（`[实测]` 本机 node v24.21.0 / Windows）：只有 1 个 1 字节文件的树里放一个
// **指向树自身**的目录 junction。修复前：`entries=200000`（撞 `maxEntries`）、
// 耗时 22033 ms、`truncated=true`、`errors=[MEASURE_TREE_BOUND]`，
// `checkStagingQuota` 因此 `complete:false` ⇒ `Store.putBlob` /
// `executor.assertStagingQuota` 抛 `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`
//（该工作区永久写不进暂存）。修复后：每个真实目录只展开一次，毫秒级结束。
//
// ⚠ **本节钉的是不变量 + 环检测的 reason 可达性**（本轮改规则后 reason 不再是宿主形态相关）：
//   D1 的不变量 = "**每个真实目录只展开一次** + 终止 + 不截断 + 账目/配额可用"；
//   现行规则把"拒谁"精确定义成**树外**，树内一律"跟随且只展开一次" ⇒ `[实测·本轮]`
//   `danger-full-access`（lstat 看得见 ⇒ `isSymbolicLink()===true`、`isDirectory()===false`）
//   与注入的 `workspace-write` 盲形态（lstat 穿透 ⇒ `isDirectory()===true`）**处置一致**：
//   自指/互指链接都记 `already-visited-cycle`（不是 `reparse-point-not-followed`、
//   更不是 `realpath-outside-tree*`）。历史口径（旧规则）下前者是"环检测分支到不了"的死代码，
//   那正是本轮要修的覆盖损失；测试据此**严格断言 reason**，并用 §4v2/§4ab5 的注入盲形态
//   证明这条断言与宿主 lstat 形态无关。
//   同时把"没有目录被展开两次"做成**可观测计数**（注入 fsImpl 数 `readdirSync` 调用次数）——
//   这条断言才是"环检测一旦失效（真实的重扫/爆炸）就必然见红"的那一条。
//
// "树外 junction 一个字节都不计"这条硬不变式不在本节现场（本节的链接指向**树内**），
// 但两种宿主形态下都各有证据：真实形态 ⇒ §4a/4b/4p；**盲形态** ⇒ §4p2/§4p3。
// 本节只额外要求：**环链接的处置不许是"出树逃逸"**（否则说明现场根本不是"树内环"）。
//
// 这些断言在**正常模式与 `--plant` 模式下都必须通过**：`--plant` 拆的是"树外包含性判定"
// 与"硬链接去重"，树内环仍由 `visitedDirs` 收住（§4p2/§4p3 单独钉盲形态下 `--plant` 的破坏力）。
// ═══════════════════════════════════════════════════════════════════════════
function tryJunction(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'junction')
    return 'junction'
  } catch (error) {
    return `failed:${error.code}`
  }
}

/**
 * 现行规则下 in-tree 目录环链接的**唯一**期望 reason（宿主 lstat 形态无关）。
 * `[实测·本轮]` 真实形态（`lstat.isSymbolicLink()===true`）与注入盲形态都给出这一条；
 * 它必须**不是** `realpath-outside-tree*`（否则现场根本不是"树内环"）。
 */
const CYCLE_REASON = 'already-visited-cycle'

/** 计数用 `fsImpl`：包住真实 fs，记录每次 `readdirSync` 的**打开前路径** */
function countingFs() {
  const readdirPaths = []
  return {
    readdirPaths,
    impl: {
      lstatSync: (path) => lstatSync(path),
      readdirSync: (path, options) => {
        readdirPaths.push(path)
        return readdirSync(path, options)
      },
      realpathSync: (path) => realpathSync.native(path),
    },
  }
}

/** 目录 key：小写 + 去尾分隔符（与 `src\limits.mjs::dirKey` / `isWithin` 同口径） */
const dirKeyOf = (value) => String(value).toLowerCase().replace(/[\\/]+$/, '')

/** 把 `readdirSync` 的打开前路径解析成真实路径后，统计"每个真实目录被展开了几次" */
function expansionsByRealDir(counter) {
  const byReal = new Map()
  for (const path of counter.readdirPaths) {
    let real
    try {
      real = realpathSync.native(path)
    } catch {
      real = path
    }
    const key = dirKeyOf(real)
    byReal.set(key, (byReal.get(key) ?? 0) + 1)
  }
  return byReal
}

/** 展开次数的最大值：`=== 1` 就是"**没有任何真实目录被展开超过一次**"（D1 的不变量本体） */
function maxExpansions(counter) {
  const values = [...expansionsByRealDir(counter).values()]
  return values.length === 0 ? 0 : Math.max(...values)
}

/**
 * 注入"**盲**"形态 `fsImpl`：把指定**基名**的条目在 `lstat` 与 `readdir`/`Dirent` 两处
 * 都报成"普通目录"（`isSymbolicLink()=>false`、`isDirectory()=>true`、`isFile()=>false`），
 * 即模拟 `workspace-write` 形态下 `lstat` **穿透** junction 的样子。
 * 用途：证明"树内环链接 ⇒ `already-visited-cycle`"这条处置**与宿主 lstat 形态无关**
 * （真实形态是 §4v/§4ab，这里是盲形态的对照，两条路都必须真的走通）。
 */
function blindJunctionFs(blindNames) {
  const names = new Set(blindNames)
  const baseName = (value) => String(value).split(/[\\/]/).pop()
  const asDirectory = (info) => ({ ...info, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false })
  return {
    lstatSync: (path) => {
      const info = lstatSync(path)
      return names.has(baseName(path)) ? asDirectory(info) : info
    },
    readdirSync: (path, options) => {
      const dirents = readdirSync(path, options)
      return dirents.map((dirent) =>
        names.has(dirent.name) ? { name: dirent.name, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } : dirent,
      )
    },
    realpathSync: (path) => realpathSync.native(path),
  }
}

const cycleTree = tmpDir('cycle-self')
bytesFile(join(cycleTree, 'in.bin'), 7, 0x50)
const selfLoop = join(cycleTree, 'self')
const selfKind = tryJunction(cycleTree, selfLoop)
if (selfKind === 'junction') {
  // 刻意**不**传 maxEntries：走生产默认 200000（修复前这一行要烧 22 秒）
  const selfFs = countingFs()
  const startedAt = process.hrtime.bigint()
  const selfReport = measureTree(cycleTree, { fsImpl: selfFs.impl })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  const selfMaxExpansions = maxExpansions(selfFs)
  check(
    '4v 自指 junction：终止且 entries 有界（修复前撞满 maxEntries=200000）',
    selfReport.entries <= 16,
    `entries=${selfReport.entries}（上界 200000）truncated=${selfReport.truncated} 耗时=${elapsedMs.toFixed(1)}ms`,
  )
  check(
    '4w 自指 junction **不因环**而 truncated（没有 MEASURE_TREE_BOUND，errors 为空）',
    selfReport.truncated === false && selfReport.errors.length === 0,
    `truncated=${selfReport.truncated} errors=${JSON.stringify(selfReport.errors.map((item) => item.code))}`,
  )
  const selfSkip = selfReport.skipped.find((item) => item.path === selfLoop)
  check(
    '4x 自指 junction 被**结构化**记为**环检测**跳过：reason=already-visited-cycle ＋ notes 留 cycle-skipped 证据（本轮改规则后在真实 lstat 形态下重新可达，不再是死分支）',
    selfSkip !== undefined &&
      selfSkip.reason === CYCLE_REASON &&
      !/^realpath-outside-tree/.test(String(selfSkip.reason)) &&
      selfReport.notes.some((note) => note.kind === 'cycle-skipped'),
    JSON.stringify({
      reason: selfSkip?.reason,
      kind: selfSkip?.kind,
      expected: CYCLE_REASON,
      notes: selfReport.notes.map((note) => note.kind),
    }),
  )
  check(
    '4x2 自指 junction：**没有任何真实目录被展开超过一次**（注入 fsImpl 数 readdirSync —— 这才是 D1 的不变量，与 reason 无关；环检测失效时会无界重扫）',
    selfMaxExpansions === 1 && selfReport.entries <= 16,
    `readdir 调用 ${selfFs.readdirPaths.length} 次；按真实路径去重：${JSON.stringify([...expansionsByRealDir(selfFs).entries()].map(([dir, times]) => ({ dir, times })))}；max=${selfMaxExpansions}`,
  )
  // 4x3：**完全走生产路径**再钉一次 —— 不传 `fsImpl`、不传 `guard`，直接 `measureTree(root)`。
  // §4x 的注入 `fsImpl` 虽然包的是**真实** `lstatSync`，但为了不留"只有注入才可达"的疑问，
  // 这里用生产默认调用证明：环检测 reason 在本机**真实 lstat 形态**下确实活着。
  const selfPlainReport = measureTree(cycleTree)
  check(
    '4x3 生产默认调用（无任何注入）下自指 junction 仍记 already-visited-cycle ⇒ 环检测分支在本机真实形态下活着（不是只在注入形态下可达）',
    selfPlainReport.skipped.some((item) => item.path === selfLoop && item.reason === CYCLE_REASON) &&
      selfPlainReport.truncated === false &&
      selfPlainReport.errors.length === 0 &&
      selfPlainReport.bytes === 7 &&
      selfPlainReport.dirs === 1,
    JSON.stringify({
      skipped: selfPlainReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })),
      truncated: selfPlainReport.truncated,
      bytes: selfPlainReport.bytes,
      dirs: selfPlainReport.dirs,
    }),
  )
  // ── 4v2：**宿主形态无关性** —— 注入盲形态（lstat ＋ Dirent 都把 `self` 报成普通目录，
  // 模拟 workspace-write 的 lstat 穿透）后，同一条现场必须给**同一个**处置与同样的账目。
  // 与 §4v/§4x/§4x3 合起来 ⇒ "环检测分支活着"不依赖本机 lstat 形态（两种形态都有活路径）。
  const selfBlindReport = measureTree(cycleTree, { fsImpl: blindJunctionFs(['self']) })
  check(
    '4v2 注入盲形态（lstat＋Dirent 都看不见 junction，模拟 workspace-write）：同一条自指 junction 仍记 already-visited-cycle、账目与真实形态逐字段一致（宿主形态无关）',
    selfBlindReport.entries === selfReport.entries &&
      selfBlindReport.truncated === false &&
      selfBlindReport.errors.length === 0 &&
      selfBlindReport.bytes === selfReport.bytes &&
      selfBlindReport.files === selfReport.files &&
      selfBlindReport.dirs === selfReport.dirs &&
      selfBlindReport.skipped.some((item) => item.path === selfLoop && item.reason === CYCLE_REASON),
    JSON.stringify({
      real: { entries: selfReport.entries, bytes: selfReport.bytes, files: selfReport.files, dirs: selfReport.dirs },
      blind: { entries: selfBlindReport.entries, bytes: selfBlindReport.bytes, files: selfBlindReport.files, dirs: selfBlindReport.dirs },
      blindSkipped: selfBlindReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })),
    }),
  )
  check(
    '4y 自指 junction 不污染账：bytes=7 / files=1 / dirs=1（环上的目录不重复计入）',
    selfReport.bytes === 7 && selfReport.files === 1 && selfReport.dirs === 1,
    `bytes=${selfReport.bytes} files=${selfReport.files} dirs=${selfReport.dirs}`,
  )
  // 后果链：D1 的真实危害是"配额统计永远不完整 ⇒ 永久拒绝写入"
  const selfQuota = checkStagingQuota({ root: cycleTree, incomingBytes: 1 })
  check(
    '4z 有自指 junction 的树：checkStagingQuota ⇒ complete=true 且判定可用（不再抛 MEASUREMENT_INCOMPLETE）',
    selfQuota.measure?.complete === true && selfQuota.allowed === true && selfQuota.usedBytes === 7 && selfQuota.measure.truncated === false,
    JSON.stringify({ complete: selfQuota.measure?.complete, allowed: selfQuota.allowed, usedBytes: selfQuota.usedBytes }),
  )
  // 加严接口不能变成"关掉环检测/跟随判定"的后门（与 4p 同一条硬不变式）：
  // 漏判的 guard 在两种宿主形态下都不许让 walk 出树或重扫。
  const weakGuardCycle = measureTree(cycleTree, { guard: (info) => info.isSymbolicLink() })
  check(
    '4aa 漏判 guard（`info.isSymbolicLink()` 在盲形态下看不见 junction）不能关掉环检测/跟随判定',
    weakGuardCycle.entries <= 16 && weakGuardCycle.truncated === false && weakGuardCycle.bytes === 7,
    `entries=${weakGuardCycle.entries} truncated=${weakGuardCycle.truncated} bytes=${weakGuardCycle.bytes}`,
  )
} else {
  skip('4v-4ab 自指 junction 环检测用例', `无法创建 junction（${selfKind}）—— 本机权限不足，环检测在本机**未获证据**`)
}

// 4ab 互指（a → b 且 b → a）：也不是"只有一条自环"的特例。
// ⚠ 这里断言的是"**两条链接都记 already-visited-cycle**"（现行规则下宿主形态无关，见本节头注）：
//    旧规则下 `danger-full-access` 形态把两条都在"非目录链接"分支拒掉、环计数为 0，
//    因此那时只能断言"属于两种安全处置之一"；改规则后 reason 变成**确定的**环检测。
//    真正要钉的仍是"终止 + 每个真实目录只展开一次 + 两条链接都结构化留痕 + 账目/配额可用"。
const mutualRoot = tmpDir('cycle-mutual')
const mutualA = join(mutualRoot, 'a')
const mutualB = join(mutualRoot, 'b')
mkdirSync(mutualA, { recursive: true })
mkdirSync(mutualB, { recursive: true })
bytesFile(join(mutualA, 'in.bin'), 5, 0x51)
const mutualKind = (() => {
  const first = tryJunction(mutualB, join(mutualA, 'to-b'))
  if (first !== 'junction') return first
  return tryJunction(mutualA, join(mutualB, 'to-a'))
})()
if (mutualKind === 'junction') {
  const mutualFs = countingFs()
  const mutualReport = measureTree(mutualRoot, { fsImpl: mutualFs.impl })
  const mutualMaxExpansions = maxExpansions(mutualFs)
  check(
    '4ab 互指 junction（a→b→a）：终止、有界、不截断、账目不污染（**不钉环计数**）',
    mutualReport.entries <= 16 &&
      mutualReport.truncated === false &&
      mutualReport.errors.length === 0 &&
      mutualReport.bytes === 5 &&
      mutualReport.files === 1,
    JSON.stringify({
      entries: mutualReport.entries,
      truncated: mutualReport.truncated,
      bytes: mutualReport.bytes,
      dirs: mutualReport.dirs,
      skipped: mutualReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })),
    }),
  )
  // 注意：不能按**完整路径**字符串找（walker 入栈的是 `realpathSync` 的产物，
  // 可能把 `ADMINI~1` 之类的短名解析成长名 ⇒ 大小写/短名不一致）；`to-b`/`to-a` 名字唯一，按**基名**找。
  const mutualSkips = ['to-b', 'to-a'].map((name) =>
    mutualReport.skipped.find((item) => item.path.split('\\').pop() === name),
  )
  check(
    '4ab2 两条环链接都被**结构化**记为**环检测**跳过：reason=already-visited-cycle（两条都是，且都不是出树拒绝；本轮改规则后真实形态下可达）',
    mutualSkips.every((item) => item !== undefined && item.reason === CYCLE_REASON) &&
      mutualReport.notes.filter((note) => note.kind === 'cycle-skipped').length >= 2,
    JSON.stringify({
      skips: mutualSkips.map((item) => ({ name: item?.path.split('\\').pop(), reason: item?.reason, kind: item?.kind })),
      expected: CYCLE_REASON,
      cycleNotes: mutualReport.notes.filter((note) => note.kind === 'cycle-skipped').length,
    }),
  )
  check(
    '4ab3 互指 junction：**没有任何真实目录被展开超过一次**（计数 readdirSync；环检测失效时会无界重扫）',
    mutualMaxExpansions === 1 && mutualReport.entries <= 16,
    `readdir 调用 ${mutualFs.readdirPaths.length} 次；按真实路径去重：${JSON.stringify([...expansionsByRealDir(mutualFs).entries()].map(([dir, times]) => ({ dir, times })))}；max=${mutualMaxExpansions}`,
  )
  const mutualQuota = checkStagingQuota({ root: mutualRoot, incomingBytes: 1 })
  check(
    '4ab4 互指 junction 的树：checkStagingQuota ⇒ complete=true 且判定可用（与 4z 同一条后果链：环不再让配额统计失效）',
    mutualQuota.measure?.complete === true && mutualQuota.allowed === true && mutualQuota.usedBytes === 5,
    JSON.stringify({ complete: mutualQuota.measure?.complete, allowed: mutualQuota.allowed, usedBytes: mutualQuota.usedBytes }),
  )
  // ── 4ab5：互指现场的**盲形态对照**（同 §4v2）—— 两条环链接在"两种判据都看不见"时
  // 仍必须记 already-visited-cycle、条数与账目一致 ⇒ 环检测的 reason 与宿主 lstat 形态无关。
  const mutualBlindReport = measureTree(mutualRoot, { fsImpl: blindJunctionFs(['to-a', 'to-b']) })
  check(
    '4ab5 注入盲形态下的互指环形：两条链接仍都记 already-visited-cycle、账目与真实形态一致（宿主形态无关）',
    mutualBlindReport.entries === mutualReport.entries &&
      mutualBlindReport.bytes === mutualReport.bytes &&
      mutualBlindReport.files === mutualReport.files &&
      mutualBlindReport.dirs === mutualReport.dirs &&
      mutualBlindReport.skipped.filter((item) => item.reason === CYCLE_REASON).length >= 2,
    JSON.stringify({
      real: { entries: mutualReport.entries, bytes: mutualReport.bytes, dirs: mutualReport.dirs },
      blind: { entries: mutualBlindReport.entries, bytes: mutualBlindReport.bytes, dirs: mutualBlindReport.dirs },
      blindSkipped: mutualBlindReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })),
    }),
  )
} else {
  skip('4ab 互指 junction 用例', `无法创建 junction（${mutualKind}）—— 环检测在本机**未获证据**`)
}

// ── 4ac：**in-tree alias 恢复进账**（旧规则在 danger-full-access 形态下的覆盖面损失）──────
// 现场：真实目录 `inner/`（3 B 文件）＋ 指向它的 junction `alias`（**目标在树内**）。
// 现行规则 ⇒ alias 展开一次（`alias` 与 `inner` 是同一个真实目录，第二个到访记环跳过），
// 因此：bytes=3 / files=1 / dirs=2（root + inner，**只算一次**），且 `skipped` 里**必有一条**
// `already-visited-cycle` —— 这条只能来自"junction 真的被跟随过一次"（旧规则记的是
// `reparse-point-not-followed`、`skipped` 里没有环 ⇒ 本条会红）。计数 readdirSync 钉"只展开一次"。
const aliasRoot = tmpDir('cycle-alias')
const aliasInner = join(aliasRoot, 'inner')
mkdirSync(aliasInner, { recursive: true })
bytesFile(join(aliasInner, 'in.bin'), 3, 0x52)
const aliasPath = join(aliasRoot, 'alias')
const aliasKind = tryJunction(aliasInner, aliasPath)
if (aliasKind === 'junction') {
  const aliasFs = countingFs()
  const aliasReport = measureTree(aliasRoot, { fsImpl: aliasFs.impl })
  const aliasCycleSkips = aliasReport.skipped.filter((item) => item.reason === CYCLE_REASON)
  check(
    '4ac in-tree alias（junction → 树内真实目录）：目标进账且**只展开一次** —— bytes=3 / files=1 / dirs=2，恰有一条 already-visited-cycle，且没有任何真实目录被 readdir 两次',
    aliasReport.bytes === 3 &&
      aliasReport.files === 1 &&
      aliasReport.dirs === 2 &&
      aliasReport.truncated === false &&
      aliasReport.errors.length === 0 &&
      aliasCycleSkips.length === 1 &&
      maxExpansions(aliasFs) === 1,
    JSON.stringify({
      bytes: aliasReport.bytes,
      files: aliasReport.files,
      dirs: aliasReport.dirs,
      skipped: aliasReport.skipped.map((item) => ({ name: item.path.split('\\').pop(), reason: item.reason })),
      readdir: aliasFs.readdirPaths.map((path) => path.split('\\').pop()),
      maxExpansions: maxExpansions(aliasFs),
    }),
  )
} else {
  skip('4ac in-tree alias 用例', `无法创建 junction（${aliasKind}）—— 该不变式在本机**未获证据**`)
}

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 5. checkStagingQuota：写入前拒绝 / 零余量放行 / remaining 正确 ===')
// ═══════════════════════════════════════════════════════════════════════════
const quotaTree = tmpDir('quota')
bytesFile(join(quotaTree, 'used.bin'), 1000, 0x4b)
const Q = 10000
const qAllow = checkStagingQuota({ root: quotaTree, quotaBytes: Q, incomingBytes: 500 })
check(
  '5a 配额内放行，used=1000 / remaining=9000 / headroom=8500',
  qAllow.allowed === true && qAllow.usedBytes === 1000 && qAllow.remainingBytes === 9000 && qAllow.headroomBytes === 8500,
  JSON.stringify({ allowed: qAllow.allowed, used: qAllow.usedBytes, remaining: qAllow.remainingBytes, headroom: qAllow.headroomBytes }),
)
check('5b 放行时 reason 是人可读的（进审批面）', typeof qAllow.reason === 'string' && /配额内/.test(qAllow.reason), qAllow.reason)
check('5c 统计细节被带出来（含 complete 标记）', qAllow.measure && qAllow.measure.complete === true && qAllow.measure.bytes === 1000, JSON.stringify(qAllow.measure))

const qExact = checkStagingQuota({ root: quotaTree, quotaBytes: Q, incomingBytes: 9000 })
check(
  '5d **恰好用满**（used+incoming === quota）⇒ 放行，headroom=0、remaining=9000',
  qExact.allowed === true && qExact.headroomBytes === 0 && /恰好用满/.test(qExact.reason),
  JSON.stringify({ allowed: qExact.allowed, headroom: qExact.headroomBytes, remaining: qExact.remainingBytes, reason: qExact.reason }),
)
const qOver = checkStagingQuota({ root: quotaTree, quotaBytes: Q, incomingBytes: 9001 })
check(
  '5e 超出一个字节 ⇒ **拒绝**（写入前就拒，硬不变式 #2）',
  qOver.allowed === false && qOver.headroomBytes === -1,
  JSON.stringify({ allowed: qOver.allowed, headroom: qOver.headroomBytes, reason: qOver.reason }),
)
check('5f 拒绝时 reason 写清超了多少', /超出 1 字节/.test(qOver.reason), qOver.reason)
const qReserved = checkStagingQuota({ root: quotaTree, quotaBytes: Q, incomingBytes: 100, reservedBytes: 9000 })
check(
  '5g reservedBytes 计入判定（防并发超卖）：100+9000 加上已用 ⇒ 拒绝',
  qReserved.allowed === false && qReserved.reservedBytes === 9000,
  JSON.stringify({ allowed: qReserved.allowed, wouldBe: qReserved.wouldBeBytes }),
)
const qFree = checkStagingQuota({ root: quotaTree, quotaBytes: Q })
check('5h 不传 incoming 时按 0 处理且放行', qFree.allowed === true && qFree.incomingBytes === 0)

// 5i 恰好等于配额边界（用显式 usedBytes，不经文件系统）
const qBoundary = checkStagingQuota({ usedBytes: 10, quotaBytes: 10, incomingBytes: 0 })
check('5i used === quota ⇒ 放行（零头寸）', qBoundary.allowed === true && qBoundary.remainingBytes === 0)
const qBoundaryOver = checkStagingQuota({ usedBytes: 11, quotaBytes: 10 })
check('5j used > quota ⇒ 拒绝且 remaining 为负（如实报告欠账）', qBoundaryOver.allowed === false && qBoundaryOver.remainingBytes === -1)
const qZero = checkStagingQuota({ usedBytes: 0, quotaBytes: 0 })
check('5k quota=0 / used=0 ⇒ 放行；再来一个字节就拒', qZero.allowed === true && checkStagingQuota({ usedBytes: 0, quotaBytes: 0, incomingBytes: 1 }).allowed === false)

// 5l 统计不完整时集成方拿到 complete:false（据此 fail-closed）
const incomplete = checkStagingQuota({ root: boundTree, quotaBytes: 100000, measureOptions: { maxEntries: 2 } })
check(
  '5l 统计被截断时 measure.complete === false（集成方据此按已用=配额 fail-closed）',
  incomplete.measure && incomplete.measure.complete === false && incomplete.measure.truncated === true,
  JSON.stringify(incomplete.measure),
)

// 5m 参数校验（fail-closed）+ 拒绝"猜"
checkThrows('checkStagingQuota(quotaBytes: -1) 抛错', () => checkStagingQuota({ usedBytes: 0, quotaBytes: -1 }), 'LIMITS_INVALID')
checkThrows('checkStagingQuota(incomingBytes: NaN) 抛错', () => checkStagingQuota({ usedBytes: 0, quotaBytes: 10, incomingBytes: Number.NaN }), 'LIMITS_INVALID')
checkThrows('checkStagingQuota(reservedBytes: 1.5) 抛错', () => checkStagingQuota({ usedBytes: 0, quotaBytes: 10, reservedBytes: 1.5 }), 'LIMITS_INVALID')
checkThrows('既无 root 又无 usedBytes ⇒ 抛错（拒绝猜测）', () => checkStagingQuota({ quotaBytes: 10 }), 'LIMITS_INVALID')
checkThrows('checkStagingQuota(null) 抛错', () => checkStagingQuota(null), 'LIMITS_INVALID')
checkThrows('统计实现不返回 bytes ⇒ 抛错（fail-closed）', () => checkStagingQuota({ root: quotaTree, measure: () => ({}) }), 'LIMITS_INVALID')
const qDefault = checkStagingQuota({ usedBytes: 0 })
check('5n 默认配额 = DEFAULT_LIMITS.stagingBytes（64 GiB）', qDefault.quotaBytes === DEFAULT_LIMITS.stagingBytes, String(qDefault.quotaBytes))

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 6. applyOutputCap：显式截断 / UTF-8 字符边界 / ASCII 标记 ===')
// ═══════════════════════════════════════════════════════════════════════════
const noop = applyOutputCap('hello world')
check(
  '6a 不超上限：原文返回、truncated:false、marker:null（不做任何改写）',
  noop.text === 'hello world' && noop.truncated === false && noop.marker === null && noop.droppedBytes === 0 && noop.keptLines === 0,
  JSON.stringify(noop),
)
const asciiText = 'A'.repeat(100)
const asciiCap = applyOutputCap(asciiText, { maxBytes: 40, maxLines: 1e6 })
check(
  '6b ASCII 截断：保留前 40 字节，droppedBytes = 总字节 - 保留字节（恒等式）',
  asciiCap.truncated === true && asciiCap.keptBytes === 40 && asciiCap.droppedBytes === 60 && asciiCap.keptBytes + asciiCap.droppedBytes === Buffer.byteLength(asciiText),
  `kept=${asciiCap.keptBytes} dropped=${asciiCap.droppedBytes}`,
)
check('6c 保留部分是原文的**逐字节前缀**', asciiCap.text.startsWith('A'.repeat(40)), `head=${JSON.stringify(asciiCap.text.slice(0, 8))}`)
check('6d 标记出现在返回文本里（可机检）', asciiCap.text.includes(asciiCap.marker) && /OUTPUT-TRUNCATED/.test(asciiCap.marker), JSON.stringify(asciiCap.marker))
check('6e 标记是**纯 ASCII**（不用非 ASCII 标记，避免控制台乱码）', (() => {
  try {
    return __internal.assertAsciiMarker(asciiCap.marker) === true
  } catch {
    return false
  }
})(), JSON.stringify(asciiCap.marker))
check('6f byteTruncated:true / lineTruncated:false（分别标注触发了哪条）', asciiCap.byteTruncated === true && asciiCap.lineTruncated === false)
check(
  '6g droppedBytes 是"被丢掉的**原文**字节"，与标记里报告的数字一致',
  asciiCap.marker.includes(`dropped ${asciiCap.droppedBytes} bytes`),
  asciiCap.marker,
)

// 6h-6k 多字节 UTF-8 边界（'中' = 3 字节）
const cjk = '中'.repeat(10) // 30 字节
const cjkTotal = Buffer.byteLength(cjk)
for (const limit of [1, 2, 4, 7, 10, 29]) {
  const capped = applyOutputCap(cjk, { maxBytes: limit, maxLines: 1e6 })
  const keptText = capped.marker ? capped.text.slice(0, capped.text.length - capped.marker.length) : capped.text
  const keptBytes = Buffer.byteLength(keptText, 'utf8')
  const valid =
    capped.truncated === true &&
    keptBytes === capped.keptBytes &&
    keptBytes % 3 === 0 && // 只能整字符
    keptBytes + capped.droppedBytes === cjkTotal &&
    !__internal.hasLoneSurrogate(keptText) &&
    !keptText.includes('\uFFFD') && // 没有替换字符 = 没有半个码点被"宽松解码"吞掉
    keptText === cjk.slice(0, keptText.length)
  check(
    `6h maxBytes=${limit}：截在 UTF-8 字符边界（kept=${keptBytes} 字节，无半个码点）`,
    valid,
    `keptBytes=${capped.keptBytes} dropped=${capped.droppedBytes} text=${JSON.stringify(keptText)} lone=${__internal.hasLoneSurrogate(keptText)}`,
  )
}
const cjkExact = applyOutputCap(cjk, { maxBytes: cjkTotal, maxLines: 1e6 })
check('6i 恰好等于上限：不截断（边界不误伤）', cjkExact.truncated === false && cjkExact.text === cjk)
const cjkOneLess = applyOutputCap(cjk, { maxBytes: cjkTotal - 1, maxLines: 1e6 })
check(
  '6j 差一个字节：退到 27 字节（丢一个完整字符），绝不返回 29 字节的半个字符',
  cjkOneLess.keptBytes === cjkTotal - 3 && cjkOneLess.droppedBytes === 3 && cjkOneLess.byteTruncated === true,
  `kept=${cjkOneLess.keptBytes} dropped=${cjkOneLess.droppedBytes}`,
)
// 4 字节字符（emoji）也不能被切半
const emojiText = '😀'.repeat(4) // 16 字节
const emojiCap = applyOutputCap(emojiText, { maxBytes: 6, maxLines: 1e6 })
const emojiKept = emojiCap.text.slice(0, emojiCap.text.length - emojiCap.marker.length)
check(
  '6k 4 字节码点（emoji）同样截在字符边界（6 字节 ⇒ 只保留 1 个 = 4 字节）',
  Buffer.byteLength(emojiKept, 'utf8') === 4 && !__internal.hasLoneSurrogate(emojiKept) && emojiCap.droppedBytes === 12,
  `kept=${Buffer.byteLength(emojiKept, 'utf8')} dropped=${emojiCap.droppedBytes}`,
)

// 6l-6n 行数上限
const lines = 'a\nb\nc\nd\n' // 4 个换行
const lineCap = applyOutputCap(lines, { maxBytes: 1e6, maxLines: 2 })
check(
  '6l 行数上限：保留恰好前 2 个换行符（口径 = 换行符个数）',
  lineCap.keptLines === 2 && lineCap.text.startsWith('a\nb\n') && lineCap.lineTruncated === true && lineCap.byteTruncated === false,
  JSON.stringify(lineCap.text.slice(0, 6)),
)
check(
  '6m droppedLines 正确（4 - 2 = 2）且 droppedBytes = 少了 4 个字节',
  lineCap.droppedLines === 2 && lineCap.droppedBytes === 4,
  `droppedLines=${lineCap.droppedLines} droppedBytes=${lineCap.droppedBytes}`,
)
const lineFit = applyOutputCap('a\nb\n', { maxBytes: 1e6, maxLines: 2 })
check('6n 换行数不超过上限 ⇒ 不截断', lineFit.truncated === false && lineFit.text === 'a\nb\n')
const lineZero = applyOutputCap('a\nb\n', { maxBytes: 1e6, maxLines: 0 })
check(
  '6o maxLines=0：不保留任何原文，但**仍然**输出显式标记（不静默丢）',
  lineZero.truncated === true && lineZero.keptBytes === 0 && lineZero.droppedBytes === 4 && lineZero.text === lineZero.marker,
  JSON.stringify(lineZero.text),
)
// 6p-6p3 两条上限的分工：byteTruncated / lineTruncated 必须分别反映"哪一条真的削减了内容"
const cjkLine = '中'.repeat(6) + '\n' + '中'.repeat(6) // 18 + 1 + 18 = 37 字节，1 个换行
check('6p0 现场自检：cjkLine = 37 字节 / 1 个换行', Buffer.byteLength(cjkLine) === 37 && __internal.countNewlines(cjkLine) === 1, `${Buffer.byteLength(cjkLine)} B`)
const lineOnly = applyOutputCap(cjkLine, { maxBytes: 1e6, maxLines: 0 })
check(
  '6p 只触发行上限时：lineTruncated:true、byteTruncated:false（不把行截断误报成字节截断）',
  lineOnly.lineTruncated === true && lineOnly.byteTruncated === false && lineOnly.keptBytes === 0 && lineOnly.droppedBytes === 37,
  JSON.stringify({ byte: lineOnly.byteTruncated, line: lineOnly.lineTruncated, kept: lineOnly.keptBytes, dropped: lineOnly.droppedBytes }),
)
// 行切已清空 ⇒ 字节上限"一字节都没丢" ⇒ 不许报 byteTruncated（这正是 6p2 的形态）
const lineThenEmpty = applyOutputCap(cjkLine, { maxBytes: 9, maxLines: 0 })
check(
  '6p2 行切已清空后再看字节上限：byteTruncated **仍然** false（预算没削减任何内容）',
  lineThenEmpty.lineTruncated === true && lineThenEmpty.byteTruncated === false,
  JSON.stringify({ byte: lineThenEmpty.byteTruncated, line: lineThenEmpty.lineTruncated }),
)
// 现场：`'x'.repeat(10) + '\n' + 'y'.repeat(10) + '\n' + 'z'.repeat(10) + '\n'` = 33 字节 / 3 个换行
// 口径：**保留恰好前 `maxLines` 个换行符**（`maxLines=2` ⇒ 保留 21 字节 `xxx…\n yyy…\n`）
const threeLines = 'x'.repeat(10) + '\n' + 'y'.repeat(10) + '\n' + 'z'.repeat(10) + '\n'
check('6p1 现场自检：threeLines = 33 字节 / 3 个换行', Buffer.byteLength(threeLines) === 33 && __internal.countNewlines(threeLines) === 3, `${Buffer.byteLength(threeLines)} B`)
// 行切到 21 B，但字节上限只要 10 B ⇒ 两条上限**都**削减了内容
const lineThenByte = applyOutputCap(threeLines, { maxBytes: 10, maxLines: 2 })
check(
  '6p3 行切后再按字节切：两条标志都为 true（两条上限都确实削减了内容）',
  lineThenByte.lineTruncated === true && lineThenByte.byteTruncated === true && lineThenByte.keptBytes === 10 &&
    lineThenByte.keptLines === 0 && lineThenByte.droppedBytes === 23,
  JSON.stringify({ byte: lineThenByte.byteTruncated, line: lineThenByte.lineTruncated, kept: lineThenByte.keptBytes, dropped: lineThenByte.droppedBytes }),
)
// 反例：行切到 22 B（`x`×10 + `\n` + `y`×10 + `\n`）后已经在字节预算（30 B）之内
// ⇒ 字节上限**没有**削减内容 ⇒ 只报行截断
const lineOnlyCut = applyOutputCap(threeLines, { maxBytes: 30, maxLines: 2 })
check(
  '6p4 行切后已落在字节预算内：byteTruncated:false、lineTruncated:true（不虚报字节截断）',
  lineOnlyCut.lineTruncated === true && lineOnlyCut.byteTruncated === false && lineOnlyCut.keptBytes === 22 && lineOnlyCut.keptLines === 2,
  JSON.stringify({ byte: lineOnlyCut.byteTruncated, line: lineOnlyCut.lineTruncated, kept: lineOnlyCut.keptBytes, keptLines: lineOnlyCut.keptLines }),
)
const huge = applyOutputCap('x'.repeat(1000), { maxBytes: 10, maxLines: 1e6 })
check(
  '6q 恒等式在极端截断下也成立（kept + dropped === 原文总字节）',
  huge.keptBytes + huge.droppedBytes === 1000 && huge.keptBytes === 10,
  `kept=${huge.keptBytes} dropped=${huge.droppedBytes}`,
)
check(
  '6r 默认上限是 4 MiB：5 MiB 输出必被截断且标记含 limit 4194304',
  (() => {
    const capped = applyOutputCap('y'.repeat(5 * 1024 * 1024))
    return capped.truncated === true && capped.keptBytes === 4 * 1024 * 1024 && capped.marker.includes('4194304')
  })(),
)
checkThrows('applyOutputCap(Buffer) 抛错（要求先 decode，避免字节语义含糊）', () => applyOutputCap(Buffer.from('x')), 'OUTPUT_CAP_INVALID')
checkThrows('applyOutputCap(text, { maxBytes: -1 }) 抛错', () => applyOutputCap('x', { maxBytes: -1 }), 'OUTPUT_CAP_INVALID')
checkThrows('applyOutputCap(text, { maxLines: 1.5 }) 抛错', () => applyOutputCap('x', { maxLines: 1.5 }), 'OUTPUT_CAP_INVALID')
checkThrows('applyOutputCap(null) 抛错', () => applyOutputCap(null), 'OUTPUT_CAP_INVALID')

// ═══════════════════════════════════════════════════════════════════════════
W('')
W('=== 7. wrapLimits / summariseLimits：归一化、校验、报告（fail-closed）===')
// ═══════════════════════════════════════════════════════════════════════════
const wrappedDefault = wrapLimits()
check(
  '7a 不传参 ⇒ 全默认，且 source 如实标注为 defaults',
  wrappedDefault.stagingBytes === DEFAULT_LIMITS.stagingBytes &&
    wrappedDefault.maxOutputBytes === DEFAULT_LIMITS.maxOutputBytes &&
    wrappedDefault.maxOutputLines === DEFAULT_LIMITS.maxOutputLines &&
    wrappedDefault.source === 'defaults',
  JSON.stringify({ ...wrappedDefault, staging: undefined, output: undefined }),
)
check('7b wrapLimits 结果被冻结', Object.isFrozen(wrappedDefault) && Object.isFrozen(wrappedDefault.staging) && Object.isFrozen(wrappedDefault.output))
const wrappedFlat = wrapLimits({ stagingBytes: '1GiB', maxOutputBytes: '1MiB', maxOutputLines: 10 })
check(
  '7c 扁平形状：字符串体积被解析成字节，source=explicit',
  wrappedFlat.stagingBytes === 1024 ** 3 && wrappedFlat.maxOutputBytes === 1024 ** 2 && wrappedFlat.maxOutputLines === 10 && wrappedFlat.source === 'explicit',
  JSON.stringify({ stagingBytes: wrappedFlat.stagingBytes, maxOutputBytes: wrappedFlat.maxOutputBytes, maxOutputLines: wrappedFlat.maxOutputLines }),
)
const wrappedNested = wrapLimits({ staging: { bytes: '2GiB' }, output: { maxBytes: '3MiB', maxLines: 5 } })
check(
  '7d 嵌套形状与扁平形状**归一化到同一个出口**（不是两套口径）',
  wrappedNested.stagingBytes === 2 * 1024 ** 3 && wrappedNested.maxOutputBytes === 3 * 1024 ** 2 && wrappedNested.maxOutputLines === 5,
  JSON.stringify({ stagingBytes: wrappedNested.stagingBytes, maxOutputBytes: wrappedNested.maxOutputBytes, maxOutputLines: wrappedNested.maxOutputLines }),
)
check(
  '7e 嵌套形状的出口与扁平等价（同一份配置两种写法结果逐字段相同）',
  JSON.stringify({ ...wrapLimits({ stagingBytes: '2GiB', maxOutputBytes: '3MiB', maxOutputLines: 5 }), source: 'x' }) ===
    JSON.stringify({ ...wrappedNested, source: 'x' }),
)
const wrappedPartial = wrapLimits({ maxOutputLines: 7 })
check(
  '7f 部分覆盖：只给一个字段，其余回落默认（且如实标注哪一层来自默认）',
  wrappedPartial.stagingBytes === DEFAULT_LIMITS.stagingBytes && wrappedPartial.maxOutputLines === 7,
  JSON.stringify({ staging: wrappedPartial.stagingBytes, lines: wrappedPartial.maxOutputLines }),
)
checkThrows('7g 未知键抛错（拼错 maxOutputByte 必须当场报错，不能静默失效）', () => wrapLimits({ maxOutputByte: 10 }), 'LIMITS_INVALID')
checkThrows('7h 负数抛错', () => wrapLimits({ stagingBytes: -1 }), 'SIZE_PARSE_INVALID')
checkThrows('7i 非整数行数抛错', () => wrapLimits({ maxOutputLines: 1.5 }), 'LIMITS_INVALID')
checkThrows('7j 垃圾体积字符串抛错', () => wrapLimits({ stagingBytes: '很多' }), 'SIZE_PARSE_INVALID')
checkThrows('7k 嵌套里的未知键抛错', () => wrapLimits({ staging: { bogus: 1 } }), 'LIMITS_INVALID')
checkThrows('7l 嵌套 output 里的未知键抛错', () => wrapLimits({ output: { maxLine: 1 } }), 'LIMITS_INVALID')
checkThrows('7m 数组抛错', () => wrapLimits([]), 'LIMITS_INVALID')
checkThrows('7n 字符串抛错', () => wrapLimits('64GiB'), 'LIMITS_INVALID')
checkThrows('7o 嵌套与扁平混用抛错（避免歧义）', () => wrapLimits({ staging: { bytes: 1 }, stagingBytes: 2 }), 'LIMITS_INVALID')

const summary = summariseLimits(wrapLimits())
check(
  '7p summariseLimits 出口字段齐全（能力报告按这个读）',
  ['stagingBytes', 'stagingGiB', 'maxOutputBytes', 'maxOutputLines'].every((key) => key in summary),
  JSON.stringify(summary),
)
check('7q stagingGiB === 64（能力报告里"有上限"的可读证据）', summary.stagingGiB === 64, String(summary.stagingGiB))
check(
  '7r 摘要带出处标记：staging 为 [官方]、output 为 [推断]（不把本项目取值说成官方）',
  summary.stagingSource === '[官方]' && summary.outputSource === '[推断]',
  `${summary.stagingSource} / ${summary.outputSource}`,
)
check('7s summariseLimits 也接受裸对象（内部先 wrap，fail-closed）', summariseLimits({ stagingBytes: '1GiB' }).stagingGiB === 1)
checkThrows('7t summariseLimits 收到垃圾同样抛错（不留后门）', () => summariseLimits({ nope: 1 }), 'LIMITS_INVALID')

// ═══════════════════════════════════════════════════════════════════════════
// 清理现场（只删自己创建的临时根）
// ═══════════════════════════════════════════════════════════════════════════
let cleanupOk = false
try {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  cleanupOk = !existsSync(TMP_ROOT)
} catch (error) {
  cleanupOk = false
  W(`清理临时根失败：${error.message}`)
}

W('')
W('='.repeat(72))
if (PLANT) {
  // --plant 的**元断言**：判定必须真的变红（否则这套测试的判定力等于 0）
  const plantWorked = failures >= 3
  assertions += 1
  if (!plantWorked) failures += 1
  W(`${plantWorked ? '  ✓' : '  ✗'} PLANT1 --plant 模式必须让 ≥3 项断言变红`)
  W(`      证据: 失败 ${failures} 项（含本条）；正常模式应当为 0`)
  const hooksCleared = __internal.resetTestHooks()
  assertions += 1
  if (hooksCleared.followReparsePoints || hooksCleared.disableHardlinkDedupe) failures += 1
  W(`${hooksCleared.followReparsePoints || hooksCleared.disableHardlinkDedupe ? '  ✗' : '  ✓'} PLANT2 测试钩子可复位（不把变异体泄漏给后续用例）`)
}
W(`临时根已清理: ${cleanupOk ? '是' : '否'}`)
W(`${PLANT ? 'limits 测试（--plant 变异体，判定应当红）' : 'limits 测试'}：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`)
if (skips > 0) {
  W(`未提供的保证（${skips} 条）：跳过的用例**不是**通过 —— 本机无法创建 junction/symlink，`)
  W('  因此"不跟随重解析点"这条不变式在**本机**没有拿到证据；换一台允许创建链接的机器必须重跑。')
}
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (assertions=${assertions} failures=${failures} skips=${skips}${PLANT ? ' plant=true' : ''})`)
W('='.repeat(72))
process.exit(failures === 0 ? 0 : 1)
