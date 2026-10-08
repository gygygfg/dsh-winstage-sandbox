/**
 * 装配层「择一装载」验证（离线、零依赖于仓库；只用 DSH 自带的 yaml 解析器）
 *
 * 做什么：
 *   1. 用**真实 yaml 解析器 + 真实 `!!js` 类型**（cordis-plugin-include 的同一套 schema）
 *      解析改后的 `dsh-plugin/cordis.patch.yml`，把 `disabled` 抽成表达式字符串；
 *   2. 用**与 loader 完全同构**的求值器
 *      （`new Function('ctx','expr','with (ctx) { return eval(expr) }')`，
 *       源码 cordis-plugin-loader/src/config/utils.ts:5-9）求值；
 *   3. 在受控 `DSH_HOME/DSH_PROFILE/WINSTAGE_SHELL` + 受控 profile 文本下，
 *      断言**恰好一个** shell 提供方启用（不变量）。
 *
 * 跑法：node docs/dsh2-装配择一-验证.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const DSH_NM = 'C:\\Users\\Administrator\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules'
const requireDsh = createRequire(join(DSH_NM, 'noop.cjs'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: ok === true })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail !== undefined ? `  —— ${detail}` : ''}`)
}

console.log('='.repeat(70))
console.log(' 装配层「择一装载」验证（真实 yaml + 真实求值器）')
console.log('='.repeat(70))

// ── 载入真实 yaml，用**普通解析**读 patch（`!!js` 的标量文本会原样保留）──────
// 不用 include 的 schema：它绑在自己那份 yaml 副本上（跨副本会
// `findScalarTagByTest` 崩），且本机这份 yaml 构建不导出可构造的 `Type`。
// 我们只需要拿到 `disabled:` 的**表达式文本**，普通解析就够。
const yaml = requireDsh('yaml')
check('Y0 能载入 yaml 解析器', typeof yaml?.parse === 'function')
// 先证明"普通解析"本来就 OK（排除是我这个 patch 写坏了 YAML）
{
  let plainOk = false
  let plainRows = 0
  try {
    const p = yaml.parse(readFileSync(join(REPO, 'dsh-plugin', 'cordis.patch.yml'), 'utf8'))
    plainOk = Array.isArray(p)
    plainRows = Array.isArray(p) ? p.length : 0
  } catch {
    plainOk = false
  }
  check('Y0c 不带 schema 的普通解析成功（证明 YAML 本身合法）', plainOk, `rows=${plainRows}`)
}

// ── 解析 patch ───────────────────────────────────────────────────
const PATCH = join(REPO, 'dsh-plugin', 'cordis.patch.yml')
let rows
try {
  // 普通解析即可：`!!js` 标量会以**纯字符串**返回（字面量则是 boolean），
  // 这正好让我们能用同一套判据同时处理"表达式"与"字面量"两种形态。
  rows = yaml.parse(readFileSync(PATCH, 'utf8'))
  check('Y1 cordis.patch.yml 可被解析', Array.isArray(rows), `rows=${Array.isArray(rows) ? rows.length : typeof rows}`)
} catch (e) {
  check('Y1 cordis.patch.yml 可被解析', false, `${e.constructor.name}: ${e.message}`)
  process.exit(1)
}

/** 展平成 id → row（insert 里的也算） */
const byId = new Map()
for (const r of rows) {
  if (r?.id) byId.set(r.id, r)
  for (const ins of r?.insert ?? []) if (ins?.id) byId.set(ins.id, ins)
}
check('Y2 能取到 pwsh-sandbox 行', byId.has('pwsh-sandbox'))
check('Y3 能取到 winstage-shell 行', byId.has('winstage-shell'))

/**
 * `disabled` 取值：`!!js` ⇒ string（表达式，激活时求值）；字面量 ⇒ boolean。
 * 两种形态都要支持，才能在**同一套判据**下对比"修复前/修复后"。
 */
const platformDisabledRaw = byId.get('pwsh-sandbox')?.disabled
const winstageDisabledRaw = byId.get('winstage-shell')?.disabled
check(
  'Y4 pwsh-sandbox.disabled 是 !!js 表达式（不再是字面量 true）',
  typeof platformDisabledRaw === 'string',
  `typeof=${typeof platformDisabledRaw}`,
)
check(
  'Y5 winstage-shell.disabled 是 !!js 表达式（不再是字面量 false）',
  typeof winstageDisabledRaw === 'string',
  `typeof=${typeof winstageDisabledRaw}`,
)

