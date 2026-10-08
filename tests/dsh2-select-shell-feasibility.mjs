/**
 * 装配层"择一装载"可行性验证（离线、零依赖）
 *
 * 目的一：确认 `cordis.patch.yml` 的 `!!js` 表达式在**真实求值器**下能访问什么。
 *   求值器源码：cordis-plugin-loader/src/config/utils.ts:5-9
 *     new Function('ctx','expr', 'with (ctx) { return eval(expr) }')
 *
 * 目的二：给出"按开关择一装载 shell 提供方"的判定函数，并做变异体验证。
 *
 * 跑法：node docs/dsh2-装配择一-可行性.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL
 */

import { existsSync, readFileSync } from 'node:fs'

const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: ok === true })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail !== undefined ? `  —— ${detail}` : ''}`)
}
function t(expr) {
  try {
    return { ok: true, v: evaluate({}, expr) }
  } catch (e) {
    return { ok: false, err: `${e.constructor.name}: ${e.message}` }
  }
}

console.log('='.repeat(66))
console.log(' 装配层「择一装载」可行性：!!js 求值器能力探测')
console.log('='.repeat(66))

// ── A. 求值器能力 ────────────────────────────────────────────────
console.log('\n── A. !!js 在 with(ctx)+eval 下能访问什么 ──')
{
  const p = t("typeof process !== 'undefined' && process.platform === 'win32'")
  check('A1 process 可用', p.ok && p.v === true, JSON.stringify(p))

  const r = t('typeof require')
  check('A2 require 不可用（记录事实，不是缺陷）', r.ok && r.v === 'undefined', `typeof require = ${JSON.stringify(r.v ?? r.err)}`)

  const gm = t('typeof process.getBuiltinModule')
  check('A3 process.getBuiltinModule 可用', gm.ok && gm.v === 'function', JSON.stringify(gm.v ?? gm.err))

  const gf = t(
    "process.getBuiltinModule('node:fs').existsSync('C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml')",
  )
  check('A4 getBuiltinModule 能读文件系统', gf.ok && gf.v === true, JSON.stringify(gf.v ?? gf.err))

  const gr = t(
    "process.getBuiltinModule('node:fs').readFileSync('C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml','utf8').length > 0",
  )
  check('A5 getBuiltinModule 能读到 profile 内容', gr.ok && gr.v === true, JSON.stringify(gr.v ?? gr.err))
}

// ── B. 判定函数（建议实现的语义）──────────────────────────────────
console.log('\n── B. 从 profile 覆盖层文本判定 host 开关（建议实现）──')

/** 在 `id: winstage-sandbox` 之后最近的 `enabled:` 取布尔；判不出 ⇒ true（保持历史行为） */
function winstageEnabledOf(src) {
  const m = /id:\s*winstage-sandbox\b([\s\S]*?)(?=\n-\s*id:|\s*$)/.exec(src)
  if (!m) return true
  const e = /enabled:\s*(true|false)/.exec(m[1])
  if (!e) return true
  return e[1] !== 'false'
}

/** 择一装载判定：**出错 ⇒ 选平台原生 shell**（fail-safe，绝不两头都不装） */
function arbitrationOf(src) {
  let on
  try {
    on = winstageEnabledOf(src)
  } catch {
    on = false
  }
  return {
    winstageShellDisabled: !on, // host 关 ⇒ WinStage shell 让位
    platformShellDisabled: on, // host 开 ⇒ 平台 shell 让位
    winstageEnabled: on,
  }
}

{
  const profilePath = 'C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml'
  const text = readFileSync(profilePath, 'utf8')

  const on = winstageEnabledOf(text)
  check('B1 能从 profile 文本判定 host 开关', typeof on === 'boolean', `enabled=${on}`)
  check('B2 与该 profile 实际一致（当前 enabled: false）', on === false, `enabled=${on}`)

  const a = arbitrationOf(text)
  const exactlyOne = a.winstageShellDisabled !== a.platformShellDisabled
  check('B3 恰好一个 shell 提供方启用', exactlyOne, JSON.stringify(a))
  check(
    'B4 当前 profile ⇒ 平台 shell 启用、WinStage 让位',
    a.platformShellDisabled === false && a.winstageShellDisabled === true,
    JSON.stringify(a),
  )

  // 变异体：把 host 开关翻成 true ⇒ 判定必须翻转
  const mutSrc = text.replace(/(id:\s*winstage-sandbox\b[\s\S]*?)enabled:\s*false/, '$1enabled: true')
  const mut = arbitrationOf(mutSrc)
  check(
    'B5 变异体（enabled:true）⇒ 判定翻转、WinStage 接管',
    mut.winstageShellDisabled === false && mut.platformShellDisabled === true,
    JSON.stringify(mut),
  )
  check('B5b 变异体真的改到了输入（不是空转）', mut.winstageEnabled === true && on === false)

  // fail-safe：畸形输入绝不能"两头都不装"
  for (const [label, src] of [
    ['空串', ''],
    ['无 winstage-sandbox 行', '- id: other\n  disabled: false\n'],
    ['enabled 值畸形', '- id: winstage-sandbox\n  config:\n    enabled: maybe\n'],
  ]) {
    const r = arbitrationOf(src)
    const one = r.winstageShellDisabled !== r.platformShellDisabled
    check(`B6 fail-safe：${label} ⇒ 恰好一个启用`, one, JSON.stringify(r))
  }

  // 无 winstage-sandbox 行 ⇒ 视为开启（历史行为）⇒ WinStage 接管
  const noRow = arbitrationOf('- id: other\n')
  check('B7 找不到 host 行 ⇒ 保持历史行为（WinStage 接管）', noRow.winstageEnabled === true, JSON.stringify(noRow))
}

console.log('\n' + '='.repeat(66))
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(66))
process.exit(fail === 0 ? 0 : 1)
