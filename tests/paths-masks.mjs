/**
 * 敏感清单（MASK_CLASSES）与探针映射（MASK_PROBES）的一致性测试。
 *
 * ── 存在理由（缺陷 D-清单 / 阶段 A §4.4）────────────────────────────────────
 * `src\paths.mjs` 的敏感清单是"拦得住什么"的唯一权威。它的失效方式**不是崩溃**，
 * 而是**悄悄少了一条**或**某条正则写错了却不自知**——两者都会让遮蔽在运行期静默失准。
 * 因此本测试把阶段 A §4.4 的三条工程约束变成断言：
 *   (a) 每条规则必须有 `id` + `category` + `reason`，且 id 不重复；
 *   (b) **每条规则必须能映射到一个探针**，且该探针必须**真的命中**它声明的 id；
 *   (c) 规则集**幂等且可单调收紧**：原有 15 个 id 一个都不能消失。
 *
 * ── 本测试**不**做的事（必须如实说明，避免"全绿"被读成"已经挡住了"）──────────
 * 它**不**读取真实敏感文件、不要求权限、也不证明运行期拦截生效。
 * 真实的读面读数由 `src\audit.mjs` 在沙箱内发起的探针给出；
 * `[实测]` 本机 `.npmrc` / `hosts` / `Unattend.xml` **当前仍可读**（残余边界 R1）。
 *
 * 用法：
 *   node tests\paths-masks.mjs           # 全绿
 *   node tests\paths-masks.mjs --plant   # 故意破坏一条映射，断言必须变红
 */

import { MASK_CLASSES, MASK_PROBES, SELF_MASK_ID, canonical, isMasked, maskKey, maskReason } from '../src/paths.mjs'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLANT = process.argv.includes('--plant')
const PROBE = process.argv.includes('--probe')
const USERPROFILE = process.env.USERPROFILE ?? 'C:\\Users\\Default'
const APPDATA = process.env.APPDATA ?? join(USERPROFILE, 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(USERPROFILE, 'AppData', 'Local')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const W = (s) => process.stdout.write(`${s}\n`)
let assertions = 0
let failures = 0
let skips = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}
/**
 * 如实记录"本环境无法实测"的用例。
 *
 * 为什么单独一个函数而不是直接 `check(name, true)`：跳过**不是通过**。
 * `check(name, true)` 会把"没测"伪装成"测过了"，正是本项目缺陷 11（空结果被当成拒绝）
 * 的同一族错误。跳过必须打印原因、计入 `skips`、并在总结行里与"失败 0"一起读。
 */
