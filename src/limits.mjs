/**
 * limits.mjs — 缺失的资源上限：**暂存磁盘配额** + **工具输出上限**
 *
 * ── 为什么需要这个模块（差距输入，逐字对齐）────────────────────────────────────
 * ① 磁盘配额（暂存树）：`docs\WinStageSandbox-能力清单与差距基线.md` §2 矩阵里
 *    「磁盘配额（暂存树）」= **ABSENT**（原文证据：全 `src/` 无 `quota`/`diskUsage`；
 *    Job 内存限制与磁盘无关）。对标项见 `docs\NeoAI-沙箱能力分析与差距输入.md` §5.2 第 13 条。
 * ② 输出大小上限：同矩阵「输出大小上限」= **ABSENT**。没有上限时，一次
 *    `type huge.bin` 或死循环 `while(1) echo x` 会把捕获缓冲撑爆，
 *    而"输出被静默截断"比"输出太大直接报错"更危险 —— 因此本模块的截断**必须显式可机检**。
 *
 * ── 64 GiB 这个数字的出处（不是本模块拍的）────────────────────────────────────
 * `[官方]` NeoAI `lua/NeoAI/default_config.lua`：`disk_bytes = 64 * 1024 * 1024 * 1024, -- 64 GiB`
 * （差距输入 §5.2 第 13 条与该文档第 137 行同时引用；上游仓库
 * https://github.com/gygygfg/NeoAI ，原文链接见差距输入文档）。
 * 因此 `DEFAULT_LIMITS.stagingBytes = 64 GiB` 是**对齐上游默认值**，不是新发明的阈值。
 * `maxOutputBytes` / `maxOutputLines` 上游没有对应项（`[推断]`）：本模块取"够大但不会撑爆
 * 捕获缓冲"的 4 MiB / 200000 行，二者都可在构造时覆盖。
 *
 * ── 定位（务必如实理解）──────────────────────────────────────────────────────
 * 本模块是**纯函数 + 只读文件系统**的一层：
 *   · 它**不**阻止任何写入；它只回答"这一笔该不该放行"（`checkStagingQuota`）。
 *   · 它**已经接线**（不是"由集成方另行接线"）：暂存写入前——`src\store.mjs:241`
 *     （`putBlob` 落盘前）；执行前 preflight——`src\executor.mjs:2150`（`run()`）；
 *     输出捕获——`src\executor.mjs:2265`（stdout/stderr 走 `applyOutputCap`）。
 *     本文件末"接线契约"一节保留的是**接口说明**，不是"尚未接线"的声明。
 *   · 真正的硬边界是 ACL/Job Object/T0；配额是**资源约束**，不是安全边界。
 *     `[实测]` 本机（node v24.21.0 / Windows；**本轮 `danger-full-access` 文件策略**下运行）：
 *     本模块全部函数可跑（见 `tests\limits.mjs` 的 **192** 项断言，正常模式自报
 *     `assertions=192 failures=0`；`--plant` **194** 项 / **5** 失败：§4a/§4b 树外 junction
 *     被跟随、§4e/§4f/§4g 硬链接去重**账目**不变式；其中 188→192 的 +4 来自
 *     本轮新增/改写的 §4x3（生产默认调用下的环检测 liveness）、§4v2（盲形态自指环）、
 *     §4ab5（盲形态互指环）、§4ac（in-tree alias 进账））。
 *     历史口径：更早的 `workspace-write` 受限会话为 **182** 项 / 0 失败、`--plant` 3 失败
 *     （该形态下 junction 的 `lstat` 看不见链接，与本轮 `danger-full-access` 形态的差异
 *     见 `tests\limits.mjs` 文件头 ②；本轮改规则后**两种形态处置一致**，见文件头 ⑧）；
 *     "配额被拒绝后写入确实没发生"由 `store.putBlob` 的调用点断言（见 `tests\e2e-flow.mjs`
 *     与本套件 §5 的 `putBlob` 用例）。
 *
 * ── 设计原则（与项目既有约定一致）────────────────────────────────────────────
 * 1. **fail-closed**：任何非法输入（未知键、负数、NaN、非安全整数）一律抛
 *    `LimitsError`，绝不"取个默认值继续跑"。静默回落 = 上限失效。
 * 2. **只拒树外重解析点**：`measureTree` 对每个条目做**包含性**判定（`realpathSync.native`
 *    解析后是否仍在被测树内）：**树外**目标一律不跟随、不计字节（否则一个指向 `C:\` 的
 *    junction 就能让配额瞬间"爆表"，或者反过来把外部大文件算进沙箱账）；
 *    **树内**目标跟随，但**每个真实目录只展开一次**（`visitedDirs` 环检测 ⇒ 自指/互指终止）。
 *    该口径在两种已观测的宿主 `lstat` 形态下**结局一致**（见 `tests\limits.mjs` 文件头 ②）。
 * 3. **可注入**：`measureTree` 接受 `fsImpl` 与 `onStat` 两个可选注入点，
 *    使"统计中途条目消失 / 条目不可读 / 遍历超界"这些**难复现的故障**能在离线测试里
 *    确定性复现（详见函数注释）。
 * 4. **错误不吞**：读不到的条目进 `errors[]`，跳过的不跟随项进 `skipped[]`，
 *    遍历超界进 `truncated`。三者都不等于"没有"。
 */

import { lstatSync as nodeLstatSync, readdirSync as nodeReaddirSync, realpathSync as nodeRealpathSync } from 'node:fs'
import { join } from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `[官方]` 上游默认暂存上限：64 GiB（见文件头"64 GiB 这个数字的出处"）。
 * 用乘法而不是写死十进制数，是为了让"这是 64 × 1024³"在源码里可见、可复核。
 */
export const UPSTREAM_STAGING_BYTES = 64 * 1024 ** 3

/** `[官方]` 该默认值的出处，供能力报告与审计引用（不参与任何判定） */
export const STAGING_BYTES_SOURCE = {
  marker: '[官方]',
  project: 'NeoAI',
  file: 'lua/NeoAI/default_config.lua',
  line: 'disk_bytes = 64 * 1024 * 1024 * 1024, -- 64 GiB',
  reference: 'docs/NeoAI-沙箱能力分析与差距输入.md §5.2 第 13 条',
}

/** `[推断]` 输出上限：上游无对应项，这里取"足够大但不撑爆捕获缓冲"的值 */
export const OUTPUT_CAP_SOURCE = {
  marker: '[推断]',
  reason: '上游无输出上限对标项；4 MiB / 200000 行为本项目取值，可在构造时覆盖',
}

/**
 * 默认上限（**冻结**：改它必须在源码里改，不能在运行期改）。
 * 三个字段与 `summariseLimits()` 的出口一一对应。
 */
export const DEFAULT_LIMITS = Object.freeze({
  stagingBytes: UPSTREAM_STAGING_BYTES,
  maxOutputBytes: 4 * 1024 * 1024,
  maxOutputLines: 200000,
})

/** `wrapLimits` 认识的键（未知键一律 fail-closed） */
export const LIMIT_KEYS = Object.freeze(['stagingBytes', 'maxOutputBytes', 'maxOutputLines'])

/**
 * `[实测]`（本机 node v24.21.0，Windows；**本轮 danger-full-access 会话**复测）：
 *   · `fs.statSync(os.tmpdir())` ⇒ `mode=0x41b6`、`mode & 0x400 === 0`
 *     （⇒ 这个常量**不是**"目录天生带的位"，旧注释里"tmpdir 给出 0x400"的说法已作废）；
 *   · 对**真重解析点**（junction）的 `lstatSync` 在两种 DSH 文件策略下是**两种形态**
 *     （与 `docs/审批策略never-用户感知一致性-分析与实施清单.md` §6.4 同口径，**证据分层**）：
 *       – `danger-full-access`（本轮会话）：`mode=0xa1b6`、`isSymbolicLink()===true`、
 *         `isDirectory()===false` —— `[实测]` 本轮（本会话探针复现；这是本轮**唯一**可测的一行）；
 *       – `workspace-write`（更早的受限会话）：`mode=0x41b6`、`isSymbolicLink()===false`、
 *         `isDirectory()===true` —— **历史受限会话实测**、`[未实测]` 本轮（本机现不可复现，
 *         本轮只在 `tests/limits.mjs` §4p2/§4p3 里用**注入的盲 / 双盲 `fsImpl`** 模拟它，标 `[注入]`）。
 *     两种形态的 `mode & 0x400` **都是 0** ⇒ "`mode & 0x400`"这条判据在 junction 上
 *     **恒为假**（与 `docs` 里 task-7 的"假判据"同族，详见 `measureTree` 判据 A 的注释）。
 * 保留 0x400 这条 limbs 的理由**不是**本机 junction，而是保守覆盖 Win32 `stat` 扩展字段里
 * 可能出现的**非符号链接重解析点**（挂载点 / OneDrive 占位符 / AppExecLink…）：
 *   `isSymbolicLink()`（POSIX/Windows 通用）**或** `mode & 0x400`（Windows 重解析点）。
 * `[未实测]` 本轮没有"非符号链接重解析点"的样本，因此这一 limbs 只作**保守兜底**，
 * 不主张它在本机有判定力（真正的判定力来自 dirent / `isSymbolicLink()` / 结构性出树校验）。
 */
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400

/**
 * 有界遍历的默认上限：最多访问这么多个**文件系统条目**（文件 + 目录）。
 * 存在理由：配额统计会被集成方放进"写入前"路径，而 `node_modules` 级别的
 * 病态目录树（几十万条目）会把它变成事实上的挂起。超界即 `truncated: true`，
 * 让调用方**知道自己拿到的是下界**，而不是以为拿到了完整账。
 */
export const MAX_TREE_ENTRIES = 200000

/** `[推断]` 硬链接按 inode 去重的容量上限（超过就停止去重并如实标注，绝不无限吃内存） */
const MAX_INODE_TRACK = 500000

/**
 * `formatSize` 的上界：`Number.MAX_SAFE_INTEGER` 附近 `String(n)` 会变成科学计数法
 * （`1e21`），而科学计数法**不是**本模块的合法输入形状 ⇒ `parseSize(formatSize(n))` 会抛，
 * 破坏"格式化/解析互为逆运算"这条硬不变式。
 * 这里取 999 TiB（仍用 `String(n)` 的定点写法），并把更大的输入**显式拒绝**
 * （fail-closed：格式化不了就报错，绝不吐一个自己解不回来的字符串）。
 */
