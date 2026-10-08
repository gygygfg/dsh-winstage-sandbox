#!/usr/bin/env node
/**
 * residual-baseline —— **治理套件**：把"已知残余边界"冻结成基线断言
 * ============================================================================
 * 存在理由（对齐 NeoAI 的实践："已知残余要冻结为基线断言，任何漂移都要报警"）：
 *   本项目最危险的回归不是"某个函数写错了"，而是**声明面悄悄变宽** ——
 *   `docs/Windows功能开启清单.md` §13 的 R1–R12 被删掉几行、`summarise()` 的
 *   `guaranteesNotProvided` 少了一条、或者某处开始把"代码存在"读成"网络上真的挡住了"。
 *   这类漂移不会让任何既有套件变红，只会让**结论显得比实际更强**。
 *   所以这里把"残余还在不在"本身变成可执行断言：**报警，不迎合**。
 *
 * 检查分三段（每条一个 ✓/✗）：
 *   A. 文档基线：§13 残余表里 R1…R12 逐条仍在、无重复、每行都带证据标记（`[官方]`/`[实测]`/…）
 *   B. 声明面基线：`src/testrunner.mjs::summarise()` 的 `guaranteesNotProvided` 仍含
 *      读取面 R1 行、网络面 `[未实测]` 行、缓解策略 `[未实测]` 行、配额未端到端证明行；
 *      且**不再**沿用旧的笼统"网络硬阻断（受限令牌与 ACL 均不涉及网络…）"说法。
 *   C. 诚实比较不变量（用离线替身绑定表**真的调用** `src/netpolicy.mjs`）：
 *      - OFFLINE 缺前置能力 ⇒ `refused` 且 `enforced:false`（fail-closed）
 *      - 只有"确实装了 + 回读通过"才可能 `enforced:true`（另有正例证明这条判定非恒假）；
 *        D2 之后"确实装了"还要求证据**来源可信**：只有 `installNetworkPolicy()` 亲自产出的
 *        对象被采信，自造/拷贝/`teardown()` 之后的证据一律降级（C2b–C2d、C3b–C3c）
 *      - 非 OFFLINE 档位在任何输入下都**不得** `enforced:true`
 *      - `refused` 结果**永不**携带 `enforced:true`；未知档位必须抛错而不是"当成不阻断"
 *      - `summariseNetworkPolicy()` 对缺失/异常输入恒 `enforced:false`
 *
 * 证据分层：A/B 是读本机当前文件文本，C 是在本机跑的**离线替身**（不碰真实 WFP/BFE，
 * 不创建子进程，不写任何文件）—— 因此都标 `[实测]`，但**只对"离线替身运行过"成立**，
 * 真实引擎行为仍为 `[未实测]`（这正是本套件要保护的那句话）。
 *
 * 用法：
 *   node tests\residual-baseline.mjs            # 正常，应当全绿，退出码 0
 *   node tests\residual-baseline.mjs --plant    # 只改测试这一侧的输入副本，应当见红，退出码 1
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarise, REPO } from '../src/testrunner.mjs'
import {
  NETWORK_TIER_STATES,
  resolveNetworkPolicy,
  installNetworkPolicy,
  summariseNetworkPolicy,
} from '../src/netpolicy.mjs'
import { NETWORK_TIERS, OFFLINE_LAYER_KEYS, formatGuid, coerceGuid } from '../src/wfp.mjs'

const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

function checkThrows(name, fn, expectedCode) {
  assertions += 1
  try {
    fn()
    failures += 1
    W(`  ✗ ${name}\n      证据: 竟然没有抛错（期望 ${expectedCode ?? '任意错误'}）`)
    return undefined
  } catch (error) {
    const ok = expectedCode === undefined || error.code === expectedCode
    if (!ok) failures += 1
    W(`  ${ok ? '✓' : '✗'} ${name}\n      证据: code=${error.code ?? '(none)'} message=${String(error.message).slice(0, 160)}`)
    return error
  }
}

function section(title) {
  W('')
  W(`=== ${title} ===`)
}

const short = (value, n = 200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > n ? `${text.slice(0, n)}…` : text
}

// ══════════════════════ A. 文档基线：R1–R12 ══════════════════════

const RESIDUAL_IDS = Object.freeze(Array.from({ length: 12 }, (_v, i) => `R${i + 1}`))
const DOC_REL = 'docs/Windows功能开启清单.md'

/** 截出 `## 13.` 到下一个二级标题之间的正文（只认这一节，避免误抓正文里的 R 编号） */
function section13Of(text) {
  const start = text.indexOf('## 13.')
  if (start < 0) return ''
  const rest = text.slice(start)
  const end = rest.indexOf('\n## ', 3)
  return end >= 0 ? rest.slice(0, end) : rest
}