const skip = (name, why) => {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${why}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取面 / 归一化**可复现探针**（`--probe`；不进断言路径，只出证据）
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么要有它：`MASK_CLASSES` 是"工具层能读什么"的判据，但它**拦住了什么**与
// "文件在本机到底可不可读"是两件事。本探针把两者**并排**打出来：
//   · 判定（readable / read-metadata-only / denied / not-present / error）来自**真实**
//     `stat` + 读前 4 字节，五态与 `src\audit.mjs::READ_PROBES` 同一口径；
//   · `mask=` 来自 `maskReason()`，即工具层**当前**的遮蔽判据。
// 于是"改前 / 改后"的对照就是跑两次 `--probe`（本次 T2 收敛的报告即由此产出）。
//
// 秘密红线：**只看 4 个字节的读取成败，绝不打印内容**（连哈希都不打，避免把
// "内容指纹"带进文档证据）。
const PROBE_TARGETS = [
  // DSH 自身凭据/会话产物（[实测] 本机全部可读）
  ['dsh-credentials-yaml', join(USERPROFILE, '.dsh', '.credentials.yaml')],
  ['dsh-settings-imported', join(USERPROFILE, '.dsh', 'settings.yaml.imported')],
  ['dsh-web-url', join(USERPROFILE, '.dsh', 'web-url.txt')],
  ['dsh-dir', join(USERPROFILE, '.dsh')],
  // 系统/网络
  ['hosts', 'C:\\Windows\\System32\\drivers\\etc\\hosts'],
  ['sam-hive', 'C:\\Windows\\System32\\config\\SAM'],
  ['security-hive', 'C:\\Windows\\System32\\config\\SECURITY'],
  ['system-hive', 'C:\\Windows\\System32\\config\\SYSTEM'],
  ['config-dir', 'C:\\Windows\\System32\\config'],
  ['ntuser-dat', join(USERPROFILE, 'NTUSER.DAT')],
  ['npmrc', join(USERPROFILE, '.npmrc')],
  // 终端命令历史
  ['psreadline-history', join(APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')],
  ['psreadline-dir', join(APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine')],
  // 浏览器（AppData 形态：真实存在）
  ['edge-local-state', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Local State')],
  ['edge-login-data', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data')],
  ['edge-login-data-account', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data For Account')],
  ['edge-network-cookies', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies')],
  ['edge-history', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'History')],
  ['chrome-local-state', join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Local State')],
  // 浏览器（非 AppData 形态：S5 的原始证据形状，本机当前只留 headful profile）
  ['nonappdata-login-data', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile-headful', 'Default', 'Login Data')],
  ['nonappdata-network-cookies', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Network', 'Cookies')],
  ['nonappdata-history', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'chrome-profile', 'Default', 'History')],
  // 凭据存储（命名约定类）
  ['cred-manager-dir', join(LOCALAPPDATA, 'Microsoft', 'Credentials')],
  ['appdata-credentials-class', join(APPDATA, 'acme.credentials')],
  ['appdata-credentials-class-file', join(APPDATA, 'acme.credentials', 'token.bin')],
]

function probeVerdict(target) {
  let stat
  try {
    stat = statSync(target)
  } catch (error) {
    const code = error.code ?? 'ERR'
    if (code === 'ENOENT' || code === 'ENOTDIR') return { verdict: 'not-present', code, len: null }
    if (code === 'EACCES' || code === 'EPERM') return { verdict: 'denied', code, len: null }
    return { verdict: 'error', code, len: null }
  }
  if (stat.isDirectory()) {
    try {
      const entries = readdirSync(target).length
      return { verdict: 'readable', code: null, len: entries, kind: 'dir' }
    } catch (error) {
      const code = error.code ?? 'ERR'
      return { verdict: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'error', code, len: null, kind: 'dir' }
    }
  }
  let fd
  try {
    fd = openSync(target, 'r')
    const buffer = Buffer.alloc(4)
    const read = readSync(fd, buffer, 0, 4, 0)
    return { verdict: 'readable', code: null, len: stat.size, readBytes: read, kind: 'file' }
  } catch (error) {
    const code = error.code ?? 'ERR'
    return { verdict: 'read-metadata-only', code, len: stat.size, kind: 'file' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 收尾 */
      }
    }
  }
}

if (PROBE) {
  const rows = []
  W('=== P1. 读取面实测（本机宿主进程；五态与 audit.mjs::READ_PROBES 同口径）===')
  W('    判定 = 真实 stat + 读前 4 字节；内容不进证据（只记判定/长度/错误码）')
  for (const [id, path] of PROBE_TARGETS) {
    const probe = probeVerdict(path)
    const mask = maskReason(path)
    rows.push({ id, path, verdict: probe.verdict, errCode: probe.code, len: probe.len, kind: probe.kind ?? null, mask: mask ? mask.id : null })
    W(
      `  [${probe.verdict.padEnd(18)}] len=${String(probe.len).padStart(7)} err=${String(probe.code ?? '-').padEnd(6)} ` +
        `mask=${String(mask ? mask.id : '(none)').padEnd(23)} ${path}`,
    )
  }
  W('')
  W('=== P2. 归一化实测（大小写 / 8.3 短名 / 长路径前缀 / 尾分隔符 / 正斜杠）===')
  const normalizeCases = [
    ['短名(NTUSER.DAT)', join('C:\\Users\\ADMINI~1', 'NTUSER.DAT')],
    ['短名(.dsh 凭据)', 'C:\\Users\\ADMINI~1\\.dsh\\.credentials.yaml'],
    ['长路径前缀', '\\\\?\\C:\\Users\\Administrator\\.dsh\\.credentials.yaml'],
    ['全大写', 'C:\\USERS\\ADMINISTRATOR\\.DSH\\SETTINGS.YAML.IMPORTED'],
    ['尾分隔符(目录自身)', 'C:\\Windows\\System32\\config\\'],
    ['正斜杠', 'C:/Users/Administrator/.dsh/web-url.txt'],
  ]
  for (const [label, path] of normalizeCases) {
    const canonicalPath = canonical(path)
    const mask = maskReason(path)
    W(`  ${label.padEnd(20)} canonical=${canonicalPath}`)
    W(`  ${''.padEnd(20)} mask=${mask ? mask.id : '(none)'}`)
  }
  W('')
  W(`DSH-T2-PATHS-PROBE: ${JSON.stringify({ rows, rules: MASK_CLASSES.length, probes: MASK_PROBES.length })}`)
  process.exit(0)
}

/** 阶段 A 之前就存在的 15 个 id：**一个都不能少**（单调收紧断言） */
const LEGACY_IDS = [
  'sam',
  'dpapi',
  'dpapi-user',
  'ssh',
  'aws',
  'gcloud',
  'kube',
  'git-credentials',
  'npmrc',
  'dsh-home',
  SELF_MASK_ID,
  'browser',
  'unattend',
  'sysvol-copy',
  'hosts',
  'wifi',
]

W('=== 1. 清单结构（约束 a：id / category / reason 齐全且不重复）===')
{
  const ids = MASK_CLASSES.map((rule) => rule.id)
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
  check('每个规则都有 id', ids.every((id) => typeof id === 'string' && id.length > 0), `${ids.length} 条规则`)
  check('id 不重复', dupes.length === 0, dupes.length ? `重复: ${dupes.join(', ')}` : '无重复')
  const noCategory = MASK_CLASSES.filter((rule) => typeof rule.category !== 'string' || rule.category.length === 0).map((r) => r.id)
  check('每个规则都有判据类别 category', noCategory.length === 0, noCategory.length ? `缺: ${noCategory.join(', ')}` : '齐全')
  const noReason = MASK_CLASSES.filter((rule) => typeof rule.reason !== 'string' || rule.reason.length === 0).map((r) => r.id)
  check('每个规则都有 reason', noReason.length === 0, noReason.length ? `缺: ${noReason.join(', ')}` : '齐全')
  const badPattern = MASK_CLASSES.filter((rule) => !(rule.pattern instanceof RegExp)).map((r) => r.id)
  check('每个规则都有 RegExp pattern', badPattern.length === 0, badPattern.length ? `坏: ${badPattern.join(', ')}` : '齐全')
  W(`  当前规则数 = ${MASK_CLASSES.length}（阶段 A 之前为 ${LEGACY_IDS.length}）`)
}

W('')
W('=== 2. 规则 ↔ 探针双向映射（约束 b：没有探针的规则不得入库）===')
{
  const rulesWithoutProbe = MASK_CLASSES.filter((rule) => !MASK_PROBES.some((p) => p.maskClass === rule.id)).map((r) => r.id)
  check('每条规则都有至少一个探针', rulesWithoutProbe.length === 0, rulesWithoutProbe.length ? `缺探针: ${rulesWithoutProbe.join(', ')}` : '全部有探针')

  const known = new Set(MASK_CLASSES.map((r) => r.id))
  const orphanProbes = MASK_PROBES.filter((p) => !known.has(p.maskClass)).map((p) => `${p.id}→${p.maskClass}`)
  check('没有指向不存在规则的孤儿探针', orphanProbes.length === 0, orphanProbes.length ? orphanProbes.join(', ') : '无孤儿')

  const ids = MASK_PROBES.map((p) => p.id)
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
  check('探针 id 不重复', dupes.length === 0, dupes.length ? dupes.join(', ') : '无重复')

  // 正向：探针必须**真的**命中它声明的 id（这才是"探针"而不是"注释"）
  const mismatches = []
  for (const probe of MASK_PROBES) {
    // --plant：把一条探针的期望类别改错，判定必须变红（用于证明本测试真的能失败）
    const expected = PLANT && probe.id === 'probe-npmrc' ? 'ssh' : probe.maskClass
    const got = maskReason(probe.path)
    if (!got || got.id !== expected) mismatches.push(`${probe.id}: 期望 ${expected}，实际 ${got ? got.id : 'undefined'}（${probe.path}）`)
  }
  check(
    `${MASK_PROBES.length} 条探针全部命中其声明的类别`,
    mismatches.length === 0,
    mismatches.length ? mismatches.slice(0, 6).join(' | ') : '全部命中',
  )
}

W('')
W('=== 3. 单调收紧（约束 c：原 15 个 id 一个都不能消失）===')
{
  const ids = new Set(MASK_CLASSES.map((r) => r.id))
  const lost = LEGACY_IDS.filter((id) => !ids.has(id))
  check('原有 15 个 id 全部保留', lost.length === 0, lost.length ? `丢失: ${lost.join(', ')}` : '全部保留')
  check('规则数为 15 + 新增（只增不减）', MASK_CLASSES.length >= LEGACY_IDS.length, `${MASK_CLASSES.length} >= ${LEGACY_IDS.length}`)
}

W('')
W('=== 4. N1–N10 的具体类别（每条至少一个探针，逐条点名）===')
{
  const NEW_IDS = [
    'cli-cred-dirs', // N1
    'pkg-token-files', // N2
    'cred-vault', // N3
    'dsh-credentials', // N4
    'dsh-profile-deps', // N4
    'unattend-family', // N5
    'net-config-family', // N6
    'editor-token-state', // N7
    'private-key-files', // N8
    'credential-cache', // N9
    'process-dumps', // N10
  ]
  for (const id of NEW_IDS) {
    const rule = MASK_CLASSES.find((r) => r.id === id)
    const probes = MASK_PROBES.filter((p) => p.maskClass === id)
    check(
      `N 类规则 ${id} 存在且有 ${probes.length} 个探针`,
      rule !== undefined && probes.length > 0,
      rule ? `category=${rule.category}` : '规则缺失！',
    )
  }
}

W('')
W('=== 5. 作用域与豁免（#16.8：豁免要限定作用域）===')
{
  // N8 的私钥扩展名规则**必须**限定在 \users\ 与 \programdata\ 之下，
  // 否则会把工作区里的源码/夹具（例如测试用的 *.pem）一起封死。
  check('源码路径下的 *.pem 不被 N8 误伤', !isMasked(join('C:\\repo\\src', 'fixture.pem')), 'C:\\repo\\src\\fixture.pem')
  check('用户目录下的 *.pem 命中 N8', isMasked(join('C:\\Users\\Administrator', 'certs', 'a.pem')), 'C:\\Users\\Administrator\\certs\\a.pem')
  check('不存在的普通文件不命中任何规则', !isMasked('C:\\repo\\src\\index.mjs'), 'C:\\repo\\src\\index.mjs')
  // 误报防线：不带路径分隔符上下文的名字（如 notes.key）在源码目录下不得命中
  check('源码目录下的 notes.key 不被误伤', !isMasked(join('C:\\repo\\docs', 'notes.key')), 'C:\\repo\\docs\\notes.key')
}

W('')
W('=== 6. S3/S5 回归：目录自身命中 + 位置无关（本轮修复的判定力） ===')
{
  // ── S3：`canonical()` 走 `path.normalize`，**去掉结尾分隔符** ────────────────────
  // 因此任何以 `\\` 收尾的模式都只能命中"目录之下的文件"，命中不到**目录本身**。
  // `[实测]` 修复前：`%APPDATA%\Microsoft\Protect` 目录可枚举（entries=2）却 mask=(none)。
  // 这一条把"目录自身"钉死：规范化前后都必须是 dpapi-user。
  const protectDir = join(APPDATA, 'Microsoft', 'Protect')
  const canonicalDir = canonical(protectDir)
  check('S3：目录路径经 canonical() 后不以分隔符结尾（这就是旧模式命中不到的原因）', !/[\\/]$/.test(canonicalDir), canonicalDir)
  check('S3：dpapi-user 目录**自身**命中（修复点）', maskReason(protectDir)?.id === 'dpapi-user', `mask=${maskReason(protectDir)?.id ?? '(none)'}（${protectDir}）`)
  check('S3：目录**之下**的文件仍然命中（收紧没有破坏原有覆盖）', maskReason(join(protectDir, 'S-1-5-21-0-0-0-500', 'x'))?.id === 'dpapi-user', 'ok')
  check('S3：DPAPI 主密钥规则在带尾分隔符的输入上同样命中（两种写法等价）', maskReason(`${protectDir}\\`)?.id === 'dpapi-user', 'ok')

  // ── S5：既有 `browser` 规则硬编码 `\\appdata\\...`，非 AppData 的 profile 完全不遮蔽 ──
  // `[实测]` 修复前 `.t\dsh2\browser\edge-profile{,-headful}\...` 六条全部可读、mask=(none)。
  const nonAppDataProfiles = [
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile\\Default\\Login Data',
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile\\Default\\Login Data For Account',
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile-headful\\Default\\Login Data',
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile-headful\\Default\\Web Data',
  ]
  const missed = nonAppDataProfiles.filter((p) => maskReason(p)?.id !== 'browser-profile-auth-db')
  check('S5：非 AppData 的 Chromium 凭据库文件名族全部命中 browser-profile-auth-db', missed.length === 0, missed.length ? missed.join(' | ') : `${nonAppDataProfiles.length} 条全部命中`)
  const stateFiles = [
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile\\Local State',
    'C:\\repo\\.t\\dsh2\\browser\\edge-profile-headful\\Local State',
    'C:\\somewhere\\chrome-profile\\Local State',
  ]
  const stateMissed = stateFiles.filter((p) => maskReason(p)?.id !== 'browser-profile-state')
  check('S5：`<*profile>\\Local State`（含加密密钥）全部命中 browser-profile-state', stateMissed.length === 0, stateMissed.length ? stateMissed.join(' | ') : `${stateFiles.length} 条全部命中`)
  // 误伤防线：这两个新规则名字里有空格/位置无关，必须**不**吃掉源码或普通文件
  check('S5 不误伤源码：`src\\logindata.mjs` 不被命中', !isMasked('C:\\repo\\src\\logindata.mjs'), 'C:\\repo\\src\\logindata.mjs')
  check('S5 不误伤普通文件：`docs\\Web Data.txt` 之外的同名裸名不命中', !isMasked('C:\\repo\\docs\\webdata.json'), 'C:\\repo\\docs\\webdata.json')
  check('S5：AppData 下的 Chrome 凭据库仍由更宽的 browser 规则命中（顺序/优先级未变）', maskReason(join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'))?.id === 'browser', 'browser')

  // ── 新规则的字段完备性（id/category/reason），与 S5 的两条规则逐条点名 ──────────
  for (const id of ['browser-profile-auth-db', 'browser-profile-state']) {
    const rule = MASK_CLASSES.find((r) => r.id === id)
    check(
      `S5 新规则 ${id} 有 id/category/reason 且至少一个探针`,
      rule !== undefined && rule.category.length > 0 && rule.reason.length > 0 && MASK_PROBES.some((p) => p.maskClass === id),
      rule ? `category=${rule.category}` : '规则缺失！',
    )
  }
}

W('')
W('=== 7. T2 收敛：实测可读项逐条覆盖 + 目录形态 + 大小写/8.3 短名归一化 ===')
{
  // ── 7a. 覆盖表 ───────────────────────────────────────────────────────────────
  // 每行 = [标签, 路径, **期望命中的 id**]。期望值是"`maskReason()` 返回的**第一个**命中项"
  // （顺序即优先级），不是"随便哪条规则能命中" —— 否则"宽规则吃掉窄规则"会被绿掉。
  // 路径与 `[实测]` 一一对应：全部来自 `tests\paths-masks.mjs --probe` 的真实读数
  // （`docs\T2-敏感读收敛报告.md` 有改前/改后对照），**不含**任何编出来的样本。
  const REQUIRED_COVERAGE = [
    ['DSH 凭据文件', join(USERPROFILE, '.dsh', '.credentials.yaml'), 'dsh-credentials'],
    ['DSH 导入设置', join(USERPROFILE, '.dsh', 'settings.yaml.imported'), 'dsh-home'],
    ['DSH Web URL', join(USERPROFILE, '.dsh', 'web-url.txt'), 'dsh-home'],
    ['DSH 主目录自身（目录形态）', join(USERPROFILE, '.dsh'), 'dsh-home'],
    ['SAM 配置单元', 'C:\\Windows\\System32\\config\\SAM', 'sam'],
    ['SECURITY 配置单元', 'C:\\Windows\\System32\\config\\SECURITY', 'sam'],
    ['SYSTEM 配置单元', 'C:\\Windows\\System32\\config\\SYSTEM', 'sam'],
    ['config 目录自身（目录形态）', 'C:\\Windows\\System32\\config', 'sam'],
    ['用户注册表 NTUSER.DAT', join(USERPROFILE, 'NTUSER.DAT'), 'sam'],
    ['hosts', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['PSReadLine 命令历史', join(APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'), 'editor-token-state'],
    ['PSReadLine 目录自身（改名不绕过）', join(APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'), 'editor-token-state'],
    ['Edge Local State', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Local State'), 'browser-profile-state'],
    ['Edge Login Data', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data'), 'browser'],
    ['Edge Login Data For Account', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data For Account'), 'browser'],
    ['Edge Network\\Cookies', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies'), 'browser'],
    ['Edge History', join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'History'), 'browser-profile-auth-db'],
    ['非 AppData Login Data', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Login Data'), 'browser-profile-auth-db'],
    ['非 AppData Network\\Cookies', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Network', 'Cookies'), 'browser-profile-auth-db'],
    ['非 AppData History', join(REPO_ROOT, '.t', 'dsh2', 'browser', 'chrome-profile', 'Default', 'History'), 'browser-profile-auth-db'],
    ['凭据管理器目录自身（目录形态）', join(LOCALAPPDATA, 'Microsoft', 'Credentials'), 'cred-vault'],
    ['AppData *.credentials 命名类', join(APPDATA, 'acme.credentials', 'token.bin'), 'cred-vault'],
  ]
  const coverageRows = REQUIRED_COVERAGE.map(([label, path, expected]) => ({ label, path, expected, got: maskReason(path)?.id ?? null }))
  const coverageMisses = coverageRows.filter((row) => row.got !== row.expected)
  check(
    `T2 覆盖表 ${coverageRows.length} 条（含目录形态与 *.credentials 命名类）全部命中期望类别`,
    coverageMisses.length === 0,
    coverageMisses.length ? coverageMisses.map((r) => `${r.label}: got=${r.got} want=${r.expected}`).join(' | ') : '全部命中',
  )
  for (const row of coverageRows) W(`    ${row.got === row.expected ? '·' : '!'} ${row.label} → ${row.got}`)

  // ── 7b. 目录形态（S3 口径）：**目录自身**、带尾分隔符、目录之下三种写法等价 ────────
  // 旧表里 `sam`/`dsh-home`/`stage-store`/`ssh`/`aws`/… 都以 `\\` 收尾 ⇒ 目录自身命中不到。
  // `[实测]` 修复前 `.dsh`（13 个条目）与 `System32\config` 的 `mask=(none)`。
  const dirFormCases = [
    ['dsh-home', join(USERPROFILE, '.dsh')],
    ['sam', 'C:\\Windows\\System32\\config'],
    ['editor-token-state', join(APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine')],
    ['cred-vault', join(LOCALAPPDATA, 'Microsoft', 'Credentials')],
    ['stage-store', join(REPO_ROOT, '.dshstage')],
  ]
  const dirFormBad = []
  for (const [expected, dir] of dirFormCases) {
    const bare = maskReason(dir)?.id ?? null
    const trailing = maskReason(`${dir}\\`)?.id ?? null
    const inside = maskReason(join(dir, 'probe-child'))?.id ?? null
    if (bare !== expected || trailing !== expected || inside !== expected) {
      dirFormBad.push(`${dir}: bare=${bare} trailing=${trailing} inside=${inside} want=${expected}`)
    }
  }
  check(
    `目录形态 ${dirFormCases.length} 组（目录自身 / 带尾分隔符 / 目录之下）三种写法等价命中`,
    dirFormBad.length === 0,
    dirFormBad.length ? dirFormBad.join(' | ') : '全部等价',
  )

  // ── 7c. 归一化：8.3 短名 / 大小写 / 长路径前缀 / 正斜杠 / 尾分隔符 ───────────
  // 8.3 短名用**真实存在**的别名（本机 `C:\Users\Administrator` → `C:\Users\ADMINI~1`）。
  // 若本机没开 8.3（短名路径不存在），**如实跳过**而不是假装通过 —— 判定力不能靠环境假设。
  const shortNameCases = [
    ['sam', join(USERPROFILE, 'NTUSER.DAT'), join('C:\\Users\\ADMINI~1', 'NTUSER.DAT')],
    ['dsh-credentials', join(USERPROFILE, '.dsh', '.credentials.yaml'), 'C:\\Users\\ADMINI~1\\.dsh\\.credentials.yaml'],
  ]
  let shortNameChecked = 0
  for (const [expected, longPath, shortPath] of shortNameCases) {
    if (!existsSync(shortPath)) {
      skip(`8.3 短名绕过回归：${shortPath}`, '本机没有开 8.3 短名（该路径不存在）⇒ 无法实测，不假装通过')
      continue
    }
    shortNameChecked += 1
    check(
      `8.3 短名写法不能绕过（${shortPath} → ${expected}）`,
      maskReason(shortPath)?.id === expected && maskReason(longPath)?.id === expected,
      `short=${maskReason(shortPath)?.id ?? '(none)'} long=${maskReason(longPath)?.id ?? '(none)'} canonical(short)=${canonical(shortPath)}`,
    )
  }
  W(`  （短名用例实际执行 ${shortNameChecked}/${shortNameCases.length} 组，其余如实跳过）`)

  // 大小写 / 长路径前缀 / 正斜杠 / 尾分隔符：这些是**纯归一化**，不依赖 8.3 是否开启。
  const canonicalCases = [
    ['全大写写法', 'C:\\USERS\\ADMINISTRATOR\\.DSH\\SETTINGS.YAML.IMPORTED', 'dsh-home'],
    ['长路径前缀 \\\\?\\', '\\\\?\\C:\\Users\\Administrator\\.dsh\\.credentials.yaml', 'dsh-credentials'],
    ['正斜杠写法', 'C:/Users/Administrator/.dsh/web-url.txt', 'dsh-home'],
    ['尾分隔符（目录自身）', 'C:\\Windows\\System32\\config\\', 'sam'],
    ['相对上级折叠（..）', 'C:\\Windows\\System32\\config\\..\\config\\SAM', 'sam'],
  ]
  const canonicalBad = []
  for (const [label, path, expected] of canonicalCases) {
    const got = maskReason(path)?.id ?? null
    if (got !== expected) canonicalBad.push(`${label}(${path}): got=${got} want=${expected}`)
  }
  check(`归一化 ${canonicalCases.length} 组（大小写/长路径前缀/正斜杠/尾分隔符/..）全部命中`, canonicalBad.length === 0, canonicalBad.length ? canonicalBad.join(' | ') : '全部命中')

  // `maskKey()` 的幂等与"目录自身 = 目录\\"不变式（它是判据的唯一入口）
  const keyCases = ['C:\\Users\\Administrator\\.dsh', 'C:\\Users\\Administrator\\.dsh\\', 'C:/Users/Administrator/.dsh']
  const keys = keyCases.map((p) => maskKey(p))
  check('maskKey：目录自身 / 尾分隔符 / 正斜杠三种写法得到同一个键', keys.every((k) => k === keys[0]), keys.join(' | '))
  check('maskKey 幂等', keys.every((k) => maskKey(k) === k), keys[0])
  check('maskKey 不以分隔符结尾（除非是盘符根）', keys.every((k) => !/[\\/]$/.test(k)), keys[0])

  // ── 7d. 误伤防线（#16.8：作用域限定）──────────────────────────────────────
  // 新覆盖里最容易误伤的是 `History`（太普通）与 `*.credentials`（AppData 下任意深度）。
  const falsePositives = [
    ['裸 History 文件名（无 profile 形状父目录）', 'C:\\repo\\src\\History'],
    ['带扩展名的 history 源码', 'C:\\repo\\docs\\history.md'],
    ['非 AppData 下的 *.credentials 之外的文件', 'C:\\repo\\src\\credentials.mjs'],
    ['带 .bak 后缀的 ntuser.dat（不是配置单元本体）', 'C:\\repo\\backup\\ntuser.dat.bak'],
    ['普通 powershell 源码目录（不是 PSReadLine 状态目录）', 'C:\\repo\\src\\powershell\\run.ps1'],
    ['普通 default\\history 之外的目录名', 'C:\\repo\\src\\myhistory\\index.js'],
  ]
  const hurt = falsePositives.filter(([, p]) => isMasked(p)).map(([label, p]) => `${label} (${p}) → ${maskReason(p)?.id}`)
  check(`误伤防线 ${falsePositives.length} 条源码/夹具路径不被遮蔽`, hurt.length === 0, hurt.length ? hurt.join(' | ') : '全部未命中')

  // 宽规则优先（设计而非缺陷）：AppData 内的浏览器凭据仍先由 `browser` 命中
  check(
    '顺序未变：AppData 内 Edge/Chrome 凭据库仍先由更宽的 browser 命中',
    maskReason(join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data'))?.id === 'browser' &&
      maskReason(join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'))?.id === 'browser',
    'browser',
  )
}

W('')
W('=== 8. task-10 机器可读导出：与内部表**同源同序**，且可被独立实现复现 ===')
{
  const { exportMaskList, exportMaskJson, maskKey } = await import('../src/paths.mjs')

  const exported = exportMaskList()
  check('导出 schema/source 齐全', exported.schema === 'winstage.mask.v1' && exported.source === 'src/paths.mjs', JSON.stringify({ schema: exported.schema, source: exported.source }))
  check(
    '条目数 == 内部表条目数（导出不是"再写一份"）',
    exported.entries.length === MASK_CLASSES.length && exported.counts.rules === MASK_CLASSES.length,
    `entries=${exported.entries.length} MASK_CLASSES=${MASK_CLASSES.length}`,
  )
  const fieldBad = exported.entries.filter(
    (entry) =>
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      !['file', 'dir', 'glob'].includes(entry.kind) ||
      typeof entry.pattern !== 'string' ||
      entry.pattern.length === 0 ||
      entry.matchMode !== 'casefold' ||
      typeof entry.reason !== 'string' ||
      entry.reason.length === 0,
  ).map((entry) => entry.id)
  check('每条导出含 {id,kind,pattern,matchMode,reason} 且非空', fieldBad.length === 0, fieldBad.length ? fieldBad.join(', ') : '全部合规')

  // **逐条同源**：id / 顺序 / pattern 源串 / flags 都必须与内部表一致
  const drift = []
  for (const [index, rule] of MASK_CLASSES.entries()) {
    const entry = exported.entries[index]
    if (
      !entry ||
      entry.id !== rule.id ||
      entry.pattern !== rule.pattern.source ||
      entry.flags !== rule.pattern.flags ||
      entry.reason !== rule.reason ||
      entry.category !== rule.category
    ) {
      drift.push(`${index}: ${rule.id} vs ${entry ? entry.id : '(缺失)'}`)
    }
  }
  check(`导出逐条同源（id/顺序/pattern/flags/reason/category）${MASK_CLASSES.length} 条`, drift.length === 0, drift.length ? drift.slice(0, 6).join(' | ') : '无漂移')

  // **判定力复现**：用导出的 (pattern, flags) 独立复算一遍，对**每条探针**都必须得到
  // 与内部 `maskReason()` **逐字相同**的 id（含"顺序即优先级"这条语义）。
  const compiled = exported.entries.map((entry) => ({ id: entry.id, regex: new RegExp(entry.pattern, entry.flags) }))
  const mismatches = []
  for (const probe of MASK_PROBES) {
    const key = maskKey(probe.path)
    const viaExport = compiled.find((entry) => entry.regex.test(key))?.id ?? null
    const viaInternal = maskReason(probe.path)?.id ?? null
    if (viaExport !== viaInternal) mismatches.push(`${probe.id}: export=${viaExport} internal=${viaInternal}`)
  }
  check(
    `导出清单独立复算 ${MASK_PROBES.length} 条探针，判定与 maskReason() 逐字一致`,
    mismatches.length === 0,
    mismatches.length ? mismatches.slice(0, 5).join(' | ') : '全部一致',
  )
  check(
    '探针样本随导出一起提供（shim 实现可用它自检，漂移可见）',
    exported.probes.length === MASK_PROBES.length &&
      exported.probes.every((probe, index) => probe.id === MASK_PROBES[index].id && (probe.maskClass ?? null) === (MASK_PROBES[index].maskClass ?? null)),
    `probes=${exported.probes.length}`,
  )
  check(
    '归一化契约指向唯一来源 maskKey（不是第二套实现）',
    exported.normalizer.name === 'maskKey' && exported.normalizer.steps.length >= 2,
    exported.normalizer.name,
  )
  check(
    '归一化不变式成立：目录自身与“目录\\\\”得到同一个键',
    maskKey(join(APPDATA, 'Microsoft', 'Protect')) === maskKey(`${join(APPDATA, 'Microsoft', 'Protect')}\\`),
    maskKey(join(APPDATA, 'Microsoft', 'Protect')),
  )

  // ── CLI 往返（`node src/paths.mjs --export-mask <file>`）─────────────────────
  // 用 fd 重定向捕获 stdout/stderr（本环境不能用命名管道，见残余边界 R10）。
  const cliDir = mkdtempSync(join(tmpdir(), 'dsh-mask-export-'))
  const outFile = join(cliDir, 'mask.json')
  const logFile = join(cliDir, 'cli.log')
  let cliStatus = null
  let cliError = null
  try {
    const fd = openSync(logFile, 'w')
    const run = spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'paths.mjs'), '--export-mask', outFile], {
      cwd: REPO_ROOT,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    closeSync(fd)
    cliStatus = run.status
  } catch (error) {
    cliError = error
  }
  check('CLI `--export-mask <file>` exit 0', cliStatus === 0, cliError ? `spawn 失败: ${cliError.code ?? cliError.message}` : `status=${cliStatus}`)
  let cliPayload = null
  try {
    cliPayload = JSON.parse(readFileSync(outFile, 'utf8'))
  } catch (error) {
    cliPayload = null
  }
  check(
    'CLI 写出的 JSON 与 exportMaskList() 逐字段一致（去掉 generatedAt 时间戳）',
    cliPayload !== null && JSON.stringify({ ...cliPayload, generatedAt: null }) === JSON.stringify({ ...exported, generatedAt: null }),
    cliPayload ? `entries=${cliPayload.entries?.length}` : `无法解析：${existsSync(outFile) ? '文件存在' : '文件不存在'}`,
  )
  check(
    'CLI 的 JSON 可直接解析且 pretty 输出（喂 shim 的是同一份内容）',
    typeof exportMaskJson({ pretty: false }) === 'string' && exportMaskJson({ pretty: false }).length > 0,
    `compact=${exportMaskJson({ pretty: false }).length} bytes`,
  )
  rmSync(cliDir, { recursive: true, force: true })
}

W('')
W('='.repeat(64))
W(
  PLANT
    ? `敏感清单测试（--plant 模式，应当失败）：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`
    : `敏感清单测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`,
)
if (skips > 0) {
  W(`未提供的保证（${skips} 条）：跳过的用例**不是**通过 —— 它们描述的环境条件在本机不成立，`)
  W('  换一台开了 8.3 短名的机器（或反过来）必须重跑，判定力才完整。')
}
W('='.repeat(64))
process.exit(failures ? 1 : 0)