const FORMAT_SIZE_MAX = 999 * 1024 ** 4

/**
 * 测试钩子表（**仅供 `tests\limits.mjs --plant` 使用**，生产运行时永远是全 `false`）。
 *
 * 存在理由：任务要求 `--plant` 能"破坏一条不变式并让 ≥3 项检查变红"，
 * 而这两条不变式（不跟随重解析点 / 硬链接去重）都藏在遍历内部，
 * 无法从外部参数关掉 —— 若为了测试而在**公开 API** 上开洞，就是在生产路径上开洞。
 * 因此把开关放在 `__internal` 里，并让遍历判据**直接读**这个可变表：
 * 测试一改，源码里那两行判据就**真的**失效了（不是"另写一套坏替身"），
 * `--plant` 变红才算对判定力的真证据。公开 API 上不存在这个开关。
 *
 * ⚠ `[实测]` 本轮（`danger-full-access`，改规则后）：`followReparsePoints` 的**唯一**作用
 * 是把判据 C 里的包含性判定 `escaped` 关掉（即"树外也不拒"），于是**树外 junction 会被跟随**；
 * "树内 junction 展开一次"不再由这个钩子控制（新规则下树内一律展开一次）。
 * 于是本机**真实** junction 形态下 §4a/§4b（树外 1 MiB 进账 / 不再记 skipped）也会随
 * `--plant` 变红 —— 变异覆盖不再依赖注入（注入口径的 §4p2/§4p3 仍然保留）。
 */
const HOOK_VALUES = { followReparsePoints: false, disableHardlinkDedupe: false }

// ═══════════════════════════════════════════════════════════════════════════
// 错误类型（"类型化错误"：调用方可以 `instanceof` / 按 `code` 分支）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 上限相关错误。每个实例都带稳定 `code`，便于调用方区分"输入非法"与"运行期失败"：
 *   · `LIMITS_INVALID`        —— `wrapLimits` / 参数校验失败
 *   · `SIZE_PARSE_INVALID`    —— `parseSize` 拿到非法文本
 *   · `OUTPUT_CAP_INVALID`    —— `applyOutputCap` 拿到非法上限
 *   · `MEASURE_TREE_INVALID`  —— `measureTree` 参数非法
 * 消息里**回显原始输入**（截断到 200 字符），因为"到底是哪个参数错了"必须以证据呈现。
 */
export class LimitsError extends Error {
  constructor(message, code = 'LIMITS_INVALID', details = undefined) {
    super(message)
    this.name = 'LimitsError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const clip = (value) => {
  const text = String(value)
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

// ═══════════════════════════════════════════════════════════════════════════
// 体积解析 / 格式化
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 单位表。两套并存（**大小写不敏感**）：
 *   · 二进制：`KiB`/`MiB`/`GiB`/`TiB` = 1024ⁿ（显式写 `i` 的一律按二进制）
 *   · 十进制：`KB`/`MB`/`GB`/`TB`   = 1000ⁿ（SI 口径）
 *   · `B` 与**无后缀**都是字节；`K`/`M`/`G`/`T`（省略 B）与 `Ki`/`Mi`/`Gi`/`Ti`
 *     （省略 B）按**二进制**解释 —— 上游注释里的写法（`64 GiB`）与常见简写都覆盖。
 */
const SIZE_UNITS = new Map([
  ['B', 1],
  ['K', 1024],
  ['KI', 1024],
  ['KB', 1000],
  ['KIB', 1024],
  ['M', 1024 ** 2],
  ['MI', 1024 ** 2],
  ['MB', 1000 ** 2],
  ['MIB', 1024 ** 2],
  ['G', 1024 ** 3],
  ['GI', 1024 ** 3],
  ['GB', 1000 ** 3],
  ['GIB', 1024 ** 3],
  ['T', 1024 ** 4],
  ['TI', 1024 ** 4],
  ['TB', 1000 ** 4],
  ['TIB', 1024 ** 4],
])

/** 内部：安全非负整数校验（NaN / Infinity / 小数 / 负 / 超安全整数 一律抛） */
function assertByteCount(value, label, code) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new LimitsError(`${label} 必须是数字，收到 ${clip(value)}（类型 ${typeof value}）`, code, { value })
  }
  if (!Number.isFinite(value)) {
    throw new LimitsError(`${label} 必须是有限数字，收到 ${clip(value)}`, code, { value })
  }
  if (!Number.isInteger(value)) {
    throw new LimitsError(`${label} 必须是整数（字节），收到 ${clip(value)}`, code, { value })
  }
  if (value < 0) {
    throw new LimitsError(`${label} 不能为负，收到 ${clip(value)}`, code, { value })
  }
  if (!Number.isSafeInteger(value)) {
    throw new LimitsError(`${label} 超出安全整数范围（会静默丢精度），收到 ${clip(value)}`, code, { value })
  }
  return value
}

/**
 * 体积文本 → 字节数。
 *
 * 接受（`[实测]` `tests\limits.mjs` 逐条断言）：
 *   · `'64GiB'` `'512MiB'` `'1MB'` `'2TB'`  → 十进制/二进制单位
 *   · `'1024'` / `1024` / `'1_048_576'`     → 无后缀 = 字节
 *   · 小数 + 整数结果：`'0.5MiB'` = 524288
 *   · 大小写任意：`'64gib'` / `'64GIB'` / `'1 mb'`（允许内部空白）
 *   · 下划线分隔（JS 数字字面量习惯，便于人读 `1_048_576`）
 *   · `{ bytes }` 包装对象（便于从配置对象直接取值）
 *
 * 拒绝（一律 `LimitsError('SIZE_PARSE_INVALID')`，**绝不返回 NaN**）：
 *   · 空串 / 纯空白 / `null` / `undefined` / 对象 / 布尔
 *   · `'64ZiB'`（未知单位）、`'64 GiB x'`（尾随垃圾）
 *   · 负数、`Infinity`、`NaN`
 *   · 非整数结果：`'10.5'`（避免"半个字节"进入配额运算）
 *   · 超出 `Number.MAX_SAFE_INTEGER`
 */
export function parseSize(text) {
  if (typeof text === 'number') return assertByteCount(text, 'parseSize(number)', 'SIZE_PARSE_INVALID')
  if (text !== null && typeof text === 'object') {
    if ('bytes' in text) return parseSize(text.bytes)
    throw new LimitsError(`parseSize 收到不支持的对象（缺 bytes 字段）：${clip(JSON.stringify(text))}`, 'SIZE_PARSE_INVALID', { text })
  }
  if (typeof text !== 'string') {
    throw new LimitsError(`parseSize 需要字符串或数字，收到 ${clip(text)}（类型 ${typeof text}）`, 'SIZE_PARSE_INVALID', { text })
  }

  const raw = text.trim()
  if (raw.length === 0) {
    throw new LimitsError('parseSize 收到空字符串', 'SIZE_PARSE_INVALID', { text })
  }
  // 去下划线（`1_048_576`），但保留首个字符用于后续符号判断
  const cleaned = raw.replace(/_/g, '')
  // ⚠ 符号位**刻意只要 `-` 不要 `+`**：`'+1GiB'` 这类"带正号的体积"在本模块看来是
  //   需要人复核的异常输入（配置里出现正号通常意味着这个值是从别处拼出来的），
  //   fail-closed 拒掉比"猜他想写 1GiB"安全。`'-1GiB'` 也必须进下面的负值分支。
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-z]*)$/i.exec(cleaned)
  if (!match) {
    throw new LimitsError(`parseSize 无法解析：${clip(text)}（形状应为 <数字><单位?>，如 64GiB / 512MiB / 1024）`, 'SIZE_PARSE_INVALID', { text })
  }
  const [, numberText, unitText] = match
  const suffix = unitText.toUpperCase()
  // 无后缀 = 字节（`'1024'` / `1024` 都是 1024 字节，**不是** 1024 KiB ——
  // 这一点必须明确：把裸数字当 KiB 会让"限额 1024"静默变成 1 MiB）。
  const unit = suffix.length === 0 ? 1 : SIZE_UNITS.get(suffix)
  if (unit === undefined) {
    throw new LimitsError(
      `parseSize 不认识的单位 "${clip(unitText)}"（支持 B/KB/MB/GB/TB、KiB/MiB/GiB/TiB，以及 KB 的简写 K/M/G/T 与 KiB 的简写 Ki/Mi/Gi/Ti；无后缀=字节）`,
      'SIZE_PARSE_INVALID',
      { text, unit: unitText },
    )
  }
  const magnitude = Number(numberText)
  if (!Number.isFinite(magnitude)) {
    throw new LimitsError(`parseSize 数字部分非法：${clip(text)}`, 'SIZE_PARSE_INVALID', { text })
  }
  if (magnitude < 0) {
    throw new LimitsError(`parseSize 不接受负数：${clip(text)}`, 'SIZE_PARSE_INVALID', { text })
  }
  const bytes = magnitude * unit
  if (!Number.isFinite(bytes)) {
    throw new LimitsError(`parseSize 结果溢出：${clip(text)}`, 'SIZE_PARSE_INVALID', { text })
  }
  if (!Number.isInteger(bytes)) {
    throw new LimitsError(
      `parseSize 结果是小数（${clip(text)} = ${bytes} 字节）：上限必须是整数字节，避免半字节进入配额运算`,
      'SIZE_PARSE_INVALID',
      { text, bytes },
    )
  }
  return assertByteCount(bytes, `parseSize("${clip(text)}")`, 'SIZE_PARSE_INVALID')
}

/**
 * 字节数 → 人读字符串。
 *
 * 规则（**保持不变式 `parseSize(formatSize(n)) === n`**）：
 *   1. 取**能整除** `bytes` 的最大二进制单位（`GiB` > `MiB` > `KiB` > `B`），输出整数；
 *   2. 没有任何 ≥ 1 KiB 的单位能整除 ⇒ 回退成十进制定点（例如 `1536` → `'1.5KiB'`），
 *      因为"1.5KiB"仍然精确可解析回 1536；
 *   3. 全都不适用（理论上不会发生，因为 B 总能输出整数）⇒ 输出 `'<n>B'`。
 * 输出**只用 ASCII**（项目反复被非 ASCII 标记坑过），且用显式二进制单位，避免 SI/二进制歧义。
 */