const docText = readFileSync(join(REPO, DOC_REL), 'utf8')
const section13 = section13Of(docText)
const residualRows = section13.split(/\r?\n/).filter((line) => /^\|\s*R\d+\s*\|/.test(line))
const documentedIds = residualRows.map((line) => /^\|\s*(R\d+)\s*\|/.exec(line)[1])
const effectiveIds = PLANT ? documentedIds.filter((id) => id !== 'R7') : documentedIds

section(`A. 文档基线（${DOC_REL} §13）：R1–R12 逐条仍在`)
check('§13 残余表可解析（找到二级标题且有表格行）', section13.length > 0 && residualRows.length >= 12, `rows=${residualRows.length}`)
for (const id of RESIDUAL_IDS) {
  check(
    `残余边界 ${id} 仍记录在 §13`,
    effectiveIds.includes(id),
    effectiveIds.includes(id) ? '仍在' : `**${id} 已从文档消失且没有替代行 —— 不得为了让结论好看而删残余**`,
  )
}
check(
  '§13 无重复残余编号',
  new Set(documentedIds).size === documentedIds.length,
  `ids=${documentedIds.join(',')}`,
)
const markerlessRows = residualRows.filter((line) => !/\[(官方|实测|推断|未实测)\]/.test(line))
check(
  '§13 每一行残余都带证据标记（[官方]/[实测]/[推断]/[未实测]）',
  markerlessRows.length === 0,
  markerlessRows.length === 0 ? `${residualRows.length} 行全部带标记` : short(markerlessRows.join(' | ')),
)

// ══════════════════════ B. 声明面基线：guaranteesNotProvided ══════════════════════

section('B. 声明面基线（summarise().guaranteesNotProvided）')
// 故意用"没有套件、没有审计"的最干净输入：这正是最容易被误读成"什么都没缺"的那次调用
const plainSummary = summarise([], null)
const plainLines = plainSummary.guaranteesNotProvided ?? []
check(
  'guaranteesNotProvided 是非空字符串数组',
  Array.isArray(plainLines) && plainLines.length > 0 && plainLines.every((line) => typeof line === 'string'),
  `n=${plainLines.length}`,
)

const r1Line = plainLines.find((line) => line.includes('R1') && line.includes('读取面'))
check(
  '仍声明读取面收敛（R1）未改变（即使本轮没跑审计）',
  r1Line !== undefined,
  r1Line ?? '**读取面 R1 声明消失**',
)

const withResidual = summarise([], { status: 'PASS', residual: 7 })
const residualLine = (withResidual.guaranteesNotProvided ?? []).find((line) => line.includes('R1') && line.includes('读取面'))
check(
  '有审计残余条数时 R1 行仍在并带条数（声明不因审计缺失而收缩）',
  residualLine !== undefined && residualLine.includes('7'),
  residualLine ?? '**R1 行在带审计残余时消失**',
)

const plantedNetworkLines = PLANT
  ? plainLines.map((line) => (line.includes('网络') ? line.replace('[未实测]', '已实测') : line))
  : plainLines
