/**
 * 网络策略的**强制 / 审计层** —— 把 `src/wfp.mjs` 从"惰性库"变成"可强制、可审计的策略"
 *
 * ── 为什么需要这一层（差距输入）────────────────────────────────────────────
 * `docs/WinStageSandbox-能力清单与差距基线.md` §2 与 §5 记录：`src/wfp.mjs` 已实现完整的
 * WFP 结构/调用层，但**没有任何生产调用方**，一个 `Fwpm*Add0` 都从未被调用过，
 * 网络面因此记为 **ABSENT**；`src/testrunner.mjs:245` 仍声明"网络硬阻断未提供"。
 * `docs/NeoAI-沙箱能力分析与差距输入.md` §3.3 记录 NeoAI 的残余边界是"裸 TCP 绕过应用层代理"，
 * §5.3 第 15 条要求 Windows 侧用 WFP 做**内核层**出站过滤（`[官方]` WFP 在 ALE 层裁决，
 * 严格强于应用层代理）。本模块补齐的正是"计划 → 强制 → 回读核对"这段缺失的接线与审计。
 *
 * ── 职责边界（严格）────────────────────────────────────────────────────────
 *   1. **只做策略判定 / 安装编排 / 回读审计**，不重新实现任何结构构造：
 *      sublayer / filter / condition / displayData 的字节全部由 `src/wfp.mjs::applyOfflinePlan()`
 *      产出；本模块不写任何 `OFF_*` / `*_SIZE` 字面量，也不碰 Win32。
 *   2. **fail-closed**：任一前置能力缺失（绑定表、引擎、可用性探测、GUID、pin 回调），
 *      `OFFLINE` 档位一律 `REFUSED`，**绝不**返回 `enforced:true`。对应 NeoAI 的设计不变量
 *      "未知结果不报告为成功"（§3.4）与本项目 `src/wfp.mjs` 顶部"不做任何隐含降级（fail-closed）"。
 *   3. **可审计**：`auditNetworkPolicy()` 从引擎**回读**已安装的过滤器；绑定表不提供回读入口时
 *      如实返回 `verified:false` / `reason:'enumeration-unavailable'`，**不猜**。
 *   4. **不留残迹**：`installNetworkPolicy()` 在任何失败路径上先做 best-effort 拆除
 *      （删 filter → 删 sublayer → 关引擎），再抛类型化错误。
 *
 * ── 为什么"关引擎"也算拆除手段 ─────────────────────────────────────────────
 * `[官方]` `FWPM_SESSION_FLAG_DYNAMIC`：会话结束（`FwpmEngineClose0`）时 BFE 自动删除本次会话
 * 添加的对象（URL 见下）。`src/wfp.mjs::buildSession0()` 固定使用该标志，因此"关引擎"是
 * **兜底**：即使某个 filter 的 `filterId` 因中途失败而未能记下，它也会随会话一起消失。
 * 这与"显式按 id 删除"是两件事：显式删除进程内立刻恢复网络，会话清理要等关引擎。
 *
 * ── 证据分层（本项目强制约定）──────────────────────────────────────────────
 * `[官方]` = 微软 Learn 文档（URL 见下）；`[推断]` = 由官方语义推导；`[未实测]` = 本机未在
 * 真实 WFP 上运行（安装过滤器是系统级状态变更，本阶段未获授权，`src/wfp.mjs:28-30` 同口径）。
 * 本模块的**全部运行期行为**由 `tests/netpolicy.mjs` 用**替身绑定表**离线验证；
 * 那里的 `[实测]` 只表示"离线替身运行过"，**不等于**真实 BFE 行为已实测。
 *
 * 官方依据：
 *   FwpmEngineOpen0            https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineopen0
 *   FwpmEngineClose0           https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineclose0
 *   FwpmSubLayerAdd0           https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmsublayeradd0
 *   FwpmSubLayerDeleteByKey0   https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmsublayerdeletebykey0
 *   FwpmFilterAdd0             https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmfilteradd0
 *   FwpmFilterDeleteById0      https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmfilterdeletebyid0
 *   FwpmFilterGetByKey0        https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmfiltergetbykey0
 *   FwpmFilterEnum0            https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmfilterenum0
 *   FWPM_SESSION_FLAG_DYNAMIC  https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ne-fwpmtypes-fwpm_session_flags
 *   WFP 返回码（0x803200xx）   https://learn.microsoft.com/en-us/windows/win32/fwp/wfp-return-codes
 */

import {
  NETWORK_TIERS,
  planOfflineRules,
  applyOfflinePlan,
  openEngine,
  deleteFilterById,
  deleteSubLayerByKey,
  probeWfpAvailability,
  describeWfpStatus,
  formatGuid,
  coerceGuid,
  stableRuleKey,
} from './wfp.mjs'

// ─────────────────────────── 档位状态 ───────────────────────────

/**
 * 网络档位的**四态**（互斥，覆盖全部情形，不允许出现第五种含混表述）。
 *
 *   - `ENFORCED`       计划**确实已装到 BFE 上**，且在绑定表提供回读入口时回读核对通过
 *   - `NOT_ENFORCED`   计划可解析，但**没有**安装证据（或只装了一部分、或回读不通过）
 *   - `REFUSED`        声称会阻断，但前置能力不足 —— 明知挡不住就明确拒绝，不假装挡得住
 *   - `NOT_IMPLEMENTED`该档位没有实现，且**不作出任何阻断声明**（因此仍允许执行）
 */
export const NETWORK_TIER_STATES = Object.freeze({
  ENFORCED: 'enforced',
  NOT_ENFORCED: 'not-enforced',
  REFUSED: 'refused',
  NOT_IMPLEMENTED: 'not-implemented',
})

/** `auditNetworkPolicy()` 在"绑定表没有回读入口"时返回的固定 reason（调用方按常量比较，别写字面量） */
export const ENUMERATION_UNAVAILABLE_REASON = 'enumeration-unavailable'

/**
 * 安装 OFFLINE 硬阻断所**必需**的绑定表函数。
 *
 * `[官方]` `fwpmEngineClose0` 不参与安装，但参与**拆除**：没有它就无法确定性地结束
 * DYNAMIC 会话（也就无法保证中途失败的过滤器一定消失），因此把它也算作安装前置条件。
 */
const INSTALL_BINDINGS = Object.freeze([
  'fwpmEngineOpen0',
  'fwpmEngineClose0',
  'fwpmSubLayerAdd0',
  'fwpmFilterAdd0',
  'fwpmFilterDeleteById0',
  'fwpmSubLayerDeleteByKey0',
])

// ─────────────────────────── 安装证据的来源校验（D2 修复）───────────────────────────

/**
 * 模块私有**品牌**（`Symbol`，不导出）：只有 `installNetworkPolicy()` 能给返回值打上。
 *
 * 单靠一个 Symbol 还不够（`Object.getOwnPropertySymbols()` 能把品牌符号抄走），
 * 因此真正的权威是下面的 `INSTALL_EVIDENCE_RECORDS`（模块私有 `WeakMap`）：
 * 外界**无法**凭空把对象加进去，也无法读出它。品牌只作第一道快筛。
 */
const INSTALL_EVIDENCE_BRAND = Symbol('WinStageSandbox.netpolicy.install-evidence')