export function formatSize(bytes) {
  const value = assertByteCount(bytes, 'formatSize(bytes)', 'LIMITS_INVALID')
  if (value > FORMAT_SIZE_MAX) {
    throw new LimitsError(
      `formatSize 收到 ${value} 字节（> ${FORMAT_SIZE_MAX}）：再大就只能用科学计数法表示，而那种字符串本模块无法解析回去，故拒绝`,
      'LIMITS_INVALID',
      { bytes: value, max: FORMAT_SIZE_MAX },
    )
  }
  const units = [
    ['TiB', 1024 ** 4],
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
    ['B', 1],
  ]
  // ① 优先"能整除的最大单位"，输出整数（`64GiB` 而不是 `64.0GiB`）。
  //    ⚠ **跳过 `B`**：`value % 1 === 0` 恒真，若把 B 放在这一轮里，
  //    任何非整 KiB 的值都会立刻返回 `'<n>B'`，第 ② 轮的定点小数**永远轮不到**
  //    （本套件当场抓到过这个形态：`1536` 输出 `'1536B'` 而不是 `'1.5KiB'`）。
  for (const [suffix, unit] of units) {
    if (suffix === 'B') continue
    if (value % unit === 0) return `${value / unit}${suffix}`
  }
  // ② 没有整除单位时取**最大的 `value >= unit`**，用定点小数表示（`1536` → `1.5KiB`）。
  //    ⚠ 这里**不假设** `toFixed` 一定精确：二进制浮点下 `1025 / 1024 = 1.0009765625`
  //    定点到 6 位会变成 `1.000977`，回解析成 1025.000448 ⇒ 破坏硬不变式。
  //    因此每个候选串都**当场回解析验证**（`parseSize(text) === value`），
  //    验证不过就落到更小的单位；`B` 分支永远是整数，必然能过 —— 函数一定终止。
  //    这条"生成即验证"的写法比"证明 toFixed 精确"的推理更可靠：它把不变式变成断言。
  for (const [suffix, unit] of units) {
    if (suffix === 'B') continue
    if (value < unit) continue
    const scaled = value / unit
    if (scaled * 1e6 >= 1e15) continue // 定点会丢低位，直接跳过
    const text = Number.isInteger(scaled) ? String(scaled) : String(Number(scaled.toFixed(6)))
    const candidate = `${text}${suffix}`
    try {
      if (parseSize(candidate) === value) return candidate
    } catch {
      // 候选串自己都解析不了（理论上不会发生）⇒ 落到更小单位
    }
  }
  return `${value}B`
}

/** GiB 换算（只用于报告；不做四舍五入，保留原始精度由调用方决定） */
export function toGiB(bytes) {
  return assertByteCount(bytes, 'toGiB(bytes)', 'LIMITS_INVALID') / 1024 ** 3
}

// ═══════════════════════════════════════════════════════════════════════════
// 重解析点判据（**唯一入口**：全模块只在这里判断"该不该跟随"）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 该 `lstat` 结果是不是**重解析点**（符号链接 / junction / 挂载点 / OneDrive 占位符…）。
 *
 * ── 为什么不用 `src\paths.mjs` 的既有导出（如实说明）──────────────────────────
 * 任务要求"优先复用项目既有重解析点守卫"。我读完了 `src\paths.mjs`（692 行）：
 * 它导出的是**路径级**能力 —— `canonical()`（`realpathSync.native`，会**解析**链接）、
 * `isInside()`、`relativeTo()`、`maskKey()`、`exportMaskList()` 等 ——
 * **没有**可以复用的"这个 dirent 是不是重解析点"的逐条判据
 * （`canonical()` 的语义正相反：它主动跟随链接；而 `maskKey()` 的用途是遮蔽匹配，
 * 拿它当遍历判据既不对口径也会引入不需要的 realpath 成本）。
 * 全仓 `grep` 确认：`src\workspace.mjs` 与 `src\store.mjs` 里的重解析点判断
 * 都是各自内联写的（`store.mjs:151` 用 `isSymbolicLink()`）。
 * 因此这里按任务允许的退路**本地实现**，并且**只此一处**，避免同一件事两套判据。
 *
 * 判据：`isSymbolicLink()`（跨平台）**或** `mode & FILE_ATTRIBUTE_REPARSE_POINT`（Windows）。
 * 语义是**保守**的：只要有一丝可能是重解析点就返回 `true`（宁可少统计，不可越界统计）。
 */
export function isReparsePoint(info) {
  if (!info || typeof info !== 'object') return false
  try {
    if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return true
  } catch {
    // 判据本身抛错时按"是重解析点"处理（保守方向）
    return true
  }
  return (info.mode & FILE_ATTRIBUTE_REPARSE_POINT) === FILE_ATTRIBUTE_REPARSE_POINT
}

/**
 * `measureTree` **内部**使用的判据 = `isReparsePoint` + 测试钩子。
 *
 * 为什么要把"带钩子的判据"与公开的 `isReparsePoint` 分成两个函数：
 * `tests\limits.mjs --plant` 需要把"不跟随重解析点"这条不变式**真的**关掉，
 * 但**绝不能**因此让生产调用方拿到一个"可以跟随链接"的开关 ——
 * 公开 API 上不存在的洞，就不需要靠纪律去守。
 */
function isReparseEntry(info) {
  if (HOOK_VALUES.followReparsePoints) return false
  return isReparsePoint(info)
}

/** 重解析点分类（**仅供诊断/报告**，不参与任何放行判定） */
export function reparsePointKind(info) {
  if (!isReparsePoint(info)) return undefined
  if (info.isSymbolicLink && info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory && info.isDirectory()) return 'reparse-directory'
  if (info.isFile && info.isFile()) return 'reparse-file'
  return 'reparse'
}