const networkLines = plantedNetworkLines.filter((line) => line.includes('网络'))
check('存在网络面残余声明行', networkLines.length >= 1, `n=${networkLines.length}`)
check(
  '每条网络面声明都带 [未实测]（不得把"代码存在/离线替身跑过"读成"网络上真的挡住了"）',
  networkLines.length >= 1 && networkLines.every((line) => line.includes('[未实测]')),
  networkLines.map((line) => short(line, 120)).join(' || ') || '（无网络行）',
)
check(
  '网络面声明写明 OFFLINE 是 fail-closed 且本机未安装真实过滤器',
  networkLines.some((line) => /fail-closed/i.test(line) && line.includes('未安装')),
  short(networkLines.find((line) => /fail-closed/i.test(line)) ?? '(缺)', 200),
)
check(
  '不再沿用旧的笼统说法"网络硬阻断（受限令牌与 ACL 均不涉及网络…）"',
  !plainLines.some((line) => line.includes('受限令牌与 ACL 均不涉及网络')),
  plainLines.some((line) => line.includes('受限令牌与 ACL 均不涉及网络')) ? '**旧笼统声明又回来了**' : '已改写为"策略层存在 + 真实安装 [未实测]"两段口径',
)

const mitigationsLine = plainLines.find((line) => line.includes('缓解'))
check(
  '仍声明进程缓解策略运行期为 [未实测]',
  mitigationsLine !== undefined && mitigationsLine.includes('[未实测]'),
  mitigationsLine ?? '**缓解策略的未实测声明消失**',
)

const quotaLine = plainLines.find((line) => line.includes('配额'))
check(
  '仍声明暂存配额/输出上限尚未在真实写入路径上端到端证明',
  quotaLine !== undefined && /(尚未|未测|未证明)/.test(quotaLine),
  quotaLine ?? '**配额未端到端证明的声明消失**',
)

check(
  '仍声明操作系统级一次性隔离未提供',
  plainLines.some((line) => line.includes('一次性隔离')),
  plainLines.find((line) => line.includes('一次性隔离')) ?? '**该声明消失**',
)

// ══════════════════════ C. 诚实比较不变量（离线替身） ══════════════════════

section('C. 诚实比较不变量：src/netpolicy.mjs（离线替身绑定表）')

/** 任意合法 GUID 文本（只用于离线替身；真值必须来自 Windows SDK 的 fwpmu.h） */
const guidFor = (index) => `{00000000-0000-0000-0000-${String(index).padStart(12, '0')}}`
const guids = { ALE_PACKAGE_ID: guidFor(1) }
for (const [index, layer] of OFFLINE_LAYER_KEYS.entries()) guids[layer] = guidFor(100 + index)
// `applyOfflinePlan`（真正的安装路径）还需要条件值：AppContainer 包 SID 的**替身指针**。
// `resolveNetworkPolicy` 只构造计划、不需要它，所以 C3 的正例在 D2 之前从未暴露这个缺口。
guids.targetValue = 0x2000n

const OPEN_CALLS = []
/**
 * D2 之后，"enforced:true" 只接受 `installNetworkPolicy()` 亲自产出的证据，
 * 所以 C 段的正例必须**真的走一遍安装路径**（仍然是离线替身，不碰真实 WFP）。
 * 下面这张替身表因此多两个能力：`fwpmFilterAdd0` 回填 filterId、`fwpmFilterGetByKey0`
 * 按计划回读 —— 两者都从 `plantForInstall` 这个计划派生，不写死任何 key。
 */
