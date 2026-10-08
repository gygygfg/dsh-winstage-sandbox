/**
 * assembly-toggle-selftest —— 装配层"shell 提供方择一"的离线确定性回归。
 *
 * ── 它守的是什么（缺陷本源）──────────────────────────────────────────────────
 * `ctx.shell` 是**单例服务名**：`dsh-plugin/cordis.patch.yml` 里
 *   · `pwsh-sandbox`（平台）与
 *   · `winstage-shell`（本沙箱）
 * 必须**恰好一个**处于启用态。两个都禁用 ⇒ `ctx.shell` 服务缺失（所有 shell 命令不可用）；
 * 两个都启用 ⇒ cordis 重复注册服务（插件加载即失败）。而这两个"禁用"开关是两条
 * 各自独立的 `!!js` 表达式，写在 YAML 文本里、**没有任何编译期约束**把它们绑在一起 ——
 * 只改其中一条是本项目最容易犯、也最难在运行期看出来的错（症状是"某个开关组合下 shell 整个消失"）。
 *
 * 本轮真实踩到的两个坑，本套件都钉住：
 *   ① 门控口径：旧表达式要求**进程环境变量** `WINSTAGE_SHELL=1` ⇒ 第二实例从未设过它，
 *      `winstage-shell` **永远不装载**，"沙箱开着但 shell 面是平台的" ⇒ 注册表写只剩内核硬拒。
 *      现口径：profile 开关是唯一权威，`WINSTAGE_SHELL=1`/`=0` 只作诊断强制。
 *   ② YAML 形态：`disabled: !!js !(...)` **不是合法 YAML** —— 行首的 `!` 会被解析成
 *      **第二个标签**，报 `YAMLException: duplication of a tag property (…)`，
 *      后果是**整条 bundle patch 被跳过**（实测：`dsh2.err.log` 里
 *      `failed to parse overlay … YAMLException` + `4 entries did not activate`）。
 *      因此表达式标量必须以 `(` 开头 —— 本套件用文本断言钉住这条。
 *
 * ── 判据（都要求"能 FAIL"）──────────────────────────────────────────────────
 *   A. 文本形态：两行都存在；表达式以 `(` 开头；不含 `!!js !` 形态；
 *      两条表达式**逐字共享**同一段 profile 读取代码（防止只改一条）。
 *   B. 行为矩阵：env {未设, 1, 0} × profile {enabled: true, enabled: false, 文件缺失}
 *      = 9 种组合，逐一求值，断言：
 *        · **恰好一个启用**（服务名单例）；
 *        · `WINSTAGE_SHELL=0` ⇒ 永远平台接管；`=1` ⇒ 永远 WinStage 接管；
 *        · 未设环境变量时**只看开关**：true ⇒ 接管，false ⇒ 交还；
 *        · profile 读不出（文件缺失）⇒ **fail-safe 接管**（不静默失去沙箱）。
 *
 * 零子进程、零注册表、零网络 ⇒ 离线档，任何会话都能跑。
 *
 * 用法：node tests\assembly-toggle-selftest.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PATCH = join(REPO, 'dsh-plugin', 'cordis.patch.yml')
const SCRATCH = join(REPO, '.t', 'assembly-toggle-selftest')

let checks = 0
let failures = 0
function ok(condition, label, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  }
}

/** 取某一行（`- id: <id>`）之后**第一条** `disabled: !!js <expr>` 的表达式文本 */
function expressionFor(text, id) {
  const rowAt = text.indexOf(`- id: ${id}`)
  if (rowAt < 0) return undefined
  const tail = text.slice(rowAt)
  const match = /^[^\S\n]*disabled:\s*!!js\s+(.+)$/m.exec(tail)
  return match ? match[1].trim() : undefined
}

const require_ = createRequire(import.meta.url)

/**
 * 在**假的 `process`** 下求值表达式。
 *
 * 为什么传入 `process` 而不是改真实 `process.env`：表达式读 `process.env` 与
 * `process.getBuiltinModule`；用参数遮蔽可以让 9 种组合互不干扰，且**不污染**
 * 本进程环境（本进程可能就是被装配的宿主）。
 */
function evaluate(expression, { env, getBuiltinModule = (name) => require_(name) }) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('process', `return (${expression});`)
  return fn({ env, getBuiltinModule })
}

process.stdout.write('=== assembly-toggle-selftest ===\n')
const text = readFileSync(PATCH, 'utf8')

// ── A. 文本形态 ──────────────────────────────────────────────────────────────
const pwshExpr = expressionFor(text, 'pwsh-sandbox')
const shellExpr = expressionFor(text, 'winstage-shell')

process.stdout.write('\n[A] 文本形态\n')
ok(typeof pwshExpr === 'string' && pwshExpr.length > 0, 'A1 `pwsh-sandbox` 行有一条 `disabled: !!js` 表达式')
ok(typeof shellExpr === 'string' && shellExpr.length > 0, 'A2 `winstage-shell` 行有一条 `disabled: !!js` 表达式')
ok(pwshExpr?.startsWith('(') === true, 'A3 pwsh 表达式标量以 `(` 开头（YAML：行首 `!` 会被当成第二个标签）', pwshExpr?.slice(0, 24))
ok(shellExpr?.startsWith('(') === true, 'A4 shell 表达式标量以 `(` 开头（同上）', shellExpr?.slice(0, 24))
ok(!/disabled:\s*!!js\s*!/.test(text), 'A5 全文不含 `!!js !`（已知会整条 bundle 被 YAML 解析失败跳过）')
ok(
  pwshExpr?.includes(': ') !== true && shellExpr?.includes(': ') !== true,
  'A6 两条表达式都不含 `: `（冒号+空格）：YAML 会把它当映射键分隔符 ⇒ `disabled` 变成对象而不是布尔（实测 dump `[object Object]`）',
)