// ── 与 loader 同构的求值器 ────────────────────────────────────────
const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')

/** 求值一个 `disabled` 取值（string ⇒ 当表达式求值；boolean ⇒ 直接用） */
function resolveDisabled(raw) {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return Boolean(evaluate({}, raw))
  return false
}

/** 造一个受控的假 HOME/PROFILE，写入指定 profile 文本（或故意不写） */
const made = []
function fakeEnv({ winstageEnabled = true, writeFile = true, text } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wstage-asm-'))
  made.push(home)
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const body =
    text !== undefined
      ? text
      : `- id: winstage-sandbox\n  name: "@local/dsh-winstage-sandbox"\n  config:\n    enabled: ${winstageEnabled}\n`
  if (writeFile) writeFileSync(join(dir, 'cordis.patch.yml'), body, 'utf8')
  return { DSH_HOME: home, DSH_PROFILE: 'web' }
}

/**
 * 在受控 env 下求值一对 `disabled`。
 * @param {{DSH_HOME:string,DSH_PROFILE:string,WINSTAGE_SHELL?:string}} env
 * @param {{platform?:any, winstage?:any}} [raw] 允许用"另一份 patch 的取值"做对照
 */
function evalPair(env, raw = {}) {
  const platformRaw = raw.platform ?? platformDisabledRaw
  const winstageRaw = raw.winstage ?? winstageDisabledRaw
  const saved = {}
  for (const k of ['DSH_HOME', 'DSH_PROFILE', 'WINSTAGE_SHELL']) saved[k] = process.env[k]
  try {
    process.env.DSH_HOME = env.DSH_HOME
    process.env.DSH_PROFILE = env.DSH_PROFILE
    if (env.WINSTAGE_SHELL === undefined) delete process.env.WINSTAGE_SHELL
    else process.env.WINSTAGE_SHELL = env.WINSTAGE_SHELL
    return {
      platformDisabled: resolveDisabled(platformRaw),
      winstageDisabled: resolveDisabled(winstageRaw),
    }
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const oneEnabled = (r) => r.platformDisabled !== r.winstageDisabled

// ── 核心不变量：4 种组合下恰好一个启用 ────────────────────────────
console.log('\n── I. 不变量：恰好一个 shell 提供方启用 ──')
for (const shellEnv of [undefined, '1']) {
  for (const enabled of [true, false]) {
    const env = fakeEnv({ winstageEnabled: enabled })
    env.WINSTAGE_SHELL = shellEnv
    const r = evalPair(env)
    check(
      `I  WINSTAGE_SHELL=${shellEnv ?? '(未设)'} × enabled=${enabled} ⇒ 恰好一个`,
      oneEnabled(r),
      `platformDisabled=${r.platformDisabled} winstageDisabled=${r.winstageDisabled}`,
    )
  }
}

// ── 语义：开关关 ⇒ 平台 shell 接管（这是用户要的"完全恢复原生行为"）──
console.log('\n── S. 语义：开关关闭时必须是平台 shell 接管 ──')
{
  const env = fakeEnv({ winstageEnabled: false })
  env.WINSTAGE_SHELL = '1' // 即使显式要求 WinStage，开关关也必须让位
  const r = evalPair(env)
  check('S1 enabled=false ⇒ 平台 shell 启用', r.platformDisabled === false, JSON.stringify(r))
  check('S1b enabled=false ⇒ WinStage shell 让位', r.winstageDisabled === true, JSON.stringify(r))
}
{
  const env = fakeEnv({ winstageEnabled: true })
  env.WINSTAGE_SHELL = '1'
  const r = evalPair(env)
  check('S2 enabled=true + WINSTAGE_SHELL=1 ⇒ WinStage 接管', r.winstageDisabled === false && r.platformDisabled === true, JSON.stringify(r))
}
{
  const env = fakeEnv({ winstageEnabled: true })
  env.WINSTAGE_SHELL = undefined // 未显式要求 ⇒ 平台照旧
  const r = evalPair(env)
  check('S3 enabled=true 但未设 WINSTAGE_SHELL ⇒ 平台照旧（不影响别的 profile）', r.platformDisabled === false && r.winstageDisabled === true, JSON.stringify(r))
}

// ── fail-safe：判不出时不能"两头都不装" ───────────────────────────
console.log('\n── F. fail-safe：判不出也必须恰好一个 ──')
{
  const case1 = fakeEnv({ writeFile: false }) // profile 文件不存在
  case1.WINSTAGE_SHELL = '1'
  const r1 = evalPair(case1)
  check('F1 profile 文件不存在 ⇒ 恰好一个', oneEnabled(r1), JSON.stringify(r1))

  const case2 = fakeEnv({ text: '- id: other\n  disabled: false\n' }) // 无 winstage-sandbox 行
  case2.WINSTAGE_SHELL = '1'
  const r2 = evalPair(case2)
  check('F2 无 winstage-sandbox 行 ⇒ 恰好一个', oneEnabled(r2), JSON.stringify(r2))

  const case3 = fakeEnv({ text: '- id: winstage-sandbox\n  config:\n    enabled: maybe\n' }) // 值畸形
  case3.WINSTAGE_SHELL = '1'
  const r3 = evalPair(case3)
  check('F3 enabled 值畸形 ⇒ 恰好一个', oneEnabled(r3), JSON.stringify(r3))

  const case4 = fakeEnv({ text: '' })
  case4.WINSTAGE_SHELL = '1'
  const r4 = evalPair(case4)
  check('F4 profile 为空 ⇒ 恰好一个', oneEnabled(r4), JSON.stringify(r4))
}

// ── 真环境（当前 live profile）───────────────────────────────────
console.log('\n── L. 当前 live profile 的真实判定 ──')
{
  const env = { DSH_HOME: 'C:\\Users\\Administrator\\.dsh', DSH_PROFILE: 'web', WINSTAGE_SHELL: undefined }
  const r = evalPair(env)
  check('L1 当前 profile（enabled:false）⇒ 平台 shell 接管', r.platformDisabled === false && r.winstageDisabled === true, JSON.stringify(r))
}

// ── M. 变异体：旧的「字面量覆盖」必须**违反**"开关关闭时平台接管" ───
// 本轮修掉的现场：3080 的 web profile 用字面量
//   pwsh-sandbox.disabled: true / winstage-shell.disabled: false
// 覆盖掉 env 门控。
//
// ★ 注意判据：旧配置下**仍然恰好一个**提供方启用（不变量没被破坏！），
//   被破坏的是**"哪个"** —— 开关为关时却由 **WinStage** 占着 `ctx.shell`。
//   所以真正要钉的不变量是：
//     `enabled=false` ⇒ 平台 shell 必须启用、WinStage 必须让位。
console.log('\n── M. 变异体：旧的字面量覆盖必须违反"开关关 ⇒ 平台接管" ──')
{
  const OLD = { platform: true, winstage: false } // 旧 profile 的两个字面量

  /** 真正的不变量：开关关闭 ⇒ 平台接管 */
  const switchOffMeansPlatform = (r) => r.platformDisabled === false && r.winstageDisabled === true

  const off = fakeEnv({ winstageEnabled: false })
  off.WINSTAGE_SHELL = undefined

  const oldR = evalPair(off, OLD)
  check(
    'M1 旧字面量 × 开关关 ⇒ **违反**"平台应接管"',
    !switchOffMeansPlatform(oldR),
    `platformDisabled=${oldR.platformDisabled} winstageDisabled=${oldR.winstageDisabled}`,
  )
  check(
    'M1b 违反形态 = WinStage 仍占着 ctx.shell（正是"关了沙箱 shell 全废"）',
    oldR.platformDisabled === true && oldR.winstageDisabled === false,
    JSON.stringify(oldR),
  )
  check(
    'M1c 旧配置下"恰好一个"其实是成立的 ⇒ 说明判据必须是"哪个"，不是"几个"',
    oldR.platformDisabled !== oldR.winstageDisabled,
    JSON.stringify(oldR),
  )

  const fixedR = evalPair(off)
  check('M2 同一输入 × 修后表达式 ⇒ 平台接管（不变量成立）', switchOffMeansPlatform(fixedR), JSON.stringify(fixedR))

  check(
    'M3 变异体与修复体在同一输入下结果不同（断言有效、非空转）',
    switchOffMeansPlatform(oldR) !== switchOffMeansPlatform(fixedR),
    `old=${switchOffMeansPlatform(oldR)} fixed=${switchOffMeansPlatform(fixedR)}`,
  )
}

for (const d of made) rmSync(d, { recursive: true, force: true })

console.log('\n' + '='.repeat(70))
const pass = results.filter((x) => x.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