const installHost = { filters: new Map(), nextId: 0x7000n }
let installPlan = null
let installAddIndex = 0
const stubApi = {
  pin: () => 0x1000,
  fwpmEngineOpen0: (_server, _authn, _identity, _session, slot) => {
    OPEN_CALLS.push('open')
    slot[0] = 1n
    return 0
  },
  fwpmEngineClose0: () => 0,
  fwpmSubLayerAdd0: () => 0,
  fwpmFilterAdd0: (_handle, _filter, _sd, out) => {
    if (installPlan === null) return 0x57 // ERROR_INVALID_PARAMETER：没有计划就没有正例
    const rule = installPlan.filters[installAddIndex]
    if (rule === undefined) return 0x57
    installAddIndex += 1
    const id = installHost.nextId++
    installHost.filters.set(formatGuid(coerceGuid(rule.key, 'filterKey')), rule)
    out.id = id // [官方] filterId 是 OUT 参数，也是唯一的删除凭据
    return 0
  },
  fwpmFilterDeleteById0: () => 0,
  fwpmSubLayerDeleteByKey0: () => 0,
  fwpmFilterGetByKey0: (_handle, key, out) => {
    const keyText = formatGuid(key)
    const rule = installPlan?.filters.find((candidate) => formatGuid(coerceGuid(candidate.key, 'filterKey')) === keyText)
    if (rule === undefined) return 0x80320003 // FWP_E_FILTER_NOT_FOUND
    out[0] = {
      filterKey: coerceGuid(rule.key, 'filterKey'),
      layerKey: coerceGuid(guids[rule.layerKey], 'layerKey'),
      subLayerKey: coerceGuid(installPlan.subLayerKey, 'subLayerKey'),
    }
    return 0
  },
}
const available = { available: true, status: 0, detail: '离线替身：引擎可开' }

check(
  'NETWORK_TIERS 口径未漂移（OFFLINE + 两个在线档位）',
  NETWORK_TIERS.length === 3 && NETWORK_TIERS[0] === 'OFFLINE' && NETWORK_TIERS.includes('CONTROLLED_ONLINE') && NETWORK_TIERS.includes('OBSERVED_ONLINE'),
  NETWORK_TIERS.join(' / '),
)
check(
  '离线替身绑定表具备安装所需的 6 个函数 + pin（否则下面的判定是真空的）',
  ['fwpmEngineOpen0', 'fwpmEngineClose0', 'fwpmSubLayerAdd0', 'fwpmFilterAdd0', 'fwpmFilterDeleteById0', 'fwpmSubLayerDeleteByKey0', 'pin'].every(
    (name) => typeof stubApi[name] === 'function',
  ),
  `guids=${Object.keys(guids).length} 项，层=${OFFLINE_LAYER_KEYS.length} 条`,
)

// ── C1. OFFLINE 缺前置能力 ⇒ refused / enforced:false ──
const noApi = resolveNetworkPolicy({ requested: 'OFFLINE' })
const noGuids = resolveNetworkPolicy({ requested: 'OFFLINE', api: stubApi, probe: available, guids: null })
const effectiveNoApi = PLANT ? { ...noApi, state: NETWORK_TIER_STATES.REFUSED, enforced: true } : noApi

check(
  'C1a OFFLINE 且绑定表不可用 ⇒ state=refused 且 enforced=false',
  effectiveNoApi.state === NETWORK_TIER_STATES.REFUSED && effectiveNoApi.enforced !== true,
  short(`${effectiveNoApi.state} enforced=${effectiveNoApi.enforced} reason=${effectiveNoApi.reason}`, 220),
)
check(
  'C1b OFFLINE 前置齐全但缺 GUID ⇒ 计划不可构造 ⇒ refused 且 enforced=false',
  noGuids.state === NETWORK_TIER_STATES.REFUSED && noGuids.enforced !== true,
  short(`${noGuids.state} enforced=${noGuids.enforced} reason=${noGuids.reason}`, 220),
)

