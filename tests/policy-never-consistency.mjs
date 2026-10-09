#!/usr/bin/env node
/**
 * policy-never-consistency —— 审批策略 `ask→never` / 文件策略 `workspace-write→danger-full-access`
 * 之下的 **WinStage 用户感知一致性守门套件**（侦察清单 C3）。
 * ============================================================================
 * 侦察结论（`docs/审批策略never-用户感知一致性-分析与实施清单.md` §1–§2，本文件不复述其推理）：
 * 本轮策略变化**没有**任何"由 WinStage 插件自身行为在当前装配下造成"的用户可感知差异。
 * 但有三件事是"一旦回归，用户就直接看不见某些东西"，必须从人工记忆变成机器断言：
 *
 * ① **潜在硬断裂（最高价值，检查 1）**
 *    装配期 `derive(EMPTY_KNOBS)` = `ctx.shell.sandboxMode` + `ctx.approval.config.policy`
 *    （`R\dsh-permission-presets\lib\index.js:178,295-306`，`R\` = 只读 harness 安装路径）。
 *    若组合出来是 `custom` 且**没有**显式 `defaultPreset`，构造器**抛错**：
 *      `R\dsh-permission-presets\lib\index.js:180`
 *      `permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly`
 *    ⇒ `permission` 行装不上 ⇒ `permissions` 投影缺失 ⇒ 客户端 `PermissionSelect` 返回 `null`
 *       （`R\dsh-client-ui-permission-presets\lib\client.js:324`）
 *    ⇒ **composer 的访问模式控件整块消失**（开关为 off 时用户在那个位置什么都看不到）。
 *    `[官方]`（读 harness 源码；**本轮未在真实装配中复现** —— 需要重启宿主 + 改 profile，超出授权）。
 *    当前唯一掩蔽物是活动 profile 里的**显式 `defaultPreset`**
 *    （`~/.dsh/profiles/<name>/cordis.patch.yml`；bundle 层只有 `presets`、没有 `defaultPreset`）。
 *    本套件把这条掩蔽物钉住：删掉它、或把它改成一个不在 `presets` 里的名字，立刻见红。
 *
 * ② **`sandboxMode` 必须保持静态、最窄（检查 2）**
 *    `dsh-plugin/shell-executor.mjs` 的 `get sandboxMode()` 恒报 `'workspace-write'`。
 *    改成"反映生效档位"会同时破坏两件事：
 *      - `R\dsh-permission-presets\lib\index.js:387`（会话没有 `sandbox/mode` 事件时，把
 *        `ctx.shell.sandboxMode` **写进会话日志**）与执行器互相追随 ⇒ 形成**会话档位反馈环**；
 *      - `R\dsh-tool-fs\lib\index.js:1082-1088` / `R\dsh-tool-pwsh\lib\index.js:314-319` 那类
 *        "有围栏 ⇒ 必须要求 `ctx.sandboxPolicy`"的装配语义被改写。
 *    `.t/shell-selftest.mjs` 的 S1.2 / S1.2b / S1.2c / S3b.2 / M1 已从**执行器行为**侧钉死；
 *    本套件从**源码文本**侧再钉一次（两条独立通道，改坏任一条都见红）。
 *
 * ③ **审批策略不得参与任何用户可见判定（检查 3 / 4）**
 *    `conversation.input.permission` 槽位的接管只看 WinStage 自己的三态开关
 *    （`readSwitch(form) === 'on'`）；WinStage 的批准/拒绝走自己的 `review.json` + `/winstage`
 *    命令面，**不经过** `ctx.approval`。这正是 `never` 下面板照旧在场、审批照旧可用的原因。
 *
 * 本套件**离线、确定性、零子进程、零管理员、零网络、不启动 harness**：
 * 输入只有"源码文本 + 活动 profile 文本 + 纯函数调用"（`audit-mirror.mjs` 的导出），
 * 因此结论是 `[实测]`（跑的就是本机当前文件内容）。读不到的部分（env 未设 / 文件不可读 /
 * 值不是可静态求值的字面量）一律 **SKIP 并写明原因**，绝不用假 PASS 掩盖。
 *
 * 用法：
 *   node tests\policy-never-consistency.mjs           # 正常，应当全绿，退出码 0
 *   node tests\policy-never-consistency.mjs --plant   # 只扰动**测试这一侧的输入副本**，应当见红，退出码 1
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuditMirror, hasOpenTurn, winStageApprovalId } from '../dsh-plugin/audit-mirror.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)

let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}\n      原因: ${reason}`)
}

function section(title) {
  W('')
  W(`=== ${title} ===`)
}

function readText(absPath) {
  try {
    return { text: readFileSync(absPath, 'utf8') }
  } catch (error) {
    return { error: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}` }
  }
}

/**
 * 极小的 JS 词法投影：注释、（可选）字符串内容替换成**等长**空白。
 * 长度不变 ⇒ 可以用同一套下标在原串上做括号配平切片。
 * 只服务本套件的源码级断言，不试图做完整 JS 解析（模板字面量的 `${}` 不展开，本仓库用不到）。
 */