/** 内部：把任意异常规范化成可序列化的一条记录（**绝不吞掉 code**） */
function errorRecord(path, error) {
  return {
    path,
    code: error && error.code ? String(error.code) : 'ERR_UNKNOWN',
    message: error && error.message ? String(error.message) : String(error),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 目录树统计（只读，绝不跟随重解析点）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统计一棵树的占用：`{ bytes, files, dirs, skipped, errors, truncated }`。
 *
 * ── `skipped` 与 `errors` 的区别（很重要，别混读）────────────────────────────
 *   · `skipped[]`：**按设计**没跟随的条目（树外链接 / 非目录链接 / 已展开过的目录环）——
 *     这是**正确行为**的证据，不是故障。每条形如 `{ path, kind, reason }`；出树链接的 reason 是
 *     `realpath-outside-tree*`，非目录链接（含**宿主 `lstat` 看得见 junction** 形态下的**文件**
 *     符号链接，见判据 A 注释）的 reason 是 `reparse-point-not-followed`，
 *     重复目录（自指/互指/菱形）的 reason 是 `already-visited-cycle`。
 *     ⚠ **调用方不许把具体 reason 当契约**（它可能随宿主/文件策略变化）：`skipped` 的语义是
 *     "这个条目没被跟随"，两种形态都安全；要判"是否出树"请只看 `realpath-outside-tree*`。
 *     `[实测]` 本轮（`danger-full-access`）in-tree 目录 junction 已**稳定**走
 *     `already-visited-cycle`（不再是 `reparse-point-not-followed`），但断言仍应以不变式为准。
 *   · `errors[]`：**出了故障**的条目（不存在 / 不可读 / 遍历中被删除 / 超界）——
 *     每条形如 `{ path, code, message }`。**本函数永不因这些抛错**，
 *     调用方必须自己决定"有 errors 时还信不信这个账"（`checkStagingQuota` 的做法见其注释）。
 *   · `truncated: true`：遍历触到 `maxEntries` 上界**提前结束** ⇒ `bytes` 是**下界**，
 *     不是完整账。集成方遇到 `truncated` 时应当**fail-closed**（按已用=配额处理），
 *     否则一个"条目数炸弹"就能绕过配额。
 *     ⚠ 环**不是**截断：自指 junction 由 `visitedDirs` 环检测收住（每个真实目录只展开一次），
 *     因此"只有 2 个条目的树"不会因为链接自环而 `truncated`（D1 修复的正是这一点）。
 *
 * ── 重解析点的最终规则：**只拒树外，树内"展开且只展开一次"**（硬不变式 #3 的当前口径）──
 * 暂存树里出现 junction 有两种来源：① 受限进程自己造（越界写的前置动作）；
 * ② 用户工作区本来就有的链接。**树外**目标跟随一定得到错误结论：
 * 指向外部大树时配额假爆表（合法写入被拒），指向外部小目录时把外部字节算进沙箱账。
 * 因此本函数的规则是：
 *   · 解析后**出树** ⇒ 链接自身与目标字节都不计，记一条 `skipped{reason:'realpath-outside-tree*'}`；
 *   · 解析后**在树内**且目标是目录 ⇒ 跟随，但**每个真实目录只展开一次**（`visitedDirs`），
 *     重复命中记 `skipped{reason:'already-visited-cycle'}`（自指/互指/菱形 alias 都终止）；
 *   · 解析后是**非目录**（文件符号链接等）⇒ 记 `reparse-point-not-followed`，目标字节不按链接计。
 * `[实测]` 本机（`danger-full-access`，node v24.21.0）两种 in-tree 现场都终止且只展开一次：
 * 自指（`self -> 树自身`）与互指（`a->b`、`b->a`）都记 `already-visited-cycle`；
 * 历史 `workspace-write` 形态（lstat 穿透 junction）在新规则下**结局一致**。
 * 该口径下"每个真实目录只展开一次"才是真正阻止 D1 重扫的性质（reason 字符串只是账目）。
 *
 * ── 硬链接按 inode 去重（任务要求"能去重就去重"）──────────────────────────────
 * `[实测]`（本机 node v24.21.0 / Windows）`lstatSync` 的 `ino`/`dev` 是**真实数值**
 * （`dev=2489330908`），因此同一份数据被 `link()` 成多个名字时只算一次。
 * 去重表有上限（`MAX_INODE_TRACK`）：超过就停止去重并在 `notes[]` 里如实标注
 * —— 宁可重复计数，不可无限吃内存（且重复计数是**保守方向**，只会更早拒绝）。
 * POSIX 上 `ino === 0` 表示"文件系统不给 inode"（少数虚拟 FS），此时退化为不去重。
 *
 * ── 可注入点（为"难复现故障"的确定性测试而设，不是给生产用的）────────────────
 *   · `fsImpl`：`{ lstatSync, readdirSync, realpathSync }` 覆盖实现。
 *   · `onStat(info, fullPath, index)`：每次 `lstatSync` **成功之后**回调。
 *     测试用它做两件真实故障：① 统计中途删掉后面的条目（→ 下一次 lstat 报 ENOENT，
 *     必须进 `errors` 而不是抛）；② 让某个路径的**后续**读取失败。
 *     `onStat` 自身抛错会被记成 `errors`（不吞）。生产不传即可。
 *
 * @param {string} root 目录或文件路径（文件也能量：`bytes` = 该文件大小）
 * @param {{guard?:Function, maxEntries?:number, fsImpl?:object, onStat?:Function}} [options]
 *   · `guard(info, path)`：调用方**加严**判据（返回 true = 当作链接、不跟随）。它**不能**
 *     削弱 `measureTree` 自身的"解析后不得出树"闭合校验（见下方合并逻辑的注释）。
 */
export function measureTree(root, options = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new LimitsError(`measureTree 需要非空路径字符串，收到 ${clip(root)}`, 'MEASURE_TREE_INVALID', { root })
  }
  const {
    guard, // 可选：调用方注入自己的"该不该跟随"判据（任务签名允许）；返回 true = 是重解析点
    maxEntries = MAX_TREE_ENTRIES,
    fsImpl,
    onStat,
  } = options
  if (guard !== undefined && typeof guard !== 'function') {
    throw new LimitsError(`measureTree 的 guard 必须是函数，收到 ${typeof guard}`, 'MEASURE_TREE_INVALID', { guard: typeof guard })
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new LimitsError(`measureTree 的 maxEntries 必须 ≥1 的正整数，收到 ${clip(maxEntries)}`, 'MEASURE_TREE_INVALID', { maxEntries })
  }
  if (onStat !== undefined && typeof onStat !== 'function') {
    throw new LimitsError(`measureTree 的 onStat 必须是函数，收到 ${typeof onStat}`, 'MEASURE_TREE_INVALID', { onStat: typeof onStat })
  }

  const fs = {
    lstatSync: (fsImpl && fsImpl.lstatSync) || nodeLstatSync,
    readdirSync: (fsImpl && fsImpl.readdirSync) || nodeReaddirSync,
    // ⚠ 必须用 **`.native`**：`[实测]` 本机 node v24.21.0，
    //   `fs.realpathSync(<tree>\junc)` 返回的是 **junction 自身**（还带 8.3 短名
    //   `...\ADMINI~1\...`），**不解析到目标**；而 `fs.realpathSync.native(<tree>\junc)`
    //   返回目标的**长名**真实路径 ⇒ 逃逸闭合校验只能建立在 `.native` 上。
    //   （这与 `src\paths.mjs::canonical()` 的选择一致：那里用的也是 `realpathSync.native`，
    //     理由写在它的文件头：JS 层解析不了 junction。）
    realpathSync: (fsImpl && fsImpl.realpathSync) || nodeRealpathSync.native || nodeRealpathSync,
  }

  const report = { bytes: 0, files: 0, dirs: 0, entries: 0, skipped: [], errors: [], notes: [], truncated: false }
  const seenInodes = new Set()
  let dedupeDisabled = false

  /**
   * 该条目该不该跟随？`guard` 优先（调用方口径），否则用本模块判据。
   *
   * `guard(info, path)` 的第二个参数是**条目路径**：`info` 只是一个 `lstat` 快照，
   * 而它是否"看得见"junction 依**宿主 / DSH 文件策略**而变（见遍历里判据 A 的实测注释：
   * `workspace-write` 形态看不见、`danger-full-access` 形态看得见），因此调用方按路径
   * 自己再查一次（例如用 `src\paths.mjs::canonical()` 或自己读父目录的 Dirent）
   * 是**两种形态下都可靠**的加严手段。判据抛错 ⇒ 按"是链接"处理（保守）。
   */
  const shouldSkip = (info, path) => {
    if (guard) {
      try {
        return guard(info, path) === true
      } catch {
        return true // 判据抛错 ⇒ 按"是链接"处理（保守）
      }
    }
    return isReparseEntry(info)
  }

  // 根自身先量一次：不存在就只记一条 error 并返回（**不抛**）
  let rootInfo
  try {
    rootInfo = fs.lstatSync(root)
  } catch (error) {
    report.errors.push(errorRecord(root, error))
    return report
  }
  if (onStat) {
    try {
      onStat(rootInfo, root, report.entries)
    } catch (error) {
      report.errors.push(errorRecord(root, error))
    }
  }
  report.entries += 1
  if (shouldSkip(rootInfo, root)) {
    report.skipped.push({ path: root, kind: 'root', reason: 'root-is-reparse-point' })
    report.truncated = report.entries >= maxEntries
    return report
  }
  if (!rootInfo.isDirectory()) {
    if (rootInfo.isFile()) {
      report.files += 1
      report.bytes += rootInfo.size
    }
    return report
  }
  let realRoot = root
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    realRoot = root // 解析失败不阻断统计（我们本来就不跟随链接）
  }
  report.dirs += 1

  // ── 环检测：**每个真实目录只展开一次**（D1 修复）──────────────────────────────
  // `[实测]`（本机 node v24.21.0 / Windows，2025 本轮修复会话）：只有 1 个 1 字节文件
  // 的树里放一个**指向树自身**的目录 junction（`symlinkSync(base, base + '/loop', 'junction')`），
  // 旧代码把解析后的同一目录反复入栈 ⇒ 生产默认 `maxEntries=200000` 下
  // `entries=200000`（`files=100000`/`dirs=100000`）、耗时 **22033 ms**、`truncated=true`、
  // `errors=[MEASURE_TREE_BOUND]`；`checkStagingQuota` 因此 `complete:false`，
  // `Store.putBlob` / `executor.assertStagingQuota` 抛 `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`
  // ⇒ **该工作区永久无法暂存写入**，且每次判定先烧 22 秒。
  //
  // 判定口径：入栈前把 `resolved`（`realpathSync.native` 的产物）按**小写 + 去尾分隔符**
  // 归一成 key；命中即说明这个真实目录已经展开过（自环、互指环、菱形重复），
  // **记一条 `skipped`（`reason:'already-visited-cycle'`）后跳过**，不重复计字节。
  // `[实测]` 本轮（`danger-full-access`）这条分支**重新有活路径**（不再是死代码）：
  // 自指 junction 的 `lstat` 是 `isSymbolicLink()=true`/`isDirectory()=false`，
  // 但新规则（见判据 C 段落）对**树内**目标一律"展开且只展开一次" ⇒
  // `self -> 树自身` 解析出的真实路径与根同 key，**当场命中本分支**并记
  // `already-visited-cycle`（真实宿主断言见 `tests\limits.mjs` §4v/§4x，
  // 另有注入盲形态的 §4v2 证明它对宿主形态不敏感）。
  // 历史口径（如实保留）：**旧**规则下这条分支在 `danger-full-access` 形态确实到不了
  //（junction 先被"非目录链接"分支拒掉，记 `reparse-point-not-followed`），
  // 那时"每个真实目录只展开一次"由"非目录链接不入栈"这条旁路保证 —— 但那同时
  // 让 in-tree alias **完全不进账**、并把本分支变成死代码，故本轮改规则。
  // 本判据是**加严**方向：它只减少遍历，不改变"树外链接绝不跟随"（判据 C 先执行）
  // 与"guard 只能加严"这两条硬不变式。
  // 副作用（如实声明）：树内**别名**链接（`link -> inner`，两者都在树内）只展开一次，
  // 于是 `files` 计 1 而不是 2（字节数不变 —— inode 去重本来就不会重复计字节）。
  const visitedDirs = new Set()
  /** 目录 key：小写 + 去掉尾部分隔符（与 `isWithin` 同口径，NTFS 大小写不敏感） */
  const dirKey = (value) => String(value).toLowerCase().replace(/[\\/]+$/, '')
  visitedDirs.add(dirKey(realRoot))

  /**
   * 内部：**解析后的真实路径**是不是目录 —— 新规则里"树内重解析点要不要展开"的唯一依据。
   *
   * 判据 A（`dirent.isSymbolicLink()` / `lstat.isSymbolicLink()`）只回答"**这个条目是不是链接**"，
   * **不回答目标类型**；`danger-full-access` 形态下 `info.isDirectory()` 对 junction 为 `false`，
   * 所以必须对 `realpathSync` 的产物再判一次目录（`[实测]` 本机
   * `lstat(realpath.native(<tree>\junc)).isDirectory()===true`）。
   * 判据抛错/目标读不到 ⇒ 返回 false（**不跟随**，保守方向），并把故障记进 `errors[]`
   * ——绝不因为"判不出来"就把一个可能出树的目标入栈。
   */
  const resolvedTargetIsDirectory = (target) => {
    if (typeof target !== 'string' || target.length === 0) return false
    try {
      return fs.lstatSync(target).isDirectory() === true
    } catch (error) {
      report.errors.push(errorRecord(target, error))
      return false
    }
  }

  // ── 显式栈 DFS（不用 `readdirSync({recursive:true})`：那条路径无法逐条拦截重解析点，
  //    也无处插入 onStat / 上界检查）。栈元素 = `{ path, parent }`，
  //    `parent` 是"**打开前**看到的路径"，用于在打开后做真实路径闭合校验（见下）。──────
  const stack = [{ path: root, parent: root }]
  /**
   * `hitBound`：本次遍历是否**因为上界而提前结束**。
   *
   * ⚠ 必须用这个显式标志，不能在循环结束后用 `stack.length > 0` 之类的外部状态推断 ——
   * `[实测]`（本套件 §4l 当场抓到）：`maxEntries` 恰好卡在**最后一个目录的最后一条目**上时，
   * 内层 `break` 之后 `stack` 已经是空的，于是"以 `stack.length > 0` 为条件的记账"**不会执行**，
   * `truncated` 停在第 1 层检查上、`MEASURE_TREE_BOUND` 一条都不记。
   * 后果正是最危险的那一种：调用方以为拿到的是完整账（实际是下界）。
   */
  let hitBound = false
  scan: while (stack.length > 0) {
    if (report.entries >= maxEntries) {
      hitBound = true
      break scan
    }
    const frame = stack.pop()
    const current = frame.path
    let dirents
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      report.errors.push(errorRecord(current, error))
      continue
    }
    // 排序：让"截断发生在哪个条目"在同样输入下**可复现**（否则上层测试会飘）
    dirents = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      // ── 上界**在处理本条目之前**检查（唯一入口）──────────────────────────────
      // 位置很关键：`entries` 是"已开始处理的条目数"，如果把它放在条目末尾，
      // 那么"正好用完最后一条"的情况下循环会自然结束、`stack` 已空，
      // 外层 `while` 的上界记账**不会执行** ⇒ `truncated=false`（§4l 当场抓到）。
      // 放在条目开头，则"达到上界"一定是从这里 `break scan` 出去的，
      // 且当前条目**尚未被算入** ⇒ `entries === maxEntries` 恰好等于"处理了这么多条"。
      if (report.entries >= maxEntries) {
        hitBound = true
        break scan
      }
      const full = join(current, dirent.name)
      const index = report.entries
      report.entries += 1

      // ── 判据 A（**Windows 上唯一有效的那一条**）───────────────────────────────
      // ⚠ `[实测]` 本机 node v24.21.0：**同一台机器**上 junction 的 `lstatSync` 形态是
      //   **宿主 / DSH 文件策略相关**的 —— 两种形态都观测到过，且本函数在两种形态下都安全：
      //     · `workspace-write` 文件策略（更早的受限会话）：`mode=0x41b6`（**没有** 0x400 重解析位）、
      //       `isSymbolicLink()===false`、`isDirectory()===true`、`ino` 与目标目录**完全相同**，
      //       目标删掉后 lstat 直接 ENOENT —— 即 `lstatSync` **穿透 junction**，
      //       "`mode & 0x400`"与"`lstat().isSymbolicLink()`"这两条常见判据在 junction 上**都是死的**
      //       （本项目 `workspace.mjs` 的 task-7 教训同族：判据凭记忆写、从未生效）；
      //     · `danger-full-access` 文件策略（本轮）：`mode=0xa1b6`、`isSymbolicLink()===true`、
      //       `isDirectory()===false` —— lstat **看得见** junction。
      //   两种形态下都恒真的是：`mode & 0x400 === 0`（Node 的 `Stats.mode` 是 POSIX 位，
      //   不携带 Win32 重解析属性 ⇒ 这条判据**永远为假**）。
      //   唯一可靠的来源是**父目录 readdir 的 `Dirent`**：
      // `[实测]` 同一次 `readdirSync(tmp,{withFileTypes:true})` 里 junction 的
      // `isSymbolicLink()===true`、`isDirectory()===false`（两种文件策略下都一样）。
      // 因此本函数**一律**用 `withFileTypes: true` 并按 Dirent 判定，再看 lstat。
      // ⚠ 判据 A 的**用途边界**（本轮改规则后）：它只负责"这个条目**是不是链接**"，
      //   **不**决定"要不要跟随" —— 跟随与否交给判据 C 段落（包含性 + 每个真实目录一次）。
      //   历史缺陷形态（已修）：旧规则让 `danger-full-access` 下 `isDirectory()===false` 的
      //   in-tree junction 全部**不被展开**（覆盖面损失，见 `tests\limits.mjs` §4x2 的
      //   "每个真实目录只展开一次"不变式与 §4v2 的注入盲形态对照）。
      let kind
      try {
        if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) kind = 'symlink'
      } catch {
        kind = 'dirent-error'
      }

      let info
      let statOk = false
      try {
        info = fs.lstatSync(full)
        statOk = true
      } catch (error) {
        // 关键：遍历中条目被删除/无权限 ⇒ 记录并继续，**绝不抛**
        report.errors.push(errorRecord(full, error))
      }
      // onStat 只在 lstat **成功之后**回调：这样测试可以借它做
      // "统计到一半，后面的条目被删掉"这种真实故障（下一次 lstat 就会 ENOENT）。
      if (statOk && onStat) {
        try {
          onStat(info, full, index)
        } catch (error) {
          report.errors.push(errorRecord(full, error))
        }
      }
      if (!statOk) {
        if (report.entries >= maxEntries) break
        continue
      }

      // ── 判据 B：`guard`（调用方口径）或本模块的 `lstat` 判据（POSIX/其它重解析点）──
      const guardSaysLink = shouldSkip(info, full)
      if (kind === undefined && guardSaysLink) kind = reparsePointKind(info) || 'other'

      if (kind !== undefined || !info.isFile()) {
        // ── 不是普通文件 ⇒ 走"包含性优先"的最终规则（本轮改写，取代旧的"拒绝一切重解析点"）──
        // 最终规则（本段是唯一实现）：
        //   ① **包含性优先（安全关键，不变）**：`realpathSync` 解析后若落在 `realRoot` **之外**
        //      ⇒ 绝不跟随、绝不计数，记 `realpath-outside-tree*`（树外字节永远不进账）；
        //   ② **树内目标**：解析后若在 `realRoot` **之内** ⇒ 跟随，但**每个真实目录只展开一次**
        //      （`visitedDirs`，key 为解析后真实路径的小写归一）；重复命中记
        //      `already-visited-cycle` ⇒ **自指/互指/菱形 alias 都终止且只展开一次**；
        //   ③ 解析后是**非目录**（文件符号链接等）⇒ 仍旧记 `reparse-point-not-followed`，
        //      **不**把目标文件字节按链接自身算（目标在树内时会经其真实名字计一次，不重复）。
        //
        // 为什么这样比"拒绝一切重解析点"更好：旧规则在 `danger-full-access` 形态下
        // 让 `info.isDirectory()===false` 的 in-tree junction **一个都不展开**（in-tree alias
        // 完全不进账），而且把 D1 的 `visitedDirs` 环检测分支变成**没有活路径的死代码**。
        // 新规则把"拒谁"精确定义成**树外**，树内改为"展开且只展开一次"，于是
        // **无论 `lstat`/`dirent` 看不看得见重解析点**，语义都一样。
        //
        // `[实测]` 本机本轮探针（`danger-full-access`，node v24.21.0；探针文件跑完即删）：
        //   `lstat(树\self)`：`mode=0xa1b6`、`isSymbolicLink()=true`、`isDirectory()=false`、`isFile()=false`；
        //   `dirent(self)`：`isSymbolicLink()=true`；`realpath.native(树\self)` = 树的真实长名；
        //   `lstat(该真实路径).isDirectory()=true` ⇒ ②的"目标是不是目录"在**看得见**的形态下
        //   必须靠"对解析后真实路径再判一次目录"，而不是 `info.isDirectory()`（后者为 false）。
        // `[实测]`（更早的 `workspace-write` 受限会话，历史口径）：同一台机器同一种建法，
        //   `lstat` 给出 `mode=0x41b6`、`isSymbolicLink()=false`、`isDirectory()=true`（lstat 穿透
        //   junction）⇒ 那时 ② 直接走 `info.isDirectory()`。两种形态在本规则下**结局一致**。
        //
        // ── 把 `guard`（调用方口径）与判据 C（结构性闭合校验）**合并**，且都只往"更不跟随"方向使劲 ──
        // `[实测]`：`guard` 收到的 `info` 来自 `lstatSync`，而它是否"看得见"junction 是
        // **宿主 / DSH 文件策略相关**的（同一台机器两种形态都观测到过，见判据 A 的注释）：
        //   · `workspace-write`（更早的受限会话）：`isSymbolicLink()===false`、`mode=0x41b6` 无 0x400 位
        //     ⇒ "调用方自己写一条 `info.isSymbolicLink()` 当 guard"**根本拦不住 junction**；
        //   · `danger-full-access`（本轮）：`isSymbolicLink()===true` ⇒ 这种 guard 能命中。
        // 因此这里**不依赖** guard 的形态：绝不把判据 C 交给 guard 去否决 ——
        // **结构性的"解析后是否出树"永远要算**，guard 只能**追加**"这个也算链接"。
        // 这样"注入 guard"这个接口是**加严**方向的安全阀，而不是能关掉逃逸判定的后门
        //（否则调用方传一个漏判的 guard 就等于关掉了硬不变式 #3）。
        // `tests\limits.mjs` §4p/§4p2 在**两种形态下**都钉这条：漏判 guard 不许放行，
        // 而注入"盲 lstat"（模拟 workspace-write 形态）后判据 C 必须**独自**拒掉树外 junction。
        //
        // 判据 C 的要求：解析后必须仍在 `realRoot` 之内（小写比较 + 分隔符边界，
        // 与 `src\paths.mjs::isInside()` 同口径）。`[实测]` 本机：
        // `realpathSync.native(<tree>\escape)` 返回**外部真实目录**，而 `realpathSync.native(<tree>)`
        // 返回树根 ⇒ 判据 C 能抓住这类逃逸。
        // 计数口径：**先判定逃逸、再给 `dirs` 加一** —— 绝不允许"数了却不算"
        //（dirs 与入栈必须同增同减，否则报告的目录数与实际遍历面不符）。
        let resolved = full
        try {
          resolved = fs.realpathSync(full)
        } catch {
          resolved = full // 解析失败不阻断统计（本来就不跟随链接）
        }
        const escaped = !HOOK_VALUES.followReparsePoints && !isWithin(realRoot, resolved)
        const shouldNotFollow = escaped || (Boolean(guard) && guardSaysLink)
        if (shouldNotFollow) {
          report.skipped.push({
            path: full,
            kind: kind === undefined ? (escaped ? 'realpath-escape' : 'guard-says-link') : `${kind}${escaped ? '+realpath-escape' : ''}`,
            reason: escaped
              ? resolved === full
                ? 'realpath-outside-tree'
                : `realpath-outside-tree:${resolved}`
              : 'guard-reparse-point-not-followed',
          })
          // ⚠ **不要**在这里把 `frame.parent` 入栈 —— 那等于"再扫一遍父目录"，
          // 父目录里的同一个链接又会被读到 ⇒ **无限递归**直到撞上 `maxEntries`
          // （本套件 §4c 当场抓到：`errors` 里出现 MEASURE_TREE_BOUND，
          //  而正确结果应当是"这个目录被跳过、一条 error 都没有"）。
          // 语义上"跳过一条目录"= 不进它的子树，仅此而已；`report.dirs` 保持**外层文件夹**口径
          // （`dirs` 只统计真正被扫描的目录），与 `skipped[]` 的条数一起构成可复核的账。
        } else {
          // 解析后的目标是不是**目录**？这决定"入栈展开"还是"记为未跟随的链接"：
          //   · 普通目录：`info.isDirectory()` 在**两种**宿主形态下都为真 ⇒ 不必再 stat；
          //   · 树内重解析点：`dirent` 只说"它是链接"，**不说目标类型** ⇒ 必须判解析后的
          //     真实路径（`[实测]` 本机 `lstat(realpath.native(junction)).isDirectory()===true`）。
          const targetIsDirectory = info.isDirectory() || resolvedTargetIsDirectory(resolved)
          if (targetIsDirectory) {
            // ── 环检测（D1）：解析后的真实目录若**已经展开过**，就不再入栈 ──────────────
            // `[实测]` 本轮 `danger-full-access` 形态下这条路**重新有活路径**：
            // 自指 junction（`self -> 树自身`）解析后与根的真实路径同 key ⇒ 命中本分支。
            // 三种环形态都靠这一条收住：① 自指（`loop -> 树自身`）；
            // ② 互指（`a -> b` 且 `b -> a`）；③ 菱形重复（多个链接指向同一真实目录）。
            // 记一条 `skipped`（这是"按设计没跟随"，不是故障）并留一条 `notes` 证据。
            // 关键：**先记后跳、不入栈** —— 入栈才会重扫，重扫才是指数/无限。
            const key = dirKey(resolved)
            if (visitedDirs.has(key)) {
              report.skipped.push({
                path: full,
                kind: kind === undefined ? 'directory-cycle' : `${kind}+cycle`,
                reason: 'already-visited-cycle',
              })
              report.notes.push({ path: full, kind: 'cycle-skipped', target: resolved })
            } else {
              visitedDirs.add(key)
              report.dirs += 1
              stack.push({ path: resolved === full ? full : resolved, parent: full })
            }
          } else if (kind !== undefined) {
            // 非目录的链接（文件符号链接等）：记 skipped，**不**把目标文件字节计入
            report.skipped.push({ path: full, kind, reason: 'reparse-point-not-followed' })
          }
        }
        // 其他类型（FIFO/设备/socket）：不计字节，也不报错 —— 它们不是"故障"
      } else {
        const key = typeof info.ino === 'number' && info.ino !== 0 ? `${info.dev}:${info.ino}` : undefined
        if (key !== undefined && !dedupeDisabled && !HOOK_VALUES.disableHardlinkDedupe) {
          if (seenInodes.has(key)) {
            // 同一 inode 的第二个名字：**不重复计字节**，但条目/文件数照计
            report.files += 1
            report.notes.push({ path: full, kind: 'hardlink-dedup', inode: key })
          } else {
            if (seenInodes.size >= MAX_INODE_TRACK) {
              dedupeDisabled = true
              report.notes.push({
                path: full,
                kind: 'inode-table-full',
                message: `inode 去重表达到上限 ${MAX_INODE_TRACK}，后续硬链接可能被重复计数（保守方向）`,
              })
              report.files += 1
              report.bytes += info.size
            } else {
              seenInodes.add(key)
              report.files += 1
              report.bytes += info.size
            }
          }
        } else {
          report.files += 1
          report.bytes += info.size
        }
      }

      // ⚠ **不要**在这里 `break`（历史缺陷形态，见 `hitBound` 注释与 §4l）：
      //    内层 `break` 会"吃掉一条本该处理的条目"，却让外层 `while` 因 `stack` 已空而**不执行**
      //    上界记账 ⇒ `truncated=false`，调用方把下界当完整账。
      //    正确做法是让循环自然走到外层 `while (stack.length > 0)` 的
      //    `entries >= maxEntries` 检查：**只有真的还有没访问的条目**时才算被截断。
    }
  }

  // 统一记账：只要**因为上界**停下，就必须置 truncated 并留一条 MEASURE_TREE_BOUND。
  // （放在循环外，避免"内层 break 吃掉条目 ⇒ 记账被跳过"这一类静默漏标。）
  if (hitBound) {
    report.truncated = true
    report.errors.push({
      path: stack.length > 0 ? stack[stack.length - 1].path : root,
      code: 'MEASURE_TREE_BOUND',
      message: `遍历达到上限 maxEntries=${maxEntries}，提前结束：bytes 是下界，不是完整账`,
    })
  }

  report.realRoot = realRoot
  return report
}