/**
 * 真实安装证据 → 不可伪造的**冻结**记录：
 * `{ api, planFingerprint, engine, engineCloser, audit, auditFingerprint, evidence }`。
 *
 * R3-2 补充：记录里**确实**按对象同一性留着 `api` 与 `engine` 两个引用（判据 4/6 要比的正是
 * "是不是同一个绑定表 / 句柄还在不在"，比快照反而会丢掉 `engine-missing` 这条降级语义），
 * 但**拆除不读它们**：拆除所需的句柄与关闭函数在安装时另存为 `engineCloser`
 * （`Object.freeze`；关闭函数已 `bind` 到当时的会话，句柄是当时的快照），
 * 因此调用方事后改写 `result.engine.close` / `result.engine.handle` 或整体替换 `result.engine`
 * 都不影响真实拆除（第三轮复核 R3-2）。
 *
 * `[实测]` **修复前的 fail-open 由独立验证会话在本机实测**（node v24.21.0，离线替身绑定表；
 * 原始记录见 `docs/NeoAI-差距补齐-实施与验证报告.md` §2.1 A5 与 §3 D2，验证脚本 `.t/adv/honesty.mjs`
 * 已按该报告删除）：
 * `capabilityDimensions({ networkTier:'OFFLINE', networkBindings:<替身表>, networkGuids,
 * networkProbe:{available:true}, networkInstall:{installed:[6 条]}, networkAudit:{verified:true} })`
 * ⇒ `state:'enforced'` / `enforced:true` / `verified:true`，而底层
 * `FwpmFilterAdd0` **调用 0 次**（调用日志只有 `engineOpen, engineClose`）。
 * 原因是 `enforcementFromEvidence()` 只数 `install.installed.length`、只看 `audit.verified`，
 * **不验证证据来源**。
 * `[实测]` **修复后（本轮修复会话，同机同替身表，脚本 `.t/fix-d2-repro.mjs` 跑完已删）**：
 * 同一输入 ⇒ `state:'not-enforced'` / `enforced:false` / `verified:false`，
 * 调用日志仍只有 `FwpmEngineOpen0, FwpmEngineClose0`（`FwpmFilterAdd0` = 0 次）；
 * 正例（真实 `installNetworkPolicy()` 产物 + 回读通过）仍可到 `enforced:true`
 * （`tests/netpolicy.mjs` 2b/2c/2l 钉死）。
 *
 * 记录里存的 `evidence` 是**冻结快照**（不是调用方那个可变对象）：
 * 即便调用方事后往 `install.installed` 里 push，也无法抬高计数。
 *
 * 本轮（N1/N2）进一步把记录变成**不可变证据**：记录本身 `Object.freeze`，
 * 计划只存**指纹**（不再存活计划对象），审计只存**冻结的结构快照**（不再存活 `audit`）。
 * 原因是第二轮独立审计发现：记录里存活对象时，调用方事后
 * `inst.audit.verified = true` 或 `inst.plan.filters = <另一个计划>` 就能让
 * `resolveNetworkPolicy()` 拿**被篡改后的活对象**重判（N1 fail-open / N2 计划冒名）。
 * `[实测]` 本机修复前复现（node v24.21.0，离线替身表，临时脚本 `.t/n1n2-repro.mjs`，已删）：
 *   - N1：无枚举入口的真实安装（`verified:false`）后置 `inst.audit.verified = true`，
 *     再 `resolveNetworkPolicy({ install, audit: inst.audit })` ⇒ `verified:true`；
 *     连**不带** `audit` 参数也一样（记录里就是同一个活对象）。
 *   - N2：就地改 `inst.plan.filters/target/subLayerKey` 为 app-identifier 计划后按
 *     `target:'app-identifier'` 解析 ⇒ `enforced:true` / `verified:true`（未篡改时为 `plan-mismatch`）。
 * `[实测]` 修复后（同机同替身表，`tests/netpolicy.mjs` 3c 的 2m–2q 钉死）：
 *   - N1：篡改后**带**那个 audit ⇒ `not-enforced` / `enforced:false` / `verified:false`（audit-mismatch）；
 *     **不带** audit ⇒ 判定只读冻结快照 ⇒ `enforced:true` / `verified:false`（"已强制但未独立验证"不变）。
 *   - N2：篡改活计划后按 app-identifier 解析 ⇒ 仍 `plan-mismatch` / `not-enforced` / `enforced:false`；
 *     按原 target 解析则仍按请求侧计划判定（`enforced:true` / `verified:true`），篡改既不能冒名也不能破坏。
 *
 * 「是否仍然活跃」**不是**记录上的字段（记录已冻结，写不进去）：拆除后作废用模块私有的
 * `INVALIDATED_INSTALL_EVIDENCE`（`WeakSet`）表达，语义与修复前 `active=false` 完全一致。
 */
const INSTALL_EVIDENCE_RECORDS = new WeakMap()

/**
 * 已被 `teardown()` 作废的安装证据（模块私有 `WeakSet`）。
 *
 * 为什么不让记录自己带 `active` 布尔：记录必须 `Object.freeze`（N1/N2 的要求），
 * 冻结后 `record.active = false` 在 ESM 严格模式下会抛 `TypeError`，把拆除路径整个搞坏。
 * 放进 `WeakSet` 既保持记录不可变，又保持"拆除即作废"的原语义（`evidence-torn-down`）。
 */
const INVALIDATED_INSTALL_EVIDENCE = new WeakSet()

/**
 * 把计划**真正消费的** GUID / 条件值归一成确定性文本（R3-1）。
 *
 * 为什么不能只比"GUID 对象"：两次调用各给一份 `guids`，对象同一性不同但**语义相同**的取值
 * 必须算出同一个指纹，语义不同的取值必须算出不同指纹。归一规则（任何取值都不抛错）：
 *   - 16 字节 Buffer / 合法 GUID 文本 → `guid:<规范小写文本>`（两种表示归一成同一条）；
 *   - 其它 Buffer → `buf:<hex>`；整数（number / bigint）→ `num:<十六进制>`（`0x2000` 与 `8192n`
 *     同值同串，避免"同一个指针换个 JS 类型就误判成篡改"）；非整数 → `num:<十进制文本>`；
 *   - 字符串 → `text:<原样>`；`null`/`undefined` → `null`；其余对象 → `other:<类型标签>`（不猜内容）。
 */
function canonicalPlanValue(value) {
  if (value === null || value === undefined) return null
  const text = guidText(value)
  if (text !== null) return `guid:${text}`
  if (Buffer.isBuffer(value)) return `buf:${value.toString('hex')}`
  if (typeof value === 'bigint') return `num:${value.toString(16)}`
  if (typeof value === 'number') return `num:${Number.isInteger(value) ? BigInt(value).toString(16) : String(value)}`
  if (typeof value === 'string') return `text:${value}`
  if (typeof value === 'boolean') return `bool:${value}`
  return `other:${Object.prototype.toString.call(value)}`
}

/**
 * 计划指纹：把计划的**有意义内容**折成一个确定性字符串（复用 `src/wfp.mjs::stableRuleKey` 作摘要）。
 *
 * 覆盖字段：`tier` / `target` / `subLayerKey` / **按序**每条规则的稳定 key、层、条件键、匹配类型、
 * 动作与描述，以及 **`guids` 里该计划真正会写进 BFE 的取值**（R3-1 修复点）：
 *   - 每条规则的 `guids[rule.layerKey]`（ALE 层 GUID）与 `guids[rule.conditionKey]`（条件 GUID）；
 *   - `guids.targetValue`（条件值：AppContainer 包 SID 指针 / `ALE_APP_ID` blob 指针）。
 * 为什么必须折进去：`applyOfflinePlan()` 构造出的安装字节**只**由这些取值决定；指纹不覆盖它们时，
 * 同一份真安装证据就能给"另一个应用身份 / 另一套层 GUID"的请求背书（第三轮复核 R3-1）。
 * `[实测]` 修复后：同一份真证据只要两次调用的 `guids` 在条件 GUID / 层 GUID / `targetValue`
 * 任一处不同 ⇒ `plan-mismatch` / `not-enforced` / `enforced:false`；`guids` 完全相同则正例仍
 * `enforced:true`（`tests/netpolicy.mjs` 的 2q/2r 钉死）。
 *
 * 两侧必须**同式重算**：安装时由 `installNetworkPolicy()` 用当次 `plan` + `guids` 算，
 * 复判时由 `verifyInstallEvidence()` 用**请求侧重算的 `plan`** + **调用方本次给的 `guids`** 算。
 * **不**依赖对象同一性，也**不**读任何活对象 —— 指纹在安装那一刻算好并随记录冻结，
 * 之后调用方怎么改计划对象或 `guids` 对象都改不动它（N2 / R3-1）。
 *
 * 不能识别（不是对象 / `filters` 不是数组）时返回 `null`，由调用方 fail-closed 成 plan-mismatch。
 */