function project(src, { blankStrings = true } = {}) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = c; out += blankStrings ? ' ' : c; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n' } else out += ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // 字符串内部
    if (c === '\\') {
      out += blankStrings ? '  ' : `${c}${d ?? ''}`
      i += 2
      continue
    }
    if (c === state) { state = 'code'; out += blankStrings ? ' ' : c; i += 1; continue }
    out += c === '\n' ? '\n' : blankStrings ? ' ' : c
    i += 1
  }
  return out
}

const stripComments = (src) => project(src, { blankStrings: false })
const blankAll = (src) => project(src, { blankStrings: true })

/**
 * **不依赖词法投影**的"只看代码行"提取：去掉行尾 `// …` 注释，丢掉整行注释
 * （`//`、`*`、`/*` 开头的行）。用来扫"源码里有没有真的用某个 API"。
 * 为什么不用上面的投影：投影会在 JS 正则字面量（里面可能带引号）处错位；
 * 这个行级提取没有这个问题，代价是"字符串字面量里的同名 token 也会被算命中"——
 * 对"不得使用 ctx.approval"这条断言来说，宁可误报（红）也不漏报（假绿）。
 */
function codeLinesOnly(src) {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join('\n')
}

/** 从 `{` 开始做括号配平，返回 `{ start, end, text }`（下标与原串一致） */
function balancedBraces(src, openIndex) {
  const clean = blankAll(src)
  let depth = 0
  for (let i = openIndex; i < clean.length; i += 1) {
    if (clean[i] === '{') depth += 1
    else if (clean[i] === '}') {
      depth -= 1
      if (depth === 0) return { start: openIndex, end: i + 1, text: src.slice(openIndex, i + 1) }
    }
  }
  return null
}

// ── 1. 潜在硬断裂的守门：活动 profile 的 permission 行必须有显式且自洽的 defaultPreset ──

/**
 * 从 profile patch 文本里取 `- id: permission` 那一行条目，返回
 * `{ defaultPreset, presets }` 或 `null`（没有该条目）。
 * 只做行级解析（YAML 的一个受控子集：顶层 `- id:` 条目 / `key: value` / 注释），
 * 刻意**不**引入 YAML 依赖（离线确定性 + 零依赖）。
 */