/**
 * 内部：`child` 的**真实路径**是否落在 `parent` 的真实路径之内（含自身）。
 * 只用于遍历的闭合校验；大小写不敏感（NTFS 默认）且要求分隔符边界
 * （避免 `C:\ws-evil` 被判成 `C:\ws` 之内 —— 与 `paths.mjs::isInside()` 同一口径）。
 */
function isWithin(parentReal, childReal) {
  if (typeof parentReal !== 'string' || typeof childReal !== 'string') return false
  const p = parentReal.toLowerCase().replace(/[\\/]+$/, '')
  const c = childReal.toLowerCase()
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 暂存配额判定（**写入前**拒绝）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 这笔写入放不放行？
 *
 * 判定式（**逐字可复核**）：`used + incoming + reserved > quotaBytes` ⇒ `allowed:false`。
 * 即：**恰好用完**（相等、剩余 0）是**放行**的（任务硬不变式 #2），
 * 只有**超过**才拒绝。`reservedBytes` 用于"已在途、尚未落盘"的写入
 * （例如同一次工具调用里的多段内容，或并发会话的预留），防止并发超卖。
 *
 * ── 为什么必须在**写入前**能拒绝（而不是写完再量）────────────────────────────
 * 写完再量只能"事后发现超了"，此时磁盘已经被占用、暂存树已经不一致。
 * 因此本函数**只**依赖"当前已用 + 本次要写"这两个数，不需要先写任何东西。
 *
 * ── 集成方必须自己决定"errors/truncated 时怎么办" ─────────────────────────────
 * 本函数**不看** `measureTree` 的 `errors[]/truncated`（它的入参是数字，不是报告）。
 * 推荐接线（更保守，已写进文件末"接线契约"）：
 *   统计报告 `truncated === true` 或 `errors[]` 非空 ⇒ 按 `usedBytes = quotaBytes` 传入
 *   （即一律拒绝新的写），否则一个"统计不了"的树就等于"配额的洞"。
 *   本函数把这条判断**留给调用方**，是因为它只有数字输入 —— 这里如实声明，避免误以为已覆盖。
 *
 * @returns {{allowed:boolean, usedBytes:number, incomingBytes:number, reservedBytes:number,
 *            quotaBytes:number, remainingBytes:number, wouldBeBytes:number, headroomBytes:number, reason:string}}
 */
export function checkStagingQuota(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new LimitsError(`checkStagingQuota 需要选项对象，收到 ${clip(options)}`, 'LIMITS_INVALID', { options })
  }
  const {
    root,
    quotaBytes = DEFAULT_LIMITS.stagingBytes,
    incomingBytes = 0,
    reservedBytes = 0,
    usedBytes: explicitUsed,
    measure = measureTree,
  } = options

  const quota = assertByteCount(quotaBytes, 'checkStagingQuota.quotaBytes', 'LIMITS_INVALID')
  const incoming = assertByteCount(incomingBytes, 'checkStagingQuota.incomingBytes', 'LIMITS_INVALID')
  const reserved = assertByteCount(reservedBytes, 'checkStagingQuota.reservedBytes', 'LIMITS_INVALID')

  let used
  let measured
  if (explicitUsed !== undefined) {
    used = assertByteCount(explicitUsed, 'checkStagingQuota.usedBytes', 'LIMITS_INVALID')
  } else {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new LimitsError(
        'checkStagingQuota 需要 root（暂存树路径）或显式 usedBytes —— 两者都没有就无法判定，拒绝猜测',
        'LIMITS_INVALID',
        { root },
      )
    }
    if (typeof measure !== 'function') {
      throw new LimitsError(`checkStagingQuota.measure 必须是函数，收到 ${typeof measure}`, 'LIMITS_INVALID', { measure: typeof measure })
    }
    measured = measure(root, options.measureOptions || {})
    if (!measured || typeof measured.bytes !== 'number') {
      throw new LimitsError('checkStagingQuota: 统计实现没有返回 { bytes }，无法判定（fail-closed）', 'LIMITS_INVALID', { measured })
    }
    used = assertByteCount(measured.bytes, 'checkStagingQuota(统计得到的 usedBytes)', 'LIMITS_INVALID')
  }

  const wouldBe = used + incoming + reserved
  if (!Number.isSafeInteger(wouldBe)) {
    throw new LimitsError(`checkStagingQuota: used+incoming+reserved 溢出安全整数（${used}+${incoming}+${reserved}）`, 'LIMITS_INVALID')
  }
  const allowed = wouldBe <= quota // 恰好等于 ⇒ 放行（零余量）
  const remaining = quota - used
  const headroom = quota - wouldBe
  const reason = allowed
    ? headroom === 0
      ? `恰好用满配额：used=${used} + incoming=${incoming} + reserved=${reserved} == quota=${quota}（零余量放行）`
      : `配额内：wouldBe=${wouldBe} <= quota=${quota}（余量 ${headroom} 字节）`
    : `超出配额：used=${used} + incoming=${incoming} + reserved=${reserved} = ${wouldBe} > quota=${quota}（超出 ${-headroom} 字节）`

  const result = {
    allowed,
    usedBytes: used,
    incomingBytes: incoming,
    reservedBytes: reserved,
    quotaBytes: quota,
    remainingBytes: remaining,
    wouldBeBytes: wouldBe,
    headroomBytes: headroom,
    reason,
  }
  // 统计细节保留下来（**不参与判定**，但集成方/审批面需要它来解释根因）
  if (measured) {
    result.measure = {
      bytes: measured.bytes,
      files: measured.files,
      dirs: measured.dirs,
      skipped: measured.skipped ? measured.skipped.length : 0,
      errors: measured.errors ? measured.errors.length : 0,
      truncated: measured.truncated === true,
      // 明确标注"这个账可信吗"：截断或出错 ⇒ 只是下界
      complete: measured.truncated !== true && (measured.errors ? measured.errors.length === 0 : true),
    }
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════
// 输出上限（显式、可机检地截断）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `[实测]` ASCII-only 标记模板。项目反复被"非 ASCII 标记在 cmd/PowerShell 5.1 控制台
 * 按 OEM 代码页解码变乱码"坑过（`src\testrunner.mjs:46-52` 记的就是这个形态），
 * 因此标记**只允许** 0x20–0x7E。模板里 `{n}` 由实际丢弃量填充。
 */
export const TRUNCATION_MARKER_TEMPLATE =
  '\n[WinStageSandbox][OUTPUT-TRUNCATED] dropped {droppedBytes} bytes / {droppedLines} lines; kept {keptBytes} bytes / {keptLines} lines (limit {limitBytes} bytes / {limitLines} lines)\n'

/** 内部：模板填充（字段名固定，测试直接断言"标记文本确实是这个形状"） */
function renderMarker(fields) {
  return TRUNCATION_MARKER_TEMPLATE.replace(/\{(\w+)\}/g, (whole, key) => (key in fields ? String(fields[key]) : whole))
}

/** 内部：字符串字节数（UTF-8） */
function byteLengthOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** 内部：换行符个数（**行数口径 = 换行符个数**，因为"末行没有换行符"也要能截） */
function countNewlines(text) {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

/**
 * 内部：`maxLines` 指定的**截断点**在字符串里的 UTF-16 下标。
 *
 * 口径（避免经典行数 off-by-one）：**保留恰好前 `maxLines` 个 `\n`**，
 * 在第 `maxLines` 个 `\n` **之后**切断。于是 `'a\nb\nc'` 在 `maxLines=2` 时保留 `'a\nb\n'`。
 * `maxLines=0` ⇒ 截断点为 0（不保留任何字节，但**仍然输出标记**）。
 * 返回 `undefined` 表示**不需要按行截断**（换行数不超过上限）。
 */
function lineCutIndex(text, maxLines) {
  if (maxLines === 0) return 0
  let seen = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      seen += 1
      if (seen >= maxLines) return i + 1
    }
  }
  return undefined
}

