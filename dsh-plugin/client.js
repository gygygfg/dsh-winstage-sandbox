/**
 * WinStageSandbox — 客户端半：设置开关 + **暂存审阅悬浮窗**
 *
 * ── 悬浮窗挂在哪个槽位（读源码得到，不是猜的）────────────────────────────────
 * `conversation.composer` 是 **chain** 槽位："Selector-routed replacements for the
 * current Session's resident composer"。它的注册契约只有一个必填项：
 *   select: (owner) => unknown | null
 * 条目按**升序**依次询问，第一个返回非 null 的接管输入框，其返回值作为组件的
 * `matched` prop；全部为 null 时落回宿主自己的输入框。
 * 内置审批面板（`@deepseek-ai/dsh-client-ui-approval`）用的就是同一个槽位
 * （priority: 1），因此本插件的审阅窗用 **priority: 20**：审批窗优先，
 * 否则由本窗接管 —— 视觉上与审批卡片同类（输入框上方的卡片）。
 *
 * ── 数据怎么来（DSH 的机制约束，必须如实说明）────────────────────────────────
 * Client **无法**注册新的 `ctx.remote.<命名空间>`：能力选集是构建期产物
 * （`@deepseek-ai/dsh-api-remotes`）。因此：
 *   - 读（**WP3-B 起**）：`fetch('/winstage-panel/snapshot?session=<会话 id>')` —— 这是
 *     宿主插件（`host-plugin.mjs`）注册的同源只读路由，**存储根在宿主侧**用
 *     `resolveReviewStoreDir()` 解析（Phase 1 起在 Windows 缓存里）。客户端只持有
 *     **逻辑标识**（路由名 + 会话 id + 存储短哈希），**不再自己拼任何路径**；
 *   - 读（兼容兜底，**不是首选**）：路由不可用时（宿主没装 webServer / 进程未重启到新代码）
 *     退回 `ctx.remote.workspaceFiles.read` 读**升级前**布局的那份快照。见
 *     `readReviewViaLegacyPath()` —— 全文件**只有那一处**拼旧布局，且带注释与来源标记；
 *   - 写：用**已有**的 `ctx.remote.commands.execute` 执行 `/winstage approve|reject`
 *     （命令不产生模型消息）。
 * 两条读法都只走用户侧（面板），命令自身的 stdout/stderr 与工具输出逐字节不变。
 * 另外 `fetch('/winstage-panel/trust')` 取同一份**可信性状态卡**（与 `/winstage status`
 * 同一个 `buildTrustCard()`），把"沙箱此刻可不可信"直接显示在面板上。
 *
 * ── 设计约束（来自技能的 UI 规则）────────────────────────────────────────────
 *   - 外观全部用 host 主题 token（`--dsw-*`），不写死颜色，因此明暗主题都正确；
 *   - **不 import 任何 Harness Client 包**（含 ui-primitives），控件自己写；
 *   - 在 `apply` 内注册资源并由 ctx.effect 拥有，卸载即撤；
 *   - **平台 UI 只在开关"确定开着"时才接管**（`readSwitch(form) === 'on'`）：关闭、
 *     `loading`、`unavailable`（宿主插件没装 / 本页看不到）、没有表单，一律不注册
 *     `conversation.input.permission` 的遮蔽，也不让 composer 审阅卡参与选举 ——
 *     平台原来的访问模式控件与它弹出的预设菜单/审批卡必须原样保留。
 *     见 §12.6「关闭/未知沙箱不得覆盖原版审批弹窗」。
 *   - 可见文案走 Client locale 服务；
 *   - 轮询是本实现的**已知折衷**：Client 收不到插件自定义的推送事件，
 *     所以按固定间隔读那一个小 JSON（默认 1500 ms）。文件不存在 = 没有待审。
 *   - **根只有一个来源**：插件 Config 的 `workspaceRoot`（C-7）。`owner.session.cwd`
 *     **不再**作为兜底 —— 那会读到**别的工作区**的 `.dshstage/review.json`；另外
 *     快照自带的 `workspaceRoot` 会与本面板的根做一致性自校验，不一致就不接管。
 */