function planFingerprint(plan, guids) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.filters)) return null
  const guidSource = guids && typeof guids === 'object' ? guids : {}
  const rules = plan.filters.map((rule) => [
    guidText(rule?.key) ?? String(rule?.key ?? ''),
    String(rule?.layerKey ?? ''),
    String(rule?.conditionKey ?? ''),
    String(rule?.matchType ?? ''),
    String(rule?.action ?? ''),
    String(rule?.description ?? ''),
    canonicalPlanValue(guidSource[rule?.layerKey]),
    canonicalPlanValue(guidSource[rule?.conditionKey]),
  ])
  const canonical = JSON.stringify({
    tier: String(plan.tier ?? ''),
    target: String(plan.target ?? ''),
    subLayerKey: String(plan.subLayerKey ?? ''),
    rules,
    targetValue: canonicalPlanValue(guidSource.targetValue),
  })
  return stableRuleKey('dsh-stage/netpolicy/plan-fingerprint', canonical)
}

/**
 * 审计判定的**冻结结构快照**（不是活 `audit` 对象）。
 *
 * 至少覆盖 `verified` / `reason` / `installed` / `filterCount`（判定字段），
 * 另附 `subLayerKey` / `layerChecked` 作为可审计上下文。全部归一成稳定类型，
 * 缺失一律取"更保守"的取值（`false` / `null` / `0`）—— 不猜。
 */
function auditVerdictSnapshot(auditResult) {
  return Object.freeze({
    verified: auditResult?.verified === true,
    reason: typeof auditResult?.reason === 'string' ? auditResult.reason : null,
    installed: auditResult?.installed === true,
    filterCount: Number.isInteger(auditResult?.filterCount) ? auditResult.filterCount : 0,
    subLayerKey: typeof auditResult?.subLayerKey === 'string' ? auditResult.subLayerKey : null,
    layerChecked: auditResult?.layerChecked === true,
  })
}

/**
 * 审计**判定字段**指纹：只取参与决策的四个字段，用来判断"调用方另给的 audit 与冻结快照是否一致"。
 *
 * 为什么按内容而不是对象同一性：调用方（`src/executor.mjs:2025`、能力报告面）会原样回传
 * `install.audit`，但那条路径看到的永远是安装时的活对象；按内容比对既能让正常回传通过，
 * 又能把"篡改/替换过的 audit"识别成不一致并整条降级（fail-closed）。
 * 无论调用方给什么，判定只读快照 —— 比对只是"允不允许继续"，**不是**权限来源。
 */
function auditVerdictFingerprint(auditResult) {
  const snapshot = auditVerdictSnapshot(auditResult)
  return JSON.stringify([snapshot.verified, snapshot.reason, snapshot.installed, snapshot.filterCount])
}

/**
 * 校验"安装证据"是否**真的**由 `installNetworkPolicy()` 产出，且与本次解析的
 * `api` / `plan` 同源。任何一条不满足都返回 `{ok:false, reason}` —— 调用方一律
 * 降级成 `not-enforced` / `enforced:false`（fail-closed），**绝不**采信自造对象。
 *
 * 判据（逐条）：
 *   1. 品牌符号在（快筛）；
 *   2. 在模块私有 `WeakMap` 里（**权威**：外界加不进去）；
 *   3. 不在模块私有 `INVALIDATED_INSTALL_EVIDENCE` 里（`teardown()` 之后证据作废
 *      —— 过滤器已经删掉了）；
 *   4. `record.api === api`（**对象同一性**：证据不能跨绑定表转发）；
 *   5. **计划指纹**一致（`record.planFingerprint` 是安装时算好并冻结的字符串；
 *      本次重新 `planOfflineRules()` 得到的新计划 + **调用方本次给的 `guids`** 现场重算指纹再比
 *      —— 比的是**字符串**，所以调用方事后就地改 `install.plan.*` 也换不出一个"匹配"的指纹（N2），
 *      两次调用之间换 `guids`（层 GUID / 条件 GUID / `targetValue`）同样换不出（R3-1，见
 *      `planFingerprint`）；
 *   6. 引擎句柄仍在记录里（结构上非空）。
 *
 * 注意：`audit` **不**作为独立输入被采信。安装时的回读结果在记录里是**冻结快照**
 * （`record.audit`），判定只读它。调用方另给的 `audit` 只按**判定字段**与快照比对：
 * 一致才继续（正常回传 `install.audit` 走的正是这条），不一致整条判为 `audit-mismatch`
 * 并降级 —— 否则"把 `install.audit.verified` 改成 true 再回传"就能把
 * "已强制但未独立验证"升级成"已核对"，这正是不允许的 fail-open 方向（N1）。
 */
function verifyInstallEvidence({ install, api, plan, guids, audit }) {
  if (install === null || install === undefined) return { ok: false, reason: 'missing-install' }
  if (typeof install !== 'object') return { ok: false, reason: 'install-not-an-object' }
  // 整段包 try：`install` 可能是 Proxy / 带抛错 getter 的怪对象，
  // 校验本身抛错也必须落到 fail-closed（"校验不了"≠"证据可信"）。
  try {
    if (install[INSTALL_EVIDENCE_BRAND] !== true) return { ok: false, reason: 'not-branded' }
    const record = INSTALL_EVIDENCE_RECORDS.get(install)
    if (!record) return { ok: false, reason: 'not-produced-by-installNetworkPolicy' }
    if (INVALIDATED_INSTALL_EVIDENCE.has(install)) return { ok: false, reason: 'evidence-torn-down' }
    if (record.api !== api) return { ok: false, reason: 'api-mismatch' }
    const wanted = planFingerprint(plan, guids)
    if (wanted === null || typeof record.planFingerprint !== 'string' || record.planFingerprint !== wanted) {
      return { ok: false, reason: 'plan-mismatch' }
    }
    if (engineHandleOf(record.engine) === null) return { ok: false, reason: 'engine-missing' }
    if (audit !== null && audit !== undefined && auditVerdictFingerprint(audit) !== record.auditFingerprint) {
      return { ok: false, reason: 'audit-mismatch' }
    }
    return { ok: true, install: record.evidence, audit: record.audit }
  } catch (error) {
    return { ok: false, reason: `evidence-check-threw:${error?.message ?? String(error)}` }
  }
}

// ─────────────────────────── 小工具 ───────────────────────────

function netError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** 绑定表上缺哪些安装所需函数（`api` 不是对象时视为全缺） */
function missingInstallBindings(api) {
  if (!api || typeof api !== 'object') return [...INSTALL_BINDINGS]
  return INSTALL_BINDINGS.filter((name) => typeof api[name] !== 'function')
}

/**
 * 归一 `guids` 入参：显式 `null`（以及 `undefined`）一律表示"**没有提供任何 GUID**"，统一成空对象。
 *
 * 为什么必须归一，而不是直接透传给 `planOfflineRules`：后者的默认参数 `guids = {}` **只对
 * `undefined` 生效**，显式 `null` 会一路走到 `guids[conditionKey]`，抛出原生
 * `TypeError: Cannot read properties of null (reading 'ALE_PACKAGE_ID')`；这个 TypeError 再被
 * 本模块的 plan 异常分支包装成 `WFP_PLAN_FAILED`。判定仍然是 `refused` / `enforced:false`
 * （fail-closed 不破），但**类型化错误码契约被削弱**（`[实测]`：修复前 `guids:null` 与
 * `guids:undefined` 都得到 `WFP_PLAN_FAILED: Cannot read properties of null…`）。
 *
 * 归一成空对象后，缺 GUID 由 `src/wfp.mjs` 自己以既有的 `WFP_GUIDS_MISSING`（并带上
 * `missing` 列表）如实报出，本模块只做转述 —— 不猜、不降级。其它取值（含非对象）**原样透传**，
 * 保持既有语义不变。
 */