/**
 * 内部：把字符串**按 UTF-8 字符边界**缩到不超过 `maxBytes` 字节，且返回的串
 * 重新编码后的字节数**恰好**等于报告值。
 *
 * 做法（**不用** `Buffer.toString` 的宽松解码，因为它会把半个多字节序列静默换成 U+FFFD
 * —— 那既不等于原字节，也无法被察觉，正是"静默损坏"的形态）：
 *   1. 从 `min(maxBytes, byteLength)` 起**向前**最多退 3 个字节（UTF-8 单字符最长 4 字节）；
 *   2. 每个候选位置试 `slice(0, i).toString('utf8')`，再 `Buffer.from(结果)` 回编码；
 *   3. **只有回编码字节数恰好等于 `i`** 才算"切在字符边界上"。
 * 于是"不发出半个码点"是**被验证过的**，不是被假定过的。
 */
function cutOnCharacterBoundary(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  const budget = Math.max(0, Math.min(maxBytes, buffer.length))
  for (let size = budget; size >= Math.max(0, budget - 3); size -= 1) {
    if (size === 0) return { prefix: '', keptBytes: 0 }
    // 快速剔除"新增字节是 UTF-8 续字节"的位置（0b10xxxxxx）
    const next = buffer[size]
    if (next !== undefined && (next & 0xc0) === 0x80) continue
    const candidate = buffer.subarray(0, size).toString('utf8')
    if (Buffer.byteLength(candidate, 'utf8') === size) return { prefix: candidate, keptBytes: size }
  }
  return { prefix: '', keptBytes: 0 }
}