/** 两条表达式必须逐字共享同一段"读 profile 开关"的代码 */
const READER_MARK = "const p = process.env.DSH_HOME + '/profiles/' + process.env.DSH_PROFILE + '/cordis.patch.yml'"
ok(pwshExpr?.includes(READER_MARK) === true, 'A7 pwsh 表达式含权威开关读取段')
ok(shellExpr?.includes(READER_MARK) === true, 'A8 shell 表达式含**逐字相同**的开关读取段（防只改一条）')
ok(
  pwshExpr?.includes("process.env.WINSTAGE_SHELL !== '0'") === true &&
    shellExpr?.includes("process.env.WINSTAGE_SHELL !== '0'") === true,
  'A9 两条表达式都认 `WINSTAGE_SHELL=0` 强制交还',
)
ok(
  pwshExpr?.includes("process.env.WINSTAGE_SHELL === '1'") === true &&
    shellExpr?.includes("process.env.WINSTAGE_SHELL === '1'") === true,
  'A10 两条表达式都认 `WINSTAGE_SHELL=1` 强制接管',
)

// ── B. 行为矩阵 ──────────────────────────────────────────────────────────────
process.stdout.write('\n[B] 行为矩阵（env × profile 开关）\n')
mkdirSync(SCRATCH, { recursive: true })
const FAKE_HOME = join(SCRATCH, 'home')
const PROFILE = 'selftest'
const PROFILE_DIR = join(FAKE_HOME, 'profiles', PROFILE)
mkdirSync(PROFILE_DIR, { recursive: true })
const PROFILE_FILE = join(PROFILE_DIR, 'cordis.patch.yml')

const baseEnv = { DSH_HOME: FAKE_HOME, DSH_PROFILE: PROFILE }
const cases = [
  // [env 值, profile 文本（null=文件缺失）, 期望 winstage 接管?]
  ['unset', 'enabled: true\n', true],
  ['unset', 'enabled: false\n', false],
  ['unset', null, true], // fail-safe：读不出 ⇒ 接管（绝不静默失去沙箱）
  ['1', 'enabled: false\n', true], // 强制接管可越过"开关关"
  ['1', 'enabled: true\n', true],
  ['0', 'enabled: true\n', false], // 强制交还可越过"开关开"
  ['0', 'enabled: false\n', false],
]

for (const [shellEnv, profileText, expectWinstage] of cases) {
  if (profileText === null) rmSync(PROFILE_FILE, { force: true })
  else writeFileSync(PROFILE_FILE, `- id: winstage-sandbox\n  config:\n    ${profileText}`, 'utf8')
  const env = { ...baseEnv }
  if (shellEnv !== 'unset') env.WINSTAGE_SHELL = shellEnv

  const pwshDisabled = evaluate(pwshExpr, { env })
  const shellDisabled = evaluate(shellExpr, { env })
  const winstageEnabled = shellDisabled === false
  const platformEnabled = pwshDisabled === false

  const label = `env=${shellEnv} profile=${profileText === null ? '(缺失)' : profileText.trim()}`
  ok(
    winstageEnabled !== platformEnabled,
    `B 恰好一个 shell 提供方启用 —— ${label}`,
    `platform=${platformEnabled} winstage=${winstageEnabled}`,
  )
  ok(winstageEnabled === expectWinstage, `B 接管方符合预期 —— ${label}`, `期望 winstage=${expectWinstage}，实际=${winstageEnabled}`)
}

// 负面对照：把 shell 行的极性"改坏"（变成与平台行同向）⇒ B 段"恰好一个"判据必须能红。
process.stdout.write('\n[C] 变异自证（负面对照）\n')
for (const profileText of ['enabled: true\n', 'enabled: false\n']) {
  writeFileSync(PROFILE_FILE, `- id: winstage-sandbox\n  config:\n    ${profileText}`, 'utf8')
  const env = { ...baseEnv } // 必须不含 WINSTAGE_SHELL
  const platformEnabled = evaluate(pwshExpr, { env }) === false
  // 变异体 = 直接把平台行那条表达式当成 shell 行的表达式（极性同向）
  const mutatedWinstageEnabled = evaluate(pwshExpr, { env }) === false
  ok(
    platformEnabled === mutatedWinstageEnabled,
    `C1 极性同向的变异体确实违反"恰好一个" —— profile=${profileText.trim()}（证明 B 段断言有分辨力）`,
    `platform=${platformEnabled} winstage=${mutatedWinstageEnabled}`,
  )
}

const failed = failures > 0
process.stdout.write(`\n断言 ${checks} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'} (${checks} checks)\n`)
process.exit(failed ? 1 : 0)