function parsePermissionRow(text) {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s*id:\s*['"]?permission['"]?\s*(#.*)?$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*-\s+\S/.test(lines[i])) { end = i; break }
  }

  let defaultPreset
  let presetsIndent = -1
  let presetIndent = -1
  const presets = []
  for (const raw of lines.slice(start, end)) {
    const line = raw.replace(/#.*$/, '')
    if (line.trim() === '') continue
    const m = /^(\s*)([^\s:#][^:]*?):\s*(.*)$/.exec(line)
    if (!m) continue
    const indent = m[1].length
    const key = m[2].trim()
    const value = m[3].trim().replace(/^['"]|['"]$/g, '')
    if (presetsIndent >= 0 && indent > presetsIndent) {
      if (presetIndent < 0) presetIndent = indent
      if (indent === presetIndent) presets.push(key)
      continue
    }
    presetsIndent = -1
    if (key === 'presets' && value === '') { presetsIndent = indent; continue }
    if (key === 'defaultPreset') defaultPreset = value
  }
  return { defaultPreset, presets }
}

section('1. 潜在硬断裂：活动 profile 的 permission 行必须有**显式** defaultPreset（缺失 ⇒ 控件整块消失）')

const dshHome = process.env.DSH_HOME
const dshProfile = process.env.DSH_PROFILE
let profileAbs = null
if (typeof dshHome === 'string' && dshHome.length > 0 && typeof dshProfile === 'string' && dshProfile.length > 0) {
  profileAbs = join(dshHome, 'profiles', dshProfile, 'cordis.patch.yml')
}
if (profileAbs === null) {
  skip('1.1 活动 profile 的 cordis.patch.yml 可读', 'DSH_HOME / DSH_PROFILE 未设置，无法定位活动 profile（不猜路径，不假 PASS）')
  skip('1.2 permission 行存在', '同上：没有活动 profile 路径')
  skip('1.3 行内有显式 defaultPreset', '同上：没有活动 profile 路径')
  skip('1.4 defaultPreset 指向 presets 里定义的预设', '同上：没有活动 profile 路径')
} else {
  const read = readText(profileAbs)
  if (read.error) {
    skip('1.1 活动 profile 的 cordis.patch.yml 可读', `${profileAbs} 读取失败（${read.error}）`)
    skip('1.2 permission 行存在', '同上：profile 文件不可读')
    skip('1.3 行内有显式 defaultPreset', '同上：profile 文件不可读')
    skip('1.4 defaultPreset 指向 presets 里定义的预设', '同上：profile 文件不可读')
  } else {
    check('1.1 活动 profile 的 cordis.patch.yml 可读', true, `DSH_HOME=${dshHome} DSH_PROFILE=${dshProfile}`)
    // --plant：在**内存副本**上删掉 defaultPreset 行（绝不改真实 profile）
    const profileText = PLANT ? read.text.replace(/^[ \t]*defaultPreset:.*$/m, '') : read.text
    const row = parsePermissionRow(profileText)
    check(
      '1.2 permission 行存在（id: permission）',
      row !== null,
      row === null ? '活动 profile 里没有 `- id: permission` 条目（bundle 层没有 defaultPreset，掩蔽物消失）' : `${profileAbs}`,
    )
    if (row === null) {
      check('1.3 行内有显式 defaultPreset', false, '整行不存在 ⇒ 无法给出显式 defaultPreset')
      check('1.4 defaultPreset 指向 presets 里定义的预设', false, '整行不存在 ⇒ 无法给出显式 defaultPreset')
    } else {
      const explicit = typeof row.defaultPreset === 'string' && row.defaultPreset.length > 0
      check(
        '1.3 行内有显式 defaultPreset',
        explicit,
        explicit
          ? `defaultPreset=${row.defaultPreset}${PLANT ? '（--plant 已删除该行）' : ''}`
          : '缺失 ⇒ derive(EMPTY_KNOBS)==="custom" 时 permission 行会抛错装不上（R\\dsh-permission-presets\\lib\\index.js:180）',
      )
      if (!explicit) {
        check('1.4 defaultPreset 指向 presets 里定义的预设', false, '没有 defaultPreset 可校验')
      } else if (row.defaultPreset.startsWith('!!')) {
        skip(
          '1.4 defaultPreset 指向 presets 里定义的预设',
          `defaultPreset 是 \`${row.defaultPreset}\` 形式的表达式，离线无法求值（不猜测其取值）`,
        )
      } else {
        check(
          '1.4 defaultPreset 指向 presets 里定义的预设',
          row.presets.includes(row.defaultPreset),
          `defaultPreset=${row.defaultPreset}；presets=[${row.presets.join(', ')}]`,
        )
      }
    }
  }
}

// ── 2. 钉住"必须永不发生"的改动：sandboxMode 静态 + 最窄 ─────────────────────

section('2. sandboxMode 必须恒报最窄可用档，且不读 spec / 会话档位 / 审批策略（静态源码断言）')

const shellPath = join(REPO, 'dsh-plugin', 'shell-executor.mjs')
const shellRead = readText(shellPath)
if (shellRead.error) {
  skip('2.1 恰好一处 `get sandboxMode()`，且体是 `return <字符串字面量>` 形态', `${shellPath} 读取失败（${shellRead.error}）`)
  skip("2.2 恒报最窄可用档 'workspace-write'", '同上：源文件不可读')
  skip('2.3 体是单一 return 字面量（无分支 / 无拼接 / 无 ??）', '同上：源文件不可读')
  skip('2.4 体里不读 spec / session / approval / policy / ctx / this', '同上：源文件不可读')
} else {
  const plantedShell = PLANT ? shellRead.text.replace(/return\s+'workspace-write'/, 'return undefined') : shellRead.text
  // 刻意**锚定源码原文的形状**（而不是先做全局词法投影）：投影会在正则字面量处错位，
  // 而这里的判据本身就要求"这个 getter 只能长成这一个样子" —— 任何改写都必须先改本套件。
  const getterHeads = [...codeLinesOnly(plantedShell).matchAll(/get\s+sandboxMode\s*\(\s*\)\s*\{/g)]
  const bodyMatch = /get\s+sandboxMode\s*\(\s*\)\s*\{\s*return\s+('([^']*)'|"([^"]*)")\s*;?\s*\}/.exec(plantedShell)
  const getterText = bodyMatch ? bodyMatch[0] : ''
  const bodyInner = getterText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '').trim()
  check(
    '2.1 恰好一处 `get sandboxMode()`，且体是 `return <字符串字面量>` 形态',
    getterHeads.length === 1 && bodyMatch !== null,
    bodyMatch ? `getter=${JSON.stringify(getterText)}` : `getter 出现 ${getterHeads.length} 次；体不是单一 return 字符串字面量`,
  )

  const returned = bodyMatch ? bodyMatch[2] ?? bodyMatch[3] : undefined
  check(
    "2.2 恒报最窄可用档 `'workspace-write'`（非空字符串字面量，不是 undefined / null / 表达式）",
    returned === 'workspace-write',
    `实际 return 值 = ${returned === undefined ? '(不是字符串字面量 / 找不到 return)' : JSON.stringify(returned)}`,
  )
  check(
    '2.3 体是单一 return 字面量（无分支 / 无拼接 / 无 ??）',
    bodyMatch !== null && /^return\s+['"][^'"]*['"]\s*;?$/.test(bodyInner),
    `体内文 = ${JSON.stringify(bodyInner)}`,
  )
  const dynamicTokens = /\b(spec|session|approval|policy|ctx|this|requested|target|effective)\b/.exec(bodyInner)
  check(
    '2.4 体里不读 spec / session / approval / policy / ctx / this（否则形成会话档位反馈环）',
    dynamicTokens === null,
    dynamicTokens === null ? '体里没有任何外部输入' : `命中动态标识符：${dynamicTokens[1]}`,
  )
}

// ── 3. 钉住"面板只看自己的开关"：策略值不得参与槽位接管 ───────────────────────

section('3. `conversation.input.permission` 的接管只由 WinStage 三态开关驱动（策略无关）')

const clientPath = join(REPO, 'dsh-plugin', 'client.js')
const clientRead = readText(clientPath)
if (clientRead.error) {
  skip('3.1 找到 conversation.input.permission 的注入块', `${clientPath} 读取失败（${clientRead.error}）`)
  skip("3.2 判据严格等于 'on'（readSwitch(form) === 'on'）", '同上：源文件不可读')
  skip('3.3 注册 / 撤销只由该判据驱动', '同上：源文件不可读')
  skip('3.4 块内没有 approval / preset / sandboxMode 等策略值参与', '同上：源文件不可读')
} else {
  const plantedClient = PLANT
    ? // 只扰动**代码里**那一处（文件第 28 行的注释里也有同样的字面量，不能误伤到它）
      clientRead.text.replace(
        "const readEnabled = () => readSwitch(form) === 'on'",
        "const readEnabled = () => readSwitch(form) !== 'off'",
      )
    : clientRead.text
  const clientCode = stripComments(plantedClient)
  const anchor = clientCode.indexOf("inject('conversation.input.permission'")
  const blockOpen = anchor >= 0 ? clientCode.indexOf('{', clientCode.indexOf('=>', anchor)) : -1
  const block = blockOpen >= 0 ? balancedBraces(plantedClient, blockOpen) : null
  const blockText = block ? block.text : ''
  const blockCode = stripComments(blockText)
  check(
    '3.1 找到 conversation.input.permission 的注入块',
    anchor >= 0 && blockText.length > 0,
    block ? `块长度=${blockText.length} 字节` : '没找到注入块',
  )
  check(
    "3.2 判据严格等于 'on'（readSwitch(form) === 'on'）",
    /const\s+readEnabled\s*=\s*\(\s*\)\s*=>\s*readSwitch\(form\)\s*===\s*'on'/.test(blockCode),
    "`'unknown'` / `'loading'` 是真值字符串：少写这个严格比较就退回 fail-open（旧缺陷形态）",
  )
  check(
    '3.3 注册 / 撤销只由该判据驱动（on ⇒ register(permissionEntry)；!on ⇒ dispose）',
    /if\s*\(\s*on\s*&&\s*!dispose\s*\)\s*dispose\s*=\s*ctx\.slots\.register\(permissionEntry/.test(blockCode) &&
      /else\s+if\s*\(\s*!on\s*&&\s*dispose\s*\)/.test(blockCode),
    blockCode.includes('register(permissionEntry') ? '注册与撤销都挂在 on 上' : '找不到 register(permissionEntry) 分支',
  )
  const policyToken = /\b(approval|preset|presets|sandboxMode)\b|danger-full-access|workspace-write|read-only/.exec(blankAll(blockText))
  check(
    '3.4 块内没有 approval / preset / sandboxMode 等策略值参与判定',
    policyToken === null,
    policyToken === null ? '去注释去字符串后块内无任何策略标识符' : `命中策略标识符：${policyToken[0]}`,
  )
}

// ── 4. WinStage 审批不经过平台审批 seam ─────────────────────────────────────

section('4. WinStage 审批走自己的 review.json + /winstage 命令面，不经过 ctx.approval')

const seamToken = /\bctx\s*\.\s*approval\b|\bapprover\b|\brequestApproval\b|approval\s*\/\s*request/
for (const rel of ['dsh-plugin/review-service.mjs', 'dsh-plugin/host-plugin.mjs']) {
  const abs = join(REPO, rel)
  const read = readText(abs)
  if (read.error) {
    skip(`4.x ${rel} 不使用平台审批 seam`, `${abs} 读取失败（${read.error}）`)
    continue
  }
  const planted = PLANT && rel.endsWith('host-plugin.mjs') ? `${read.text}\nvoid ctx.approval\n` : read.text
  const hit = seamToken.exec(codeLinesOnly(planted))
  check(
    `${rel} 不使用 ctx.approval / approver / approval-request（只看代码行）`,
    hit === null,
    hit === null ? '0 命中（该文件里 approval 只出现在注释里）' : `命中：${hit[0]}`,
  )
}

const hostRead = readText(join(REPO, 'dsh-plugin', 'host-plugin.mjs'))
check(
  '4.3 host-plugin 仍然注册自己的 /winstage* 命令面（审批有自己的通路）',
  hostRead.error ? false : /registerCommands\s*\(/.test(hostRead.text) && /name:\s*'winstage'/.test(hostRead.text),
  hostRead.error ? `host-plugin.mjs 读取失败（${hostRead.error}）` : "命中 registerCommands( 与 name: 'winstage'",
)

// ── 5. 行为断言：审计镜像绝不自己编造决策 ───────────────────────────────────

section('5. audit-mirror 行为：不编造 decided；回合未开宁可跳过也不写孤儿事件')

/** 假 session 汇（形状照 `audit-mirror.hasOpenTurn` 的读取面：`seq` + `eventAt(i)` + `append`） */
function makeSession(events = [], { appendThrows = false } = {}) {
  const list = events.map((e) => ({ ...e }))
  return {
    get seq() { return list.length },
    eventAt: (i) => list[i],
    append: (type, data) => {
      if (appendThrows) throw new Error('append 失败（注入）')
      list.push({ type, data })
    },
    list,
  }
}

const byType = (session, type) => session.list.filter((e) => e.type === type)
const openTurn = () => makeSession([{ type: 'turn/start', data: { turnId: 't1' } }])
const closedTurn = () => makeSession([{ type: 'turn/start', data: {} }, { type: 'turn/end', data: {} }])

/**
 * `--plant` 的变异体**只在这里**：把"审计镜像自己补一个 decided"（谎报决策）与
 * "跳过回合校验直接写"这两种缺陷形态注入被测装配，用来证明上面的断言真的能红。
 */
function makeMirror(sessionOf, hooks = {}) {
  const real = createAuditMirror({ sessionOf, ...hooks })
  if (!PLANT) return real
  return {
    ask(info = {}) {
      const wrote = real.ask(info)
      try {
        sessionOf()?.append?.('approval/decided', { id: winStageApprovalId(info.candidateId), outcome: 'allowed-once' })
      } catch {
        /* 变异体自身不抛 */
      }
      return wrote
    },
    decide: (info = {}) => real.decide(info),
  }
}

check(
  '5.1 模块导出 createAuditMirror / hasOpenTurn / winStageApprovalId（行为断言的前提）',
  typeof createAuditMirror === 'function' && typeof hasOpenTurn === 'function' && typeof winStageApprovalId === 'function',
  `id 形态示例 = ${winStageApprovalId('cs_0001')}`,
)

// 5.2 暂存 ⇒ 写 approval/asked
const s1 = openTurn()
const m1 = makeMirror(() => s1)
const askedOk = m1.ask({ candidateId: 'cs_0001', fileCount: 2 })
const askedEvents = byType(s1, 'approval/asked')
const asked0 = askedEvents[0]?.data
check(
  '5.2 暂存候选 ⇒ 写 approval/asked 并返回真值（id/toolName/reason 齐备）',
  askedOk === true &&
    askedEvents.length === 1 &&
    asked0?.id === 'winstage:cs_0001' &&
    asked0?.toolName === 'winstage-stage' &&
    typeof asked0?.reason === 'string' &&
    asked0.reason.length > 0,
  `返回=${askedOk}；事件=${JSON.stringify(asked0)}`,
)
check(
  '5.3 ask() 自己不产生任何 approval/decided（审计镜像不得编造决策）',
  byType(s1, 'approval/decided').length === 0,
  `asked=${askedEvents.length} decided=${byType(s1, 'approval/decided').length}`,
)

// 5.4 反复暂存同样不产生 decided
const s2 = openTurn()
const m2 = makeMirror(() => s2)
m2.ask({ candidateId: 'cs_0002' })
m2.ask({ candidateId: 'cs_0003' })
check(
  '5.4 重复暂存（两次 ask）仍不产生任何 decided',
  byType(s2, 'approval/asked').length === 2 && byType(s2, 'approval/decided').length === 0,
  `asked=${byType(s2, 'approval/asked').length} decided=${byType(s2, 'approval/decided').length}`,
)

// 5.5 真实调用序列（ask → decide）：顺序 + 同 id
const s3 = openTurn()
const m3 = makeMirror(() => s3)
m3.ask({ candidateId: 'cs_0004', fileCount: 1 })
const decideOk = m3.decide({ candidateId: 'cs_0004', approved: true, pathCount: 1 })
const firstAsked = s3.list.findIndex((e) => e.type === 'approval/asked')
const s3AskedId = s3.list[firstAsked]?.data?.id
const decidedIndex = s3.list.findIndex((e) => e.type === 'approval/decided')
const decidedData = s3.list[decidedIndex]?.data
const everyDecidedPaired = s3.list
  .map((e, i) => ({ e, i }))
  .filter(({ e }) => e.type === 'approval/decided')
  .every(({ e, i }) => s3.list.slice(0, i).some((p) => p.type === 'approval/asked' && p.data?.id === e.data?.id))
check(
  '5.5 decide() 只在配对的 asked 之后写 decided，且 id 与 asked 完全相同',
  decideOk === true && firstAsked >= 0 && decidedIndex > firstAsked && decidedData?.id === s3AskedId && everyDecidedPaired,
  `asked#${firstAsked} → decided#${decidedIndex}；decided=${JSON.stringify(decidedData)}；asked id=${s3AskedId}`,
)

// 5.6 outcome 语义照抄原生（批准 = allowed-once，唯一的授予值；否则 rejected）
const outcomeOk = decidedData?.outcome === 'allowed-once'
const rejectSession = openTurn()
const rejectMirror = makeMirror(() => rejectSession)
rejectMirror.ask({ candidateId: 'cs_0005' })
rejectMirror.decide({ candidateId: 'cs_0005', approved: false, note: 'user-rejected' })
const rejected = byType(rejectSession, 'approval/decided')[0]?.data
check(
  "5.6 outcome 语义：approved ⇒ 'allowed-once'；否则 'rejected'（note 透传）",
  outcomeOk && rejected?.outcome === 'rejected' && rejected?.note === 'user-rejected',
  `allowed-once=${outcomeOk}；rejected=${JSON.stringify(rejected)}`,
)

// 5.7 hasOpenTurn 真值表
const turnTable =
  hasOpenTurn(makeSession([])) === false &&
  hasOpenTurn(makeSession([{ type: 'turn/start', data: {} }])) === true &&
  hasOpenTurn(closedTurn()) === false
check('5.7 hasOpenTurn 真值表：无事件 / 开着 / 已关闭', turnTable, '[] ⇒ false；[turn/start] ⇒ true；[start,end] ⇒ false')

// 5.8 回合未开：ask 跳过（falsy）且**零事件**（不写孤儿 asked）
const s4 = closedTurn()
const m4 = makeMirror(() => s4)
const closedAsk = m4.ask({ candidateId: 'cs_0006' })
check(
  '5.8 回合未开时 ask 跳过并返回 falsy，且一个事件都不写（不造孤儿 asked）',
  !closedAsk && s4.list.length === 2,
  `返回=${JSON.stringify(closedAsk)}；事件数=${s4.list.length}（应与建会话时相同）`,
)

// 5.9 回合未开：decide 同样跳过（不写孤儿 decided）
const s5 = closedTurn()
const m5 = makeMirror(() => s5)
const closedDecide = m5.decide({ candidateId: 'cs_0006', approved: true })
check(
  '5.9 回合未开时 decide 同样跳过（绝不写无配对的 decided）',
  !closedDecide && byType(s5, 'approval/decided').length === 0 && s5.list.length === 2,
  `返回=${JSON.stringify(closedDecide)}；decided=${byType(s5, 'approval/decided').length}；事件数=${s5.list.length}`,
)

// 5.10 拿不到 session 句柄：跳过且不抛
const m6 = makeMirror(() => undefined)
const noSession = m6.ask({ candidateId: 'cs_0007' })
check('5.10 拿不到 session 句柄时跳过（falsy）且不抛', !noSession, `返回=${JSON.stringify(noSession)}`)

// 5.11 append 抛错必须被吞掉（审计失败绝不影响审批）
const s6 = openTurn()
const errorLogs = []
const m7 = makeMirror(() => makeSession([{ type: 'turn/start', data: {} }], { appendThrows: true }), {
  logError: (msg) => errorLogs.push(msg),
})
let threw = false
let throwResult
try {
  throwResult = m7.ask({ candidateId: 'cs_0008' })
} catch {
  threw = true
}
check(
  '5.11 append 抛错被吞掉（不抛给调用方）+ 返回 falsy + error 级日志可见',
  !threw && !throwResult && errorLogs.length === 1,
  `抛出=${threw}；返回=${JSON.stringify(throwResult)}；error 日志=${errorLogs.length} 条`,
)
void s6

/**
 * 明确 SKIP 的一项（诚实性纪律：不与现状冲突地"断言"一个模块并不具备的性质）。
 * `audit-mirror.decide()` 不做"先前是否写过同 id 的 asked"的校验；配对由**调用方顺序**
 * （`review-service.mjs:549` 建候选时 ask、`:963/:1114` 落盘/拒绝时 decide）与平台不变式
 * （`R\dsh-user-approval\lib\invariant.js:213`：decided 找不到 asked 即抛 InvariantError）兜底。
 * "跨回合：asked 因回合未开被跳过、之后回合内批准 ⇒ 孤儿 decided"这一场景需要真装配 + 人为时序，
 * 离线无法证伪；把它写成 PASS 是假绿，写成 FAIL 又与现状语义冲突 ⇒ SKIP 并写明。
 */
skip(
  '5.12 decide() 强制"必须已有同 id 的 asked"才写（模块级配对校验）',
  '当前实现只做 emit，不校验配对；配对由调用方调用顺序 + 平台 invariant（R\\dsh-user-approval\\lib\\invariant.js:213）兜底。' +
    '跨回合孤儿场景需真装配 + 人为时序，离线无法证伪 ⇒ 宁可 SKIP 也不假 PASS（见侦察清单 Q3-3.9 / V6）',
)

// ── 6. 文档真值（廉价漂移守卫） ─────────────────────────────────────────────

section('6. docs/DSH集成.md 不得再声称 sandboxMode 报 undefined')

const docPath = join(REPO, 'docs', 'DSH集成.md')
const docRead = readText(docPath)
if (docRead.error) {
  skip('6.1 docs/DSH集成.md 可读', `${docPath} 读取失败（${docRead.error}）`)
  skip('6.2 没有任何一行同时出现 sandboxMode 与 undefined', '同上：文档不可读')
  skip("6.3 有明确的更正说法（sandboxMode 报 'workspace-write'）", '同上：文档不可读')
} else {
  // --plant：在**内存副本**上追加旧说法（绝不改真实文档）
  const docText = PLANT ? `${docRead.text}\n\`sandboxMode\` 也刻意报 \`undefined\`（不广告升权）。\n` : docRead.text
  check('6.1 docs/DSH集成.md 可读', true, `${docPath}`)
  const lines = docText.split(/\r?\n/)
  const staleLine = lines.findIndex((line) => line.includes('sandboxMode') && line.includes('undefined'))
  check(
    '6.2 没有任何一行同时出现 sandboxMode 与 undefined（旧说法 = 诱导后人"改回去"）',
    staleLine < 0,
    staleLine < 0 ? `${lines.length} 行扫描完毕，0 命中` : `第 ${staleLine + 1} 行：${lines[staleLine].trim()}`,
  )
  const sandboxWindows = [...docText.matchAll(/sandboxMode/g)].map((m) => docText.slice(m.index, m.index + 240))
  check(
    "6.3 有明确的更正说法（某处 sandboxMode 就近出现 'workspace-write'）",
    sandboxWindows.length > 0 && sandboxWindows.some((w) => w.includes("'workspace-write'")),
    sandboxWindows.length === 0
      ? '文档里根本没提 sandboxMode'
      : `${sandboxWindows.length} 处 sandboxMode，就近 240 字符内 ${sandboxWindows.some((w) => w.includes("'workspace-write'")) ? '有' : '没有'} 'workspace-write'`,
  )
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

if (PLANT) {
  check(
    '--plant 模式下失败项 ≥5（证明本套件的判定真的能红，而不是恒绿）',
    failures >= 5,
    `failures=${failures}（变异体：删 defaultPreset / sandboxMode=undefined / 判据 !=='off' / 注入 ctx.approval / 审计镜像自补 decided / 文档旧说法）`,
  )
}

W('')
W('='.repeat(72))
W(
  PLANT
    ? `策略无关性守门（--plant 模式：扰动输入副本，应当失败）：断言 ${assertions} 项，失败 ${failures} 项，SKIP ${skips} 项`
    : `策略无关性守门（离线静态 + 纯函数行为）：断言 ${assertions} 项，失败 ${failures} 项，SKIP ${skips} 项`,
)
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips} mode=${PLANT ? 'plant' : 'normal'}`)

process.exitCode = failures > 0 ? 1 : 0