/**
 * 内部：字符串里有没有"落单的代理项"（UTF-16 层面半个码点）。仅用于**自检**：
 * 返回的文本必须不含落单代理项（`Buffer` 会把它们编成 EF BF BD = U+FFFD）。
 */
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/** 内部：标记是不是**纯 ASCII 可打印 + 换行**（非 ASCII 标记会让"红/绿"看起来一样） */
function assertAsciiMarker(marker) {
  for (const char of marker) {
    const code = char.codePointAt(0)
    if (code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e)) continue
    throw new LimitsError(`截断标记含非 ASCII 字符（U+${code.toString(16).toUpperCase()}）—— 控制台会变乱码，禁止`, 'OUTPUT_CAP_INVALID', { marker })
  }
  return true
}

/**
 * 给输出加**显式、可机检**的上限。
 *
 * 语义契约（**按此接线，别猜**）：
 *   1. 输入不超上限 ⇒ 原文返回，`truncated:false`，标记为 `null`（**不做任何改写**）；
 *   2. 超上限 ⇒ 返回 `保留下来的前缀 + 标记`。**保留部分逐字节等于原文开头**
 *      （绝不插到中间、绝不改写保留字节），标记永远在**末尾** —— 这样 grep/日志解析
 *      仍然能命中保留段里的关键错误行；
 *   3. `droppedBytes` = `原文总字节 - 保留字节`（**不含标记**），因此
 *      `保留字节 + droppedBytes === 原文总字节` 这条恒等式在任何情况下都成立
 *      （测试逐例断言它，避免"丢弃量报错但没人发现"）；
 *   4. `byteTruncated` / `lineTruncated` 分别说明触发了哪一条上限（可同时为真）；
 *   5. `marker` 是**纯 ASCII**（`assertAsciiMarker` 强制），且 `text` 里含有它。
 *
 * 边界口径（诚实声明，避免下一手误解）：
 *   · `maxBytes` / `maxLines` = 0 是合法的，含义是"一个字节都不留"（仍然出标记）；
 *   · 标记本身**不占** `maxBytes` 预算 —— 上限管的是"被保留的原文"，标记是诊断尾注。
 *     因此极端小的 `maxBytes`（例如 1）下，返回文本可能**长于** `maxBytes`。
 *     这是有意为之：宁可输出多几十字节的**显式**标记，也不要静默截断。
 *   · 先按行切、再按字节切：两条上限都生效时，保留段同时满足二者。
 *
 * @returns {{text:string, truncated:boolean, droppedBytes:number, droppedLines:number,
 *            keptBytes:number, keptLines:number, byteTruncated:boolean, lineTruncated:boolean, marker:string|null}}
 */