function normaliseGuids(value) {
  return value === null || value === undefined ? {} : value
}

/** pin 回调可以显式传，也可以挂在绑定表上（与 `src/appcontainer-runtime.mjs` 的 `bindings.pin` 同约定） */
function resolvePin(api, pin) {
  if (typeof pin === 'function') return pin
  if (api && typeof api.pin === 'function') return api.pin
  return null
}

/**
 * 执行可用性探测。
 *
 * `probe` 允许三种形态，避免调用方为了测试而伪造真实 Win32：
 *   - `undefined`/`null` → 用 `src/wfp.mjs::probeWfpAvailability(api)` 真探测；
 *   - 函数 → `probe(api)`，其返回值即探测结果；
 *   - 对象 → 直接当探测结果（`{ available, status?, detail? }`）。
 */
function runProbe(api, probe) {
  if (typeof probe === 'function') {
    try {
      const result = probe(api)
      if (result && typeof result === 'object') return result
      return { available: false, detail: 'probe 函数返回了非对象，按不可用处理（fail-closed）' }
    } catch (error) {
      return { available: false, detail: `probe 函数抛错：${error.message}` }
    }
  }
  if (probe && typeof probe === 'object') return probe
  return probeWfpAvailability(api)
}

function refusedResult(tier, reason, extra = {}) {
  return {
    tier,
    state: NETWORK_TIER_STATES.REFUSED,
    enforced: false,
    verified: false,
    reason,
    plan: null,
    ...extra,
  }
}

/** 把 GUID 的各种表示归一成规范小写文本；无法识别时返回 null（不猜） */
function guidText(value) {
  if (value === null || value === undefined) return null
  try {
    if (Buffer.isBuffer(value)) return value.length === 16 ? formatGuid(value) : null
    if (typeof value === 'string') return formatGuid(coerceGuid(value))
  } catch {
    return null
  }
  return null
}

function engineHandleOf(engine) {
  if (engine === null || engine === undefined) return null
  if (typeof engine === 'object' && 'handle' in engine) return engine.handle ?? null
  return engine
}

/** 统一"出参槽位 / 返回值对象"两种绑定约定（与 `src/wfp.mjs` 的既有约定一致） */
function splitStatusAndOut(returned, slot, outKey) {
  if (returned !== null && typeof returned === 'object' && ('status' in returned || outKey in returned)) {
    return { status: ((returned.status ?? 0) >>> 0), out: returned[outKey] ?? null }
  }
  return { status: (typeof returned === 'number' ? returned : 0) >>> 0, out: slot?.[0] ?? null }
}

// ─────────────────────────── 策略解析 ───────────────────────────

/**
 * 解析网络策略：**只判定、不安装**。
 *
 * 这是本模块最关键的一条设计：`resolveNetworkPolicy()` **不会**因为"计划能构造出来"就报告
 * `ENFORCED`。`ENFORCED` 需要**安装证据**（`installNetworkPolicy()` 的产物）以及
 * （当绑定表提供回读入口时）回读核对通过 —— 见 `enforcementFromEvidence()`。
 * 而"安装证据"本身必须**来源可信**（D2）：只有 `installNetworkPolicy()` 亲自产出的对象、
 * 且与本 `api`/本计划同源，才被 `verifyInstallEvidence()` 采信；调用方自造的
 * `{ installed: [...] }` 一律降级成 `not-enforced`（fail-closed）。
 * 这样"未知结果不报告为成功"就不是一句注释，而是一个可被测试钉死的不变量。
 *
 * OFFLINE 的判定顺序（确定性，测试逐条钉死）：
 *   1. 绑定表是否具备全部安装所需函数（缺哪个就报哪个）
 *   2. 是否有 pin 回调（没有它构造不出内嵌指针 ⇒ 计划不可安装）
 *   3. 可用性探测（默认 `probeWfpAvailability`）
 *   4. 引擎是否真的能打开（`openEngine`，随即关闭，不改系统状态）
 *   5. 计划是否能构造（缺 GUID 会在这里以 `WFP_GUIDS_MISSING` 暴露）
 *   6. 有无安装证据（**先做来源校验**）⇒ `ENFORCED` / `NOT_ENFORCED`
 *
 * @param {object} options
 * @param {'OFFLINE'|'CONTROLLED_ONLINE'|'OBSERVED_ONLINE'} [options.requested='OBSERVED_ONLINE']
 *   请求的档位；**默认 `OBSERVED_ONLINE`**，与现状一致（现状不阻断网络，默认不得回归成"阻断"）
 * @param {object|null} [options.api] WFP 绑定表（含 `pin` 时无需再显式传 `pin`）
 * @param {Function|object|null} [options.probe] 可用性探测（见 `runProbe`）
 * @param {object|null} [options.guids] 语义键名 → GUID（透传给 `planOfflineRules`，本模块不内置任何 GUID）；
 *   `null`/`undefined` 一律按"没有提供 GUID"归一，由既有的 `WFP_GUIDS_MISSING` 类型化拒绝，
 *   **不泄漏原生 `TypeError`**（见 `normaliseGuids`）
 * @param {'appcontainer'|'app-identifier'} [options.target='appcontainer']
 * @param {Function|null} [options.pin] `pin(buffer) -> 原生地址`
 * @param {object|null} [options.install] `installNetworkPolicy()` 的产物（安装证据）。
 *   **只接受真实产物**：来源校验见 `verifyInstallEvidence()`（模块私有 WeakMap + 私有品牌符号，
 *   且必须与本 `api`/本计划同源 —— 同源性按**计划指纹**比字符串，改计划活对象无效；
 *   `teardown()` 之后作废）。自造的 `{ installed: [...] }`
 *   ⇒ `state:'not-enforced'` / `enforced:false`（fail-closed），**不会**被判成已强制。
 * @param {object|null} [options.audit] 回读核对证据：**不参与判定**，只按判定字段与安装时写入记录
 *   的冻结快照比对；不一致（含被篡改或被替换成另一个对象且字段不同）整条证据降级为
 *   `audit-mismatch` —— 防止用伪造/篡改的 `{verified:true}` 把"已强制但未独立验证"升级成"已核对"。
 *   判定始终只读快照（详见 `INSTALL_EVIDENCE_RECORDS` 与 `verifyInstallEvidence`）。
 * @returns {{tier:string,state:string,enforced:boolean,verified:boolean,reason:string,plan:object|null}}
 */