window.__ModuleLoader__.load({
  id: 'dsh-winstage-sandbox',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 插件在 profile 里的命名空间（= cordis.patch.yml 里该行的 id） */
    const NAMESPACE = 'winstage-sandbox'
    /** 本行自己的字典命名空间 */
    const LOCALE_NS = 'settings.winstage'
    /** 槽位优先级：比内置审批窗（1）大，因此审批优先接管输入框 */
    const COMPOSER_PRIORITY = 20
    /**
     * `conversation.input.permission` 是 **single** 槽位，平台条目在 priority 0。
     * slots 的遮蔽规则是"**最低** priority 渲染"（dsh-client-ui-slots/lib/index.js:163-172
     * 逐字：`register at a different priority to shadow it (lowest renders)`；同 priority
     * 注册直接抛错）。因此本插件用 -10 遮蔽它。
     * ★ **只有开关确定开着**（`readSwitch() === 'on'`）才注册：关闭、以及状态未知
     *   （`loading` / `unavailable` / 没有表单 ⇒ 沙箱没装或本页读不到）一律撤销/不注册，
     *   平台控件与它弹出的预设菜单原样保留（见 `readSwitch` 的注释）。
     */
    const PERMISSION_PRIORITY = -10
    /** 快照轮询间隔；Client 收不到插件自定义推送，这是刻意的折衷 */
    const POLL_MS = 1500

    const dicts = {
      zh: {
        title: 'WinStage 沙箱',
        description:
          '启用 Windows 暂存—候选—选择性提交沙箱。关闭即卸载暂存与审阅面：写入退回平台自带的沙箱/审批模式，不再有暂存候选。',
        on: '已启用',
        off: '已关闭',
        unavailable: 'Host 未提供该设置项',
        error: '写入失败，已保留原值',
        loading: '读取中…',
        reviewTitle: 'WinStage 暂存待审',
        reviewWaiting: '等待你批准后才写入真实工作区',
        reviewFiles: '{files} 个文件',
        reviewCounts: '+{added} / −{removed}',
        noDiff: '（无差异内容）',
        groupInside: '工作区内',
        groupOutside: '工作区外',
        groupSensitive: '敏感',
        // S3i：等级徽章与面板标题条的分级文案
        levelL1: 'L1',
        levelL2: 'L2',
        levelL3: 'L3',
        reviewLevels: '{files} 个文件（{levels}）',
        badgeOutside: '工作区外',
        badgeSensitive: '敏感',
        badgeDanger: '危险',
        summaryOutside: '{count} 个在工作区外',
        summarySensitive: '{count} 个敏感',
        summaryDanger: '{count} 个危险',
        riskReason: '原因：{reason}',
        riskReasonUnknown: '命中敏感策略',
        riskCheckHint: '{path}（高风险项：需显式勾选才会被批准）',
        approveAllScope: '「批准全部」= 全部工作区内的普通项 + 你已勾选的工作区外/敏感项；未勾选的高风险项不会被写入。',
        alertTitle: '⚠ {count} 项危险改动',
        alertHint: '此提示不阻断任何操作，批准/拒绝仍可继续。',
        chipLabel: 'WinStage 待审 · {files}',
        // S3h：分级数量。L1 = 工作区内，L2 = 工作区外，L3 = 敏感；`danger` 是 L3 里更严的子档
        chipLabelLevels: 'WinStage 待审 · {files}（{levels}）',
        chipL1: 'L1 {count}',
        chipL2: 'L2 {count}',
        chipL3: 'L3 {count}',
        chipDanger: '危险 {count}',
        chipTitle: '展开审阅面板（这一版快照已收起；点这里即可恢复）\n分级：L1 = 工作区内 · L2 = 工作区外 · L3 = 敏感（"危险"是 L3 里更严的子档）。数字为全量计数，带 + 表示列表已截断。',
        defaultCollapsedOn: '默认收起：开',
        defaultCollapsedOff: '默认收起：关',
        defaultCollapsedHint: '开启后只在页面加载后的第一版待审快照上默认收起；之后各轮的新快照按你的手势走（chip 可随时收起/展开）',
        consentStale: '有 {count} 项档位已变化，需重新勾选后才会被批准',
        dangerHidden: '内容已按敏感策略省略',
        confirmTitle: '{count} 项命中敏感策略，需要二次确认',
        confirmBody: '批准会把暂存内容写入真实磁盘，且不可撤销。请逐条确认后果后再写入。',
        confirmReason: '命中：{reason}',
        confirmDanger: '危险档：可能是凭据/密钥或沙箱自身存储，落盘后可能被后续操作读取或覆盖。',
        confirmAccept: '我了解后果，确认写入',
        confirmCancel: '取消',
        nothingToApprove: '没有可批准的项：共 {total} 项，其中 {frozen} 项仅存档（不可批准）、{risky} 项高风险未勾选或档位已变（需重新勾选）',
        noSession: '当前没有会话身份，命令未执行（请刷新页面后重试）',
        commandNoOp: '命令未产生任何变化（宿主未返回原因）',
        unknownCommand: '命令未被执行：宿主没有识别该命令（本次没有任何改动落地）',
        rowFailed: '此条失败：{message}',
        commandTimeout: '命令超时（宿主 {seconds} 秒未响应），本次未执行；请重试（该条仍待审）',
        // D1：冻结存档行（`frozenOnly`）—— 路径已不在当前净 diff，只显示、**不可批准**
        frozenBadge: '存档',
        frozenReclaimed: '已不在当前净 diff：暂存内容已被回收，无法再批准',
        frozenNoOp: '已不在当前净 diff：该改动对真实磁盘没有净变化（例如删除一个本就不存在的文件），无法再批准',
        frozenNoNetChange: '已不在当前净 diff：暂存内容已被取代，无法再批准',
        frozenSummary: '{count} 项已不在当前净 diff（仅存档，不可批准）',
        baselineStale: '基线已过期',
        // 缺陷②（F5b）：这三条解释**为什么**过期。旧文案说"系统会自动重新对齐、无需手动操作"
        // —— 那正是丢数据的那条路径（自动对齐把外部写入变成可批准的 diff）。
        // 现在：不会自动对准有内容丢失风险的漂移，因此必须给出显式出路。
        baselineStaleAppeared: '真实文件在暂存之后出现（基线本为"不存在"）',
        baselineStaleDeleted: '真实文件在暂存之后被外部删除',
        baselineStaleDrifted: '真实文件在暂存之后被外部改写',
        baselineStaleTitle: '真实文件在暂存之后被外部改动过（手册 #12.1）。批准已被拒绝，真实磁盘上的内容不会被覆盖。出路：用「重新对齐基线」/「重新对齐并批准所选」，或 /winstage rebase；丢弃这份暂存用「拒绝」。',
        staleSummary: '{count} 项基线已过期（真实文件在暂存之后被外部改动）：批准会被拒绝，不会静默覆盖真实磁盘；请先 rebase 再批准，或拒绝这份暂存',
        // Method A 主线：AI 进程树的文件/注册表读写分类统计（宿主 `sandbox-audit.json` 的摘要）
        auditSummary: '审计：文件 读{read} 写{write}（工作区内{inws}/工作区外{outside}）删{deleted}；注册表 读{rread} 写{rwrite}',
        rebaseAll: '重新对齐基线',
        rebaseAndApprove: '重新对齐并批准所选',
        permIdle: 'WinStage 暂存',
        permPending: '暂存待审 {files}',
        permTitle: 'WinStage 沙箱：文件写入先落暂存、批准后才写真实工作区（已替代平台的访问模式选择器）',
        permOpenPanel: '查看待审（{files}）',
        permRefresh: '刷新暂存快照',
        permRebase: '重新对齐基线（{files} 项过期）',
        permDisable: '关闭 WinStage 沙箱',
        permDisableHint: '关闭后写盘退回平台自带的访问模式 / 审批',
        approveAll: '批准全部',
        approveSelected: '批准所选',
        rejectAll: '拒绝全部',
        dismiss: '暂时收起',
        selectAll: '全选',
        selectAllScope: '只选择工作区内的普通项；工作区外/敏感项需逐项勾选',
        clearSelection: '清空选择',
        opCreate: '新增',
        opModify: '修改',
        opDelete: '删除',
        opMkdir: '新建目录',
        busy: '处理中…',
        failed: '操作失败：{message}',
        // ── WP3：可信性状态卡（面板侧；与 /winstage status 同一份 buildTrustCard）──────
        // 这里只显示**一句话结论**，六个面的细节仍在 /winstage status 里（面板不堆术语）。
        trustLabel: '可信性',
        trustTrusted: '沙箱可信（命令走去令牌化通道，写入先落暂存）',
        trustAttention: '沙箱可信，但有 {count} 类待处理事项（详见 /winstage status）',
        trustDegraded: '⚠ 沙箱**不可信**：档位已掉档，写入只剩内核硬拒（详见 /winstage status）',
        trustLost: '⚠ 会话工作根已不可用：写入会失败，不会静默改写真实文件',
        trustWriteUnconfirmed: '⚠ 有写入未确认落盘（详见 /winstage status）',
        trustUnknown: '沙箱档位未知：尚无判定记录，按"未证实已生效"对待',
        trustOff: '沙箱已关闭（属预期）',
        trustSourceRoute: '读取来源：宿主路由（存储根由宿主解析）',
        trustSourceLegacy: '读取来源：兼容旧布局（宿主路由不可用，请重启宿主进程）',
        trustDetail: '档位 {lane} · 掉档 {degrades} 次 · 失根 {lost} 次 · 未结算审批 {approvals} · 未确认写入 {writes} · 敏感读 {reads}',
      },
      en: {
        title: 'WinStage Sandbox',
        description:
          'Enable the Windows staging–candidate–selective-commit sandbox. Turning it off unloads staging and the review panel: file writes return to the platform sandbox/approval mode and no candidates are kept.',
        on: 'Enabled',
        off: 'Disabled',
        unavailable: 'This setting is not exposed by the Host',
        error: 'Write failed; the previous value was kept',
        loading: 'Loading…',
        reviewTitle: 'WinStage staged changes',
        reviewWaiting: 'Nothing is written to the real workspace until you approve',
        reviewFiles: '{files} files',
        reviewCounts: '+{added} / −{removed}',
        noDiff: '(no textual difference)',
        groupInside: 'Inside workspace',
        groupOutside: 'Outside workspace',
        groupSensitive: 'Sensitive',
        levelL1: 'L1',
        levelL2: 'L2',
        levelL3: 'L3',
        reviewLevels: '{files} files ({levels})',
        badgeOutside: 'Outside',
        badgeSensitive: 'Sensitive',
        badgeDanger: 'DANGER',
        summaryOutside: '{count} outside',
        summarySensitive: '{count} sensitive',
        summaryDanger: '{count} danger',
        riskReason: 'Reason: {reason}',
        riskReasonUnknown: 'matched a sensitive policy',
        riskCheckHint: '{path} (high risk: approving requires ticking this box explicitly)',
        approveAllScope: '"Approve all" = every inside-workspace normal item + the outside/sensitive items you ticked; unticked high-risk items are never written.',
        alertTitle: '⚠ {count} dangerous change(s)',
        alertHint: 'This notice blocks nothing; approve/reject remain available.',
        chipLabel: 'WinStage pending · {files}',
        chipLabelLevels: 'WinStage pending · {files} ({levels})',
        chipL1: 'L1 {count}',
        chipL2: 'L2 {count}',
        chipL3: 'L3 {count}',
        chipDanger: 'Danger {count}',
        chipTitle: 'Reopen the review panel (this snapshot was hidden; click to restore)\nLevels: L1 = inside workspace · L2 = outside workspace · L3 = sensitive ("Danger" is the stricter sub-tier of L3). Counts are the full totals; a trailing + means the list was truncated.',
        defaultCollapsedOn: 'Default collapsed: on',
        defaultCollapsedOff: 'Default collapsed: off',
        defaultCollapsedHint: 'When on, only the first pending snapshot after page load starts collapsed; later snapshots follow your own collapse/expand (the chip reopens them)',
        consentStale: '{count} item(s) changed risk tier - tick them again to authorise',
        dangerHidden: 'Content omitted by the sensitive policy',
        confirmTitle: '{count} item(s) hit the sensitive policy - confirm again to write',
        confirmBody: 'Approving writes the staged content to the real disk and cannot be undone. Review each consequence before writing.',
        confirmReason: 'Matched: {reason}',
        confirmDanger: 'Danger tier: credentials/keys or the sandbox store itself; once written it can be read or overwritten by later operations.',
        confirmAccept: 'I understand - write anyway',
        confirmCancel: 'Cancel',
        nothingToApprove: 'Nothing to approve: {total} item(s), of which {frozen} are archive-only (not approvable) and {risky} are un-ticked/risk-tier-changed high-risk items (re-tick them)',
        noSession: 'No session identity on this panel - the command was not sent (refresh the page and retry)',
        commandNoOp: 'The command changed nothing (the host returned no reason)',
        unknownCommand: 'The command was not executed: the host did not recognise it (nothing was changed this time)',
        rowFailed: 'This item failed: {message}',
        commandTimeout: 'Command timed out (the host did not respond for {seconds}s); nothing was executed - retry (the item is still pending)',
        frozenBadge: 'archive',
        frozenReclaimed: 'no longer in the net diff: the staged content was reclaimed, so it cannot be approved',
        frozenNoOp: 'no longer in the net diff: this change has no net effect on the real disk (e.g. deleting a file that never existed), so it cannot be approved',
        frozenNoNetChange: 'no longer in the net diff: the staged content was superseded, so it cannot be approved',
        frozenSummary: '{count} item(s) are no longer in the net diff (archive only, not approvable)',
        baselineStale: 'stale baseline',
        baselineStaleAppeared: 'the real file appeared after staging (the baseline was "absent")',
        baselineStaleDeleted: 'the real file was deleted after staging',
        baselineStaleDrifted: 'the real file was changed after staging',
        baselineStaleTitle: 'The real file changed after staging (manual #12.1). Approval is refused; the content on the real disk is not overwritten. Use "re-align baseline" / "re-align and approve selected", or /winstage rebase; reject to discard this staged change.',
        staleSummary: '{count} item(s) have a stale baseline (the real file changed after staging): approval is refused and the real disk is not overwritten; re-align the baseline first, or reject this staged change',
        // Method A main line: classified file/registry read/write counts of the AI process tree
        auditSummary: 'Audit: files read {read}, written {write} (in-workspace {inws}/outside {outside}), deleted {deleted}; registry read {rread}, written {rwrite}',
        rebaseAll: 'Rebase onto real file',
        rebaseAndApprove: 'Rebase and approve selected',
        permIdle: 'WinStage staging',
        permPending: 'Staged {files}',
        permTitle: 'WinStage sandbox: writes land in staging and reach the real workspace only after approval (replaces the platform access-mode selector)',
        permOpenPanel: 'Review pending ({files})',
        permRefresh: 'Refresh staging snapshot',
        permRebase: 'Rebase onto real file ({files} stale)',
        permDisable: 'Turn off WinStage sandbox',
        permDisableHint: 'Turning it off returns file writes to the platform access mode / approval',
        approveAll: 'Approve all',
        approveSelected: 'Approve selected',
        rejectAll: 'Reject all',
        dismiss: 'Hide for now',
        selectAll: 'Select all',
        selectAllScope: 'Selects only inside-workspace normal items; outside/sensitive items must be ticked one by one',
        clearSelection: 'Clear',
        opCreate: 'create',
        opModify: 'modify',
        opDelete: 'delete',
        opMkdir: 'mkdir',
        busy: 'Working…',
        failed: 'Failed: {message}',
        // ── WP3 trust card (panel side; same buildTrustCard() as /winstage status) ──
        trustLabel: 'Trust',
        trustTrusted: 'Sandbox trusted (commands use the token-free channel; writes land in staging first)',
        trustAttention: 'Sandbox trusted, with {count} kind(s) of open items (see /winstage status)',
        trustDegraded: '⚠ Sandbox NOT trusted: the lane fell back, writes are down to kernel denial (see /winstage status)',
        trustLost: '⚠ The session working root is unavailable: writes will fail instead of silently touching real files',
        trustWriteUnconfirmed: '⚠ A write was not confirmed on disk (see /winstage status)',
        trustUnknown: 'Sandbox lane unknown: no verdict recorded yet; treat as "not proven active"',
        trustOff: 'Sandbox is off (expected)',
        trustSourceRoute: 'Read via: host route (the host resolves the store root)',
        trustSourceLegacy: 'Read via: legacy layout compatibility (host route unavailable; restart the host process)',
        trustDetail: 'lane {lane} · degraded {degrades}× · root lost {lost}× · open approvals {approvals} · unconfirmed writes {writes} · sensitive reads {reads}',
      },
    }

    // ==================== 审阅状态（模块级：select 必须是纯函数，只能读它）====================

    const store = {
      listeners: new Set(),
      state: { status: 'idle', sessionId: undefined, workspaceRoot: undefined, snapshot: null, error: undefined, alert: null, enabled: undefined },
      dismissed: undefined,
      /**
       * 「默认收起」偏好是否已在**本次页面加载**上生效过（page 级，刷新即重置）。
       *
       * 它把"启动偏好"与"每一版新快照"解耦：只有第一版**有待审的**快照会被默认收起；
       * 之后完全交给用户手势（chip 可随时收起/展开）与 sessionStorage 的那一版记忆。
       * 没有这个标记时，每个 Turn 的新 `generatedAt` 都会把面板重新压回去 ——
       * 开了偏好就永远打不开（实测缺陷）。
       */
      defaultCollapseApplied: false,
      /**
       * T3c：**粘性收起**（page 级；跨刷新由 sessionStorage 的 `STICKY_KEY` 记忆）。
       *
       * 为什么必须独立于 `dismissed`：`dismissed` 是"精确绑定某一版 `generatedAt`"的旧语义
       * （`nextDismissed` 规则 1），`.t/collapse-selftest.mjs` 逐条钉住它**必须**"换版即失效"。
       * 而用户诉求恰好相反：点过「暂时收起」之后，新的待审快照**不得**再把面板弹开（C3）。
       * 两件事共用一个值必然两败俱伤 ⇒ 拆开：`dismissed` 保留旧语义，`stickyCollapsed` 管粘性。
       * true ⇒ 面板缺席、chip 在场（与 `generatedAt` 无关），直到
       *   ① 用户显式点 chip 展开（`restorePanel`），或
       *   ② 明确读到"待审集合已清空"（ready 且 `pending !== true`）⇒ 复位（C6）。
       */
      stickyCollapsed: false,
      /**
       * `alerts[]` 的"报过哪些"记录（按 `id`）。**它不决定横幅的可见性** ——
       * 可见性跟随**当前快照**（见 `tick()` 的 ready 分支）。保留它是为了幂等记录，
       * 以及纯函数 `pickFreshAlert` 的语义（`f8` 的 A11/A12 直接断言该函数）。
       */
      alertedId: undefined,
      /**
       * 逐条失败原因（path → message）。放 **store** 而不是组件 state：
       * 命令之后 `poller.refresh()` 会换一版快照，组件 state 可能随重挂载一起丢，
       * 观感就是"点了批准 → 处理中一闪 → 什么都没有"。
       */
      failures: new Map(),
      /**
       * V2-2 记账（**新增键，只加不改**）：记录失败时"这些失败路径**当时在不在面板上**"。
       *
       * 清除时机必须靠它区分两种情况，否则会把 P0-1 的可见性改坏：
       *   · 当时在面板、现在已离场 ⇒ 条目被批准/拒绝 ⇒ 旧失败作废，可清；
       *   · 当时就不在面板（例："没有匹配的待审路径"）⇒ **必须保留**，否则下一轮
       *     轮询（1.5s）就会把它抹掉，用户又回到"点了没反应"。
       */
      failureRows: new Set(),
      /**
       * v2.1（方案 B，**新增键，只加不改**）：`showFailure()` 当时写下的那条 notice 原文。
       *
       * 为什么需要它：菜单 `run()` / S6 那 5 处会**直接** `store.publish({ notice })` 覆盖面板提示，
       * 而它们不碰 `failureRows`。于是残留的旧失败记账会让 prune 在下一秒把这条**泛化提示**
       * 误清掉（verifier `v2-fr-notice.txt` 2-2）。记录"notice 是不是我们自己写的"，
       * 就能让 prune **只清它自己记的那一条**，不动别人的提示。
       */
      failureNotice: undefined,
      /** 面板级失败原文（没归到具体条目时的兜底）；同样放 store 以求存活 */
      notice: undefined,
      inFlight: false,
      publish(patch) {
        store.state = { ...store.state, ...(patch || {}) }
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    /**
     * 两个"根"是否同一个目录：Windows 大小写不敏感、尾分隔符可省。
     * **纯字符串归一，不碰磁盘** —— `select` 必须是纯函数（槽位契约）。
     * 任一侧为空即返回 false（"无法证明一致" = 不接管，宁可不显示）。
     */
    function sameRoot(a, b) {
      const norm = (value) =>
        String(value ?? '')
          .replace(/[\\/]+$/, '')
          .replace(/\//g, '\\')
          .toLowerCase()
      const left = norm(a)
      return left.length > 0 && left === norm(b)
    }

    /**
     * 开关真值（**三态**）—— 唯一来源：`configForms` 的表单快照。
     *
     *   'on'      `status === 'ready'` 且 `value.enabled === true`
     *   'off'     `status === 'ready'` 但 `enabled` 不是 true（明确 false / 字段缺席）
     *   'unknown' `loading` / `unavailable` / 根本没有表单 —— **沙箱状态未知**
     *
     * ★ 只有 'on' 允许接管**平台 UI**（composer 审阅卡，以及
     *   `conversation.input.permission` 上的访问模式控件与它弹出的预设菜单）。
     *   'unknown' 一律**不接管**：`unavailable` 的语义逐字就是"该命名空间没有暴露给本客户端"
     *   （宿主插件没装 / 本页看不到），此时平台原来的审批控件与弹窗必须原样保留。
     *   把"读不懂"解释成"开着"会把平台控件**永久盖住** —— 那正是"关闭沙箱（或沙箱压根没装）时
     *   原版审批弹窗仍被 WinStage 覆盖"的成因。宁可晚一拍接管，也不覆盖平台 UI。
     *   三态定义见 dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:7-14。
     */
    function readSwitch(form) {
      const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
      if (!snapshot || snapshot.status !== 'ready') return 'unknown'
      const value = snapshot.value
      return value && value.enabled === true ? 'on' : 'off'
    }

    /**
     * 接管判据的**唯一实现**。
     *
     * 两处调用它，避免判据漂移：
     *   1. `routeOf`（渲染期，带 ownerProps）—— 槽位 `select`；
     *   2. 轮询器的 `shouldElect()` —— 在**没有 ownerProps** 的时机检测"接管状态是否
     *      需要跃迁"，用于驱动下面的失效通道（A/C）。
     * 差别只有一个：这里由调用方给 `sessionId`。
     */
    function winstageElection(sessionId) {
      if (!sessionId) return null
      // ★ 开关必须先**确定开着**（轮询器只在 readSwitch()==='on' 时发布 enabled:true）。
      //   'unknown'（configForms 还在 loading，或命名空间 unavailable ⇒ 宿主插件没装）
      //   ⇒ 不接管 composer：那时输入区必须留给平台自己的审批卡/审批弹窗。
      if (store.state.enabled !== true) return null
      const snapshot = store.state.snapshot
      // β（V2-1）：判据收敛为 `pending === true`。
      // 为什么不保留 `counts.files >= 1`：`review-service.snapshot()` 的 `pending` 就是
      // `files.length > 0`、`counts.files` 也是 `files.length`（**同一个数组**）⇒ 二者恒同真，
      // 该合取项恒真、只是空转；留着它会让"未来 pending 与 files 被解耦"重新变成静默不可见。
      if (!snapshot || snapshot.pending !== true) return null
      if (!sameRoot(snapshot.workspaceRoot, store.state.workspaceRoot)) return null
      // T3c：这里换成**粘性**判据。旧写法是精确匹配 `generatedAt` ⇒ 新快照 `generatedAt` 一变，
      // 记忆失配 ⇒ `select` 重新接管 ⇒ 面板自动展开（用户诉求要修的正是这一条：C3）。
      // 注意：不换槽位、不动上面的 `pending`/`sameRoot` 判据、不改本函数返回形状。
      if (isCollapsedNow(snapshot)) return null
      return { kind: 'winstage-review', sessionId, generatedAt: snapshot.generatedAt }
    }

    /**
     * select 的判据：有会话、有待审、不是刚收起的那一版、**且快照确实属于本面板的根**。
     *
     * 最后一条是 C-7「跨工作区串台」的**零额外 IO** 自校验：`review.json` 自带
     * `workspaceRoot` 字段（review-service.mjs:162），与本面板打算显示的根不一致时
     * **宁可不接管，也不显示别的工作区的待审内容**。之所以必须兜这一层：
     * `workspaceFiles.read` 的 `locateFile()` 不做 contains 校验
     * （dsh-api-workspace-files/lib/index.js:588-608），绝对路径可以越界读。
     */
    function routeOf(owner) {
      if (!owner || !owner.sessionId) return null
      return winstageElection(owner.sessionId)
    }

    // ==================== 三档风险显示（S3c）====================
    // 契约由 S3b 交付，**向后兼容是硬要求**：
    //   item.risk    : 'normal' | 'outside' | 'sensitive'（缺失/未知/旧快照 ⇒ 一律 normal）
    //   item.safety  : null | 'risk' | 'danger'（`danger` 是 **sensitive 的子计数**，不是第四档）
    //   item.external: 与 risk **允许不一致** —— `<wsRoot>\.dshstage\x` 是
    //                  `external:false` + `risk:"sensitive"` ⇒ **分组必须按 risk**，不能按 external。
    //   item.note    : **条件键**，只有 danger 档存在 ⇒ 用 `'note' in item` 判断，不猜空串。
    //   item.riskReason: 仅 sensitive 档，用于在勾选框旁内联显示。
    //   顶层 alerts[]: {id, kind, severity, count, paths, message, hint}；`id` 是去重键；
    //                  **只承载数据，绝不阻断任何操作**（用户拍板：运行时不弹窗、批准/拒绝全异步）。
    // 这些都是**纯函数**，因此可以在 Node 里直接断言（CPU 侧渲染不了 React）。

    const RISKS = ['normal', 'outside', 'sensitive']

    /** 缺字段/未知值/旧快照 ⇒ normal（不能崩，也不凭 external 猜档） */
    function riskOf(item) {
      return item && RISKS.indexOf(item.risk) >= 0 ? item.risk : 'normal'
    }

    function isDanger(item) {
      return Boolean(item) && item.safety === 'danger'
    }

    /** `note` 是条件键：只有存在且非空才显示原文 */
    function noteOf(item) {
      if (!item || typeof item !== 'object') return null
      if (!('note' in item)) return null
      return typeof item.note === 'string' && item.note.length > 0 ? item.note : null
    }

    /**
     * 漂移形状 → 行内说明（缺陷② F5b）。
     *
     * 值来自宿主快照的 `baselineStaleCode`（`review-service.driftReasonOf()` 的字面量）：
     *   - `baseline-appeared`：基线 = absent（新增）而真实文件在暂存之后出现 ——
     *     实测那条"点批准就静默丢掉磁盘内容"的形状，必须说得最清楚；
     *   - `baseline-deleted` / `baseline-drifted`：外部删除 / 外部改写；
     *   - 缺字段（旧快照）⇒ `null`，行内不显示额外说明（行为与旧版一致）。
     */
    function baselineStaleReasonText(t, item) {
      const code = item?.baselineStaleCode
      if (code === 'baseline-appeared') return t('baselineStaleAppeared')
      if (code === 'baseline-deleted') return t('baselineStaleDeleted')
      if (code === 'baseline-drifted') return t('baselineStaleDrifted')
      return null
    }

    /** 组内按 path 稳定排序（大小写不敏感；同键保持入参顺序） */
    function sortByPath(items) {
      return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const left = String(a.item?.path ?? '').toLowerCase()
          const right = String(b.item?.path ?? '').toLowerCase()
          if (left < right) return -1
          if (left > right) return 1
          return a.index - b.index
        })
        .map((entry) => entry.item)
    }

    /** 按 **risk** 分三组（不是按 external）；空组由渲染层隐藏 */
    function groupByRisk(files) {
      const list = Array.isArray(files) ? files : []
      return {
        normal: sortByPath(list.filter((item) => riskOf(item) === 'normal')),
        outside: sortByPath(list.filter((item) => riskOf(item) === 'outside')),
        sensitive: sortByPath(list.filter((item) => riskOf(item) === 'sensitive')),
      }
    }

    /**
     * 摘要：从**将要显示的那份 files** 计数，但**绝不比宿主声明的更少报**（G3，独立复核提出）。
     *
     * `files` 会被 `maxFiles` 截断，而顶层 `riskCounts` 将来可能被改成"全量净变化"的汇总
     * （`counts.files` 本来就是全量的）。两者各自都是**下界** ⇒ 取大即"绝不比看得见的少报"。
     * 而"少报高危项"是安全方向上最不该犯的错。
     */
    function summarize(files, declared, declaredTotal) {
      const list = Array.isArray(files) ? files : []
      const counts = { files: list.length, normal: 0, outside: 0, sensitive: 0, danger: 0 }
      for (const item of list) {
        const risk = riskOf(item)
        counts[risk] += 1
        if (risk === 'sensitive' && isDanger(item)) counts.danger += 1
      }
      // `declared` 是宿主顶层的 `riskCounts`（只有 normal/outside/sensitive/danger 四档，
      // **不含**总数）；总数必须单独从 `counts.totalFiles` 传入。旧版误从 riskCounts 里
      // 三档求和当总数，口径本身就是错的（那三档是按截断后的列表算的）。
      if (declared && typeof declared === 'object') {
        for (const key of ['normal', 'outside', 'sensitive', 'danger']) {
          const value = Number(declared[key])
          if (Number.isFinite(value) && value > counts[key]) counts[key] = value
        }
      }
      const total = Number(declaredTotal)
      if (Number.isFinite(total) && total > counts.files) counts.files = total
      return counts
    }

    /**
     * S3h：chip 的分级计数（用户要求"显示 L1/L2/L3 各几个待审"）。
     *
     * 等级映射（Lead 按既定三档契约定死）：**L1 = normal（工作区内）、L2 = outside（工作区外）、
     * L3 = sensitive（敏感）**；`safety:"danger"` 是 **L3 里更严的子档**，**不额外计一档**。
     *
     * 复用 `summarize` ⇒ **自动继承 G3 的 `max(派生, 声明)` 加固**（列表被 `maxFiles` 截断时
     * 用宿主的 `riskCounts`，绝不比声明的少报）。
     * `truncated` = 生效总数 > 实际列出的条数 ⇒ chip 要标 `+`，**不静默少报**。
     */
    function levelCounts(files, declared, snapshotTruncated, declaredTotal) {
      const list = Array.isArray(files) ? files : []
      const counts = summarize(list, declared, declaredTotal)
      // 截断信号有两条来源，**任一为真**都不得静默少报：
      //   · 计数：生效总数 > 实际列出条数（宿主 `counts.files` 已是全量）；
      //   · 声明：宿主顶层 `snapshot.truncated`（`review-service.snapshot()` 在
      //     `listed.length > maxFiles` 或某条内容被按敏感策略省略时置真）。
      // 修复前的症状：宿主把 `counts.files` 报成**截断后**的条数，于是这里恒 false，
      // chip 不显示 `+`、标题条不显示"列表已截断" —— 用户只看到 maxFiles(40) 条。
      const truncated = counts.files > list.length || snapshotTruncated === true
      return {
        L1: counts.normal,
        L2: counts.outside,
        L3: counts.sensitive,
        danger: counts.danger,
        total: counts.files,
        listed: list.length,
        truncated,
      }
    }

    /**
     * 分段文案：**只列非零档**（pill 不能变成长条报告），危险段附在同一括号里。
     * 用 `chipL1/L2/L3` 三个独立 key 而**不是** `L{level}` 占位符：宿主 locale 的插值
     * 已由 `{count}`/`{files}` 验证，不再引入新形态的占位符（少一个失败面）。
     */
    function levelSegments(levels, t) {
      const parts = []
      if (levels.L1 > 0) parts.push(t('chipL1', { count: levels.L1 }))
      if (levels.L2 > 0) parts.push(t('chipL2', { count: levels.L2 }))
      if (levels.L3 > 0) parts.push(t('chipL3', { count: levels.L3 }))
      if (levels.danger > 0) parts.push(t('chipDanger', { count: levels.danger }))
      return parts
    }

    /** 授权手势的记账键：`path|risk|safety` —— 档位一变签名就变，旧手势自动失效（G1） */
    function riskSignature(item) {
      return `${String(item?.path ?? '')}|${riskOf(item)}|${item?.safety ?? 'null'}`
    }

    /**
     * D1：冻结存档行（Host 快照里的 `frozenOnly: true`）= 只显示、**不可勾选、不可批准**。
     *
     * 这些行的路径**已不在当前净 diff**（暂存内容已被回收 / 已被取代），
     * 而写入面本来就是按净 diff 过滤的（`ReviewService.approve()` 在净 diff 为空时早退；
     * `/winstage approve` 用 `matchPaths(ws.diffEntries(), args)`），因此勾了只会得到
     * "没有匹配的待审路径" —— **给一个必然失败的勾选框比不给更糟**。
     * 另一条硬约束是"绝不让用户在看不到内容的情况下批准"：这些行的内容既不可保证
     * （blob 可能已被回收）也不可写入，所以只给元数据与"已不在净 diff"的标记。
     *
     * 缺字段 / 未知值 ⇒ 一律当作**可批准**（旧快照没有这个字段，行为与旧版逐字一致）。
     */
    function isActionable(item) {
      return Boolean(item) && item.frozenOnly !== true
    }

    /**
     * 冻结存档行的行内原因。Host 只发三种：
     *   `reclaimed`（暂存对象已被回收）/ `no-op`（删除一个基线不存在的对象 ⇒ 无净变化）/
     *   `no-net-change`（暂存内容已被取代）。其余/缺失一律按最后一条保守处理。
     */
    function frozenReasonText(t, item) {
      const reason = item?.frozenReason
      if (reason === 'reclaimed') return t('frozenReclaimed')
      if (reason === 'no-op') return t('frozenNoOp')
      return t('frozenNoNetChange')
    }

    // #region failure-map（.t/failure-inline-selftest.mjs 按这两个标记切片求值；勿删标记）
    /**
     * 宿主返回的失败原文 → **逐条**原因（path → 命中的那一行）。
     *
     * 归因规则：某一行（去空白后）包含某个路径（Windows 路径大小写不敏感）⇒ 该行就是
     * 这个路径的原因。没匹配上的由调用方决定是否用整段原文兜底。
     */
    function failureByPath(text, paths) {
      const map = new Map()
      if (typeof text !== 'string' || text.length === 0 || !Array.isArray(paths) || paths.length === 0) return map
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      for (const path of paths) {
        const needle = String(path).toLowerCase()
        const hit = lines.find((line) => line.toLowerCase().includes(needle))
        if (hit) map.set(path, hit)
      }
      return map
    }
    // #endregion failure-map

    // #region failure-prune（.t/dsh2/fix-asserts/p10-notice-prune.mjs 按这两个标记切片求值；勿删标记）
    /**
     * V2-2：把**已经被解除的失败**从 `notice`/`failures` 里摘掉 —— 旧文案不许继续冒充现状。
     *
     * 三条清除条件（任一命中即清）：
     *   1. 记录失败时该 path **在面板上**，而现在它已不在快照 `files[]` 里
     *      （条目被批准/拒绝/离场 ⇒ 那条失败已经没有对应物）；
     *   2. 该 path 仍在，且失败文案声称 `STALE_BASELINE`/基线过期，而它现在
     *      `baselineStale !== true`（基线已被重述 ⇒ 陈旧失败作废）；
     *   3. —— 其它一律**保留**。
     *
     * **守门（不许改坏 P0-1）**：`failureRows` 缺失/为空（旧状态、或失败本身不按路径归因，
     * 例如 `noSession`）⇒ 原样保留；**仍陈旧**的行 ⇒ 原样保留。只有"确实已经解除"才清。
     * 幂等：清完 `dropped === 0`，不会反复 publish。
     *
     * @param {Map<string,string>} failures  store.state.failures
     * @param {Set<string>} failureRows      记录失败时"在面板上"的路径（store.failureRows）
     * @param {string|undefined} notice      store.state.notice
     * @param {string|undefined} failureNotice  `showFailure()` 写下的那条 notice 原文（store.failureNotice）
     * @param {{files?: Array<{path:string, baselineStale?:boolean}>}} snapshot
     * @returns {{dropped: number, failures: Map<string,string>, notice: string|undefined}}
     */
    function pruneResolvedFailures(failures, failureRows, notice, failureNotice, snapshot) {
      const map = failures instanceof Map ? failures : new Map()
      const tracked = failureRows instanceof Set ? failureRows : new Set()
      if (map.size === 0 || tracked.size === 0) return { dropped: 0, failures: map, notice }
      const rows = Array.isArray(snapshot?.files) ? snapshot.files : []
      const present = new Set(rows.map((row) => row.path))
      const staleById = new Map(rows.map((row) => [row.path, row.baselineStale === true]))
      const next = new Map()
      let dropped = 0
      for (const [path, message] of map) {
        const wasOnPanel = tracked.has(path)
        const staleClaim = typeof message === 'string' && /STALE_BASELINE|基线已过期/i.test(message)
        const leftPanel = wasOnPanel && !present.has(path)
        const staleResolved = wasOnPanel && present.has(path) && staleClaim && staleById.get(path) !== true
        if (leftPanel || staleResolved) {
          dropped += 1
          continue
        }
        next.set(path, message)
      }
      if (dropped === 0) return { dropped: 0, failures: map, notice }
      // ★ 方案 B（v2.1）：只有"当前显示的 notice **就是** showFailure 当时写下的那一条"时，
      // 才允许把 notice 置 undefined。若中途被泛化 notice（菜单/S6 的 5 处 direct publish）
      // 覆盖过，则**不动 notice**（失败行照常被摘掉）⇒ 泛化提示不会被 prune 误清。
      // 对照：verifier v2-fr-notice 的 2-2（修复后保留）/ 2-3（去掉本判据则被清）。
      const ownsNotice = typeof failureNotice === 'string' && failureNotice.length > 0 && notice === failureNotice
      const clearNotice = ownsNotice && next.size === 0
      return { dropped, failures: next, notice: clearNotice ? undefined : notice }
    }
    // #endregion failure-prune

    /** 「全选」只选**普通项**：高风险项必须逐项显式勾选（否则「全选」会变成绕过通道） */
    function selectablePaths(files) {
      const list = Array.isArray(files) ? files : []
      return list.filter((item) => riskOf(item) === 'normal' && isActionable(item)).map((item) => item.path)
    }

    /**
     * 可写载荷（G1）。两类项：
     *   - `normal`：恒可写（不需要高风险授权）；
     *   - 高风险（outside/sensitive/danger）：必须**在勾选那一刻就是当前档位**
     *     —— `consented` 里记的是 `path|risk|safety`，档位升级后签名不匹配 ⇒ 旧手势不再授权。
     * `only === true` 时只取**被勾选**的项（「批准所选」）；否则 = 全部普通项 + 已授权高风险项（「批准全部」）。
     * `consented === null` 表示调用方不做手势记账（纯函数 API 的兼容语义：被勾选即视为已授权）。
     */
    function authorizedPaths(files, selected, consented, only) {
      const list = Array.isArray(files) ? files : []
      return list
        .filter((item) => {
          // D1：冻结存档行永远不进可写集合（它们的路径不在净 diff 里，写了也无处落）
          if (!isActionable(item)) return false
          if (riskOf(item) === 'normal') return true
          if (!selected.has(item.path)) return false
          return consented === null || consented?.get(item.path) === riskSignature(item)
        })
        .filter((item) => (only === true ? selected.has(item.path) : true))
        .map((item) => item.path)
    }

    /**
     * 「批准全部」的可写集合 = **全部 normal** + **用户已显式授权**的高风险项。
     * 兼容既有纯函数断言（f8 的 A7/A8）：等价于"被勾选即授权"。
     */
    function approveAllPaths(files, selected) {
      return authorizedPaths(files, selected, null)
    }

    /** alerts 去重：挑出 id 与"已报过的那个"不同的第一条（纯函数，便于断言） */
    function pickFreshAlert(alerts, lastId) {
      if (!Array.isArray(alerts)) return null
      for (const alert of alerts) {
        if (!alert || typeof alert.id !== 'string' || alert.id.length === 0) continue
        if (alert.id === lastId) continue
        return alert
      }
      return null
    }

    // #region session-key（.t/session-key-selftest.mjs 会把这段与 review-service.mjs 的
    // 同名导出喂同一组输入比对；两处实现必须逐字一致，勿删标记）
    /**
     * FNV-1a（32 位）—— 只用于把**非常规字符**的会话 id 压成目录名。
     * 与 host 侧 `review-service.mjs` 的 `fnv1a32` 同实现。
     */
    function fnv1a32(text) {
      let hash = 0x811c9dc5
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    }

    /**
     * 会话 id → **存储目录名**（与 host 侧 `sessionDirKey` 逐字同规则）。
     *
     * WP3-B：这个键**只**用于两件事 —— ① 宿主路由的 `?session=` 参数（宿主据此解析存储根）；
     * ② 兜底读法里那条**历史兼容**路径。它**不再**是新布局的路径来源（新布局由宿主解析）。
     */
    function sessionDirKey(sessionId) {
      const raw = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (raw.length === 0) return ''
      if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw
      return `s_${fnv1a32(raw)}_${raw.length}`
    }
    // #endregion session-key

    /** Windows 分隔符：review.json 是**绝对路径**，`read` 接受绝对路径 */
    function joinPath(root, ...parts) {
      const sep = /^[a-zA-Z]:/.test(root) ? '\\' : '/'
      return [String(root).replace(/[\\/]+$/, ''), ...parts].join(sep)
    }

    // ── WP3-B：面板读侧的两条路（顺序 = 优先级；**首选永远是宿主路由**）──────────
    /**
     * 宿主侧只读路由（`host-plugin.mjs::PANEL_ROUTE_PREFIX`，两边**同一份**字面量约定）。
     * 客户端只认**逻辑标识**：路由名 + 会话 id。存储根在哪由宿主解析 ——
     * 浏览器里没有 `%LOCALAPPDATA%` 这个事实，客户端自己拼只能拼出**旧布局**。
     */
    const PANEL_ROUTE_PREFIX = '/winstage-panel'
    const PANEL_SNAPSHOT_ROUTE = PANEL_ROUTE_PREFIX + '/snapshot'
    const PANEL_TRUST_ROUTE = PANEL_ROUTE_PREFIX + '/trust'

    /**
     * 取一次面板路由 JSON（同源 fetch）。
     *
     * ⚠ 必须校验 `content-type`：路由没注册时 webserver 的**SPA 兜底**会回 `index.html`
     * （HTTP 200 + text/html）。不校验就会把一份 HTML 当快照解析，报出一个与事实无关的错。
     *
     * @returns {{ok: boolean, value?: object, code?: string}}
     *   `code === 'no-snapshot'` 是**确定**的"当前没有待审"（宿主路由答的），
     *   与"路由不可用"必须分开：前者不该退回兼容读法。
     */
    function fetchPanelRoute(path, sessionId) {
      if (typeof fetch !== 'function') return Promise.resolve({ ok: false, code: 'no-fetch' })
      const controller = new AbortController()
      const url = `${path}?session=${encodeURIComponent(typeof sessionId === 'string' ? sessionId : '')}`
      return Promise.resolve(fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } }))
        .then(async (response) => {
          const type = String((response && response.headers && response.headers.get && response.headers.get('content-type')) || '')
          if (!type.includes('application/json')) return { ok: false, code: 'not-json' }
          const body = await response.json().catch(() => undefined)
          if (!response.ok) return { ok: false, code: String(body && body.code ? body.code : `http-${response.status}`) }
          if (!body || body.ok !== true) return { ok: false, code: String((body && body.code) || 'bad-body') }
          return { ok: true, value: body }
        })
        .catch((error) => ({ ok: false, code: `fetch-failed: ${String((error && error.message) || error)}` }))
        .finally(() => controller.abort())
    }

    /**
     * **首选**读法：宿主路由。拿到 `{ snapshot, store, source: 'host-route' }`。
     * `snapshot === null` 且 `ok === true` ⇒ 宿主解析出的存储里**确实**没有快照。
     */
    async function readReviewViaRoute(ctx, sessionId) {
      const result = await fetchPanelRoute(PANEL_SNAPSHOT_ROUTE, sessionId)
      if (!result.ok) {
        return result.code === 'no-snapshot'
          ? { ok: true, snapshot: null, store: undefined, source: 'host-route' }
          : { ok: false, code: result.code }
      }
      const body = result.value
      return { ok: true, snapshot: body.snapshot ?? null, store: body.store, source: 'host-route' }
    }

    /**
     * 兼容兜底（**历史布局**，绝不是首选 —— 首选是上面的宿主路由）。
     *
     * 为什么保留这一条：路由需要宿主进程**重启**到带 `createPanelHandler()` 的版本才会注册，
     * 而升级前发布的快照确实躺在工作区的旧布局里。没有它，面板在那段窗口里会**整片空白**；
     * 有它，面板至少能显示旧快照，并且明确标出 `legacyCompat` 让用户知道读的是哪一份。
     *
     * 全文件**只有这里**拼旧布局，且：
     *   · 只在宿主路由不可用时执行（`readReview()` 的第二分支）；
     *   · 返回的 `source` 是 `'legacy-compat-path'`（不是 `'host-route'`），面板据此可区分；
     *   · 存储短哈希/逻辑标签一律为 `undefined`（旧布局没有"宿主解析的标识"可言）。
     */
    function readReviewViaLegacyPath(ctx, sessionId, root) {
      const controller = new AbortController()
      const key = sessionDirKey(sessionId)
      const path = key
        ? joinPath(root, '.dshstage', 'sessions', key, 'review.json')
        : joinPath(root, '.dshstage', 'review.json')
      return Promise.resolve(ctx.remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: 400 }, controller.signal))
        .then((result) => {
          // 生成的 Remote 客户端返回 RemoteResult 信封；也容忍直接返回值
          if (result && result.ok === false) {
            const code = String(result.error?.code ?? result.error?.message ?? 'unknown')
            if (code.includes('not-found')) return null
            throw new Error(code)
          }
          const value = result && result.ok === true ? result.value : result
          if (!value || typeof value.text !== 'string' || value.text.length === 0) return null
          return JSON.parse(value.text)
        })
        .finally(() => controller.abort())
    }

    /**
     * 读那一份小 JSON。返回 `{ snapshot, source }`：
     *   `source: 'host-route'`         宿主解析出的存储（**首选**）
     *   `source: 'legacy-compat-path'` 兜底的旧布局（路由不可用）
     * `snapshot === null` = 当前没有待审（两种来源都可能是 null）。
     */
    async function readReview(ctx, sessionId, root) {
      const viaRoute = await readReviewViaRoute(ctx, sessionId)
      if (viaRoute.ok) return { snapshot: viaRoute.snapshot, source: viaRoute.source, store: viaRoute.store }
      const snapshot = await readReviewViaLegacyPath(ctx, sessionId, root)
      return { snapshot, source: 'legacy-compat-path', store: undefined, routeFallback: viaRoute.code }
    }

    /** 可信性状态卡（**用户侧**；与 `/winstage status` 同一个 `buildTrustCard()`） */
    async function readTrustCard(ctx, sessionId) {
      const result = await fetchPanelRoute(PANEL_TRUST_ROUTE, sessionId)
      if (!result.ok) return { ok: false, code: result.code }
      return { ok: true, card: result.value.card ?? null, store: result.value.store }
    }

    function runCommand(ctx, sessionId, line) {
      return Promise.resolve(ctx.remote.commands.execute(sessionId, line, [])).then((result) => {
        if (result && result.ok === false) throw new Error(result.error?.code ?? result.error?.message ?? 'command failed')
        return result && result.ok === true ? result.value : result
      })
    }

    /** 一个共享轮询器：所有面板实例读同一份快照（Client 收不到自定义推送） */
    function createPoller(ctx, configForm) {
      let sessionId
      let stopped = false

      const tick = async () => {
        if (stopped || store.inFlight) return
        store.inFlight = true
        try {
          const configSnapshot = configForm ? configForm.getSnapshot() : undefined
          const configValue = (configSnapshot && configSnapshot.value) || {}
          // ── 开关**关着或状态未知**：审阅面整体卸载（面板 / 常驻 chip / 读快照全停）──
          // 关闭语义 = 暂存与审批面交回平台（fs-entry.mjs 按同一个开关现读退回平台的
          // 沙箱/审批模式）。这里若继续读 review.json，用户会看到**上一版快照**的待审行，
          // 点"批准"还会调到已拒绝执行的命令 —— 那正是"关掉了却仍在审批"的错觉来源。
          //
          // ★ 'unknown'（configForms 还在 loading，或命名空间 unavailable ⇒ 宿主插件
          //   没装/本客户端看不到）按**关闭**处理，不再按"开"：未知时继续发布快照会让
          //   composer 上的 WinStage 审阅卡顶掉平台自己的审批卡与审批弹窗 ——
          //   "沙箱没有真正生效"绝不能表现成"平台 UI 被覆盖"。代价只是多一拍延迟：
          //   一旦快照 ready 且 enabled===true，下一拍即接管。
          if (readSwitch(configForm) !== 'on') {
            const configuredRoot =
              typeof configValue.workspaceRoot === 'string' && configValue.workspaceRoot.trim().length > 0
                ? configValue.workspaceRoot.trim()
                : undefined
            store.publish({ status: 'idle', snapshot: null, workspaceRoot: configuredRoot, sessionId, alert: null, enabled: false })
            return
          }
          // C-7：根**只有一个来源** —— 插件 Config 里的 workspaceRoot。
          // 绝不回退到 `owner.session.cwd`：那会让面板去读"另一个工作区"的快照
          // （项目根那份 pending=true 的快照就是这么被 3081 显示出来的，实测见 T2 报告
          // §4.4）。没显式配置 = 没有可信的根 = 视为"没有待审"，宁可不显示。
          // WP3-B：本值现在是**宿主路由**的一致性自校验基准（快照自带的 workspaceRoot
          // 必须与它同根），也是兜底读法拼旧布局时的根。
          const root = typeof configValue.workspaceRoot === 'string' ? configValue.workspaceRoot.trim() : ''
          if (!sessionId || root.length === 0) {
            // ⚠ S3g：**idle 不许清 `alert`**。这两个 idle 分支原本都写 `alert: null`，
            // 而一次瞬时 idle（例如 `observe()` 之前的那一拍、或配置快照短暂缺 workspaceRoot）
            // 就会**永久**压掉危险横幅：此后 `fresh` 恒 null（`alertedId` 已记过）、`keep` 恒 false
            // ⇒ 用户根本没看到那条信息泄露警告（Lead 按秒实测：t=1s 在、t=3s 消失、之后 14s 不回）。
            // idle 时 `store.state.snapshot` 为 null ⇒ `winstageElection` 返回 null ⇒ 面板本来就不挂载，
            // 所以保留 `alert` 不会显示陈旧横幅；下一次 ready 会用新快照**重新赋值**。
            store.publish({ status: 'idle', snapshot: null, workspaceRoot: undefined, sessionId, enabled: true })
            return
          }
          const read = await readReview(ctx, sessionId, root)
          const snapshot = read.snapshot
          // 自校验（零额外 IO）：读到的那份快照必须声明同一个根，否则丢弃
          if (snapshot && !sameRoot(snapshot.workspaceRoot, root)) {
            store.publish({ status: 'idle', snapshot: null, workspaceRoot: root, sessionId, enabled: true })
            return
          }
          /**
           * WP3：同一拍取一次**可信性状态卡**（用户侧）。
           * 它回答的是"沙箱此刻可不可信"（档位/首次掉档/失根/未结算审批/未确认写入/
           * 读侧可见性），与快照是**两块**数据：快照说"有什么待审"，卡片说"这套机制本身
           * 现在靠不靠得住"。取不到就如实不显示（**不**拿旧卡片冒充现状）。
           */
          const trust = await readTrustCard(ctx, sessionId)
          // S3e：「收起」的两个来源（sessionStorage 记住的那一版 + 「默认收起」启动偏好）
          // 都收敛到纯函数 `nextDismissed()`（离线可断言）。**关键**：「默认收起」只在
          // 本次页面加载后的第一版有待审快照上生效一次（`store.defaultCollapseApplied`），
          // 而不是每来一版快照都收一次 —— 否则每一轮 Turn 的新 generatedAt 都会把面板压回去。
          // T3c C6 复位：**明确读到待审集合为空**（ready 快照且 `pending !== true`）⇒ 取消粘性收起，
          // 于是"清空之后又出现新的待审"回到 C1 的"首现自动展开"。
          // 只认"明确读到的空集合"，**不认 `snapshot === null`**（文件缺失 / 瞬时读不到）：否则刷新后
          // 第一拍的空读会把跨刷新的粘性记忆清掉，C7 就不成立。
          if (snapshot && snapshot.pending !== true) resetStickyCollapse()
          const generatedAt = snapshot?.generatedAt
          if (generatedAt) {
            const decision = nextDismissed({
              dismissed: store.dismissed,
              generatedAt,
              remembered: readStr(sessionStore, DISMISS_KEY),
              defaultCollapsed: readStr(localStore, PREF_KEY) === '1',
              applied: store.defaultCollapseApplied,
              // β（V2-1）：同一条判据的**第 4 处出现**（喂 nextDismissed 的 `pending` 输入）。
              // 与 :323/:1319/:2030 收敛为同一写法；行为等价（见 winstageElection 处的恒等式说明）。
              pending: Boolean(snapshot && snapshot.pending === true),
            })
            store.dismissed = decision.dismissed
            store.defaultCollapseApplied = decision.applied
            // T3c：本次决策**产生了收起**（来源是「默认收起」启动偏好或跨刷新记忆；用户手势走
            // `collapseSnapshot`）⇒ 一并置为**粘性**，否则下一个新快照又会把它弹开（C8 与 C7）。
            if (decision.dismissed !== undefined) markStickyCollapsed()
          }
          // alerts（S3c/S3g）：**只报一次**是"不弹窗、不重复打扰"的语义；**可见性必须跟随当前快照**，
          // 不能靠一次性的 `alertedId`（那会让一次瞬时 idle 把横幅**永久**清掉，见上面的 idle 注释）。
          // 危险项仍在待审 ⇒ 横幅一直在（不阻断、无需点掉）；快照不再声明它 ⇒ 自动消失。
          const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : []
          const currentAlert = alerts.find((item) => item && typeof item.id === 'string' && item.id.length > 0) ?? null
          const fresh = pickFreshAlert(alerts, store.alertedId)
          if (fresh) store.alertedId = fresh.id // 只作"报过哪些"的记录，**不再决定可见性**
          // V2-2：把**已经被解除**的失败从 notice/failures 里摘掉（旧文案不许继续冒充现状）。
          // 仍成立的失败原样保留 —— 那正是 P0-1 的可见性（见 pruneResolvedFailures 的守门说明）。
          const pruned = pruneResolvedFailures(
            store.state.failures,
            store.failureRows,
            store.state.notice,
            store.failureNotice,
            snapshot,
          )
          store.publish({
            status: 'ready',
            snapshot,
            error: undefined,
            workspaceRoot: root,
            sessionId,
            alert: currentAlert,
            enabled: true,
            // WP3-B：读侧来源（`host-route` = 宿主解析的新存储 / `legacy-compat-path` = 兜底旧布局）。
            // 面板据此显示一行"读取来源"，让"读到的是哪一份"永远可分辨。
            storeSource: read.source,
            ...(read.routeFallback ? { routeFallback: read.routeFallback } : {}),
            // WP3：可信性状态卡（取不到就是 undefined ⇒ 面板不显示，而不是显示旧结论）
            trust: trust.ok ? trust.card : undefined,
            ...(trust.ok ? {} : { trustCode: trust.code }),
            ...(pruned.dropped > 0 ? { failures: pruned.failures, notice: pruned.notice } : {}),
          })
        } catch (error) {
          store.publish({ status: 'error', error: String(error?.message ?? error) })
        } finally {
          store.inFlight = false
        }
      }

      const interval = setInterval(tick, POLL_MS)
      void tick()

      return {
        /** 面板渲染时把会话身份告诉轮询器（owner props 是唯一的会话来源） */
        observe(owner) {
          // C-7：**不再**记录 `owner.session.cwd`。根只有插件 Config 一个来源；
          // 记录会话 cwd 正是跨工作区串台的那条回退路径。这里保留方法是因为
          // `select` 的调用点靠它把 sessionId 交给轮询器。
          //
          // 无会话时必须**清空**（而不是留着上一次的值）：`shouldElect()` 与
          // `routeOf()` 必须同真同假，否则失效通道会在"应当接管"与"渲染器判定不接管"
          // 之间每 1.5s 来回重挂一次（见 f6 的 anti-churn 断言）。
          const next = owner?.sessionId
          if (next !== sessionId) {
            sessionId = next
            void tick()
          }
        },
        refresh: tick,
        /**
         * "此刻是否应当接管 composer" —— 与 `routeOf` 同一判据，只差 ownerProps
         * （sessionId 由 `observe()` 提供）。供失效通道在**没有渲染**的时机检测跃迁。
         */
        shouldElect() {
          return winstageElection(sessionId) !== null
        },
        dispose() {
          stopped = true
          clearInterval(interval)
        },
      }
    }

    // ==================== 控件 ====================

    const styles = {
      root: { padding: '8px 16px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
      card: {
        width: '100%',
        maxWidth: 'var(--dsh-chat-content-width, 760px)',
        border: '1px solid var(--dsw-alias-state-warn-secondary, rgba(200,140,0,.5))',
        borderRadius: 'var(--dsw-radius-xl, 12px)',
        background: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff))',
        boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.12))',
        overflow: 'hidden',
      },
      strip: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        fontSize: '13px',
        lineHeight: '18px',
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(255,196,0,.14))',
        // ⚠ S3d：tinted 背景上的文字一律用**前景 token**（`label-primary`），
        // 不再用同色系的 state-primary：暗色下 warn-tertiary=amber-900 + warn-primary=amber-500
        // 是同色相中低对比组合（对比度审计会判 FAIL）。语义靠背景/边框的色相保留。
        color: 'var(--dsw-alias-label-primary)',
        flexWrap: 'wrap',
      },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 16px 0',
        maxHeight: 'var(--dsh-composer-text-max-height, 40vh)',
        overflowY: 'auto',
      },
      // S3i：原 `headline`（正文首行的摘要）已退役 —— 摘要移到标题条（`reviewLevels`），避免同一数字出现两遍。
      fileRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2))',
      },
      path: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        wordBreak: 'break-all',
        flex: '1 1 auto',
        minWidth: 0,
        background: 'none',
        border: 'none',
        padding: 0,
        textAlign: 'left',
        cursor: 'pointer',
      },
      meta: { fontSize: '12px', opacity: 0.65, whiteSpace: 'nowrap' },
      diff: {
        margin: '2px 0 8px',
        padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '12px',
        lineHeight: '17px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: '30vh',
        overflow: 'auto',
      },
      actionRow: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '14px 16px', flexWrap: 'wrap' },
      button: {
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-lg, 8px)',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
      },
      // ⚠ S3f（task-11）：**`--dsw-alias-brand-text` 与 `--dsw-alias-brand-primary` 在两种主题下
      // 解析成同一个值**（实测主题 CSS：light 都是 bluish-1000 `#0f1115`；dark 都是 bluish-50 `#f9fafb`）
      // ⇒ 我上一轮用它做前景，运行时得到 **1.00:1**（字与底同色 = 隐形），被对比度审计当场抓到。
      // 现在配对的是**实测互为反色**的一对：
      //   brand-primary  light #0f1115 / dark #f9fafb
      //   label-primary-foreground light #fff    / dark #0f1115
      // 计算对比度：light **18.9:1**、dark **18.1:1**（≥4.5 达标）。
      primary: { borderColor: 'transparent', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-foreground)' },
      danger: {
        borderColor: 'transparent',
        background: 'var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))',
        // S3f：**文字色一律用 label-* 前景 token**。`state-*-primary`（红/绿/琥珀）是**填充/描边**色，
        // 当正文色时实测不合格（amber-600 在白底只有 2.79:1；red-600 4.4976:1 临界不过）。
        // 语义保留在**背景 tint + 左边条/边框**上。
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))',
      },
      badge: {
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        whiteSpace: 'nowrap',
      },
      // ── S3c 三档视觉分级：**只用 host 主题 token，不写死颜色**（明暗主题都正确）──
      badgeBase: {
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        whiteSpace: 'nowrap',
        marginRight: '6px',
        fontWeight: 500,
      },
      badgeOutside: {
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-label-primary)',
      },
      badgeSensitive: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-label-primary)',
      },
      badgeDanger: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))',
        // 同 S3d：tinted 背景上的**文字**用前景 token（否则暗色下同色相中低对比）
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      rowOutside: { borderLeft: '3px solid var(--dsw-alias-state-warn-primary)', paddingLeft: '8px' },
      rowSensitive: { borderLeft: '3px solid var(--dsw-alias-state-error-primary)', paddingLeft: '8px' },
      rowDanger: { borderLeft: '3px solid var(--dsw-alias-state-error-primary)', paddingLeft: '8px' },
      groupHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: '18px',
        padding: '6px 0 2px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      groupCount: { opacity: 0.65, fontWeight: 400 },
      /**
       * S3i：组头的**等级徽章**（L1/L2/L3）。沿用既有 badge 的视觉语言（描边 pill + `--dsw-*` token），
       * **不写死颜色**；文字用前景 token（`D1`/`D2` 哨兵会管住对比度，`data-darkreader-ignore` 由渲染处加）。
       * ⚠ 这是 S3i 新增的渲染元素 ⇒ 它**必须**被 `f9` 的渲染树断言（`D4`）覆盖，否则就是新的对比度盲区。
       */
      groupBadge: {
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-warn-secondary)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      riskReason: {
        fontSize: '12px',
        lineHeight: '17px',
        padding: '0 0 4px 26px',
        // S3f：正文级文字 ⇒ label-*；红色语义由所在行的左边条（rowSensitive/rowDanger）保留
        color: 'var(--dsw-alias-label-primary)',
      },
      note: { opacity: 0.85 },
      /**
       * D1：冻结存档行的视觉语言 —— 复选框的位置换成不可交互的「存档」徽章，
       * 行内再给一句原因。**只用主题 token**（与其它自绘控件同一套），
       * 前景一律 `label-primary`（tinted/透明底上的对比度规则同 S3d/S3f）。
       */
      frozenBadge: {
        flex: '0 0 auto',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px dashed var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        color: 'var(--dsw-alias-label-primary)',
        opacity: 0.85,
        whiteSpace: 'nowrap',
      },
      frozenReason: {
        fontSize: '12px',
        lineHeight: '17px',
        padding: '0 0 4px 26px',
        color: 'var(--dsw-alias-label-primary)',
        opacity: 0.75,
      },
      frozenSummary: {
        fontSize: '12px',
        lineHeight: '18px',
        paddingBottom: '2px',
        color: 'var(--dsw-alias-label-primary)',
        opacity: 0.75,
      },
      /** 基线已过期：与 frozenBadge 同一套视觉语言，但用 warn token（不是"存档"，是"要处理"） */
      staleBadge: {
        ...{ flex: '0 0 auto' },
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-warn-secondary, rgba(200,140,0,.5))',
        color: 'var(--dsw-alias-state-warn-primary, #8a6100)',
        whiteSpace: 'nowrap',
      },
      staleSummary: {
        fontSize: '12px',
        lineHeight: '18px',
        paddingBottom: '2px',
        color: 'var(--dsw-alias-state-warn-primary, #8a6100)',
      },
      /**
       * 逐行的漂移形状说明（缺陷② F5b）。与 frozenReason 同一缩进语言：
       * 贴在那一行**下面**，因此"哪一条、为什么"不会被读成面板级告警。
       */
      staleNote: {
        fontSize: '12px',
        lineHeight: '17px',
        padding: '0 0 4px 26px',
        color: 'var(--dsw-alias-state-warn-primary, #8a6100)',
      },
      // ── 替代「访问模式」控件的视觉：与平台 PermissionSelect 同一位置、同一尺寸语言 ──
      permRoot: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      permTrigger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
        maxWidth: '200px',
        height: '28px',
        padding: '0 4px 0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: '20px',
        cursor: 'pointer',
      },
      permMark: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        height: '14px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(255,196,0,.18))',
        color: 'var(--dsw-alias-state-warn-primary, #8a6100)',
        fontSize: '10px',
        fontWeight: 700,
        lineHeight: '14px',
      },
      permLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      permDot: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-state-warn-primary, #8a6100)',
        fontWeight: 700,
        fontSize: '12px',
      },
      permChevron: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-caption)',
        fontSize: '10px',
        transition: 'transform .12s',
      },
      permMenu: {
        position: 'absolute',
        bottom: '32px',
        left: 0,
        zIndex: 30,
        minWidth: '240px',
        display: 'flex',
        flexDirection: 'column',
        padding: '4px',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.28))',
        borderRadius: 'var(--dsw-radius-lg, 8px)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.14))',
      },
      permItem: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        padding: '6px 10px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      permItemDanger: { color: 'var(--dsw-alias-state-error-primary, #b3261e)' },
      permHint: {
        padding: '4px 10px 2px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        opacity: 0.8,
        whiteSpace: 'normal',
      },
      // ── 命中敏感策略的**二次确认弹窗**（只在用户点批准时出现，不是常驻 UI）──
      confirmBackdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'rgba(0, 0, 0, .38)',
      },
      confirmCard: {
        width: '100%',
        maxWidth: '520px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '16px 18px',
        borderRadius: 'var(--dsw-radius-xl, 12px)',
        border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,60,60,.5))',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        boxShadow: 'var(--dsw-shadow-lv2, 0 8px 28px rgba(0,0,0,.28))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      confirmTitle: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      confirmBody: { fontSize: '13px', lineHeight: '20px', opacity: 0.85 },
      confirmList: { display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', maxHeight: '40vh' },
      confirmItem: {
        padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        borderLeft: '3px solid var(--dsw-alias-state-error-primary, #b3261e)',
      },
      confirmPath: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '12px',
        lineHeight: '18px',
        wordBreak: 'break-all',
      },
      confirmReason: { fontSize: '12px', lineHeight: '18px', opacity: 0.8 },
      confirmDanger: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #b3261e)' },
      confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '4px' },
      // 逐条失败原因：**原地**贴在出错条目下方
      rowError: {
        padding: '3px 10px 6px',
        fontSize: '12px',
        lineHeight: '17px',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-state-error-primary, #b3261e)',
      },
      // alerts 横幅：**非阻断**（没有按钮、不需要点掉；role=status 而非 alert 对话框）
      alert: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '8px 10px',
        marginBottom: '6px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        // ⚠ `--dsw-alias-state-error-tertiary` 在**当前主题里根本没有定义**（实测主题 CSS：
        // warn-tertiary 有，error-tertiary 无）⇒ 必须带 fallback，否则该声明非法、背景变透明、
        // 红色提示条只剩 1px 边框（这条是我 T11 复核 token 时自己发现的）。
        background: 'var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))',
        // 同 S3d：tinted 背景上的**文字**用前景 token（否则暗色下同色相中低对比）
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: '17px',
      },
      alertTitle: { fontWeight: 600 },
      alertText: { opacity: 0.9 },
      alertHint: { opacity: 0.75 },
      actionHint: { flexBasis: '100%', textAlign: 'right', fontSize: '11px', lineHeight: '16px', opacity: 0.7 },
      /** G4：摘要放进标题条（要求 4「在面板标题处显示汇总」） */
      stripSummary: { fontSize: '12px', opacity: 0.9, fontWeight: 500 },
      /** G1：档位变化导致授权失效的内联提示（非阻断、无按钮） */
      staleNotice: {
        flexBasis: '100%',
        textAlign: 'right',
        fontSize: '11px',
        lineHeight: '16px',
        // S3f：amber-600 当正文色在白底只有 2.79:1 ⇒ 用前景 token；"警告"语义由文案里的 ⚠ 前缀承载
        color: 'var(--dsw-alias-label-primary)',
      },
      // S3e：设置行里的「默认收起」开关（第 2 条退路；纯客户端偏好，不需要 host 改 schema）
      inlineToggle: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        marginTop: '4px',
        padding: '2px 8px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
      },
      // S3e：收起后的常驻重开 chip（挂在 conversation.input.dock，不依赖 composer 选举）
      chipRow: { display: 'flex', justifyContent: 'center', padding: '2px 0 4px' },
      chip: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '3px 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-warn-secondary)',
        background: 'var(--dsw-alias-state-warn-tertiary)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        // S3h：分级文案把 pill 拉长了 ⇒ 永不换行；极窄屏退化为省略号（完整含义在 title 里）
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    }

    /**
     * S3d —— Dark Reader 整段跳过标记。
     *
     * 用户装了 Dark Reader（强制暗色扩展）：它会往元素注入 `--darkreader-inline-bg` /
     * `data-darkreader-inline-bg` 把**底色**换成它自己算的值，而**显式写死的文字色**它不会同步调
     * ⇒ 深底深字（用户实测报告里那条 `color: rgb(255,255,255)` + `data-darkreader-inline-bg`）。
     *
     * 本面板**只用 host 主题 token**（`--dsw-*`），已被宿主主题正确解析；被 Dark Reader 二次改色
     * 只会帮倒忙。因此对**每个自绘控件**加 `data-darkreader-ignore`（Dark Reader 的官方退出标记；
     * 属性名**全小写**，React 会把未知 `data-*` 原样透传到 DOM）。
     *
     * 为什么不用方案 B（`--winstage-*` 自有变量）：那会**丢掉** Dark Reader 对 host token 的
     * 重映射，暗色下可能取到亮色值、与宿主主题不一致。A（跳过）更干净。
     */
    const DR = { 'data-darkreader-ignore': '' }

    // ==================== S3e：收起后的退路（存储 + 恢复）====================
    // 用户实测：点「暂时收起」后**面板再也回不来** —— 两层原因，都要修：
    //   1. 显示不回来：`dismissed` 只改 store，判定在槽位 `select` 里，没人让 `select` 重跑
    //      ⇒ 恢复必须走**已有的**「接管状态跃迁 → 重挂注册」通道（winstageElection + 下方 store 订阅）。
    //   2. 根本没有入口：只要快照没变（generatedAt 相同），`routeOf` 恒为 null ⇒ 用户无从叫回。
    //      ⇒ 必须有一个**不依赖 composer chain** 的常驻入口。
    // 本块只做"存储 + 判定"；入口是 `WinStageChip`（注册在 conversation.input.dock，见 apply）。
    /** 隐私模式/沙箱下 storage 访问会抛错：一律包住，绝不因存储失败影响面板 */
    function safeStorage(name) {
      try {
        const store = window[name]
        store.getItem('__winstage_probe__')
        return store
      } catch {
        return null
      }
    }
    const sessionStore = safeStorage('sessionStorage')
    const localStore = safeStorage('localStorage')
    function readStr(store, key) {
      try {
        return store ? store.getItem(key) : null
      } catch {
        return null
      }
    }
    function writeStr(store, key, value) {
      try {
        if (!store) return
        if (value === null || value === undefined) store.removeItem(key)
        else store.setItem(key, value)
      } catch {
        /* ignore */
      }
    }
    /** 跨刷新记住"这一版被收起过"（值 = generatedAt，因此新快照天然失效） */
    const DISMISS_KEY = 'winstage.dismissedSnapshot'
    /**
     * T3c：**粘性收起**的跨刷新记忆（'1' = 收起且粘住）。
     * 与 `DISMISS_KEY` 的"某一版"语义**刻意分开**：后者被 `.t/collapse-selftest.mjs` 钉死为
     * "换版即失效"，而 C3 要求"换版仍收起" —— 共用一个值必然两败俱伤。
     */
    const STICKY_KEY = 'winstage.collapsedSticky'
    /** 「默认收起」偏好（设置行第 2 个开关；localStorage 长期记忆） */
    const PREF_KEY = 'winstage.defaultCollapsed'
    // C7：跨刷新保持粘性收起。sessionStorage 在页面重载后仍在、关标签即失效 —— 与
    // 「暂时收起」的语义一致（不是"永久偏好"，那才是 localStorage 的 defaultCollapsed）。
    if (readStr(sessionStore, STICKY_KEY) === '1') store.stickyCollapsed = true

    // #region collapse-decision（.t/collapse-selftest.mjs 按这两个标记切片求值；勿删标记）
    /**
     * 「收起」状态的下一次取值 —— **纯函数**，因此可以在 Node 里直接断言。
     *
     * 三条规则，顺序有讲究：
     *   1. 快照换代（`generatedAt` 变了）⇒ 上一版的"收起"作废（S3e：收起只对当前这一版生效）；
     *   2. **「默认收起」是启动偏好**：只在本次页面加载后的**第一版有待审的快照**上生效
     *      **一次**（`applied` 标记）。绝不能每来一版快照就再收一次 —— 每个 Turn 都会
     *      publish 出新 `generatedAt`，那样面板会被反复压回去，用户永远打不开。
     *   3. sessionStorage 记住的那一版仍按 `generatedAt` 精确匹配（跨刷新保持收起）。
     * @param {{dismissed?: string, generatedAt?: string, remembered?: string, defaultCollapsed?: boolean, applied?: boolean, pending?: boolean}} state
     * @returns {{dismissed?: string, applied: boolean}}
     */
    function nextDismissed(state) {
      const { dismissed, generatedAt, remembered, defaultCollapsed, applied, pending } = state || {}
      let next = dismissed
      if (next && next !== generatedAt) next = undefined
      let consumed = applied === true
      if (!consumed && pending === true && Boolean(generatedAt)) {
        consumed = true
        if (defaultCollapsed === true) next = generatedAt
      }
      if (!next && remembered === generatedAt) next = generatedAt
      return { dismissed: next, applied: consumed }
    }
    // #endregion collapse-decision

    // #region sticky-collapse（p16 按这两个标记切片求值；勿删标记）
    /**
     * T3c 的**纯决策核**：给定"上一拍的粘性"与"这一拍读到的快照形态"，给出下一拍的
     * `{ sticky, collapsed, reset }`。抽成纯函数是为了能在 Node 里逐条断言 C1–C8，
     * 而不是靠肉眼观察（手法同 `.t/collapse-selftest.mjs` 对 `nextDismissed` 的切片求值）。
     *
     * @param {{sticky?: boolean, readyEmpty?: boolean, dismissedMatches?: boolean, decisionCollapsed?: boolean}} state
     *   - `sticky`           上一拍是否处于粘性收起
     *   - `readyEmpty`       本拍**明确读到**待审集合为空（ready 快照且 `pending !== true`）⇒ C6 复位
     *   - `dismissedMatches` 旧语义的精确匹配（`dismissed === 当前 generatedAt`）是否仍成立
     *   - `decisionCollapsed` 本拍 `nextDismissed()` 判定为"收起"（来源：默认收起偏好 / 跨刷新记忆）
     * @returns {{sticky: boolean, collapsed: boolean, reset: boolean}}
     */
    function stickyCollapseNext(state) {
      const { sticky, readyEmpty, dismissedMatches, decisionCollapsed } = state || {}
      // C6 复位：明确清空 ⇒ 粘性作废；下一次出现新的待审集合即回到 C1（首现自动展开）
      if (readyEmpty === true) return { sticky: false, collapsed: false, reset: true }
      // C2/C3/C7/C8：粘性一旦建立就**与 generatedAt 无关**（这正是本次要修的那一点）；
      // 决策若产生收起（启动偏好 / 跨刷新记忆）也升级为粘性。
      const nextSticky = sticky === true || decisionCollapsed === true
      // `dismissedMatches` 保留旧链路（同一版内的精确匹配），只影响本拍、不影响粘性
      return { sticky: nextSticky, collapsed: nextSticky || dismissedMatches === true, reset: false }
    }
    // #endregion sticky-collapse

    /**
     * T3c：**现在是否处于"已收起"** —— 面板（`winstageElection`）、chip（`WinStageChip` 与
     * `collapsedState`）**共用这一个判据**，避免三处各写一遍而漂移。
     */
    function isCollapsedNow(snapshot) {
      return stickyCollapseNext({
        sticky: store.stickyCollapsed === true,
        readyEmpty: Boolean(snapshot && snapshot.pending !== true),
        dismissedMatches: Boolean(snapshot && snapshot.generatedAt && store.dismissed === snapshot.generatedAt),
        decisionCollapsed: false,
      }).collapsed
    }

    /** 置为粘性收起（三条来源共用：用户手势 / 默认收起偏好 / 跨刷新记忆） */
    function markStickyCollapsed() {
      store.stickyCollapsed = true
      writeStr(sessionStore, STICKY_KEY, '1')
    }

    /** C6 复位：清掉粘性与"某一版"的旧记忆 ⇒ 回到"首现自动展开" */
    function resetStickyCollapse() {
      store.stickyCollapsed = false
      store.dismissed = undefined
      writeStr(sessionStore, STICKY_KEY, null)
      writeStr(sessionStore, DISMISS_KEY, null)
    }

    /** 收起这一版（并跨刷新记住；T3c：同时置为**粘性**，新快照不得弹开） */
    function collapseSnapshot(generatedAt) {
      store.dismissed = generatedAt
      writeStr(sessionStore, DISMISS_KEY, generatedAt ?? null)
      markStickyCollapsed()
      store.publish({})
    }

    /** 恢复：清掉 dismissed + 记忆 + 粘性，再 publish ⇒ 现有通道检测到跃迁 ⇒ 重挂 ⇒ 面板回来 */
    function restorePanel() {
      store.dismissed = undefined
      writeStr(sessionStore, DISMISS_KEY, null)
      resetStickyCollapse()
      store.publish({})
    }

    /** 这一版快照是否处于"已收起"（且确实有待审 ⇒ 才需要入口） */
    function collapsedState() {
      const snapshot = store.state.snapshot
      // β（V2-1）：判据收敛为 `pending === true`（理由见 winstageElection 处）
      const pending = Boolean(snapshot && snapshot.pending === true)
      // T3c：收起判据 = "粘性 ∨ 精确匹配某一版"（旧写法只看精确匹配 ⇒ 新快照一到就自动展开）
      const collapsed = isCollapsedNow(snapshot)
      return { pending, collapsed, files: snapshot?.counts?.files ?? 0, generatedAt: snapshot?.generatedAt }
    }

    function opLabel(t, op) {
      if (op === 'create') return t('opCreate')
      if (op === 'modify') return t('opModify')
      if (op === 'delete') return t('opDelete')
      if (op === 'mkdir') return t('opMkdir')
      return op
    }

    function useStoreState() {
      const [state, setState] = React.useState(store.state)
      React.useEffect(() => store.subscribe(() => setState(store.state)), [])
      return state
    }

    /**
     * WP3：**可信性状态卡** → 面板上的两行（纯函数，离线可断言）。
     *
     * 六个面的细节留在 `/winstage status`（面板不堆术语），这里只给：
     *   ① 一句话结论（level → locale 文案）；
     *   ② 一行机读式摘要（档位/掉档次数/失根次数/未结算审批/未确认写入/敏感读）。
     *
     * 卡片读不到（宿主路由不可用）⇒ 返回 `null`：面板**不显示**任何可信性结论，
     * 而不是拿旧的乐观结论冒充现状。文案里**没有路径**（卡片本身也不含路径）。
     */
    function trustLine(t, trust) {
      if (!trust || typeof trust !== 'object' || !trust.trust) return null
      const level = trust.trust.level
      const text =
        level === 'trusted'
          ? t('trustTrusted')
          : level === 'attention'
            ? t('trustAttention', { count: (trust.trust.blockers || []).length })
            : level === 'degraded'
              ? t('trustDegraded')
              : level === 'lost'
                ? t('trustLost')
                : level === 'write-unconfirmed'
                  ? t('trustWriteUnconfirmed')
                  : level === 'off'
                    ? t('trustOff')
                    : level === 'unknown'
                      ? t('trustUnknown')
                      : null
      if (text === null) return null
      const detail = t('trustDetail', {
        lane: trust.tier?.launchMode ?? '?',
        degrades: trust.firstDegrade?.degradeCount ?? 0,
        lost: trust.stageRoot?.lossCount ?? 0,
        approvals: trust.approvals?.unsettledCount ?? 0,
        writes: trust.writes?.count ?? 0,
        reads: trust.readVisibility?.reads ?? 0,
      })
      return { level, ok: trust.trust.ok === true, text, detail }
    }

    /**
     * 审阅悬浮窗：输入框上方的卡片，列出待审文件、逐文件 diff 与批准/拒绝动作。
     * 收到的 props：`matched`（select 的返回值）、`t`、`poller`、`executeCommand`。
     */
    function WinStageReview({ matched, t, poller, executeCommand }) {
      const state = useStoreState()
      const [selected, setSelected] = React.useState(() => new Set())
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [busy, setBusy] = React.useState(false)
      /** 失败原因走 **store**（见 store 初始化处注释）：重渲染/重挂载都不丢 */
      const failures = state.failures instanceof Map ? state.failures : new Map()
      const notice = state.notice
      /**
       * S7（§7.3）：轮询器把异常写进 `store.error`，但面板从不渲染它 ⇒ 后台失败对用户不可见。
       * 这里把它并进同一条 `[data-winstage-notice]` 通道（`notice` 优先：它是本次手势的结果）。
       */
      const pollError = typeof state.error === 'string' && state.error.length > 0 ? state.error : undefined
      /**
       * WP3：可信性状态卡（面板侧）。与 `/winstage status` 同一份 `buildTrustCard()`；
       * 读不到（`state.trust` 为 undefined）就**不显示** —— 不让旧结论冒充现状。
       */
      const trust = trustLine(t, state.trust)
      /** WP3-B：读侧来源（宿主路由 / 兜底旧布局）。只显示"是哪一条通道"，不显示任何路径。 */
      const storeSourceText =
        state.storeSource === 'host-route'
          ? t('trustSourceRoute')
          : state.storeSource === 'legacy-compat-path'
            ? t('trustSourceLegacy')
            : undefined
      /**
       * **立即、原地**显示失败：面板级 `notice` + 逐条 `failures`，一次写进 store。
       * 只针对一条时，整段原文也贴到那一条上（宿主不一定逐行带路径）。
       */
      const showFailure = (text, paths) => {
        const clean = typeof text === 'string' && text.length > 0 ? text : undefined
        const map = new Map()
        if (clean && Array.isArray(paths) && paths.length > 0) {
          for (const [path, line] of failureByPath(clean, paths)) map.set(path, line)
          if (map.size === 0 && paths.length === 1) map.set(paths[0], clean)
        }
        // V2-2 记账：这些失败路径**此刻在不在面板上**。清除时机靠它区分
        // "条目已离场（可清）"与"路径本来就不在面板（必须保留）"。
        const onPanel = new Set(((state.snapshot && state.snapshot.files) || []).map((file) => file.path))
        store.failureRows = new Set([...map.keys()].filter((path) => onPanel.has(path)))
        // v2.1：记下"这条 notice 是我们写的"（方案 B 的所有权凭据；prune 据此决定能不能清 notice）
        store.failureNotice = clean
        store.publish({ notice: clean, failures: map })
      }
      /**
       * G1：**授权手势的记账**。`path -> 勾选那一刻的 risk|safety 签名`。
       * 条目档位升级后签名不匹配 ⇒ 旧勾选不再授权，用户必须重新勾选。
       */
      const [consented, setConsented] = React.useState(() => new Map())
      /** 命中敏感策略时的二次确认（`null` = 不显示；出现即弹窗，用户点了才写盘） */
      const [pendingConfirm, setPendingConfirm] = React.useState(null)

      React.useEffect(() => {
        if (poller && matched) poller.observe(matched.owner)
      }, [poller, matched])

      const snapshot = state.snapshot
      const files = (snapshot && snapshot.files) || []

      const toggle = (setter, key) => {
        setter((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      /**
       * 勾选/取消（G1）：高风险项在**勾选那一刻**记下档位签名；档位一变签名失效 ⇒ 授权自动收回。
       * 普通项不记（它们本来就不需要高风险授权）。
       *
       * 关键细节：若该项**已被选中但授权失效**（档位升级），这一下点击语义是**重新授权**，
       * 而不是"取消选中" —— 否则用户会看到"勾着却批不了、点一下反而没了"的死循环
       * （这条是 f8 的 `B15c` 逼出来的）。
       */
      const toggleFile = (file) => {
        const inSet = selected.has(file.path)
        const needsConsent = riskOf(file) !== 'normal' && consented.get(file.path) !== riskSignature(file)
        const granting = !inSet || needsConsent
        const nextSelected = new Set(selected)
        const nextConsented = new Map(consented)
        if (granting) {
          nextSelected.add(file.path)
          if (riskOf(file) !== 'normal') nextConsented.set(file.path, riskSignature(file))
          else nextConsented.delete(file.path)
        } else {
          nextSelected.delete(file.path)
          nextConsented.delete(file.path)
        }
        setSelected(nextSelected)
        setConsented(nextConsented)
      }

      /** 命令超时上限：超过就解除 busy 并**立刻**给一条可见失败（不再"处理中"卡死） */
      const COMMAND_TIMEOUT_MS = 20000
      const act = (line, targets) => {
        if (busy) return
        if (!matched?.sessionId) {
          // 不再静默返回：没有会话身份就发不出命令，必须说出来
          showFailure(t('noSession'))
          return
        }
        if (!executeCommand) {
          // S3（§7.3）：不再静默 return —— 命令面不可用也必须说出来
          showFailure(t('commandNoOp'))
          return
        }
        setBusy(true)
        showFailure(undefined)
        const pending = Promise.resolve().then(() => executeCommand(matched.sessionId, line))
        const timeout = new Promise((resolve) => {
          setTimeout(
            () => resolve({ kind: 'error', text: t('commandTimeout', { seconds: Math.round(COMMAND_TIMEOUT_MS / 1000) }) }),
            COMMAND_TIMEOUT_MS,
          )
        })
        Promise.race([pending, timeout])
          .then((value) => {
            // 命令**没有抛错**也可能什么都没做（未知开关 / 没有匹配路径 / 需要二次确认 /
            // STALE_BASELINE）。面板必须显示出来，否则用户看到的就是"点了没反应"。
            // ★ 读法曾经是错的：commands RPC 的 value 是
            //   `CommandExecution = { commandId, result: { kind, text } }`
            //   （dsh-commands/lib/index.js:340-351），旧代码取 `value.kind` ⇒ 恒 undefined
            //   ⇒ **一切 `kind:'error'` 都被当成 success**（"点了批准没反应还不报错"）。
            //   这里向下钻一层到底层 CommandResult；同时兼容直接返回裸 CommandResult 的
            //   调用方（离线自测 / 旧宿主 stub）。
            const payload =
              value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value
            // 命令名未解析 ⇒ `execute()` 返回 undefined ⇒ 那也**不是** success，必须报错。
            const kind = payload && typeof payload.kind === 'string' ? payload.kind : value === undefined ? 'error' : 'success'
            if (kind !== 'success') {
              const text =
                typeof payload?.text === 'string' && payload.text.length > 0
                  ? payload.text
                  : value === undefined
                    ? t('unknownCommand')
                    : t('commandNoOp')
              showFailure(text, Array.isArray(targets) ? targets : undefined)
            }
          })
          .catch((error) => showFailure(String(error?.message ?? error), Array.isArray(targets) ? targets : undefined))
          .finally(() => {
            setBusy(false)
            if (poller) poller.refresh()
          })
      }

      // #region approve-command（.t/approve-button-selftest.mjs 按这两个标记切片求值；勿删标记）
      /**
       * 组装 `/winstage approve` 命令行 —— **纯函数**，离线可断言。
       *
       * `--confirm-mask` **只在确实有敏感项时**带上：
       *   1. 诚实：没给用户看过后果，就不该宣称"已确认"；
       *   2. 兼容/可见：宿主若是**尚未重启的旧进程**，不认识这个开关就会回
       *      `{kind:'error'}`；普通项也硬带上它，等于把每一次"批准"都变成一条注定被拒的命令
       *      —— 那正是"点了批准没反应"。
       */
      function approveCommandLine(paths, mode, confirm) {
        const flags = `${mode === 'rebase' ? '--rebase ' : ''}${confirm === true ? '--confirm-mask ' : ''}`
        return `/winstage approve ${flags}${paths.map((path) => `"${path}"`).join(' ')}`
      }
      // #endregion approve-command

      /** 发批准命令（是否携带确认开关由 `approveCommandLine` 决定） */
      const sendApprove = (paths, mode, confirm) => {
        // 把目标路径交给 act：失败时**逐条原地**标注原因
        act(approveCommandLine(paths, mode, confirm), paths)
      }

      /**
       * 命中敏感策略 ⇒ **先弹窗把后果逐条说清**，用户点「确认写入」才发命令；普通项直接发。
       * 服务器侧同样有闸门（`SANDBOX_PATH_MASKED_CONFIRM`），因此绕过面板也拿不到静默落盘。
       * 零路径**不再静默返回**：把"为什么一个都没选中"显示出来。
       */
      const approvePaths = (paths, mode) => {
        if (paths.length === 0) {
          const frozen = files.filter((file) => file.frozenOnly === true).length
          const risky = files.filter(
            (file) =>
              file.frozenOnly !== true &&
              riskOf(file) !== 'normal' &&
              !(selected.has(file.path) && consented.get(file.path) === riskSignature(file)),
          ).length
          showFailure(t('nothingToApprove', { total: files.length, frozen, risky }))
          return
        }
        const sensitive = files.filter((file) => paths.includes(file.path) && Boolean(file.safety))
        if (sensitive.length > 0) {
          setPendingConfirm({
            paths,
            rebase: mode === 'rebase',
            items: sensitive.map((file) => ({ path: file.path, reason: file.riskReason ?? null, danger: isDanger(file) })),
          })
          return
        }
        sendApprove(paths, mode, false)
      }

      const approveSelected = () => {
        // G1：只批准"当前档位下仍被授权"的勾选项（档位升级后旧勾选自动失效）
        approvePaths(authorizedPaths(files, selected, consented, true), 'approve')
      }

      // ── S3c 三档显示（纯渲染 + 纯函数）──────────────────────────────────────
      const grouped = groupByRisk(files)
      // G3：宿主声明的 riskCounts 由 `levelCounts`（内部走 `summarize`）一起消费，取 max ⇒ 截断时**绝不比声明的少报**
      /** G1：被勾选但档位已变（授权失效）的项 —— 用内联文案说明，不弹窗 */
      const staleConsent = files.filter((file) => selected.has(file.path) && riskOf(file) !== 'normal' && consented.get(file.path) !== riskSignature(file))
      const groupList = [
        { key: 'normal', level: t('levelL1'), label: t('groupInside'), items: grouped.normal, header: styles.groupHeader },
        {
          key: 'outside',
          level: t('levelL2'),
          label: t('groupOutside'),
          items: grouped.outside,
          header: { ...styles.groupHeader, color: 'var(--dsw-alias-label-primary)', borderLeft: '3px solid var(--dsw-alias-state-warn-primary)' },
        },
        {
          key: 'sensitive',
          level: t('levelL3'),
          label: t('groupSensitive'),
          items: grouped.sensitive,
          header: { ...styles.groupHeader, color: 'var(--dsw-alias-label-primary)', borderLeft: '3px solid var(--dsw-alias-state-error-primary)' },
        },
      ].filter((group) => group.items.length > 0)

      const riskBadge = (file) => {
        const risk = riskOf(file)
        if (risk === 'normal') return null
        const danger = isDanger(file)
        const style = danger
          ? { ...styles.badgeBase, ...styles.badgeDanger }
          : risk === 'sensitive'
            ? { ...styles.badgeBase, ...styles.badgeSensitive }
            : { ...styles.badgeBase, ...styles.badgeOutside }
        const label = danger ? t('badgeDanger') : risk === 'sensitive' ? t('badgeSensitive') : t('badgeOutside')
        return h('span', { style }, label)
      }

      const renderFile = (file) => {
        const open = expanded.has(file.path)
        const risk = riskOf(file)
        const danger = isDanger(file)
        const note = noteOf(file)
        /** D1：冻结存档行 —— 没有勾选框，只有「存档」徽章 + 行内原因 */
        const actionable = isActionable(file)
        const frozenText = actionable ? null : frozenReasonText(t, file)
        const rows = []
        if (danger) {
          // G2 纵深防御（独立复核）：**客户端自己**保证 danger 档永不渲染内容，
          // 不依赖"Host 一定返回空 diff"这条宿主保证；`note` 在 danger 档**无条件**显示。
          rows.push(h('div', { key: 'note', style: styles.note }, note !== null ? note : t('dangerHidden')))
        } else if (file.diff && file.diff.length > 0) {
          for (const [index, line] of file.diff.entries()) {
            rows.push(
              h(
                'div',
                {
                  key: index,
                  style:
                    line.type === 'add'
                      ? { color: 'var(--dsw-alias-label-primary)' }
                      : { color: 'var(--dsw-alias-label-primary)' },
                },
                `${line.type === 'add' ? '+' : '-'} ${line.text}`,
              ),
            )
          }
        } else if (note !== null) {
          // 危险档常常没有 diff：显示 note 原文，而不是会误导的"（无差异内容）"
          rows.push(h('div', { key: 'note', style: styles.note }, note))
        } else {
          rows.push(h('div', { key: 'none', style: { opacity: 0.6 } }, t('noDiff')))
        }
        if (file.truncated) rows.push(h('div', { key: 'trunc', style: { opacity: 0.6 } }, '…'))
        // 冻结存档行即使展开也没有内容可给（blob 可能已被回收、且本行不可批准），
        // 但仍要有一行说明，避免展开后是一片空白被误读成"没有改动"。
        if (!actionable) rows.push(h('div', { key: 'frozen', style: styles.frozenReason }, frozenText))

        const rowStyle =
          risk === 'normal' ? styles.fileRow : { ...styles.fileRow, ...(danger ? styles.rowDanger : risk === 'sensitive' ? styles.rowSensitive : styles.rowOutside) }

        return h(
          'div',
          { key: file.path, style: { display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            { style: rowStyle },
            // D1：可批准行才有勾选框；冻结存档行放一个**不可交互**的「存档」徽章
            actionable
              ? h('input', {
                  ...DR,
                  type: 'checkbox',
                  checked: selected.has(file.path),
                  onChange: () => toggleFile(file),
                  'aria-label': file.path,
                  title: risk === 'normal' ? file.path : t('riskCheckHint', { path: file.path }),
                })
              : h('span', { ...DR, style: styles.frozenBadge, 'data-winstage-frozen': '1', title: frozenText }, t('frozenBadge')),
            h(
              'button',
              {
                ...DR, type: 'button', style: styles.path, onClick: () => toggle(setExpanded, file.path), title: file.path },
              h('span', { style: { ...styles.badge, marginRight: '6px' } }, opLabel(t, file.op)),
              riskBadge(file),
              file.path,
            ),
            h('span', { style: styles.meta }, t('reviewCounts', { added: file.totals?.added ?? 0, removed: file.totals?.removed ?? 0 })),
            file.baselineStale === true &&
              h(
                'span',
                { ...DR, 'data-winstage-baseline-stale': '1', style: styles.staleBadge, title: t('baselineStaleTitle') },
                t('baselineStale'),
              ),
          ),
          // 缺陷②（F5b）：**逐行**说清是哪种漂移（"真实文件在暂存后出现"等）。
          // 只靠一个"基线已过期"徽标，用户看不出磁盘上已经有一份内容而批准会覆盖它。
          file.baselineStale === true &&
            h(
              'div',
              { ...DR, 'data-winstage-baseline-stale-note': '1', style: styles.staleNote },
              baselineStaleReasonText(t, file) ?? t('baselineStaleDrifted'),
            ),
          risk !== 'normal' && h('div', { style: styles.riskReason }, file.riskReason ? t('riskReason', { reason: file.riskReason }) : t('riskReasonUnknown')),
          !actionable && h('div', { style: styles.frozenReason, ...DR }, frozenText),
          // 失败原因**原地**贴在这一条下面（store 里的逐条映射；不在视野内的问题随之消失）
          failures.has(file.path) &&
            h(
              'div',
              { ...DR, 'data-winstage-row-error': '1', style: styles.rowError },
              t('rowFailed', { message: failures.get(file.path) }),
            ),
          open && h('pre', { style: styles.diff }, ...rows),
        )
      }

      // S3i：标题条与 chip **同一口径** —— 都走 `levelCounts()` + `levelSegments()`（**不另算一套**）。
      const levels = levelCounts(files, snapshot?.riskCounts, snapshot?.truncated, snapshot?.counts?.totalFiles ?? snapshot?.counts?.files)
      const summaryText = t('reviewLevels', {
        files: `${levels.total}${levels.truncated ? '+' : ''}`,
        levels: levelSegments(levels, t).join(' · '),
      })

      const alert = state.alert
      const approveAll = () => {
        // 绝不把**未勾选/未授权**的高风险项卷进来（用户模型：授权手势即点击；G1：档位变了要重新勾）
        approvePaths(authorizedPaths(files, selected, consented), 'approve')
      }

      /**
       * 基线已过期时的**显式**出路：先 rebase 再批准。
       * 与 `approveAll` 共用同一份 `authorizedPaths()`，因此**不会**比普通"批准"多覆盖
       * 任何一个文件——只是把"会被 STALE_BASELINE 拒绝"的那些先对齐到真实文件。
       */
      const rebaseAndApprove = () => {
        approvePaths(authorizedPaths(files, selected, consented), 'rebase')
      }

      /**
       * 二次确认弹窗：逐条列出命中原因与（危险档的）后果，点「确认写入」才真正发批准命令。
       * 全部自绘 + 主题 token；不引入任何 UI 库。
       */
      const confirmDialog =
        pendingConfirm &&
        h(
          'div',
          { role: 'dialog', 'aria-modal': 'true', ...DR, 'data-winstage-confirm': '1', style: styles.confirmBackdrop, onClick: () => setPendingConfirm(null) },
          h(
            'div',
            { style: styles.confirmCard, ...DR, onClick: (event) => event.stopPropagation() },
            h('div', { style: styles.confirmTitle }, t('confirmTitle', { count: pendingConfirm.items.length })),
            h('div', { style: styles.confirmBody }, t('confirmBody')),
            h(
              'div',
              { style: styles.confirmList },
              ...pendingConfirm.items.map((item) =>
                h(
                  'div',
                  { key: item.path, style: styles.confirmItem, ...DR },
                  h('div', { style: styles.confirmPath }, item.path),
                  item.reason ? h('div', { style: styles.confirmReason }, t('confirmReason', { reason: item.reason })) : null,
                  item.danger ? h('div', { style: styles.confirmDanger }, t('confirmDanger')) : null,
                ),
              ),
            ),
            h(
              'div',
              { style: styles.confirmActions },
              h('button', { ...DR, type: 'button', style: styles.button, disabled: busy, onClick: () => setPendingConfirm(null) }, t('confirmCancel')),
              h(
                'button',
                {
                  ...DR,
                  type: 'button',
                  style: { ...styles.button, ...styles.danger },
                  disabled: busy,
                  'data-winstage-confirm-accept': '1',
                  onClick: () => {
                    const pending = pendingConfirm
                    setPendingConfirm(null)
                    // 明确声明"用户已看过后果" ⇒ 只有这一条路会带 `--confirm-mask`
                    sendApprove(pending.paths, pending.rebase ? 'rebase' : 'approve', true)
                  },
                },
                t('confirmAccept'),
              ),
            ),
          ),
        )

      return h(
        'div',
        { style: styles.root, ...DR, 'data-winstage-panel': '1' },
        h(
          'div',
          { style: styles.card, ...DR },
          h(
            'div',
            { style: styles.strip, ...DR },
            h('span', null, t('reviewTitle')),
            // G4（独立复核）：要求 4 说"在面板标题处显示汇总" ⇒ 摘要在**标题条里**，
            // 正文首行只留文件数。位置改了、内容一字未减（`summaryText` 同一份）。
            h('span', { style: styles.stripSummary }, summaryText),
            h('span', { style: { opacity: 0.8 } }, t('reviewWaiting')),
            h(
              'span',
              { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('span', null, t('reviewFiles', { files: files.length })),
              h('span', null, t('reviewCounts', { added: snapshot?.counts?.additions ?? 0, removed: snapshot?.counts?.deletions ?? 0 })),
            ),
          ),
          h(
            'div',
            { style: styles.body },
            // alerts：**非阻断**横幅（没有按钮、不需要点掉；点批准/拒绝照样能用）
            alert &&
              h(
                'div',
                { role: 'status', style: styles.alert, ...DR },
                h('div', { style: styles.alertTitle }, t('alertTitle', { count: alert.count ?? 0 })),
                alert.message ? h('div', { style: styles.alertText }, String(alert.message)) : null,
                h('div', { style: styles.alertHint }, alert.hint ? String(alert.hint) : t('alertHint')),
              ),
            h('div', { style: { fontSize: '12px', opacity: 0.6, wordBreak: 'break-all' } }, snapshot?.workspaceRoot ?? ''),
            // ── WP3：可信性状态卡（**用户侧**；AI 侧零注入 —— 命令 stdout/stderr 不含它）──
            trust &&
              h(
                'div',
                {
                  ...DR,
                  'data-winstage-trust': trust.level,
                  role: 'status',
                  style: {
                    fontSize: '12px',
                    marginTop: '2px',
                    color: trust.ok ? 'inherit' : 'var(--dsw-alias-state-error-primary, #b3261e)',
                    opacity: trust.ok ? 0.85 : 1,
                  },
                },
                h('span', { style: { fontWeight: 600 } }, `${t('trustLabel')}：`),
                h('span', null, trust.text),
                h('div', { style: { opacity: 0.75, marginTop: '2px' } }, trust.detail),
                storeSourceText ? h('div', { style: { opacity: 0.6, marginTop: '2px' }, 'data-winstage-store-source': state.storeSource }, storeSourceText) : null,
              ),
            // 兜底读法（路由不可用）即使没拿到卡片也必须可见：否则用户只会看到"没有待审"
            !trust && storeSourceText
              ? h('div', { style: { fontSize: '12px', opacity: 0.6 }, 'data-winstage-store-source': state.storeSource }, storeSourceText)
              : null,
            // D1：把"N 项里有多少项是不可批准的存档行"直接说清 —— 否则用户会以为
            // 计数里的每一条都能勾、都能批。
            (snapshot?.counts?.frozenOnly ?? 0) > 0 &&
              h(
                'div',
                { ...DR, 'data-winstage-frozen-summary': '1', style: styles.frozenSummary },
                t('frozenSummary', { count: snapshot.counts.frozenOnly }),
              ),
            // 基线已过期：**必须**在正文里说清，否则用户只会看到一条必然失败的"批准"
            (snapshot?.counts?.staleBaseline ?? 0) > 0 &&
              h(
                'div',
                { ...DR, 'data-winstage-stale-summary': '1', style: styles.staleSummary },
                t('staleSummary', { count: snapshot.counts.staleBaseline }),
              ),
            // Method A 主线：AI 进程树读了/改了什么的分类统计（宿主 `snapshot.audit`）。
            // 没有审计（未开启/本会话无记录）时**不渲染**，绝不显示空括号。
            snapshot?.audit?.summary &&
              h(
                'div',
                { ...DR, 'data-winstage-audit': '1', style: { fontSize: '12px', opacity: 0.85, marginTop: '2px' } },
                t('auditSummary', {
                  read: snapshot.audit.summary.filesRead ?? 0,
                  write: snapshot.audit.summary.filesWritten ?? 0,
                  inws: snapshot.audit.summary.filesWrittenInWorkspace ?? 0,
                  outside: snapshot.audit.summary.filesWrittenOutside ?? 0,
                  deleted: snapshot.audit.summary.filesDeleted ?? 0,
                  rread: snapshot.audit.summary.registryRead ?? 0,
                  rwrite: snapshot.audit.summary.registryWritten ?? 0,
                }),
              ),
            ...groupList.map((group) =>
              h(
                'div',
                { key: group.key, style: { display: 'flex', flexDirection: 'column' } },
                h(
                  'div',
                  { style: group.header },
                  h('span', { style: styles.groupBadge, ...DR }, group.level),
                  h('span', null, group.label),
                  h('span', { style: styles.groupCount }, `(${group.items.length})`),
                ),
                ...group.items.map(renderFile),
              ),
            ),
            (notice || pollError) &&
              h(
                'div',
                { role: 'alert', 'data-winstage-notice': '1', style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #b3261e)' } },
                t('failed', { message: notice ?? pollError }),
              ),
            busy && h('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('busy')),
          ),
          h(
            'div',
            { style: styles.actionRow },
            h(
              'button',
              {
                ...DR,
                type: 'button',
                style: styles.button,
                disabled: busy,
                title: t('selectAllScope'),
                onClick: () => setSelected(new Set(selectablePaths(files))),
              },
              t('selectAll'),
            ),
            h('button', { ...DR, type: 'button', style: styles.button, disabled: busy, onClick: () => setSelected(new Set()) }, t('clearSelection')),
            h(
              'button',
              {
                ...DR,
                type: 'button',
                style: styles.button,
                disabled: busy,
                onClick: () => collapseSnapshot(snapshot?.generatedAt),
              },
              t('dismiss'),
            ),
            h(
              'button',
              {
                ...DR, type: 'button', style: { ...styles.button, ...styles.danger }, disabled: busy, onClick: () => act('/winstage reject') },
              t('rejectAll'),
            ),
            selected.size > 0 &&
              h(
                'button',
                { type: 'button', style: { ...styles.button, ...styles.primary }, disabled: busy, onClick: approveSelected },
                t('approveSelected'),
              ),
            /**
             * 缺陷②（F5b）：**基线已过期**时，拒绝文案给出的出路必须在面板上**可点**。
             *
             * 背景：旧设计删掉了「重新对齐基线」按钮，理由是"每次修改都自动对齐"——
             * 而"自动对齐"正是缺陷②要拿掉的那条丢数据路径。现在有损漂移不会被自动对准、
             * 批准会被 `STALE_BASELINE` 拒绝，如果面板上再没有按钮，用户就被卡在
             * "点批准失败 → 让你 rebase → 没有按钮"里。
             *
             * 只对**已勾选**的项出现，并且走 `authorizedPaths()` 同一份可写集合
             * （不比普通「批准所选」多覆盖任何一个文件，只是先把它们对齐到真实文件）；
             * 命令面是既有的 `/winstage approve --rebase`，不是新流程。
             */
            selected.size > 0 &&
              files.some((file) => selected.has(file.path) && file.baselineStale === true && isActionable(file)) &&
              h(
                'button',
                {
                  ...DR,
                  type: 'button',
                  'data-winstage-rebase-selected': '1',
                  style: styles.button,
                  disabled: busy,
                  title: t('baselineStaleTitle'),
                  onClick: rebaseAndApprove,
                },
                t('rebaseAndApprove'),
              ),
            // ★ 不再有「重新对齐基线」**全局**按钮（用户要求）：全局对齐会把**没有勾选**的
            //   条目也一起对齐，而"对齐"对**有损**漂移来说就是"把外部写入变成可批准"。
            //   缺陷②（F5b）之后：无损漂移仍会自动对准；有损漂移必须在面板上**显式**处理 ⇒
            //   上面那个「重新对齐并批准所选」（只对已勾选、且只走 authorizedPaths 的可写集合）
            //   就是唯一入口，终端仍有 `/winstage rebase`。
            h(
              'button',
              {
                ...DR, type: 'button', style: { ...styles.button, ...styles.primary }, disabled: busy, onClick: approveAll },
              t('approveAll'),
            ),
            // 内联文案说清「批准全部」的范围（**不用弹窗拦截**）
            h('div', { style: styles.actionHint }, t('approveAllScope')),
            // G1：档位变化导致授权失效时，用**内联**文案说明（不弹窗、不阻断其它操作）
            staleConsent.length > 0 && h('div', { style: styles.staleNotice, ...DR }, t('consentStale', { count: staleConsent.length })),
          ),
        ),
        confirmDialog,
      )
    }

    /**
     * **访问模式位置的替代控件**（single 槽位 `conversation.input.permission`）。
     *
     * 平台原本在那里放「工作区内修改 / 完全访问」预设选择器。WinStage 开启时，文件写入
     * 由暂存面接管 —— 那个预设不再决定"写盘会怎样"，留在那里只会误导用户。因此：
     *   - **元素**：本按钮（priority -10 遮蔽平台条目；关掉开关即撤销注册、平台控件原样回来）；
     *   - **逻辑**：打开审阅面板 / 对基线过期的条目重新对齐 / 直接关闭 WinStage 沙箱。
     *
     * 为什么把手动关闭也放在这里：这是 composer 上唯一"与写盘模式有关"的控件，
     * 用户要退回平台访问模式时不必绕去设置页。
     *
     * 收到的 props：`locked`（composer 是否拒绝交互）、`sessionId`、`t`，
     * 以及 inject 的 `openPanel` / `executeCommand` / `setEnabled`。
     */
    function WinStagePermission({ locked, sessionId, t, openPanel, executeCommand, setEnabled }) {
      const state = useStoreState()
      const snapshot = state.snapshot
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const boxRef = React.useRef(null)

      // 点外面关掉菜单（不引入任何 UI 库；document 监听只在打开时挂）
      React.useEffect(() => {
        if (!open) return undefined
        const onDoc = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [open])

      const files = snapshot?.counts?.files ?? 0
      const stale = snapshot?.counts?.staleBaseline ?? 0

      const run = (line) => {
        if (busy) return
        if (!sessionId || !executeCommand) {
          // S5（§7.3）：菜单按钮点不动时也要能看见原因，不再静默丢弃
          store.publish({ notice: t('commandNoOp') })
          return
        }
        setBusy(true)
        Promise.resolve()
          .then(() => executeCommand(sessionId, line))
          .then((value) => {
            // 与面板共用同一条读法：RPC 信封 `{commandId, result:{kind,text}}`，兼容裸 CommandResult
            const payload =
              value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value
            const kind = payload && typeof payload.kind === 'string' ? payload.kind : value === undefined ? 'error' : 'success'
            if (kind !== 'success') {
              store.publish({
                notice:
                  typeof payload?.text === 'string' && payload.text.length > 0
                    ? payload.text
                    : value === undefined
                      ? t('unknownCommand')
                      : t('commandNoOp'),
              })
            }
          })
          .catch((error) => store.publish({ notice: String(error?.message ?? error) }))
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        { ref: boxRef, style: styles.permRoot, ...DR, 'data-winstage-permission': '1' },
        h(
          'button',
          {
            ...DR,
            type: 'button',
            'aria-haspopup': 'true',
            'aria-expanded': open ? 'true' : 'false',
            disabled: locked,
            style: styles.permTrigger,
            title: t('permTitle'),
            onClick: () => setOpen((value) => !value),
          },
          h('span', { style: styles.permMark, 'aria-hidden': 'true' }, 'W'),
          h('span', { style: styles.permLabel }, files > 0 ? t('permPending', { files }) : t('permIdle')),
          stale > 0 && h('span', { style: styles.permDot, title: t('baselineStaleTitle') }, '!'),
          h('span', { style: { ...styles.permChevron, transform: open ? 'rotate(180deg)' : 'none' } }, '▾'),
        ),
        open &&
          h(
            'div',
            { role: 'menu', style: styles.permMenu, ...DR },
            files > 0
              ? h(
                  'button',
                  {
                    ...DR, type: 'button', role: 'menuitem', style: styles.permItem,
                    onClick: () => { setOpen(false); openPanel() },
                  },
                  t('permOpenPanel', { files }),
                )
              : h(
                  'button',
                  {
                    ...DR, type: 'button', role: 'menuitem', style: styles.permItem,
                    disabled: busy,
                    onClick: () => { setOpen(false); run('/winstage refresh'); openPanel() },
                  },
                  t('permRefresh'),
                ),
            // 「重新对齐基线」菜单项已删除（与卡片按钮同一决定：对齐是自动的，
            //  见审阅卡片处注释）。要立刻处理时终端仍有 `/winstage rebase`。
            h(
              'button',
              {
                ...DR, type: 'button', role: 'menuitem',
                style: { ...styles.permItem, ...styles.permItemDanger },
                onClick: () => {
                  setOpen(false)
                  // S6（§7.3）：关闭开关失败原本被 `.catch(() => {})` 吞掉 —— 必须响
                  Promise.resolve(setEnabled(false))
                    .then((ok) => {
                      if (ok === false) store.publish({ notice: t('error') })
                    })
                    .catch((error) => store.publish({ notice: `${t('error')}（${String(error?.message ?? error)}）` }))
                },
              },
              t('permDisable'),
            ),
            h('div', { style: styles.permHint }, t('permDisableHint')),
          ),
      )
    }

    /**
     * S3e —— 收起之后的**常驻重开入口**（task-10 的第 1 条退路）。
     *
     * 为什么单独注册在 `conversation.input.dock`、而不复用 composer 槽位：
     * composer 是 **chain** 槽位，收起之后 `select` 返回 null ⇒ 它自己就是"消失"的那一个。
     * 入口必须挂在**另一个、始终渲染**的槽位上，否则等于没有入口 —— 那正是用户实测卡住的那一层。
     *
     * 点击 = 恢复：清 `dismissed` + 清记忆 + `publish` ⇒ 复用**已有的**
     * 「接管状态跃迁 → 重挂注册」通道（`winstageElection` / `shouldElect`，见 apply 里的 store 订阅），
     * **不另造通道**。
     *
     * 只在"有待审 + 这一版已收起"时渲染；新快照到达时 `dismissed` 自动失效 ⇒ chip 自己消失。
     */
    function WinStageChip({ t }) {
      const state = useStoreState()
      const snapshot = state.snapshot
      // β（V2-1）：判据收敛为 `pending === true`（理由见 winstageElection 处）
      const pending = Boolean(snapshot && snapshot.pending === true)
      // T3c：与 `winstageElection` / `collapsedState` 共用同一判据 ⇒ 新快照到达时 chip 仍渲染
      // （C3"面板缺席、chip 在场"），而计数取自 `snapshot`，因此**自动反映最新一版**（C4）。
      const collapsed = isCollapsedNow(snapshot)
      if (!pending || !collapsed) return null
      // S3h：分级计数走纯函数（可离线断言），数据优先用宿主的 `riskCounts`（G3 的 max 加固在里面）
      const levels = levelCounts(snapshot.files, snapshot.riskCounts, snapshot.truncated, snapshot.counts?.totalFiles ?? snapshot.counts?.files)
      const segments = levelSegments(levels, t).join(' · ')
      // 兜底：万一所有档位都是 0（理论上被 pending 条件挡住），退回只显示总数，绝不渲染空括号
      // 截断标记直接并进数字里（`10+` = "至少 10 个"，同 G3 的"不静默少报"）
      const filesText = `${levels.total}${levels.truncated ? '+' : ''}`
      const label = segments.length > 0
        ? t('chipLabelLevels', { files: filesText, levels: segments })
        : t('chipLabel', { files: filesText })
      return h(
        'div',
        { style: styles.chipRow, ...DR, 'data-winstage-chip': '1' },
        h(
          'button',
          { ...DR, type: 'button', style: styles.chip, title: t('chipTitle'), onClick: () => restorePanel() },
          label,
        ),
      )
    }

    /**
     * 一行设置。宿主不传 props，因此这里自己画标题、说明与开关。
     * 收到的 props：`useValue`（读 configForms 快照）、`setEnabled`、`t`。
     */
    function WinStageRow({ useValue, setEnabled, t }) {
      const snapshot = useValue((s) => s)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      /** S3e：默认收起偏好（localStorage 持久化；纯客户端，不动 host Config schema） */
      const [prefCollapsed, setPrefCollapsed] = React.useState(() => readStr(localStore, PREF_KEY) === '1')

      const writable = snapshot && snapshot.status === 'ready' && snapshot.writable !== false
      const value = snapshot && snapshot.value ? snapshot.value : undefined
      const enabled = value && typeof value.enabled === 'boolean' ? value.enabled : true
      const unavailable = Boolean(snapshot && (snapshot.status === 'unavailable' || snapshot.writable === false))
      // 状态文字**三选一**，必须互斥（早期版本 loading 与 unavailable 会同时显示）
      const statusText = unavailable
        ? t('unavailable')
        : !snapshot || snapshot.status === 'loading'
          ? t('loading')
          : enabled
            ? t('on')
            : t('off')

      const switchStyle = {
        position: 'relative',
        flex: '0 0 auto',
        width: '38px',
        height: '22px',
        padding: 0,
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        background: enabled ? 'var(--dsw-alias-brand-primary, #247bbf)' : 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2))',
        cursor: writable && !busy ? 'pointer' : 'default',
        opacity: writable && !busy ? 1 : 0.55,
        transition: 'background .15s, opacity .15s',
      }
      const knobStyle = {
        position: 'absolute',
        top: '50%',
        left: enabled ? '19px' : '3px',
        transform: 'translateY(-50%)',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        transition: 'left .15s',
        pointerEvents: 'none',
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            padding: '12px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2))',
          },
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { fontSize: '13px', color: 'var(--dsw-alias-text-l1, inherit)', lineHeight: '20px' } },
            t('title'),
            h('span', { style: { marginLeft: '8px', fontSize: '12px', opacity: 0.6 } }, statusText),
          ),
          h('div', { style: { marginTop: '2px', fontSize: '12px', opacity: 0.6, lineHeight: '18px' } }, t('description')),
          // S3e 第 2 条退路：默认展开/默认收起。纯客户端偏好（localStorage），
          // 不改 host 的 Config schema（那不在本任务写范围），因此不需要重启就能生效。
          h(
            'button',
            {
              ...DR,
              type: 'button',
              style: styles.inlineToggle,
              title: t('defaultCollapsedHint'),
              onClick: () => {
                const next = readStr(localStore, PREF_KEY) === '1' ? '0' : '1'
                writeStr(localStore, PREF_KEY, next)
                setPrefCollapsed(next === '1')
              },
            },
            prefCollapsed ? t('defaultCollapsedOn') : t('defaultCollapsedOff'),
          ),
          unavailable && h('div', { style: { marginTop: '4px', fontSize: '12px', opacity: 0.7 } }, t('unavailable')),
          failed && h('div', { role: 'alert', style: { marginTop: '4px', fontSize: '12px' } }, t('error')),
        ),
        h(
          'button',
          {
            ...DR, // 设置行的开关同样自绘，同样跳过 Dark Reader 二次改色
            type: 'button',
            role: 'switch',
            'aria-checked': enabled ? 'true' : 'false',
            'aria-label': t('title'),
            disabled: !writable || busy,
            style: switchStyle,
            onClick: () => {
              if (!writable || busy) return
              setFailed(false)
              setBusy(true)
              Promise.resolve(setEnabled(!enabled))
                .then((ok) => {
                  if (ok === false) setFailed(true)
                })
                .catch(() => setFailed(true))
                .finally(() => setBusy(false))
            },
          },
          h('span', { style: knobStyle }),
        ),
      )
    }

    return {
      /** settings 通道（configForms）+ 槽位 + 本地化 + 只读文件/命令 Remote */
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.workspaceFiles', 'remote.commands'],

      /**
       * ★ WP3-B：**离线断言的接缝**（不是新契约、不参与 DSH 装配）。
       *
       * 为什么必须开这个口：上面那些函数都在 factory 闭包里，外部只能通过"跑轮询 + 桩 ctx"
       * 才能间接打到它们。把真正决定"读哪一份快照"的三个入口亮出来，断言就能直接问
       * 三个问题（顺序即优先级）：
       *   ① `readReviewViaRoute()` 走的是宿主路由吗？
       *   ② 路由不可用时才落到 `readReviewViaLegacyPath()`（兼容旧布局）吗？
       *   ③ 返回的 `source` 如实标出来源了吗？
       */
      __winstageTestHooks: {
        PANEL_SNAPSHOT_ROUTE,
        PANEL_TRUST_ROUTE,
        readReview,
        readReviewViaRoute,
        readReviewViaLegacyPath,
        readTrustCard,
        trustLine,
        storeSourceOf: () => store.state.storeSource,
      },

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, dicts), 'winstage-sandbox: dictionaries')

        const form = ctx.configForms.get(NAMESPACE)
        const poller = createPoller(ctx, form)
        ctx.effect(() => () => poller.dispose(), 'winstage-sandbox: review poller')

        // ── 按需诊断（在页面 URL 加 ?winstageDebug=1 才会输出）──────────────────
        // 存在理由：客户端的失败面只有"命名空间/槽位没出现"，看不到原因；
        // 这段把 configForms 与快照的真相一次读出来，避免在字符串上反复猜。
        try {
          const debug = typeof location !== 'undefined' && /[?&]winstageDebug=1/.test(location.search)
          if (debug) {
            const face = ctx.configForms.describe()
            const dump = (tag) => {
              const snap = face.getSnapshot()
              const view = snap && snap.view
              const namespaces = (view && view.namespaces ? view.namespaces : []).map((n) => n.ns)
              console.log('[winstage] configForms.describe()', tag, {
                status: snap && snap.status,
                error: snap && snap.error,
                writable: view && view.writable,
                hasDocument: view && view.hasDocument,
                namespaceCount: namespaces.length,
                namespaces,
                containsMine: namespaces.indexOf(NAMESPACE) >= 0,
                namespaceSuffixMatches: namespaces.filter((n) => String(n).indexOf('winstage') >= 0),
                myFormStatus: form.getSnapshot() && form.getSnapshot().status,
                review: {
                  status: store.state.status,
                  error: store.state.error,
                  counts: store.state.snapshot ? store.state.snapshot.counts : undefined,
                  workspaceRoot: store.state.workspaceRoot,
                },
              })
            }
            dump('initial')
            const off = face.subscribe(() => dump('changed'))
            ctx.effect(() => off, 'winstage-sandbox: debug describe subscription')
          }
        } catch (error) {
          console.log('[winstage] debug dump failed', error)
        }

        // ── 设置行（保持不变）───────────────────────────────────────────────────
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'winstage-sandbox',
              order: 40,
              locale: LOCALE_NS,
              inject: () => ({
                hooks: { value: form },
                setEnabled: (next) => form.set('enabled', next),
              }),
            },
            WinStageRow,
          ),
        )

        // ── 审阅悬浮窗：接管 conversation.composer ──────────────────────────────
        // 槽位契约要求 `select` 是**纯函数**：这里只读模块级 store 来做判定。
        // `observe()` 会记录会话身份并可能触发一次抓取，因此用微任务推迟到渲染之后，
        // 避免"渲染期间 publish → 触发他人 setState"的 React 告警。
        //
        // ── 失效通道（A「首屏不挂载」与 C「暂时收起收不起自己」的同一根因）──────
        // `conversation.composer` 是 **chain** 槽位：渲染锚点用 uSES 订阅**槽位版本**
        // （`dsh-client-ui-renderer/lib/client.js:1097` `subscribe`/`getVersion`），
        // 并在渲染时对每个条目调 `select(ownerProps)`（同文件 `:1163`）。
        // ⇒ `select` **只在渲染时求值**；模块级 `store` 变化不会让它重跑：
        //     A：页面加载时 store 还是 idle ⇒ select=null；随后快照到达，
        //        但没有任何东西重跑 select ⇒ 面板不出现，直到 composer 因无关原因重挂；
        //     C：点「暂时收起」改了 `store.dismissed`，同样没人重跑 select ⇒ 收不起来。
        // `ui-slots` 的 `SlotCore` **没有**公开的 invalidate/touch API（方法清单见
        // `dsh-cordis-client-runner/lib/client.js:2156` 的 SlotCore 声明）；
        // 唯一公开的版本推进通道是 `register()` 与它返回的 disposer —— 各自
        // `markDirty()` 一次（`dsh-client-ui-slots/lib/index.js:223` / `:240`），
        // 而 `markDirty` 会 `rec.version += 1` 并异步通知 uSES 订阅者（`:553-563`）。
        // ⇒ 做法：**只在接管状态发生跃迁时**重挂一次注册，逼渲染锚点重新选举。
        //    稳态（接管状态未变）不重挂，所以轮询不会清掉面板里的勾选/展开状态。
        //
        // 归属安全性：`ctx.slots.register` 的 `this.ctx` 由"从哪个 ctx 读到 `.slots`"决定
        // （`cordis/lib/index.js:673-675` `getTraceable(ctx, …)`），本闭包里的 `ctx`
        // 恒为本插件的 ctx ⇒ 重挂出来的 effect 仍归本插件 fiber 所有（插件卸载即撤）。
        let lastElected = false
        const route = (owner) => {
          queueMicrotask(() => poller.observe(owner))
          const matched = routeOf(owner)
          lastElected = matched !== null
          return matched ? { ...matched, owner } : null
        }
        const composerEntry = {
          name: 'conversation.composer',
          priority: COMPOSER_PRIORITY,
          select: route,
          locale: LOCALE_NS,
          inject: () => ({
            poller,
            executeCommand: (sessionId, line) => runCommand(ctx, sessionId, line),
          }),
        }
        ctx.slots.inject('conversation.composer', () => {
          let dispose = null
          const remount = () => {
            // 先撤再挂：撤掉旧闭包，register 的两次 markDirty 顺带推进槽位版本
            if (dispose) dispose()
            dispose = ctx.slots.register(composerEntry, WinStageReview)
          }
          remount()
          // 乐观置位：新注册的 select 会在下一次渲染给出真值并覆盖它
          lastElected = poller.shouldElect()
          const off = store.subscribe(() => {
            const should = poller.shouldElect()
            if (should === lastElected) return
            lastElected = should
            remount()
          })
          // `slots.inject` 的契约就是"回调返回同步 disposer"（runbook `:1385`）
          return () => {
            off()
            if (dispose) dispose()
            dispose = null
          }
        })

        // ── S3e 第 1 条退路：收起后的**常驻重开入口** ───────────────────────────
        // 挂在一个**始终渲染**的 list 槽位（conversation.input.dock，已有 queue/todo/goal 等条目），
        // 因此它**不依赖** composer 的 chain 选举 —— 收起后 composer 上是空的，只有这里能点回来。
        // 防御：槽位形状变化/占用冲突绝不能让插件加载失败。
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'winstage-sandbox-chip',
                // T3b（用户诉求）：chip 必须渲染在**发送按钮那一行**与**任务元素**之上。
                //
                // 为什么是"把 order 变成 dock 里最小的"：
                //   · 平台在这条 list 槽位上已有的条目及其 order 是
                //       todo = 0、goal = 10、queue = 20（`dsh-client-ui-conversation` / `dsh-client-ui-goal`）；
                //     list 槽位按 `(priority ?? 0)` 再按 `(order ?? 0)` **升序**排
                //     （`dsh-client-ui-slots/lib/index.js:221`）。
                //     旧值 30 ⇒ chip 排在最后，正好**压在任务元素下面**（但在发送行上面）。
                //   · dock 整块本身排在发送行之前：宿主 `composerStack` 的子节点顺序是
                //       [HeroShell?, heroWorkspaceRow?, renderSlot('conversation.input.dock'),
                //        inputBar = renderSlot('conversation.composer.bar')]
                //     （`dsh-client-ui-conversation/lib/client.js:16224-16235`），
                //     且该容器是 `flex-direction: column`（`wSkVaW_composerStack`，同文件 :15721）
                //     ⇒ **DOM 顺序 = 视觉顺序**，dock 恒在发送行上方。
                //   ⇒ 取 −10（< todo 的 0）即同时满足"在任务元素之上"与"在发送行之上"。
                // 只改排序值：不换槽位、不改 priority、不碰选举逻辑。
                order: -10,
                locale: LOCALE_NS,
              },
              WinStageChip,
            ),
          )
        } catch (error) {
          console.log('[winstage] reopen-chip slot registration failed:', error)
        }

        // ── 访问模式控件：WinStage 开启时**替换**平台的权限预设选择器 ──────────────
        // 槽位是 single（平台条目 priority 0）⇒ 本插件注册 -10 遮蔽它（"最低 priority 渲染"）；
        // 关闭开关时撤销注册 ⇒ 平台控件与它的预设弹窗原样回来。注册/撤销由开关真值驱动，
        // 因此设置页一关，composer 上的按钮立刻换回平台的访问模式选择器。
        // ★ **未知 ≠ 开**：只有 readSwitch()==='on'（快照 ready 且 enabled===true）才遮蔽。
        //   'loading'/'unavailable'/没有表单一律不注册 —— 沙箱没装或读不到时，
        //   平台控件与弹窗必须原样保留（见 readSwitch 的注释）。
        const permissionEntry = {
          name: 'conversation.input.permission',
          priority: PERMISSION_PRIORITY,
          locale: LOCALE_NS,
          inject: () => ({
            openPanel: restorePanel,
            executeCommand: (targetSessionId, line) => runCommand(ctx, targetSessionId, line),
            setEnabled: (next) => form.set('enabled', next),
          }),
        }
        try {
          ctx.slots.inject('conversation.input.permission', () => {
            let dispose = null
            /**
             * 开关真值：`readSwitch()`（唯一实现）—— 快照 `ready` 且 `enabled === true`
             * 才返回 'on'。这里保留 `form.subscribe`，因为设置页的写入会立刻 fold 回快照，
             * 于是"关掉沙箱必须**立即**恢复平台控件"（元素与逻辑一起：dispose 注册 ⇒
             * 平台条目重新成为该 single 槽位的唯一赢家，见 dsh-client-ui-slots 的
             * entriesOfSlot）。`store.subscribe` 只作兜底（表单读不到时靠轮询发布的值）。
             *
             * 与旧写法的关键差别：旧实现把"读不到开关"当成"开"（`enabled !== false`），
             * 于是命名空间 unavailable（宿主插件根本没装）时**永久**盖住平台控件；
             * 现在未知一律不接管。
             */
            const readEnabled = () => readSwitch(form) === 'on'
            const sync = () => {
              const on = readEnabled()
              if (on && !dispose) dispose = ctx.slots.register(permissionEntry, WinStagePermission)
              else if (!on && dispose) {
                dispose()
                dispose = null
              }
            }
            sync() // 初始：Config 还是 loading ⇒ 'unknown' ⇒ **不接管**（平台控件在场；ready 后按真值接管）
            const offForm = form && typeof form.subscribe === 'function' ? form.subscribe(sync) : () => {}
            const offStore = store.subscribe(sync)
            return () => {
              offForm()
              offStore()
              if (dispose) dispose()
              dispose = null
            }
          })
        } catch (error) {
          // 槽位形状变化/占用冲突绝不能让插件加载失败（与上面的 chip 同一防守）
          console.log('[winstage] permission-slot takeover failed:', error)
        }
      },
    }
  },
})