export function applyOutputCap(text, options = {}) {
  if (typeof text !== 'string') {
    // 只接受字符串：Buffer/数组会让"字节边界"语义变得含糊，宁可让调用方先 decode
    throw new LimitsError(`applyOutputCap 需要字符串，收到 ${clip(text)}（类型 ${typeof text}）—— 请先 toString/decode`, 'OUTPUT_CAP_INVALID', { text: typeof text })
  }
  const { maxBytes = DEFAULT_LIMITS.maxOutputBytes, maxLines = DEFAULT_LIMITS.maxOutputLines } = options
  const byteLimit = assertByteCount(maxBytes, 'applyOutputCap.maxBytes', 'OUTPUT_CAP_INVALID')
  const lineLimit = assertByteCount(maxLines, 'applyOutputCap.maxLines', 'OUTPUT_CAP_INVALID')

  const totalBytes = byteLengthOf(text)
  const totalLines = countNewlines(text)
  const overBytes = totalBytes > byteLimit
  const overLines = totalLines > lineLimit

  if (!overBytes && !overLines) {
    return {
      text, // 逐字节原样（含 BOM/CRLF 也原样）
      truncated: false,
      droppedBytes: 0,
      droppedLines: 0,
      keptBytes: totalBytes,
      keptLines: totalLines,
      byteTruncated: false,
      lineTruncated: false,
      marker: null,
    }
  }

  // ① 先按行切（口径：保留恰好前 lineLimit 个换行符）
  let candidate = text
  let droppedLines = 0
  if (overLines) {
    const cut = lineCutIndex(text, lineLimit)
    if (cut !== undefined && cut < text.length) {
      candidate = text.slice(0, cut)
      droppedLines = totalLines - countNewlines(candidate)
    }
  }

  // ② 再按字节切（UTF-8 字符边界）
  let kept
  let byteCutLoss = false
  const candidateBytes = byteLengthOf(candidate)
  if (candidateBytes > byteLimit) {
    const { prefix, keptBytes } = cutOnCharacterBoundary(candidate, byteLimit)
    kept = prefix
    // ⚠ 判据是"**真的丢了字节**"（`keptBytes < candidateBytes`），不是"candidate 曾超过预算"。
    // 两者在"先按行切、再按字节切"时会分叉，而分叉的后果是**误报触发上限**：
    //   现场（`tests\limits.mjs` §6p2）：`maxLines=0` ⇒ 行切已把 candidate 清空，
    //   此时字节上限**一字节都没丢**（预算 9 B，candidate 0 B），却会报 `byteTruncated:true`，
    //   于是调用方把"行截断"误读成"字节截断"。
    // 反过来（§6p3）：行切留下 51 B 超预算、字节切到 20 B ⇒ 这时字节上限**确实**生效了，
    //   即便最终保留量恰好等于字节预算，也应当报 `byteTruncated:true`。
    byteCutLoss = keptBytes < candidateBytes
  } else {
    kept = candidate
  }
  // `byteTruncated` 的对外语义 = "字节上限**削减了**内容"（rather than "字节上限曾被读取"）。
  // 行切先发生时，用它来分辨究竟是哪一条上限吃掉了输出。
  const byteTruncated = byteCutLoss

  const keptBytes = byteLengthOf(kept)
  const keptLines = countNewlines(kept)
  const droppedBytes = totalBytes - keptBytes
  const droppedLinesFinal = Math.max(droppedLines, totalLines - keptLines)

  // ③ 自检：绝不发出半个码点（宁可多丢一个字节，也不静默损坏 —— 但这里必须**抛**，
  //    因为"发出了坏码点"说明算法错了，继续返回就是在传播损坏）
  if (hasLoneSurrogate(kept)) {
    throw new LimitsError('applyOutputCap 内部错误：截断结果含落单代理项（半个码点），拒绝返回损坏文本', 'OUTPUT_CAP_INVALID')
  }
  if (byteLengthOf(kept) !== keptBytes) {
    throw new LimitsError('applyOutputCap 内部错误：截断结果字节数不自洽', 'OUTPUT_CAP_INVALID')
  }

  const marker = renderMarker({
    droppedBytes,
    droppedLines: droppedLinesFinal,
    keptBytes,
    keptLines,
    limitBytes: byteLimit,
    limitLines: lineLimit,
  })
  assertAsciiMarker(marker)

  return {
    text: kept + marker,
    truncated: true,
    droppedBytes,
    droppedLines: droppedLinesFinal,
    keptBytes,
    keptLines,
    byteTruncated,
    lineTruncated: overLines,
    marker,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 上限对象的规范化与报告
// ═══════════════════════════════════════════════════════════════════════════

/** 内部：只认这三个键（未知键 fail-closed —— 拼错 `maxOutputByte` 必须当场报错，不能静默失效） */
function assertKnownKeys(input, where) {
  const unknown = Object.keys(input).filter((key) => !LIMIT_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new LimitsError(
      `${where} 收到未知键 ${unknown.map((k) => `"${clip(k)}"`).join(', ')}（只认 ${LIMIT_KEYS.join(' / ')}）—— 拼错的键会让上限静默失效，因此 fail-closed`,
      'LIMITS_INVALID',
      { unknown },
    )
  }
}

/**
 * 规范化 + 校验上限对象，**fail-closed**。
 *
 * 接受：
 *   · `undefined` / `null` → 全默认（`DEFAULT_LIMITS`）
 *   · 扁平的**部分**对象：`{ stagingBytes: '64GiB' }`（缺的字段补默认值）
 *   · 字符串体积：`{ stagingBytes: '2GiB', maxOutputBytes: '1MiB' }`
 *   · 嵌套形状：`{ staging: { bytes }, output: { maxBytes, maxLines } }`
 *     （集成方更可能按"暂存/输出"分组；两种形状**归一化到同一个出口**，避免两套口径）
 *
 * 拒绝（一律抛 `LimitsError`）：
 *   · 未知键（含拼写错误）—— 静默忽略一个拼错的键就是"上限没生效但看起来生效了"
 *   · 负数 / NaN / Infinity / 小数（maxOutputLines 也必须是整数）/ 超安全整数
 *   · `parseSize` 解释不了的字符串
 *
 * @returns {{stagingBytes:number, staging:object, maxOutputBytes:number, maxOutputLines:number, output:object, source:string}} **冻结**
 */
export function wrapLimits(limits) {
  let flat = {}
  if (limits === undefined || limits === null) {
    flat = {}
  } else if (typeof limits !== 'object' || Array.isArray(limits)) {
    throw new LimitsError(`wrapLimits 需要对象（或 undefined），收到 ${clip(limits)}（类型 ${typeof limits}）`, 'LIMITS_INVALID', { limits })
  } else {
    const keys = Object.keys(limits)
    const nestedKeys = keys.filter((key) => key === 'staging' || key === 'output')
    if (nestedKeys.length > 0) {
      const allowedNested = new Set(['staging', 'output'])
      const unknown = keys.filter((key) => !allowedNested.has(key))
      if (unknown.length > 0) {
        throw new LimitsError(
          `wrapLimits 收到嵌套形状时不允许混入其他键（未知：${unknown.map((k) => `"${clip(k)}"`).join(', ')}）`,
          'LIMITS_INVALID',
          { unknown },
        )
      }
      // 嵌套形状的键名语义清晰（bytes / maxBytes / maxLines），这里**翻译**成内部扁平键。
      // ⚠ 翻译表就是唯一权威：`{ staging: { bytes } }` 与 `{ stagingBytes }` 归一化后
      //   **必然**同一个出口（避免"两种写法两套口径"）。嵌套子对象里的未知键同样 fail-closed。
      const staging = limits.staging
      const output = limits.output
      for (const [label, value] of [['staging', staging], ['output', output]]) {
        if (value === undefined || value === null) continue
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new LimitsError(`wrapLimits 的 ${label} 必须是对象，收到 ${clip(value)}`, 'LIMITS_INVALID', { [label]: value })
        }
      }
      if (staging) {
        const unknownStaging = Object.keys(staging).filter((key) => key !== 'bytes')
        if (unknownStaging.length > 0) {
          throw new LimitsError(
            `wrapLimits 的 staging 只认 { bytes }，收到未知键 ${unknownStaging.map((k) => `"${clip(k)}"`).join(', ')}（拼错的键会让上限静默失效）`,
            'LIMITS_INVALID',
            { unknown: unknownStaging },
          )
        }
      }
      if (output) {
        const unknownOutput = Object.keys(output).filter((key) => key !== 'maxBytes' && key !== 'maxLines')
        if (unknownOutput.length > 0) {
          throw new LimitsError(
            `wrapLimits 的 output 只认 { maxBytes, maxLines }，收到未知键 ${unknownOutput.map((k) => `"${clip(k)}"`).join(', ')}（拼错的键会让上限静默失效）`,
            'LIMITS_INVALID',
            { unknown: unknownOutput },
          )
        }
      }
      const nestedFlat = {}
      if (staging && staging.bytes !== undefined) nestedFlat.stagingBytes = staging.bytes
      if (output && output.maxBytes !== undefined) nestedFlat.maxOutputBytes = output.maxBytes
      if (output && output.maxLines !== undefined) nestedFlat.maxOutputLines = output.maxLines
      flat = nestedFlat
    } else {
      assertKnownKeys(limits, 'wrapLimits(limits)')
      flat = { ...limits }
    }
  }

  const stagingBytes = flat.stagingBytes === undefined ? DEFAULT_LIMITS.stagingBytes : parseSize(flat.stagingBytes)
  const maxOutputBytes = flat.maxOutputBytes === undefined ? DEFAULT_LIMITS.maxOutputBytes : parseSize(flat.maxOutputBytes)
  const maxOutputLines = flat.maxOutputLines === undefined ? DEFAULT_LIMITS.maxOutputLines : assertByteCount(flat.maxOutputLines, 'wrapLimits.maxOutputLines', 'LIMITS_INVALID')

  const source = limits === undefined || limits === null ? 'defaults' : 'explicit'
  return Object.freeze({
    stagingBytes,
    staging: Object.freeze({ bytes: stagingBytes }),
    maxOutputBytes,
    maxOutputLines,
    output: Object.freeze({ maxBytes: maxOutputBytes, maxLines: maxOutputLines }),
    source,
  })
}

/**
 * 能力报告用的摘要：`{ stagingBytes, stagingGiB, maxOutputBytes, maxOutputLines }`。
 * 额外带 `source` / `stagingSource`，因为"这个上限是默认值还是显式配置的"必须能上报
 * ——否则报告里出现 64 GiB 时没人知道它是不是**真的**被配置了。
 * 接受 `wrapLimits` 的产物，也接受裸的 `{ stagingBytes, ... }`（内部会先 wrap，fail-closed）。
 */
export function summariseLimits(limits) {
  const normalised = limits && limits.staging && limits.output && Object.isFrozen(limits) ? limits : wrapLimits(limits)
  return {
    stagingBytes: normalised.stagingBytes,
    stagingGiB: toGiB(normalised.stagingBytes),
    maxOutputBytes: normalised.maxOutputBytes,
    maxOutputLines: normalised.maxOutputLines,
    // 出处：报告消费者据此判断"64 GiB 是对齐上游默认还是本项目自定义"
    source: normalised.source,
    stagingSource: STAGING_BYTES_SOURCE.marker,
    outputSource: OUTPUT_CAP_SOURCE.marker,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 接线契约（**已经落地的三处调用点**；本文件只声明接口，调用点在别的模块）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 已落地的调用点（`[实测]`：源码定位 + 对应套件在 `verify.cmd` 里全绿）：
 *   · `src\store.mjs:241`  —— `putBlob` 写入前调用 `assertStagingQuota`（拒绝即不落盘）；
 *   · `src\executor.mjs:2150` —— `run()` 的 preflight（`incomingBytes=0` 的基线判定）；
 *   · `src\executor.mjs:2265` —— stdout/stderr 收集之后走 `applyOutputCap`（截断显式上报）。
 *
 * 下面是接口契约（写给集成方/复核者，不是"待办"）：
 *
 * ① 暂存写入前（`src\store.mjs` 的落盘路径：`putBlob` / `materializeBlob` / `stagedPath` 写入前）：
 *
 *      import { checkStagingQuota, measureTree } from './limits.mjs'
 *      const report = measureTree(this.dir)                       // 统计暂存根
 *      const quota = checkStagingQuota({
 *        root: this.dir,
 *        incomingBytes: buffer.length,
 *        usedBytes: report.truncated || report.errors.length > 0 ? Number.MAX_SAFE_INTEGER : report.bytes,
 *      })
 *      if (!quota.allowed) { 拒绝写入，把 quota.reason 交给审批面/错误消息 }
 *
 *    ⚠ 第二行那个三元表达式是**必须**的：统计不完整（截断/出错）时按"已用=无上限"处理，
 *      否则"统计不了的树"就是配额的洞。本模块不替调用方做这个决定（见 checkStagingQuota 注释）。
 *
 * ② 输出捕获路径（`src\executor.mjs` 收集 stdout/stderr 之后、写日志之前）：
 *
 *      const capped = applyOutputCap(stdoutText)
 *      if (capped.truncated) { 在结果对象上置 outputTruncated:true + 记录 capped.marker }
 *      // 下游**必须**能看到 truncated 标志：静默截断 = 缺陷形态
 *
 * ③ 能力报告（`summariseLimits(wrapLimits(config))`）：把 `stagingGiB` 报成 64 才算"有上限"，
 *    并如实标注 `stagingSource: '[官方]'`（对齐 NeoAI）与 `outputSource: '[推断]'`（本项目取值）。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 内部导出（**只给测试**：命名与 `src\registry-guard.mjs` / `src\audit.mjs` 的 `__internal`
// 口径一致。生产代码不得引用本对象 —— 它包含能关掉安全不变式的开关）
// ═══════════════════════════════════════════════════════════════════════════
export const __internal = Object.freeze({
  FILE_ATTRIBUTE_REPARSE_POINT,
  FORMAT_SIZE_MAX,
  MAX_INODE_TRACK,
  MAX_TREE_ENTRIES,
  TRUNCATION_MARKER_TEMPLATE,
  SIZE_UNITS,
  countNewlines,
  lineCutIndex,
  cutOnCharacterBoundary,
  hasLoneSurrogate,
  assertAsciiMarker,
  renderMarker,
  /**
   * `--plant` 变异体开关（**只影响当前进程**）。
   *
   * 钩子值刻意放在一个**可变表**里，而不是让公开 API 长出"要不要跟随链接"这种参数：
   * 遍历里只读 `HOOK_VALUES`，而它默认全 `false` —— 生产路径不存在打开的开关。
   * 测试改它，等于把源码里那两行判据**真的**拆掉（而不是写一套"模拟坏行为"的替身），
   * 因此 `--plant` 变红才是对判定力的真证据。
   */
  testHooks: HOOK_VALUES,
  setTestHooks(patch = {}) {
    if (patch === null || typeof patch !== 'object') {
      throw new LimitsError(`setTestHooks 需要对象，收到 ${clip(patch)}`, 'LIMITS_INVALID')
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in HOOK_VALUES)) throw new LimitsError(`未知测试钩子 "${clip(key)}"`, 'LIMITS_INVALID')
      if (typeof value !== 'boolean') throw new LimitsError(`testHooks.${key} 必须是布尔，收到 ${clip(value)}`, 'LIMITS_INVALID')
      HOOK_VALUES[key] = value
    }
    return { ...HOOK_VALUES }
  },
  resetTestHooks() {
    for (const key of Object.keys(HOOK_VALUES)) HOOK_VALUES[key] = false
    return { ...HOOK_VALUES }
  },
})