// ── C2. 有完整前置但无安装证据 ⇒ not-enforced（不得 enforced:true） ──
const planOnly = resolveNetworkPolicy({ requested: 'OFFLINE', api: stubApi, probe: available, guids })
check(
  'C2a OFFLINE 前置满足、计划可构造（6 条规则）但无安装证据 ⇒ enforced=false',
  planOnly.enforced !== true && planOnly.state === NETWORK_TIER_STATES.NOT_ENFORCED && planOnly.plan?.filters?.length === OFFLINE_LAYER_KEYS.length,
  short(`${planOnly.state} enforced=${planOnly.enforced} filters=${planOnly.plan?.filters?.length}`, 220),
)
const expectations = planOnly.plan?.filters?.length ?? 0
const applied = planOnly.plan?.filters?.map((rule) => ({ key: rule.key })) ?? []
const partial = resolveNetworkPolicy({
  requested: 'OFFLINE',
  api: stubApi,
  probe: available,
  guids,
  install: { installed: applied.slice(0, 1) },
  audit: { verified: true },
})
check(
  'C2b 自造 install（只 1/6 条）+ 伪造 audit ⇒ enforced=false（D2 后连证据都不采信，方向仍是 fail-closed）',
  partial.enforced !== true && partial.state === NETWORK_TIER_STATES.NOT_ENFORCED,
  short(`${partial.state} enforced=${partial.enforced} reason=${partial.reason}`, 220),
)
const verifyFailed = resolveNetworkPolicy({
  requested: 'OFFLINE',
  api: stubApi,
  probe: available,
  guids,
  install: { installed: applied },
  audit: { verified: false, reason: 'filters-missing:0/6' },
})
check(
  'C2c 自造 install（装满 6 条）+ 伪造"回读未通过" audit ⇒ enforced=false',
  verifyFailed.enforced !== true && verifyFailed.state === NETWORK_TIER_STATES.NOT_ENFORCED,
  short(`${verifyFailed.state} enforced=${verifyFailed.enforced} reason=${verifyFailed.reason}`, 220),
)
const auditMissing = resolveNetworkPolicy({
  requested: 'OFFLINE',
  api: stubApi,
  probe: available,
  guids,
  install: { installed: applied },
})
check(
  'C2d 自造 install（装满 6 条）但没有任何回读证据 ⇒ enforced=false（fail-closed，不猜）',
  auditMissing.enforced !== true && auditMissing.state === NETWORK_TIER_STATES.NOT_ENFORCED,
  short(`${auditMissing.state} enforced=${auditMissing.enforced} reason=${auditMissing.reason}`, 220),
)

// ── C3. 正例：**真实安装**（installNetworkPolicy）+ 回读通过 ⇒ enforced:true ──
// D2 修复后，自造 `{ installed: applied }` 不再被采信 —— 正例必须真的调用
// `installNetworkPolicy()`（离线替身绑定表，仍然不碰真实 WFP/BFE）。
installPlan = planOnly.plan
installAddIndex = 0
const genuineInstall = installNetworkPolicy({ api: stubApi, plan: installPlan, guids })
const enforced = resolveNetworkPolicy({
  requested: 'OFFLINE',
  api: stubApi,
  probe: available,
  guids,
  install: genuineInstall,
  audit: genuineInstall.audit,
})
check(
  'C3 正例：真实安装证据（installNetworkPolicy 产物）+ 回读通过 ⇒ enforced:true（唯一的 enforced 路径真的存在）',
  enforced.enforced === true && enforced.state === NETWORK_TIER_STATES.ENFORCED && enforced.verified === true,
  short(`${enforced.state} enforced=${enforced.enforced} verified=${enforced.verified} reason=${enforced.reason}`, 220),
)
check(
  'C3b D2 回归：同一替身表 + **自造** install（形状与真产物一致）⇒ enforced=false（来源校验挡住 fail-open）',
  resolveNetworkPolicy({
    requested: 'OFFLINE',
    api: stubApi,
    probe: available,
    guids,
    install: { installed: genuineInstall.installed, filterIds: genuineInstall.filterIds },
    audit: { verified: true },
  }).enforced === false,
  short(
    resolveNetworkPolicy({
      requested: 'OFFLINE',
      api: stubApi,
      probe: available,
      guids,
      install: { installed: genuineInstall.installed },
      audit: { verified: true },
    }).reason,
    220,
  ),
)
genuineInstall.teardown()
const afterTeardown = resolveNetworkPolicy({
  requested: 'OFFLINE',
  api: stubApi,
  probe: available,
  guids,
  install: genuineInstall,
  audit: genuineInstall.audit,
})
check(
  'C3c D2 回归：teardown() 之后同一证据作废 ⇒ enforced=false（过滤器已删，不得再声称已强制）',
  afterTeardown.enforced === false && afterTeardown.state === NETWORK_TIER_STATES.NOT_ENFORCED,
  short(`${afterTeardown.state} enforced=${afterTeardown.enforced} reason=${afterTeardown.reason}`, 220),
)