export function resolveNetworkPolicy(options = {}) {
  const {
    requested = 'OBSERVED_ONLINE',
    api = null,
    probe = null,
    guids = null,
    target = 'appcontainer',
    pin = null,
    install = null,
    audit = null,
  } = options ?? {}

  if (!NETWORK_TIERS.includes(requested)) {
    throw netError(
      'NETWORK_TIER_INVALID',
      `未知网络档位 ${JSON.stringify(requested)}：必须是 ${NETWORK_TIERS.join(' / ')} 之一 —— ` +
        '拒绝把未知档位当成"不阻断"或"已阻断"（fail-closed）',
    )
  }

  // `guids` 归一：`null` / `undefined` 都表示"没有提供 GUID"（见 normaliseGuids 的理由）。
  // 归一放在最前面，保证后面每一步（判定与转发给 wfp.mjs）看到的都是同一份输入。
  const effectiveGuids = normaliseGuids(guids)

  const isOffline = requested === 'OFFLINE'
  let probeOutcome = null
  let missingBindings = []

  if (isOffline) {
    // ── 1. 绑定表
    missingBindings = missingInstallBindings(api)
    if (missingBindings.length > 0) {
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: WFP 绑定表不可用（缺少 ${missingBindings.join(', ')}），无法调用 FwpmFilterAdd0 ` +
          '安装阻断过滤器 —— 拒绝声称网络已阻断（fail-closed）',
        { missingBindings },
      )
    }
    // ── 2. pin 回调
    if (resolvePin(api, pin) === null) {
      return refusedResult(
        requested,
        'WFP_PIN_REQUIRED: 缺少 pin(buffer)->原生地址 回调（也未挂在绑定表 api.pin 上）：' +
          'FWPM_FILTER0.filterCondition / FWPM_DISPLAY_DATA0.name/description / FWPM_SUBLAYER0.displayData ' +
          '都是内嵌指针，JS Buffer 拿不到原生地址 ⇒ 计划不可安装，拒绝声称已阻断',
        { missingBindings: ['pin'] },
      )
    }
    // ── 3. 可用性探测
    probeOutcome = runProbe(api, probe)
    if (probeOutcome.available !== true) {
      const statusText =
        probeOutcome.status === undefined || probeOutcome.status === null
          ? ''
          : ` (status=0x${(probeOutcome.status >>> 0).toString(16)} ${describeWfpStatus(probeOutcome.status)})`
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: WFP 可用性探测失败 —— ${probeOutcome.detail ?? '(无 detail)'}${statusText} —— ` +
          '拒绝声称网络已阻断（fail-closed）',
        { probe: probeOutcome, missingBindings },
      )
    }
    // ── 4. 引擎是否真能打开（只开/关，不改任何系统状态）
    try {
      const engine = openEngine(api)
      try {
        engine.close()
      } catch {
        /* 关闭失败不影响"能开"这一判定；拆除阶段会单独报告 */
      }
    } catch (error) {
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: 引擎无法打开（FwpmEngineOpen0）—— ${error.message} —— 拒绝声称网络已阻断（fail-closed）`,
        { probe: probeOutcome, missingBindings },
      )
    }
  }

  // ── 5. 计划（完全交给 planOfflineRules，本模块不重实现）
  let plan = null
  let planError = null
  try {
    plan = planOfflineRules({ tier: requested, target, guids: effectiveGuids })
  } catch (error) {
    planError = error
  }

  if (planError) {
    // 非 OFFLINE 档位：planOfflineRules 以 WFP_TIER_NOT_IMPLEMENTED 明确拒绝构造计划。
    // 这里**如实转述**成 NOT_IMPLEMENTED —— 既不静默放行成 ENFORCED，也不假装拒绝执行：
    // 该档位不作任何阻断声明，所以执行仍然允许。
    if (planError.code === 'WFP_TIER_NOT_IMPLEMENTED' || !isOffline) {
      return {
        tier: requested,
        state: NETWORK_TIER_STATES.NOT_IMPLEMENTED,
        enforced: false,
        verified: false,
        reason:
          `档位 ${requested} 未实现（${planError.code ?? 'WFP_TIER_NOT_IMPLEMENTED'}）：${planError.message} ` +
          '—— 该档位不作出阻断声明，因此仍允许执行，但绝不报告 enforced=true',
        plan: null,
      }
    }
    return refusedResult(
      requested,
      `${planError.code ?? 'WFP_PLAN_FAILED'}: ${planError.message} —— 计划不可安装，拒绝声称已阻断（fail-closed）`,
      { missing: planError.missing, probe: probeOutcome, missingBindings },
    )
  }

  // ── 6. 有无安装证据（**来源校验**：只认 installNetworkPolicy() 亲自产出的证据）──────
  // D2 修复：`enforced:true` 这条声明必须绑定到"真的调用过 FwpmFilterAdd0"。
  // 调用方自造的 `{ installed: [...] }`（哪怕形状完全正确）在这里被判为不可信，
  // 降级成 `not-enforced` / `enforced:false` —— 声明面不再能被注入对象"说服"。
  const evidence = verifyInstallEvidence({ install, api, plan, guids: effectiveGuids, audit })
  let verdict
  if (!evidence.ok) {
    const noEvidenceAtAll = evidence.reason === 'missing-install'
    verdict = noEvidenceAtAll
      ? enforcementFromEvidence({ plan, install: null, audit: null })
      : {
          state: NETWORK_TIER_STATES.NOT_ENFORCED,
          enforced: false,
          verified: false,
          reason:
            `安装证据不被采信（${evidence.reason}）：enforced:true 只接受 installNetworkPolicy() ` +
            '亲自产出、且与本绑定表/本计划同源的证据；自造或转发的 { installed: [...] } ' +
            '（含伪造的 audit）一律按"未强制"处理（fail-closed，见 src/netpolicy.mjs 的 INSTALL_EVIDENCE_RECORDS）',
        }
  } else {
    verdict = enforcementFromEvidence({ plan, install: evidence.install, audit: evidence.audit })
  }
  return {
    tier: requested,
    state: verdict.state,
    enforced: verdict.enforced,
    verified: verdict.verified,
    reason: verdict.reason,
    plan,
    probe: probeOutcome,
    missingBindings,
  }
}

/**
 * 由"安装证据"决定 `ENFORCED` / `NOT_ENFORCED`。
 *
 * ⚠ 本函数是**纯形状判定**，它**不校验证据来源** —— 唯一调用方
 * `resolveNetworkPolicy()` 必须先用 `verifyInstallEvidence()` 把自造证据挡掉（D2）。
 * 直接拿本函数去判定调用方输入就等于重新引入那个 fail-open。
 *
 * ⚠ `audit` 只接受 `verifyInstallEvidence()` 从记录里取出的**冻结快照**（N1）：
 * 这里**不再**回落到 `install.audit`，因为那条回落读的是活对象 —— 调用方改一下
 * `inst.audit.verified` 就能把 `verified:false` 变成 `verified:true`。
 *
 * 硬不变量：`enforced:true` 当且仅当
 *   - 已安装过滤器数量 == 计划数量（真的全装上了），**且**
 *   - 有回读核对结果，**且**
 *   - 回读核对通过；或者绑定表**不提供**回读入口（此时无从核对，理由必须写明"未独立验证"）。
 *
 * 任何其它组合（无证据 / 部分安装 / 回读说缺过滤器 / 回读字段不一致 / 连 audit 都没有）
 * 一律 `NOT_ENFORCED`，绝不 `enforced:true`。
 */
function enforcementFromEvidence({ plan, install, audit }) {
  const expected = Array.isArray(plan?.filters) ? plan.filters.length : 0
  const applied = appliedCount(install)
  if (!install) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason:
        `OFFLINE 计划已解析且前置条件满足（${expected} 条规则），但**没有任何安装证据**` +
        '（未调用 FwpmFilterAdd0 / 未提供 install 结果）—— 不得声称网络已阻断',
    }
  }
  if (applied < expected) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `只安装了 ${applied}/${expected} 条过滤器（部分安装），未安装者放行流量 —— 不声称已强制`,
    }
  }
  // 判定依据**只能**是上面拿到的冻结快照（N1 修复点）：绝不再读 `install.audit` 这类活对象。
  const auditResult = audit ?? null
  if (!auditResult) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `已安装 ${applied}/${expected} 条过滤器，但没有任何回读核对结果（audit 缺失）—— fail-closed：不声称已强制`,
    }
  }
  if (auditResult.verified === true) {
    return {
      state: NETWORK_TIER_STATES.ENFORCED,
      enforced: true,
      verified: true,
      reason: `已安装 ${applied}/${expected} 条过滤器，并已从引擎回读核对通过（存在性 + 层/子层一致）—— 网络已强制阻断`,
    }
  }
  if (auditResult.reason === ENUMERATION_UNAVAILABLE_REASON) {
    return {
      state: NETWORK_TIER_STATES.ENFORCED,
      enforced: true,
      verified: false,
      reason:
        `已安装 ${applied}/${expected} 条过滤器；但本机绑定表不提供过滤器回读入口` +
        `（${ENUMERATION_UNAVAILABLE_REASON}）—— 已强制但**未独立验证**（不得读成"已核对"）`,
    }
  }
  return {
    state: NETWORK_TIER_STATES.NOT_ENFORCED,
    enforced: false,
    verified: false,
    reason: `回读核对未通过：${auditResult.reason ?? '(无 reason)'} —— 不声称已强制`,
  }
}

/** 安装证据里到底装了几条（兼容 `installed[]` / `installed.filters[]` / `filterIds[]` 三种形状） */
function appliedCount(install) {
  if (!install || typeof install !== 'object') return 0
  if (Array.isArray(install.installed)) return install.installed.length
  if (install.installed && Array.isArray(install.installed.filters)) return install.installed.filters.length
  if (Array.isArray(install.filterIds)) return install.filterIds.length
  return 0
}

// ─────────────────────────── 安装编排 ───────────────────────────

/**
 * 把 OFFLINE 计划真正装到 BFE 上，并做一次回读核对。
 *
 * 全部结构构造交给 `src/wfp.mjs::applyOfflinePlan()`（本模块不重建任何结构）。
 * 任何一步失败都先在**同一条路径**里做 best-effort 拆除（删已装 filter → 删 sublayer → 关引擎），
 * 再抛类型化错误，并把拆除结果挂在错误的 `policyTeardown` / `teardownFailures` 上 ——
 * 拆除本身失败也必须可见，不能掩盖原错误（与 `applyOfflinePlan` 的 `rollbackFailures` 同精神）。
 *
 * 回读核对失败（绑定表提供了回读入口，但引擎说过滤器不在/字段不符）时，按 fail-closed
 * **立即拆除并抛 `NETWORK_POLICY_VERIFY_FAILED`**：宁可退回"网络是通的"，也绝不留下
 * "看起来装上了、其实没生效"的过滤器 —— 那正是本项目最想避免的失败模式。
 *
 * @param {object} spec
 * @param {object} spec.api WFP 绑定表
 * @param {object} spec.plan `planOfflineRules()` 的产物（本函数**不修改**它）
 * @param {object} spec.guids 语义键名 → GUID / targetValue
 * @param {Function} [spec.pin] `pin(buffer) -> 原生地址`（也可挂在 `api.pin` 上）
 * @param {Function} [spec.retainPointer] 生命周期托管回调，透传给 `applyOfflinePlan`
 * @returns {{installed:Array<{key:string,layerKey:string,filterId:*}>,
 *            subLayerKey:string, filterIds:Array<*>, teardown:Function,
 *            plan:object, engine:object, audit:object}}
 *   `teardown()` 幂等：删 filter（逆序）→ 删 sublayer → 关引擎，返回
 *   `{ removed, subLayerRemoved, subLayerIdempotent, engineClosed, failures, skipped }`，**从不抛错**。
 *   D2：返回值被登记进模块私有 `INSTALL_EVIDENCE_RECORDS`（`WeakMap`）并打上私有品牌符号，
 *   因此它是**唯一**能让 `resolveNetworkPolicy()` 采信的安装证据；`teardown()` 之后该证据作废。
 *   N1/N2：登记的是**冻结记录**（计划指纹 + 审计冻结快照），不是 `plan`/`audit` 活引用 ——
 *   调用方事后改 `result.plan.*` 或 `result.audit.*` 都不能改变判定。
 *   R3-1：指纹的输入包含当次 `guids`（层 GUID / 条件 GUID / `targetValue`）——
 *   换 GUID 复判即 `plan-mismatch` / `enforced:false`。
 *   R3-2：拆除走安装时定住的 `engineCloser`，**不读**可变的 `result.engine`。
 */
export function installNetworkPolicy({ api, plan, guids, pin = null, retainPointer = () => {} } = {}) {
  // ── 改任何状态之前，先确认"装得上 + 拆得掉"（与 applyOfflinePlan 同一 fail-closed 理由）
  const missing = missingInstallBindings(api)
  if (missing.length > 0) {
    throw netError(
      'NETWORK_POLICY_INSTALL_FAILED',
      `WFP 绑定表缺少 ${missing.join(', ')}：拒绝安装无法回滚的网络过滤器（fail-closed）`,
      { stage: 'precondition', originalCode: 'WFP_UNAVAILABLE', missingBindings: missing, installed: [], teardownFailures: [] },
    )
  }
  if (!plan || typeof plan !== 'object' || plan.tier !== 'OFFLINE' || !Array.isArray(plan.filters)) {
    throw netError(
      'NETWORK_POLICY_INSTALL_FAILED',
      'installNetworkPolicy 只接受 planOfflineRules() 产出的 OFFLINE 计划（plan.tier === "OFFLINE" 且 plan.filters 为数组）—— 不猜、不降级',
      { stage: 'precondition', originalCode: 'NETWORK_POLICY_PLAN_INVALID', installed: [], teardownFailures: [] },
    )
  }
  if (resolvePin(api, pin) === null) {
    throw netError(
      'NETWORK_POLICY_INSTALL_FAILED',
      'WFP_PIN_REQUIRED: 缺少 pin(buffer)->原生地址 回调，内嵌指针无法构造，拒绝开始安装（改动系统状态之前就拒绝）',
      { stage: 'precondition', originalCode: 'WFP_PIN_REQUIRED', installed: [], teardownFailures: [] },
    )
  }

  let engine
  try {
    engine = openEngine(api)
  } catch (error) {
    throw netError('NETWORK_POLICY_INSTALL_FAILED', `引擎无法打开，未安装任何过滤器：${error.message}`, {
      stage: 'engine-open',
      originalCode: error.code ?? 'WFP_UNAVAILABLE',
      cause: error,
      installed: [],
      teardownFailures: [],
      policyTeardown: null,
    })
  }

  /**
   * R3-2：拆除所需的引擎凭据在**安装时**定住，拆除时不再读调用方可见的 `engine` 对象。
   *
   * 为什么必须这样：`engine` 同时也是返回值 `result.engine`，是可变的活引用 —— 调用方事后
   * `result.engine.close = <假函数>`，老实现的 `teardown()` 就会照着改后的对象报告
   * "engineClosed:true"，而真实 `FwpmEngineClose0` **一次都没调**（第三轮复核 R3-2 的复现）。
   * `bind` 后的关闭函数把当时那个会话（句柄 + 绑定表）关进闭包，句柄同样是安装时的快照；
   * `Object.freeze` 之后连本对象也改不动。`[实测]` 修复后改写 `result.engine.close`（或整体
   * 替换 `result.engine`）都不影响真实拆除，关闭失败仍如实进 `failures`/`teardownFailures`
   * （`tests/netpolicy.mjs` 的 2s/2t 钉死）。
   */
  const engineCloser = Object.freeze({
    handle: engineHandleOf(engine),
    close: typeof engine.close === 'function' ? engine.close.bind(engine) : null,
  })

  /** 已记录 filterId 的安装项（顺序 = 安装顺序；拆除时逆序） */
  const recorded = []
  let tornDown = false
  /**
   * D2：本函数产出的安装证据记录（**成功返回前才填入**）。
   * N1/N2：记录本身 `Object.freeze`（计划只存指纹、审计只存冻结快照），
   * 所以"拆除后作废"改用模块私有 `INVALIDATED_INSTALL_EVIDENCE`（`WeakSet`）表达：
   * `teardown()` 里记住**返回值对象**，作废时把它加进该集合。
   */
  let evidenceRecord = null
  let evidenceResult = null
  /**
   * 拆除时要删的 sublayer key：在改任何系统状态之前**定住**（与计划指纹同一精神）。
   *
   * 若拆除时再读 `plan.subLayerKey`，调用方事后改计划对象就能让拆除删错 key
   * （删不掉真的那个 sublayer）；定住之后拆除只认"安装时那个计划"。
   */
  const installedSubLayerKey = plan.subLayerKey

  /** best-effort 拆除：删 filter（逆序）→ 删 sublayer → 关引擎；幂等且从不抛错 */
  const teardown = () => {
    if (tornDown) {
      return { removed: [], subLayerRemoved: false, subLayerIdempotent: false, engineClosed: false, failures: [], skipped: true }
    }
    tornDown = true
    // D2：拆除之后这条安装证据不再代表"当前网络被挡住"（过滤器已经删了）——
    // 记入作废集合，`resolveNetworkPolicy` 会拒绝再据此声称 enforced:true（reason=evidence-torn-down）。
    if (evidenceResult !== null) INVALIDATED_INSTALL_EVIDENCE.add(evidenceResult)
    const failures = []
    const removed = []
    for (const item of [...recorded].reverse()) {
      try {
        deleteFilterById(api, engineCloser.handle, item.id)
        removed.push(item.id)
      } catch (error) {
        failures.push(`FwpmFilterDeleteById0(${String(item.id)}) 失败：${error.message}`)
      }
    }
    let subLayerRemoved = false
    let subLayerIdempotent = false
    try {
      const result = deleteSubLayerByKey(api, engineCloser.handle, installedSubLayerKey)
      subLayerRemoved = true
      subLayerIdempotent = result?.idempotent === true
    } catch (error) {
      failures.push(`FwpmSubLayerDeleteByKey0(${installedSubLayerKey}) 失败：${error.message}`)
    }
    let engineClosed = false
    try {
      if (engineCloser.close === null) {
        // 不假装已关闭：拿不到安装时的关闭函数就如实记为失败（fail-closed 的报告面）。
        failures.push('FwpmEngineClose0 不可用：安装时未捕获到 engine.close（不假装已关闭）')
      } else {
        const result = engineCloser.close()
        engineClosed = (result?.failures?.length ?? 1) === 0
        for (const failure of result?.failures ?? []) failures.push(`FwpmEngineClose0 失败：${failure}`)
      }
    } catch (error) {
      failures.push(`FwpmEngineClose0 抛错：${error.message}`)
    }
    return { removed, subLayerRemoved, subLayerIdempotent, engineClosed, failures, skipped: false }
  }

  try {
    const applied = applyOfflinePlan(api, engine, plan, guids, retainPointer, pin)
    for (const filter of applied.filters ?? []) {
      recorded.push({ id: filter.filterId, key: filter.key, layerKey: filter.layerKey })
    }

    let auditResult
    try {
      auditResult = auditNetworkPolicy({ api, engine, plan, guids, filterIds: recorded.map((item) => item.id) })
    } catch (error) {
      throw netError('NETWORK_POLICY_VERIFY_FAILED', `回读核对抛错：${error.message}`, {
        stage: 'verify',
        originalCode: error.code ?? 'NETWORK_POLICY_AUDIT_FAILED',
        cause: error,
      })
    }
    if (auditResult.verified === false && auditResult.reason !== ENUMERATION_UNAVAILABLE_REASON) {
      throw netError(
        'NETWORK_POLICY_VERIFY_FAILED',
        `已调用 FwpmFilterAdd0 但引擎回读核对未通过（${auditResult.reason}）—— 按 fail-closed 立即回滚，` +
          '绝不留下"看起来装上了"的过滤器',
        { stage: 'verify', originalCode: 'NETWORK_POLICY_VERIFY_FAILED', audit: auditResult },
      )
    }

    const result = {
      installed: recorded.map((item) => ({ key: item.key, layerKey: item.layerKey, filterId: item.id })),
      subLayerKey: applied.subLayerKey ?? plan.subLayerKey,
      filterIds: recorded.map((item) => item.id),
      teardown,
      /** 以下为附加字段（便于审计 / 能力报告接线），不属于规定返回形状 */
      plan,
      engine,
      audit: auditResult,
    }
    // ── D2：把返回值登记为"**真实**安装证据"（模块私有 WeakMap + 私有品牌符号）──────
    // N1/N2/R3-1/R3-2：记录是**不可变证据**，不留可被冒名的活对象：
    //   · `plan`   → `planFingerprint(plan, guids)`（安装时算好的确定性字符串；覆盖计划结构
    //                **与**该计划真正消费的 GUID/条件值 —— 改计划对象或 guids 对象都无效，R3-1）；
    //   · `audit`  → `auditVerdictSnapshot`（冻结的结构快照，调用方改 `result.audit.verified` 无效），
    //                另存 `auditFingerprint` 用于与调用方回传的 audit 做**内容**比对；
    //   · `api` / `engine` 仍按**同一性**保留：判据 4/6 要比的正是同一性（`api-mismatch` /
    //                `engine-missing`），比快照反而会丢掉那条降级语义。`engine` 是活引用、
    //                可能被调用方改写，所以**拆除只用 `engineCloser`**（R3-2），
    //                `teardown()` 一次都不读 `record.engine`；
    //   · 记录本身 `Object.freeze`，`engineCloser` / `evidence` 及其数组也全部冻结。
    // 冻结快照的意义：判定计数只用 `evidenceRecord.evidence`，调用方事后
    // `result.installed.push(...)` / `result.installed.length = 0` 都抬不高、抬不低计数
    // （WeakMap 里的对象不是它）。
    // 品牌符号非枚举：不进 JSON / 不被 `{...result}` 拷贝（拷贝件因此不再是证据）。
    evidenceRecord = Object.freeze({
      api,
      planFingerprint: planFingerprint(plan, guids),
      engine,
      engineCloser,
      audit: auditVerdictSnapshot(auditResult),
      auditFingerprint: auditVerdictFingerprint(auditResult),
      evidence: Object.freeze({
        installed: Object.freeze(recorded.map((item) => Object.freeze({ key: item.key, layerKey: item.layerKey, filterId: item.id }))),
        filterIds: Object.freeze(recorded.map((item) => item.id)),
      }),
    })
    INSTALL_EVIDENCE_RECORDS.set(result, evidenceRecord)
    // `teardown()` 作废证据时要拿到返回值对象本身（记录已冻结，不能靠改字段表达"非活跃"）
    evidenceResult = result
    Object.defineProperty(result, INSTALL_EVIDENCE_BRAND, { value: true, enumerable: false, writable: false, configurable: false })
    return result
  } catch (error) {
    // 拆除**同一路径**内完成：删 filter（逆序）→ 删 sublayer → 关引擎（DYNAMIC 会话兜底）。
    // 拆除自身失败一并上报（error.teardownFailures），绝不掩盖原错误。
    const cleanup = teardown()
    // applyOfflinePlan 内部已经回滚过一轮，它的 rollbackFailures 也要并进来一起交代
    const failures = [
      ...(Array.isArray(error?.rollbackFailures) ? error.rollbackFailures.map((text) => `applyOfflinePlan 回滚：${text}`) : []),
      ...cleanup.failures,
    ]
    if (error && error.code === 'NETWORK_POLICY_VERIFY_FAILED') {
      error.teardownFailures = failures
      error.policyTeardown = cleanup
      error.installed = recorded.map((item) => item.id)
      throw error
    }
    throw netError('NETWORK_POLICY_INSTALL_FAILED', `${error?.code ?? 'WFP_ERROR'}: ${error?.message ?? String(error)}`, {
      stage: 'apply',
      originalCode: error?.code ?? null,
      cause: error,
      installed: recorded.map((item) => item.id),
      teardownFailures: failures,
      policyTeardown: cleanup,
      rollbackFailures: Array.isArray(error?.rollbackFailures) ? error.rollbackFailures : [],
    })
  }
}

// ─────────────────────────── 回读审计 ───────────────────────────

/**
 * 从引擎**回读**计划里的过滤器，核对它们真的存在且字段一致。
 *
 * 回读入口（按优先级，`[官方]`）：
 *   1. `api.fwpmFilterGetByKey0(handle, keyGuid, out)` —— 按 `filterKey` 精确回读
 *      （对应 `FwpmFilterGetByKey0`）。`filterKey` 由 `planOfflineRules()` 的稳定 key 提供，
 *      因此这条路径**不依赖**安装时记下的 `filterId`。
 *   2. `api.fwpmFilterEnum0(handle, template, out)` —— 整表枚举（对应 `FwpmFilterEnum0`），
 *      在返回项里按 key 匹配计划中的规则。
 *   3. 都没有 → `verified:false` / `reason:'enumeration-unavailable'`，**绝不猜**。
 *
 * 返回项必须是**绑定层已 marshal 成 JS 可见**的对象（`filterKey` / `layerKey` / `subLayerKey`
 * 可以是 16 字节 Buffer 或 GUID 文本）—— 把原生 `FWPM_FILTER0*` 解引用成 JS 值属于绑定层职责，
 * 本模块不碰内存布局（因此也不重复任何 `OFF_*` 常量）。
 *
 * 注意 `plan.filters[].layerKey` 是**语义键名**（如 `ALE_AUTH_CONNECT_V4`），不是 GUID：
 * 所以"层是否一致"只有在调用方把 `guids` 一并给出时才**可能**核对。没给 `guids` 时
 * 本函数只核对"存在性 + subLayerKey"，并把结果里的 `layerChecked` 标为 false ——
 * **不猜**层是否一致。
 *
 * @param {object} spec
 * @param {object} spec.api WFP 绑定表
 * @param {object|*} spec.engine `openEngine()` 的产物（`{handle}`）或裸句柄
 * @param {object} spec.plan `planOfflineRules()` 的产物
 * @param {object|null} [spec.guids] 语义键名 → GUID（给了才核对 layerKey）
 * @param {Array<*>} [spec.filterIds] 安装时记下的 id（仅作附注，不参与判定）
 * @returns {{installed:boolean,filterCount:number,subLayerKey:string|null,verified:boolean,reason:string,layerChecked:boolean}}
 */
export function auditNetworkPolicy({ api, engine, plan, guids = null, filterIds = null } = {}) {
  const subLayerKey = plan?.subLayerKey ?? null
  const handle = engineHandleOf(engine)
  const expected = Array.isArray(plan?.filters) ? plan.filters.length : 0

  if (!plan || !Array.isArray(plan.filters)) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: 'plan-missing' }
  }
  if (expected === 0) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: 'plan-empty' }
  }
  if (handle === null) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: 'no-engine' }
  }

  const hasGetByKey = typeof api?.fwpmFilterGetByKey0 === 'function'
  const hasEnum = typeof api?.fwpmFilterEnum0 === 'function'
  if (!hasGetByKey && !hasEnum) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: ENUMERATION_UNAVAILABLE_REASON }
  }

  let rawEntries = []
  let lookupNote = ''
  try {
    if (hasGetByKey) {
      const statuses = []
      for (const rule of plan.filters) {
        const slot = [null]
        const returned = api.fwpmFilterGetByKey0(handle, coerceGuid(rule.key, 'filterKey'), slot)
        const { status, out } = splitStatusAndOut(returned, slot, 'filter')
        if (status === 0 && out) rawEntries.push(out)
        else if (status !== 0) statuses.push(`0x${status.toString(16)}:${describeWfpStatus(status)}`)
      }
      if (statuses.length > 0) lookupNote = `；回读状态：${statuses.join(', ')}`
    } else {
      const slot = [null]
      const returned = api.fwpmFilterEnum0(handle, null, slot)
      const { status, out } = splitStatusAndOut(returned, slot, 'entries')
      if (status !== 0) {
        return {
          installed: false,
          filterCount: 0,
          subLayerKey,
          verified: false,
          reason: `enumeration-failed:FwpmFilterEnum0 -> 0x${status.toString(16)}`,
        }
      }
      rawEntries = Array.isArray(out) ? out : Array.isArray(out?.entries) ? out.entries : []
    }
  } catch (error) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: `enumeration-failed:${error.message}` }
  }

  const planned = new Map(plan.filters.map((rule) => [guidText(rule.key) ?? rule.key, rule]))
  // 期望的层 GUID：plan 里存的是语义键名，只有 guids 才能把它翻成 GUID（没有就不核对层）
  const expectedLayers = new Map(
    plan.filters.map((rule) => [
      guidText(rule.key) ?? rule.key,
      guids && typeof guids === 'object' ? guidText(guids[rule.layerKey]) : null,
    ]),
  )
  const matched = new Map()
  let fieldsIncomplete = false
  let fieldsMismatch = false
  let layerChecked = false

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') continue
    const key = guidText(entry.filterKey ?? entry.key)
    if (key === null) {
      fieldsIncomplete = true
      continue
    }
    const rule = planned.get(key)
    if (!rule) continue // 引擎里别的过滤器不算数，也不当作错误
    const layerKey = guidText(entry.layerKey ?? entry.layer)
    const entrySubLayer = guidText(entry.subLayerKey ?? entry.subLayer)
    if (layerKey === null || entrySubLayer === null) {
      fieldsIncomplete = true
      matched.set(key, rule)
      continue
    }
    const wantedLayer = expectedLayers.get(key) ?? null
    if (wantedLayer !== null) {
      layerChecked = true
      if (layerKey !== wantedLayer) fieldsMismatch = true
    }
    if (subLayerKey !== null && entrySubLayer !== subLayerKey) fieldsMismatch = true
    matched.set(key, rule)
  }

  const installed = matched.size === expected
  let reason
  if (!installed) reason = `filters-missing:${matched.size}/${expected}${lookupNote}`
  else if (fieldsIncomplete) reason = 'enumeration-fields-incomplete'
  else if (fieldsMismatch) reason = 'filter-fields-mismatch'
  else reason = 'verified'

  return {
    installed,
    filterCount: rawEntries.length,
    subLayerKey,
    verified: installed && !fieldsIncomplete && !fieldsMismatch,
    reason,
    layerChecked,
    // 纯附注：这里的 id 只用于报告/日志，**不是**删除凭据（删除凭据在 installNetworkPolicy
    // 的 `filterIds` 里，保持 UINT64 的 BigInt 原样）。转成字符串是为了让审计结果能直接
    // `JSON.stringify` 进能力报告 —— BigInt 会让 JSON 序列化抛错。
    filterIds: Array.isArray(filterIds) ? filterIds.map((id) => (typeof id === 'bigint' ? id.toString() : id)) : null,
  }
}

// ─────────────────────────── 报告 ───────────────────────────

const STATE_LABELS = Object.freeze({
  [NETWORK_TIER_STATES.ENFORCED]: '已强制',
  [NETWORK_TIER_STATES.NOT_ENFORCED]: '未强制',
  [NETWORK_TIER_STATES.REFUSED]: '已拒绝（能力不足，拒绝声称已阻断）',
  [NETWORK_TIER_STATES.NOT_IMPLEMENTED]: '未实现（不作阻断声明）',
})

/**
 * 一行中文摘要，给日志/审计用（**不含换行**，便于 `src/testrunner.mjs::verdictLineOf` 之类的行解析）。
 */
export function describeNetworkPolicy(result) {
  const summary = summariseNetworkPolicy(result)
  const label = STATE_LABELS[summary.state] ?? summary.state
  return (
    `网络策略 ${summary.tier ?? '(未解析)'}：状态=${summary.state}（${label}）；` +
    `enforced=${summary.enforced}；verified=${summary.verified}；原因=${summary.reason}`
  )
}

/**
 * 给能力报告用的结构化摘要（固定五个键）。
 *
 * 任何异常/缺失输入都归到 `not-enforced` + `enforced:false`：摘要层也**绝不**制造
 * `enforced:true`（fail-closed 一路贯到报告面）。
 */
export function summariseNetworkPolicy(result) {
  if (!result || typeof result !== 'object') {
    return {
      tier: null,
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: '缺少网络策略解析结果 —— 不得据此声称网络已强制（fail-closed）',
    }
  }
  return {
    tier: result.tier ?? null,
    state: result.state ?? NETWORK_TIER_STATES.NOT_ENFORCED,
    enforced: result.enforced === true,
    verified: result.verified === true,
    reason: typeof result.reason === 'string' ? result.reason : '',
  }
}