// ── C4. 非 OFFLINE 档位：任何输入下都不得 enforced:true ──
const nonOfflineResults = NETWORK_TIERS.filter((tier) => tier !== 'OFFLINE').map((tier) => ({
  tier,
  result: resolveNetworkPolicy({
    requested: tier,
    api: stubApi,
    probe: available,
    guids,
    install: { installed: applied },
    audit: { verified: true },
  }),
}))
const plantedNonOffline = PLANT
  ? nonOfflineResults.map(({ tier }) => ({ tier, result: { state: NETWORK_TIER_STATES.ENFORCED, enforced: true, verified: true, plan: {} } }))
  : nonOfflineResults
check(
  'C4 非 OFFLINE 档位（CONTROLLED_ONLINE / OBSERVED_ONLINE）任何输入下 enforced 均非 true',
  plantedNonOffline.every(({ result }) => result.enforced !== true),
  plantedNonOffline.map(({ tier, result }) => `${tier}:${result.state}/enforced=${result.enforced}`).join(' '),
)
check(
  'C4b 非 OFFLINE 档位如实报 not-implemented（既不放行成 enforced，也不假装已拒绝执行）',
  nonOfflineResults.every(({ result }) => result.state === NETWORK_TIER_STATES.NOT_IMPLEMENTED),
  nonOfflineResults.map(({ tier, result }) => `${tier}:${result.state}`).join(' '),
)

// ── C5. refused 结果永不携带 enforced:true ──
const refusedSamples = [noApi, noGuids].filter((result) => result.state === NETWORK_TIER_STATES.REFUSED)
const effectiveRefused = PLANT
  ? [{ ...refusedSamples[0], state: NETWORK_TIER_STATES.REFUSED, enforced: true }, ...refusedSamples.slice(1)]
  : refusedSamples
check(
  'C5a 至少取到 2 条 refused 样本（否则断言是真空的）',
  refusedSamples.length >= 2,
  `n=${refusedSamples.length}`,
)
check(
  'C5b 任何 state=refused 的结果都不得携带 enforced:true',
  effectiveRefused.every((result) => result.state !== NETWORK_TIER_STATES.REFUSED || result.enforced !== true),
  effectiveRefused.map((result) => `${result.tier}:${result.state}/enforced=${result.enforced}`).join(' '),
)

// ── C6. 摘要层不得制造 enforced:true ──
const poisonedSummaries = [undefined, null, 'not-an-object', 42].map((value) => summariseNetworkPolicy(value))
check(
  'C6a summariseNetworkPolicy() 对缺失/异常输入恒 enforced=false',
  poisonedSummaries.every((summary) => summary.enforced === false),
  poisonedSummaries.map((summary) => `${summary.state}/enforced=${summary.enforced}`).join(' '),
)
check(
  'C6b 摘要层原样透传 enforced=false（不会把"未强制"渲染成"已强制"）',
  summariseNetworkPolicy({ tier: 'OFFLINE', state: NETWORK_TIER_STATES.NOT_ENFORCED, enforced: false }).enforced === false,
  'not-enforced → false',
)

// ── C7. 未知档位必须抛错，绝不"当成不阻断" ──
checkThrows(
  'C7 未知网络档位必须抛 NETWORK_TIER_INVALID（不得静默当成"不阻断"）',
  () => resolveNetworkPolicy({ requested: 'NOT_A_TIER' }),
  'NETWORK_TIER_INVALID',
)

// ══════════════════════ 收尾 ══════════════════════

if (PLANT) {
  check('--plant 模式下失败项 ≥3（证明本套件的判定真的能红，而不是恒绿）', failures >= 3, `failures=${failures}`)
}

W('')
W('='.repeat(72))
W(
  PLANT
    ? `残余边界基线（--plant 模式：删掉 R7 / 抹掉 [未实测] / 让 refused 谎报 enforced，应当失败）：断言 ${assertions} 项，失败 ${failures} 项`
    : `残余边界基线（文档 §13 + guaranteesNotProvided + netpolicy 离线替身）：断言 ${assertions} 项，失败 ${failures} 项`,
)
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)

process.exitCode = failures > 0 ? 1 : 0
