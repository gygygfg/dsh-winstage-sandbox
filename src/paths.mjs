/**
 * 路径规范化与边界判定
 *
 * 手册依据：
 *   #16.6  遮蔽前先规范化，符号链接是绕过入口
 *   #3.2   目录参数不能当文件参数重写
 *   #16.8  豁免要限定作用域
 *
 * Windows 特有的三个坑（本模块存在的理由）：
 *   1. 大小写不敏感：NTFS 默认不区分大小写，`C:\WS\a.txt` 与 `c:\ws\A.TXT` 是同一对象。
 *      只做字符串前缀比较会被大小写绕过。
 *   2. 符号链接/目录联接(junction)：`realpathSync.native` 才会解析 junction；
 *      JS 层 `path.resolve` 只消 `.`/`..`，等价于手册里被证伪的 `fnamemodify(path,":p")`。
 *   3. 长路径前缀与 8.3 短名：`\\?\C:\...`、`\\.\C:\...`、`C:\PROGRA~1`。
 *      比较前必须归一，否则边界判定漏判。
 *
 * 设计原则：任何"这个路径在不在边界内"的判断，都必须先经过 canonical()。
 */

import { realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 去长路径前缀、统一分隔符、折叠 . 与 ..，但不解析链接 */
export function lexical(anyPath) {
  if (typeof anyPath !== 'string' || anyPath.length === 0) {
    throw new TypeError('path must be a non-empty string')
  }
  let p = anyPath
  // \\?\C:\x  /  \\?\UNC\server\share  /  \\.\C:\x
  if (p.startsWith('\\\\?\\')) p = p.slice(4)
  else if (p.startsWith('\\\\.\\')) p = p.slice(4)
  if (p.startsWith('UNC\\')) p = '\\\\' + p.slice(4)
  p = p.replace(/\//g, sep)
  p = normalize(p)
  // 盘符统一大写，便于不区分大小写的比较（只影响盘符，不动其余大小写）
  if (/^[a-zA-Z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  return p
}

/**
 * 解析链接后的真实路径。
 * 悬空链接（目标不存在）不抛错，回退到对父目录求值再拼回末段，
 * 这正是手册 #16.6 要求的"支持悬空链接"。
 */
export function canonical(anyPath) {
  const lex = lexical(anyPath)
  try {
    return realpathSync.native(lex)
  } catch {
    // 逐级上溯找到第一个存在且可解析的祖先
    const parts = []
    let cursor = lex
    for (let depth = 0; depth < 64; depth += 1) {
      const parent = dirname(cursor)
      if (parent === cursor) break
      parts.unshift(cursor.slice(parent.length).replace(/^[\\/]/, ''))
      try {
        const resolvedParent = realpathSync.native(parent)
        return normalize(join(resolvedParent, ...parts))
      } catch {
        cursor = parent
      }
    }
    return lex
  }
}

/** 不区分大小写的比较键 */
export function compareKey(anyPath) {
  return lexical(anyPath).toLowerCase()
}

/**
 * 词法包含判定：只看路径字面，**不解析链接**。
 *
 * 用途：先判断"调用方给的路径是否落在工作区字面范围内"，再决定是否值得做
 * canonical 解析。这样工作区内的 junction 逃逸会走到遮蔽判定，
 * 而不是让 relativeTo() 抛异常（#16.6；存在性查询不应以异常表达"不可见"）。
 *
 * @returns 相对路径字符串（根自身为 ''），或 undefined 表示词法上在外部
 */
export function lexicalInside(parent, child) {
  const p = lexical(parent).replace(/[\\/]+$/, '')
  const c = lexical(child)
  if (c.length < p.length) return undefined
  if (c.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return undefined
  const rest = c.slice(p.length)
  if (rest === '') return ''
  if (!rest.startsWith(sep)) return undefined
  return rest.replace(/^[\\/]+/, '')
}

/**
 * child 是否在 parent 之内（含自身）。
 * 两侧都先 canonical()，因此 junction / 符号链接 / 8.3 短名都不能绕过。
 */
export function isInside(parent, child) {
  const p = compareKey(canonical(parent))
  const c = compareKey(canonical(child))
  if (p === c) return true
  // 必须有分隔符边界，避免 C:\ws-evil 被判定为 C:\ws 之内
  const withSep = p.endsWith(sep) ? p : p + sep
  return c.startsWith(withSep)
}

/**
 * 逻辑路径 → 相对路径（用于映射到暂存树）。
 * @throws 当目标在 workspace 之外时 —— fail-closed，不做"尽力而为"
 */
export function relativeTo(workspaceRoot, target) {
  const root = canonical(workspaceRoot)
  const t = canonical(target)
  if (!isInside(root, t)) {
    const error = new Error(`path escapes workspace: ${target}`)
    error.code = 'PATH_OUTSIDE_WORKSPACE'
    error.workspaceRoot = root
    error.target = t
    throw error
  }
  const rel = relative(root, t)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) {
    const error = new Error(`path escapes workspace after relative(): ${target}`)
    error.code = 'PATH_OUTSIDE_WORKSPACE'
    throw error
  }
  return rel.replace(/\//g, sep)
}

/** 相对路径 → 工作区内的绝对路径，并再次校验边界 */
export function absoluteIn(workspaceRoot, relativePath) {
  const root = canonical(workspaceRoot)
  const candidate = resolve(root, relativePath)
  return relativeTo(root, candidate) === '' ? root : candidate
}

/** 路径分段（用于在暂存树里逐级合成父目录，手册 #3.11 / #3.5） */
export function segments(relativePath) {
  return relativePath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
}

/** 稳定排序：不区分大小写，保证 list/diff 输出确定性 */
export function stableSort(paths) {
  return [...paths].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
}

/**
 * 敏感路径硬拒绝清单（手册第 16 章：读取也受授权）。
 * 这是"硬拒绝"层，先于任何可协商的遮蔽（#16.7 硬边界先于可协商项）。
 * 注意：Windows 上没有 /etc/shadow 这类单一目标，泄露面是注册表配置单元、DPAPI、
 * SSH/Git 凭据、浏览器凭据库、DSH 自身会话与凭据。
 *
 * ── 每条规则的必备字段（缺一不得入库）───────────────────────────────────────
 *   `id`       稳定标识；`dsh-plugin\review-service.mjs` 的 danger 清单按 id 逐字引用
 *              （漂移会在模块加载时**硬失败**，不会静默退化成"永不 danger"）
 *   `category` 判据**类别** —— 说明这是"哪一类对象"，而不是"某个已知样本文件名"
 *   `reason`   人可读理由（进审批面 / 错误消息）
 * 另外 `MASK_PROBES` 把每个 id 映射到一条**具体探测候选**；`tests\paths-masks.mjs`
 * 双向校验"规则 ↔ 探针"并实际执行正则，把阶段 A §4.4 的约束 (b)
 * 「没有探针的规则不得入库」变成**断言**，而不是纪律。
 *
 * ── 为什么这不是"黑名单打地鼠"（阶段 A §4.4 的正面回答）────────────────────
 * 每一条都是**对象类**（整棵目录树 / 整个文件名族 / 稳定命名约定），
 * 而不是"某个已泄露样本"。同时必须如实声明：本清单是**检测/兜底**，
 * **不是硬边界** —— 真正的读面硬边界是 T0（AppContainer）；T0 的接线状态、
 * 以及"改名/换扩展名/换目录形状仍能绕过本表"这一事实，见 `docs\T2-T0接线契约.md`
 * 与 `docs\T2-敏感读收敛报告.md`（后者含 `--probe` 的改前/改后实测对照）。
 *
 * ── T2 收敛（第三轮）：三件事，每条都有实测对照 ────────────────────────────────
 *   ① **目录形态**：把历史上以 `\\` 收尾的模式统一改成 `(\\|$)`（S3 同一根因）。
 *      `[实测]` 修复前：`.dsh`（整个 DSH 主目录）、`System32\config`、
 *      `...\PSReadLine`、`...\Edge\...\History`、`Microsoft\Credentials` 的**目录自身**
 *      全部 `mask=(none)`。判据入口收敛到 `maskKey()`（见其注释）。
 *   ② **大小写 / 8.3 短名 / 长路径前缀归一化**：`canonical()` 已覆盖后两者，
 *      `maskKey()` 再补"去尾分隔符 + 统一分隔符"，并有断言用**真实存在的短名路径**
 *      （`C:\Users\ADMINI~1\NTUSER.DAT`）钉死"短名不能绕过"。
 *   ③ **补实测可读的漏项**：NTUSER.DAT、PSReadLine 命令历史、Chromium `History`、
 *      AppData 外 `Network\Cookies`、`.dsh` 的 `settings.yaml.imported` / `web-url.txt`
 *      （后两条本就落在 `dsh-home` 内，本轮补**逐条探针**，不再只靠"被宽规则顺带覆盖"）。
 *
 * ── 不得把"原本可读"说成"被拒"（`[实测]` 事实，务必保持诚实）────────────────
 * `[实测]` 本机：`C:\Users\Administrator\.ssh` **不存在**（不是被拒）；
 * `SAM`/`SECURITY`/`SYSTEM` 与 `System32\config` 存在但 `stat` 即 `EPERM`（拒绝）；
 * `NTUSER.DAT` 可 stat（1048576 B）但读内容 `EBUSY`（被系统占用）；
 * `Edge\...\Network\Cookies` 可 stat（106496 B）但内容 `EBUSY`；
 * `.dsh\{.credentials.yaml,settings.yaml.imported,web-url.txt}`、`hosts`、`.npmrc`、
 * `PSReadLine\ConsoleHost_history.txt`（7950 B）、`Edge\...\{Local State,Login Data,
 * Login Data For Account,History}` **当前确实可读**（残余边界 R1）。
 * 因此下表条目描述的是"**应当**被遮蔽"，而**不是**"已经挡住了"。
 */
export const MASK_CLASSES = [
  // ── 原有 15 条：逐字保留（review-service 的 danger 清单引用它们的 id）────────
  //
  // ⚠ 顺序即优先级（`maskReason()` 返回**第一个**命中项），因此"更具体的规则必须排在更宽的规则之前"。
  //    这条在落地 N 类时被本测试当场抓到三处（全部是"宽规则吃掉窄规则"）：
  //      `dpapi`(宽) 吃掉 `dpapi-user`(窄)、`dsh-home`(宽) 吃掉 `dsh-credentials` / `dsh-profile-deps`。
  // ⚠ S3 修复（[实测] net-sens 阶段 B §5 / 本轮复现）：
  //   `canonical()` 走 `path.normalize`，**去掉结尾分隔符**。因此任何以 `\\` 收尾的模式
  //   都只能命中"该目录**之下**的文件"，命中不到**目录本身**：
  //   实测 `%APPDATA%\Microsoft\Protect` 目录可枚举（entries=2）却 `mask=(none)`。
  //   修法是把尾部 `\\` 改成 `(\\|$)`（"分隔符或结尾"），使目录自身与其后代都能命中。
  //   `probe-dpapi-user-dir` 就是为这条口径加的探针，避免"只有文件探针"时回归悄悄发生。
  { id: 'dpapi-user', category: 'DPAPI 主密钥', pattern: /\\appdata\\roaming\\microsoft\\protect(\\|$)/i, reason: '用户 DPAPI 主密钥（目录本身与其下所有主密钥文件）' },
  { id: 'dpapi', category: 'DPAPI 主密钥', pattern: /\\microsoft\\protect(\\|$)/i, reason: 'DPAPI 主密钥（目录自身与其下所有主密钥文件；T2 修目录形态）' },
  // N4 的两条必须排在 dsh-home 之前，否则永远命中不到
  { id: 'dsh-credentials', category: '本工具自身凭据文件', pattern: /\\\.dsh\\\.credentials\.yaml$/i, reason: 'DSH 凭据文件（明文会话凭据）' },
  { id: 'dsh-profile-deps', category: '本工具 profile 的依赖树（可含第三方插件代码）', pattern: /\\\.dsh\\profiles\\[^\\]+\\node_modules(\\|$)/i, reason: 'DSH profile 依赖树：第三方插件代码及其可能内嵌的令牌' },
  // ── T2 收敛（读取面）：注册表配置单元族 ────────────────────────────────────
  // ① `config` **目录自身**也要命中（旧模式以 `\\` 收尾 ⇒ `[实测]` 目录自身 `mask=(none)`）；
  // ② 用户注册表 `NTUSER.DAT` / `UsrClass.dat` 是本机**可 stat、可枚举**的敏感对象
  //    （`[实测]` 1048576 B，读内容为 EBUSY=被系统占用），旧表**完全没有**规则覆盖它。
  // 归入 `sam`（"注册表配置单元"）而不是新开 id：`sam` 已在 `DANGER_MASK_IDS` 里，
  // 用户注册表与 SAM 同级敏感，走 danger 档（内容在审批面自动省略）才是正确后果。
  {
    id: 'sam',
    category: '注册表配置单元（SAM/SECURITY/SYSTEM 与用户注册表 NTUSER.DAT / UsrClass.dat）',
    pattern: /^[a-z]:\\windows\\system32\\config(\\|$)|\\(ntuser|usrclass)\.dat(\.log[0-9]*)?$/i,
    reason: '注册表配置单元：本地账户数据库 SAM/SECURITY/SYSTEM，以及用户/类注册表 NTUSER.DAT / UsrClass.dat（含其忙碌日志副本）',
  },
  // ⚠ 以下四条在 T2 收敛里由 `\\\.ssh\\` 改成 `(\\|$)`：旧写法命中不到**这些目录自身**
  //    （`canonical()` 去掉结尾分隔符），于是"列目录"这一步漏在外面（S3 同一根因）。
  { id: 'ssh', category: 'SSH 私钥', pattern: /\\\.ssh(\\|$)/i, reason: 'SSH 私钥（目录自身与其下所有文件）' },
  { id: 'aws', category: '云凭据', pattern: /\\\.aws(\\|$)/i, reason: '云凭据（目录自身与其下所有文件）' },
  { id: 'gcloud', category: '云凭据', pattern: /\\\.config\\gcloud(\\|$)/i, reason: '云凭据（目录自身与其下所有文件）' },
  { id: 'kube', category: '集群凭据', pattern: /\\\.kube(\\|$)/i, reason: '集群凭据（目录自身与其下所有文件）' },
  { id: 'git-credentials', category: '明文凭据', pattern: /\\\.git-credentials$/i, reason: 'Git 明文凭据' },
  { id: 'npmrc', category: '包管理器令牌', pattern: /\\\.npmrc$/i, reason: '包管理器令牌' },
  // ⚠ T2 收敛：`\\\.dsh\\` → `(\\|$)`。`[实测]` 修复前 `C:\Users\Administrator\.dsh`
  //    （**整个 DSH 主目录**，13 个条目：sessions/credentials/profile/日志）`mask=(none)`。
  {
    id: 'dsh-home',
    category: '本工具自身凭据/会话',
    pattern: /\\\.dsh(\\|$)/i,
    reason: 'DSH 主目录：会话日志、凭据库、profile 配置（目录自身与其下所有文件）',
  },
  // 同理：`.dshstage` **目录自身**此前也命中不到（S3 同一根因）。unmask 永不解除。
  { id: 'stage-store', category: '本工具自身存储', pattern: /\\\.dshstage(\\|$)/i, reason: '沙箱自身存储（unmask 永不解除；目录自身与其下所有文件）', hard: true },
  { id: 'browser', category: '浏览器凭据库', pattern: /\\appdata\\(local|roaming)\\(google|microsoft\\edge|mozilla)\\.*(login data|cookies|key4\.db|logins\.json)/i, reason: '浏览器凭据库' },
  // ── S5：浏览器凭据库的"位置无关"口径（本轮修复；[实测] 见下）──────────────────
  //
  // 为什么必须新增：既有的 `browser` 规则**硬编码了 `\appdata\...` 前缀**，
  // 于是"浏览器 profile 不在 AppData 下"时**完全不被遮蔽**。
  // `[实测]` 本机 `.t\dsh2\browser\edge-profile{,-headful}\...`（非 AppData，且是标准
  // Chromium profile 形状）：
  //   `edge-profile\Default\Login Data`                  129024 B  可读  mask=(none)
  //   `edge-profile\Default\Login Data For Account`       51200 B  可读  mask=(none)
  //   `edge-profile\Local State`                          25300 B  可读  mask=(none)
  //   `edge-profile-headful\Default\Login Data`          129024 B  可读  mask=(none)
  //   `edge-profile-headful\Default\Login Data For Account` 51200 B 可读  mask=(none)
  //   `edge-profile-headful\Local State`                  74863 B  可读  mask=(none)
  // 判据类别：**文件名族 + 扩展名约定**（不是"某个样本路径"）。
  //   · `Login Data` / `Login Data For Account` / `Web Data` 是 Chromium 的**固定文件名**，
  //     且文件名里带空格 ⇒ 不会误伤源码/夹具里任何常规标识符；
  //   · `Local State` 太普通（很多程序都有同名文件），因此**限定在** `...<profile>\Local State`
  //     这种"上一级目录名以 profile 结尾"的形状（`[^\\]*profile\local state$`）。
  // 诚实声明：这两条仍然是**黑名单**（按命名约定枚举），**不是硬边界** ——
  //   换个文件名（例如把 `Login Data` 复制成 `login.db`）就绕过了；
  //   真正的读面硬边界是 T0（AppContainer），而 T0 目前未生效（阶段 B：子进程不在 AppContainer 里）。
  // ── T2 收敛：把"浏览器 profile 关键库"从"凭据库"扩到**三类**（同为 Chromium 固定文件名）──
  // `[实测]`（本机，`tests\paths-masks.mjs --probe`）修复前：
  //   `...\Edge\User Data\Default\History`            491520 B  readable  mask=(none)
  //   `...\edge-profile\Default\Network\Cookies`                not-present（AppData 外形状）
  //   而 AppData 内的同一批文件早已由更宽的 `browser` 规则命中（`mask=browser`），
  //   所以这里补的是**位置无关**的那一半，而不是重复。
  // 判据类别（逐条都能说出"哪一类对象"）：
  //   · `Login Data[ For Account]` / `Web Data` / `Network\Cookies` —— Chromium **固定文件名**；
  //   · `History` / `Archived History` —— **文件名太普通**，所以额外要求父目录是
  //     Chromium profile 形状（`Default` / `Profile N` / `Guest Profile` / `*profile`），
  //     避免把源码或夹具里任何叫 `History` 的目录一起封死（#16.8 作用域限定）。
  // 诚实声明：这仍然是**黑名单按命名约定枚举**，换个名字（把 `History` 复制成 `h.db`）就绕过；
  //   真实的读面硬边界是 T0（AppContainer），而 T0 的接线状态见 `docs\T2-T0接线契约.md`。
  //
  // ⚠ 为什么不新开一个 `browser-history-db` id（看起来更干净）：`src\audit.mjs::READ_PROBES`
  //   与 `MASK_CLASSES` 之间有**双向覆盖契约**（`tests\audit-parse.mjs` 用
  //   `READ_PROBE_MISSING_MASK_CLASSES` 强制"每个遮蔽类都要有读取探针"），而 `audit.mjs`
  //   不在 T2 的写入边界内。为不把 `verify.cmd` 弄红又不越界，这里把新形状**并入既有类**
  //   并同步改 `category`/`reason` 文字；"单独立类"的补丁写在 `docs\T2-敏感读收敛报告.md`。
  {
    id: 'browser-profile-auth-db',
    category: '浏览器 profile 关键库文件族（凭据库 / 会话 cookie / 浏览历史；位置无关）',
    pattern:
      /\\(login data( for account)?|web data|network\\cookies)(\\|$)|\\(default|profile \d+|guest profile|system profile|[^\\]*profile)\\((archived )?history)(\\|$)/i,
    reason: '浏览器 profile 关键库：Chromium 固定文件名（Login Data / Web Data / Network\\Cookies）与 profile 形状下的 History（不再要求位于 AppData — S5/T2）',
  },
  {
    id: 'browser-profile-state',
    category: '浏览器 profile 状态文件（含加密密钥的本地状态类）',
    pattern: /\\[^\\]*profile\\(local state|login data( for account)?|web data)(\\|$)|\\local state$/i,
    reason: '浏览器 profile 关键状态文件（Local State 内含 DPAPI 保护的加密密钥；S5 修复）',
  },
  { id: 'unattend', category: '无人值守应答文件', pattern: /\\unattend\.xml$/i, reason: '可能含明文口令' },
  { id: 'sysvol-copy', category: 'AD 数据库', pattern: /\\ntds\.dit$/i, reason: 'AD 数据库' },
  { id: 'hosts', category: '网络配置（明文/可篡改）', pattern: /\\windows\\system32\\drivers\\etc\\(hosts|lmhosts)$/i, reason: '主机名映射' },
  // T2：`wlansvc\\` → `wlansvc(\\|$)`（目录自身此前命中不到）
  { id: 'wifi', category: 'Wi-Fi 配置（含明文密钥）', pattern: /\\programdata\\microsoft\\wlansvc(\\|$)/i, reason: 'Wi-Fi 配置含明文密钥（目录自身与其下所有 profile）' },

  // ── N1：凭据存储目录的通用命名 ─────────────────────────────────────────────
  // 类别：CI/云工具把**长期令牌**放在固定命名约定下（约定稳定，名字可枚举）。
  // 探针必须与规则形状一致：初次写成 `%APPDATA%\.config\gh\...`（多插了一层 AppData），
  // 被本测试当场判红——"探针写错"和"规则失效"必须能区分开。
  {
    id: 'cli-cred-dirs',
    category: '云/CI 工具凭据目录（命名约定类）',
    pattern: /\\\.terraform\.d([\\/]|$)|\\\.pulumi([\\/]|$)|\\\.config[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)|\\\.local[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)/i,
    reason: '云/CI 工具的凭据目录（长期令牌以固定命名约定落盘）',
  },
  // ── N2：包管理器令牌文件族 ─────────────────────────────────────────────────
  // 类别：**纯文本长期令牌**这同一类风险；原有表只覆盖 .npmrc 一个。
  // 注意两处（都是本测试当场抓到的真错）：
  //   ① 目录分隔符必须写成 `[\\/]`：`\.nuget\NuGet.Config` 在正则里会被解释成
  //      "转义点 + 字面 n + 任意字符 + NuGet"，于是永远不命中；
  //   ② 叶子名里本来就有点的（`NuGet.Config`）不能加前导 `\.`，否则同样永不命中。
  {
    id: 'pkg-token-files',
    category: '包管理器令牌文件族（明文长期令牌类）',
    pattern:
      /\\(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc|\.netrc|_netrc|\.gem[\\/]credentials|\.nuget[\\/]NuGet\.Config|\.config[\\/]pip[\\/]pip\.conf|\.docker[\\/]config\.json|\.cargo[\\/]credentials(\..*)?|NuGet\.Config)(\\|$)/i,
    reason: '包管理器/CI 以纯文本保存长期令牌（与 .npmrc 同类）',
  },
  // ── N3 / T2：凭据管理器 / DPAPI 输出 + AppData 下的 `*.credentials` 命名类 ────
  // `[实测]`（本机）`%LOCALAPPDATA%\Microsoft\Credentials` 目录**存在且可枚举**（3 条），
  // 修复前靠 `(\\|$)` 已能命中目录自身（与 S3 同一条修法），本轮补一条**目录形态**探针把它锁住。
  // 新增的第二支覆盖"不在 `Microsoft\` 下、但以 `.credentials` 命名"的凭据目录
  // （浏览器/CLI 常见的落盘命名约定）；`[实测]` 本机**不存在**这样的目录，
  // 因此它的探针是**形状探针**（构造出的命名类候选），会在报告里如实标注。
  {
    id: 'cred-vault',
    category: 'Windows 凭据管理器落盘位置 + AppData 下 *.credentials 命名类',
    pattern: /\\appdata\\(local|roaming)\\microsoft\\(credentials|vault)(\\|$)|\\appdata\\(local|roaming)\\[^\\]*\.credentials(\\|$)/i,
    reason: 'Windows 凭据管理器/保管库落盘位置（与 DPAPI 主密钥同类），以及 AppData 下以 *.credentials 命名的凭据目录',
  },
  // ── N5：无人值守/部署应答的族 ─────────────────────────────────────────────
  {
    id: 'unattend-family',
    category: '首次启动应答文件族',
    pattern: /\\(unattend|autounattend)\.xml$|\\sysprep\.(inf|xml)$|\\panther\\[^\\]*\.xml$/i,
    reason: '首次启动/部署应答文件可能含明文口令或产品密钥',
  },
  // ── N6：网络配置族（含明文密钥 / 可能含凭据材料的日志）────────────────────
  {
    id: 'net-config-family',
    category: '网络配置与事件日志',
    pattern: /\\(networks|protocol)$|\\windows\\system32\\winevt\\logs\\[^\\]*\.evtx$|\\windows\\system32\\config\\[^\\]*\.evtx$/i,
    reason: '网络配置文件与事件日志（事故/审计日志可能含凭据材料）',
  },
  // ── N7 / T2：编辑器/IDE 全局状态 + 终端命令历史 ──────────────────────────────
  // `[实测]`（本机）`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine` 目录可枚举（1 条），
  // 其 `ConsoleHost_history.txt` 7950 B **可读**、修复前 `mask=(none)`。
  // 判据刻意选**目录**（`...\psreadline(\\|$)`）而不是文件名：命令历史可以改名/轮转，
  // 而目录名是稳定约定 ⇒ 改名不绕过（这正是"用同一目录形态代替黑名单文件名"的做法）。
  {
    id: 'editor-token-state',
    category: '编辑器/终端全局状态（扩展令牌与命令历史类）',
    pattern:
      /\\appdata\\roaming\\(code|cursor)(\\logs)?\\user\\globalstorage(\\|$)|\\appdata\\roaming\\microsoft\\windows\\powershell\\psreadline(\\|$)/i,
    reason: '编辑器扩展把 PAT/令牌写进 globalStorage；PowerShell PSReadLine 目录保存输入过的命令（常含明文令牌/口令）',
  },
  // ── N8：本机私钥/证书导出（**限定作用域**）───────────────────────────────
  // 限定在 \users\ 与 \programdata\ 之下：避免把源码/测试夹具里的 *.pem 一起封死（#16.8）。
  {
    id: 'private-key-files',
    category: '私钥/证书导出文件（扩展名约定类，限定作用域）',
    pattern: /\\(users|programdata)\\.*\.(pfx|p12|pvk|pem|key)$/i,
    reason: '私钥/证书导出文件（作用域限定在用户与程序数据目录，避免误伤源码夹具）',
  },
  // ── N9：凭据缓存 / SSO cookie（T2：`inetcookies\\` → `inetcookies(\\|$)`，目录自身）──
  {
    id: 'credential-cache',
    category: '凭据缓存与 SSO cookie',
    pattern:
      /\\appdata\\local\\microsoft\\windows\\inetcookies(\\|$)|\\appdata\\roaming\\microsoft\\windows\\cookies(\\|$)|\\appdata\\local\\google\\chrome\\user data\\[^\\]+\\network\\cookies$/i,
    reason: '会话 cookie 可直接复用为凭据（目录自身与其下所有 cookie 库）',
  },
  // ── N10：进程/内存转储（T2：`minidump\\` → `minidump(\\|$)`，目录自身）────────
  {
    id: 'process-dumps',
    category: '进程/内存转储（可能含内存中的令牌）',
    pattern: /\.(dmp|mdmp)$|\\windows\\minidump(\\|$)/i,
    reason: '转储文件可能含进程内存里的令牌/密钥',
  },
]

function envOr(name, fallback) {
  const value = process.env[name]
  return value && value.length > 0 ? value : fallback
}
const USERPROFILE = () => envOr('USERPROFILE', 'C:\\Users\\Default')
const APPDATA = () => envOr('APPDATA', join(USERPROFILE(), 'AppData', 'Roaming'))
const LOCALAPPDATA = () => envOr('LOCALAPPDATA', join(USERPROFILE(), 'AppData', 'Local'))

/**
 * 仓库根（只用于**探针路径**的构造，不参与任何安全判定）。
 *
 * 为什么需要它：S5 的证据来自仓库内的非 AppData 浏览器 profile
 * （`.t\dsh2\browser\edge-profile\…`），它既不在 `%APPDATA%` 下、也不在 `%USERPROFILE%` 下，
 * 用环境变量拼不出来。允许 `DSH_REPO_ROOT` 覆盖（测试/迁移用），默认按本模块位置推导
 * （`<repo>\src\paths.mjs` → `<repo>`）。
 *
 * ⚠ 探针路径**只写不读**是另一回事：本常量只出现在 `MASK_PROBES` 的路径里，
 * 真正"能不能读到"由 `src\audit.mjs` 的沙箱内探针负责（且只记长度 + 前 4 字节哈希）。
 */
const REPO_ROOT = () => envOr('DSH_REPO_ROOT', resolve(dirname(fileURLToPath(import.meta.url)), '..'))

/**
 * 规则 ↔ 探针映射（阶段 A §4.4 约束 (b)：**没有探针的规则不得入库**）。
 *
 * 每条 = 一个具体候选路径；`maskReason()` 对它的返回值必须等于 `maskClass` 指定的 id。
 * `tests\paths-masks.mjs` 会做四件事：
 *   1. 反向：每个 `MASK_CLASSES.id` 都必须在这里有探针（缺一条即失败）；
 *   2. 正向：每个探针都必须**真的**命中它声明的 id（正则真被执行，而不是只写在注释里）；
 *   3. 字段：`category` / `reason` 必须非空；
 *   4. 单调收紧：原有 15 个 id 必须一个不少（新增规则不得让既有规则消失）。
 *
 * 路径由环境变量拼出，因此映射本身在任何机器上都成立；
 * **"是否能真的读到"是另一回事**，由 `src\audit.mjs` 的沙箱内探针负责。
 */
export const MASK_PROBES = [
  // 与 src/audit.mjs 的 READ_PROBES 对齐（同一批目标）
  { id: 'probe-sam-hive', maskClass: 'sam', path: 'C:\\Windows\\System32\\config\\SAM', label: '本地账户数据库 SAM' },
  { id: 'probe-ssh-key', maskClass: 'ssh', path: join(USERPROFILE(), '.ssh', 'id_rsa'), label: 'SSH 私钥' },
  { id: 'probe-git-credentials', maskClass: 'git-credentials', path: join(USERPROFILE(), '.git-credentials'), label: 'Git 明文凭据' },
  { id: 'probe-npmrc', maskClass: 'npmrc', path: join(USERPROFILE(), '.npmrc'), label: 'npm 令牌' },
  { id: 'probe-dsh-home', maskClass: 'dsh-home', path: join(USERPROFILE(), '.dsh', 'sessions'), label: 'DSH 主目录' },
  { id: 'probe-stage-store', maskClass: 'stage-store', path: join(USERPROFILE(), 'ws', '.dshstage', 'manifest.json'), label: '沙箱自身存储' },
  { id: 'probe-hosts', maskClass: 'hosts', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', label: 'hosts' },
  { id: 'probe-unattend', maskClass: 'unattend', path: 'C:\\Windows\\Panther\\Unattend.xml', label: '无人值守应答' },
  { id: 'probe-dpapi-user', maskClass: 'dpapi-user', path: join(APPDATA(), 'Microsoft', 'Protect', 'x'), label: '用户 DPAPI 主密钥' },
  // S3 修复的**专用**探针：目录**本身**（`canonical()` 会去掉结尾分隔符，
  // 因此这条探针才能证明"以 `\\` 收尾的模式命中不到目录自身"这个缺陷已被修掉）。
  // `[实测]` 本机该目录存在且可枚举：`directory(entries=2)`。
  { id: 'probe-dpapi-user-dir', maskClass: 'dpapi-user', path: join(APPDATA(), 'Microsoft', 'Protect'), label: '用户 DPAPI 主密钥目录（S3：目录本身）' },
  { id: 'probe-dpapi-machine', maskClass: 'dpapi', path: 'C:\\Windows\\System32\\Microsoft\\Protect\\S-1-5-18\\x', label: '机器 DPAPI 主密钥' },
  { id: 'probe-browser-logins', maskClass: 'browser', path: join(LOCALAPPDATA(), 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'), label: '浏览器凭据库' },
  // ── S5 的四条探针：非 AppData 的浏览器 profile（[实测] 全部可读、mask=(none)）────
  // 仓库根用 `REPO_ROOT` 环境变量或按本模块位置推导（见下方 REPO_ROOT 常量）。
  // 形状对齐真实证据：`.t\dsh2\browser\edge-profile{,-headful}\…`。
  { id: 'probe-browser-logins-nonappdata', maskClass: 'browser-profile-auth-db', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Login Data'), label: 'AppData 外的浏览器凭据库 Login Data' },
  { id: 'probe-browser-logins-account', maskClass: 'browser-profile-auth-db', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Login Data For Account'), label: 'AppData 外的浏览器凭据库 Login Data For Account' },
  { id: 'probe-browser-localstate', maskClass: 'browser-profile-state', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'edge-profile', 'Local State'), label: 'AppData 外的浏览器 Local State（含加密密钥）' },
  { id: 'probe-browser-localstate-headful', maskClass: 'browser-profile-state', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'edge-profile-headful', 'Local State'), label: 'AppData 外的浏览器 Local State（headful profile）' },
  { id: 'probe-aws', maskClass: 'aws', path: join(USERPROFILE(), '.aws', 'credentials'), label: 'AWS 凭据' },
  { id: 'probe-gcloud', maskClass: 'gcloud', path: join(USERPROFILE(), '.config', 'gcloud', 'credentials.db'), label: 'gcloud 凭据' },
  { id: 'probe-kube', maskClass: 'kube', path: join(USERPROFILE(), '.kube', 'config'), label: 'kubeconfig' },
  { id: 'probe-wifi', maskClass: 'wifi', path: 'C:\\ProgramData\\Microsoft\\WlanSvc\\Profiles.xml', label: 'Wi-Fi 配置' },
  { id: 'probe-ntds', maskClass: 'sysvol-copy', path: 'C:\\Windows\\NTDS\\ntds.dit', label: 'AD 数据库' },

  // N1
  { id: 'probe-gh-config', maskClass: 'cli-cred-dirs', path: join(USERPROFILE(), '.config', 'gh', 'hosts.yml'), label: 'gh CLI 凭据' },
  { id: 'probe-terraform-credentials', maskClass: 'cli-cred-dirs', path: join(USERPROFILE(), '.terraform.d', 'credentials.tfrc.json'), label: 'Terraform 凭据（CLI 配置文件）' },
  { id: 'probe-aws-config-dir', maskClass: 'cli-cred-dirs', path: join(USERPROFILE(), '.config', 'aws', 'config'), label: 'AWS 共享配置目录' },
  // N2
  { id: 'probe-pypirc', maskClass: 'pkg-token-files', path: join(USERPROFILE(), '.pypirc'), label: 'PyPI 令牌' },
  { id: 'probe-netrc', maskClass: 'pkg-token-files', path: join(USERPROFILE(), '_netrc'), label: 'netrc 凭据' },
  { id: 'probe-nuget-config', maskClass: 'pkg-token-files', path: join(APPDATA(), 'NuGet', 'NuGet.Config'), label: 'NuGet 令牌' },
  { id: 'probe-docker-config', maskClass: 'pkg-token-files', path: join(USERPROFILE(), '.docker', 'config.json'), label: 'Docker 注册表令牌' },
  { id: 'probe-cargo-credentials', maskClass: 'pkg-token-files', path: join(USERPROFILE(), '.cargo', 'credentials.toml'), label: 'Cargo 令牌' },
  // N3
  { id: 'probe-cred-manager', maskClass: 'cred-vault', path: join(LOCALAPPDATA(), 'Microsoft', 'Credentials', 'DFBE70A7E5CC19A398EBF1B96859CE5D'), label: '凭据管理器文件' },
  { id: 'probe-vault', maskClass: 'cred-vault', path: join(LOCALAPPDATA(), 'Microsoft', 'Vault', 'Vault.dat'), label: 'Windows 保管库' },
  // N4
  { id: 'probe-dsh-credentials-file', maskClass: 'dsh-credentials', path: join(USERPROFILE(), '.dsh', '.credentials.yaml'), label: 'DSH 凭据文件' },
  { id: 'probe-dsh-profile-deps', maskClass: 'dsh-profile-deps', path: join(USERPROFILE(), '.dsh', 'profiles', 'default', 'node_modules', 'x', 'index.js'), label: 'DSH profile 依赖树' },
  // N5
  { id: 'probe-autounattend', maskClass: 'unattend-family', path: 'C:\\Windows\\Panther\\autounattend.xml', label: 'autounattend' },
  { id: 'probe-sysprep-inf', maskClass: 'unattend-family', path: 'C:\\Windows\\System32\\Sysprep\\sysprep.inf', label: 'sysprep 应答' },
  // N6
  { id: 'probe-networks', maskClass: 'net-config-family', path: 'C:\\Windows\\System32\\drivers\\etc\\networks', label: 'networks 配置' },
  { id: 'probe-evtx', maskClass: 'net-config-family', path: 'C:\\Windows\\System32\\winevt\\Logs\\Security.evtx', label: '安全事件日志' },
  // N7
  { id: 'probe-vscode-globalstorage', maskClass: 'editor-token-state', path: join(APPDATA(), 'Code', 'User', 'globalStorage', 'state.vscdb'), label: 'VS Code 全局状态' },
  // N8
  { id: 'probe-pfx', maskClass: 'private-key-files', path: join(USERPROFILE(), 'certs', 'client.pfx'), label: '私钥导出文件（用户目录）' },
  { id: 'probe-pem', maskClass: 'private-key-files', path: 'C:\\ProgramData\\app\\server.key', label: '私钥导出文件（ProgramData）' },
  // N9
  { id: 'probe-inetcookies', maskClass: 'credential-cache', path: join(LOCALAPPDATA(), 'Microsoft', 'Windows', 'INetCookies', 'x.txt'), label: '系统 cookie 缓存' },
  // Chrome 的 cookie 库**预期由更宽的 `browser` 规则先命中**（宽规则优先是设计，不是缺陷）；
  // 这里如实声明它命中的是 browser，从而同时把"browser 规则确实覆盖 Chrome Network\Cookies"钉死。
  { id: 'probe-chrome-cookies-via-browser', maskClass: 'browser', path: join(LOCALAPPDATA(), 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'), label: 'Chrome cookie 库（由 browser 规则命中）' },
  // N10
  { id: 'probe-dump', maskClass: 'process-dumps', path: join(LOCALAPPDATA(), 'CrashDumps', 'node.exe.1234.dmp'), label: '进程转储' },
  { id: 'probe-minidump', maskClass: 'process-dumps', path: 'C:\\Windows\\Minidump\\x.dmp', label: '系统小转储' },
  // 新增（T2：`minidump` **目录自身**，S3 口径）
  { id: 'probe-minidump-dir', maskClass: 'process-dumps', path: 'C:\\Windows\\Minidump', label: '系统小转储目录（目录自身）' },

  // ═══════════════════════════════════════════════════════════════════════════
  // T2 收敛（读取面）：以下每条都是**实测可读/可枚举**的对象，或**目录自身**形态探针。
  // `[实测]` 原始读数见 `tests\paths-masks.mjs --probe` 与
  // `docs\T2-敏感读收敛报告.md` 的改前/改后对照表。
  // ═══════════════════════════════════════════════════════════════════════════
  // ── DSH 自身产物（由既有 `dsh-credentials` / `dsh-home` 覆盖；这里逐条钉死）──
  { id: 'probe-dsh-settings-imported', maskClass: 'dsh-home', path: join(USERPROFILE(), '.dsh', 'settings.yaml.imported'), label: 'DSH 导入后的设置（[实测] 197 B 可读）' },
  { id: 'probe-dsh-web-url', maskClass: 'dsh-home', path: join(USERPROFILE(), '.dsh', 'web-url.txt'), label: 'DSH Web 入口 URL（[实测] 74 B 可读，可能含带令牌的 URL）' },
  { id: 'probe-dsh-home-dir', maskClass: 'dsh-home', path: join(USERPROFILE(), '.dsh'), label: 'DSH 主目录**自身**（[实测] 13 个条目可枚举；修复前 mask=(none)）' },
  // ── 注册表配置单元（`sam`）──
  { id: 'probe-security-hive', maskClass: 'sam', path: 'C:\\Windows\\System32\\config\\SECURITY', label: 'SECURITY 配置单元（[实测] stat 即 EPERM）' },
  { id: 'probe-system-hive', maskClass: 'sam', path: 'C:\\Windows\\System32\\config\\SYSTEM', label: 'SYSTEM 配置单元（[实测] stat 即 EPERM）' },
  { id: 'probe-config-dir', maskClass: 'sam', path: 'C:\\Windows\\System32\\config', label: 'config 目录**自身**（[实测] 修复前 mask=(none)）' },
  { id: 'probe-ntuser-dat', maskClass: 'sam', path: join(USERPROFILE(), 'NTUSER.DAT'), label: '用户注册表配置单元（[实测] 1048576 B；修复前 mask=(none)）' },
  // 8.3 短名**真实存在**（`C:\Users\Administrator` → `C:\Users\ADMINI~1`）：
  // 这条探针证明"短名写法不能绕过遮蔽"（canonical 解析回长名后仍需命中）。
  { id: 'probe-ntuser-dat-shortname', maskClass: 'sam', path: 'C:\\Users\\ADMINI~1\\NTUSER.DAT', label: '用户注册表配置单元（8.3 短名写法，防绕过）' },
  { id: 'probe-usrclass-dat', maskClass: 'sam', path: join(LOCALAPPDATA(), 'Microsoft', 'Windows', 'UsrClass.dat'), label: '用户类注册表配置单元' },
  // ── 终端命令历史（`editor-token-state`；判据是**目录**，改名不绕过）──
  { id: 'probe-psreadline-history', maskClass: 'editor-token-state', path: join(APPDATA(), 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'), label: 'PSReadLine 命令历史（[实测] 7950 B 可读；修复前 mask=(none)）' },
  { id: 'probe-psreadline-dir', maskClass: 'editor-token-state', path: join(APPDATA(), 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'), label: 'PSReadLine 目录**自身**（改名不绕过；[实测] 1 个条目）' },
  // ── 浏览器 profile 关键库：AppData 形态（`browser` 先命中）+ 非 AppData 形态 ──
  { id: 'probe-edge-localstate', maskClass: 'browser-profile-state', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Local State'), label: 'Edge 本地状态（[实测] 33484 B 可读；含 DPAPI 加密密钥）' },
  { id: 'probe-edge-logins-via-browser', maskClass: 'browser', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data'), label: 'Edge 凭据库（由更宽的 browser 规则命中）' },
  { id: 'probe-edge-logins-account-via-browser', maskClass: 'browser', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Default', 'Login Data For Account'), label: 'Edge 账户凭据库（由 browser 命中）' },
  { id: 'probe-edge-network-cookies-via-browser', maskClass: 'browser', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies'), label: 'Edge 会话 cookie 库（由 browser 命中）' },
  { id: 'probe-edge-history', maskClass: 'browser-profile-auth-db', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Default', 'History'), label: 'Edge 浏览历史（[实测] 491520 B 可读；修复前 mask=(none)）' },
  { id: 'probe-edge-history-archived', maskClass: 'browser-profile-auth-db', path: join(LOCALAPPDATA(), 'Microsoft', 'Edge', 'User Data', 'Default', 'Archived History'), label: 'Edge 归档浏览历史（同族）' },
  // 非 AppData 形态（S5 的原始证据形状）：Network\Cookies 与 History 修复前 mask=(none)
  { id: 'probe-browser-network-cookies-nonappdata', maskClass: 'browser-profile-auth-db', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Network', 'Cookies'), label: 'AppData 外 Chromium 会话 cookie 库' },
  { id: 'probe-browser-history-nonappdata', maskClass: 'browser-profile-auth-db', path: join(REPO_ROOT(), '.t', 'dsh2', 'browser', 'chrome-profile', 'Default', 'History'), label: 'AppData 外 Chromium 浏览历史' },
  // ── 凭据存储的目录形态（`cred-vault`）──
  { id: 'probe-cred-manager-dir', maskClass: 'cred-vault', path: join(LOCALAPPDATA(), 'Microsoft', 'Credentials'), label: '凭据管理器目录**自身**（[实测] 3 个条目可枚举）' },
  // `[实测]` 本机**不存在** `*.credentials` 目录 ⇒ 这是**形状探针**（命名类候选），
  // 在 `docs\T2-敏感读收敛报告.md` 里如实标注"不存在的对象不算被挡住"。
  { id: 'probe-appdata-credentials-class', maskClass: 'cred-vault', path: join(APPDATA(), 'acme.credentials', 'token.bin'), label: 'AppData 下 *.credentials 命名类的凭据目录（形状探针；本机不存在）' },
  // ── 目录自身形态：DPAPI 机器主密钥 / 沙箱自身存储（S3 口径回归）──
  { id: 'probe-dpapi-machine-dir', maskClass: 'dpapi', path: 'C:\\Windows\\System32\\Microsoft\\Protect', label: '机器 DPAPI 主密钥目录**自身**' },
  { id: 'probe-stage-store-dir', maskClass: 'stage-store', path: join(REPO_ROOT(), '.dshstage'), label: '沙箱自身存储目录**自身**（unmask 永不解除）' },
]

/** 沙箱自身存储：unmask 永不解除（手册 16.2 第 8 条 / #16.8） */
export const SELF_MASK_ID = 'stage-store'

/**
 * 遮蔽判定专用的**归一化键**（手册 #16.6：遮蔽前先规范化）。
 *
 * ── 为什么要把这一步显式抽出来（T2 收敛）──────────────────────────────────────
 * 判据原本直接用 `canonical()`，它已经解决了三件事（链接解析、8.3 短名、长路径前缀），
 * 但**没有**解决第 4 件：`canonical()` 内部走 `path.normalize`，会把**结尾分隔符吃掉**。
 * 于是"以 `\\` 收尾的模式"（历史上 `dpapi-user` / `sam` / `dsh-home` / `stage-store`
 * 都是这样写的）只能命中"该目录**之下**的对象"，命中不到**目录自身**。
 * 这不是理论问题：`[实测]`（本机，`tests\paths-masks.mjs --probe`）修复前
 *   · `C:\Users\Administrator\.dsh`              → `mask=(none)`  ← 整个 DSH 目录自身可被枚举
 *   · `C:\Windows\System32\config`               → `mask=(none)`
 *   · `%LOCALAPPDATA%\Microsoft\Edge\...\History`→ `mask=(none)`
 * 都落在"目录/文件自身不被遮蔽"这一形态上（与 S3 的 `Microsoft\Protect` 同一根因）。
 *
 * 因此规则的模式一律写成 `(\\|$)`（"分隔符或结尾"），而本函数是这一口径的**单一入口**：
 *   · `canonical()`：链接 / 8.3 短名（`C:\Users\ADMINI~1` → `C:\Users\Administrator`）/
 *     `\\?\` 长路径前缀 / `.`+`..` 折叠；
 *   · 去结尾分隔符：`C:\ws\.dsh\` 与 `C:\ws\.dsh` 得到**同一个键**（目录自身与子孙同规则）；
 *   · 统一 `\` 分隔符：`C:/ws/.dsh` 与 `C:\ws\.dsh` 得到同一个键。
 *
 * 大小写**不**在这里折叠：`canonical()` 对**存在**的对象回的是磁盘真实大小写，
 * 对不存在的对象保留调用方写法；两种都由各规则自带的 `/i` 覆盖（并另有断言钉死）。
 * 盘符大小写已由 `lexical()` 统一（`c:` → `C:`）。
 */
export function maskKey(anyPath) {
  const c = canonical(anyPath)
  // 只对"盘符 + 分隔符"以上的长度去尾（`C:\` 这类根本身保留原样）
  const stripped = c.length > 3 ? c.replace(/[\\/]+$/, '') : c
  return stripped.replace(/\//g, sep)
}

export function maskReason(anyPath, extraMasks = []) {
  const p = maskKey(anyPath)
  for (const rule of extraMasks) {
    if (rule.pattern.test(p)) return { id: rule.id || 'custom', reason: rule.reason || 'custom mask', hard: rule.hard !== false }
  }
  for (const rule of MASK_CLASSES) {
    if (rule.pattern.test(p)) return { id: rule.id, reason: rule.reason, hard: true }
  }
  return undefined
}

export function isMasked(anyPath, extraMasks = []) {
  return maskReason(anyPath, extraMasks) !== undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// 机器可读导出（task-10）：把同一份遮蔽表交给 shim（进程级读遮蔽）
// ═══════════════════════════════════════════════════════════════════════════
//
// ── 为什么必须是"导出"而不是"再写一份"（这是本节唯一的存在理由）──────────────
// shim 在每个 shell 子进程里 hook `CreateFileW` 那一条链，它需要**数据**，不需要第二套
// 判据实现。历史上这个项目最有杀伤力的缺陷形态就是"同一件事两套实现"：
//   · `paths.mjs` 的 `sam` 规则与 `audit.mjs` 的读取探针各自演化；
//   · `workspace.mjs` 的重解析点判据凭记忆写成 `mode & 0x400`（task-7：从未生效）。
// 因此这里导出的**不是**"等价物"，而是同一份 `MASK_CLASSES` 的**投影**：
//   · `entries[i]` 与 `MASK_CLASSES[i]` **同序、同 id、同 pattern 源串、同 flags**；
//   · 归一化语义由 `maskKey()` 一处提供（本导出只**声明**这个契约，不重写它）；
//   · 另附 `MASK_PROBES` 作为**可自检样本**：shim 实现完匹配后，必须对每条探针复现出
//     它声明的 `maskClass`（`tests\paths-masks.mjs` 已逐条断言内部一致）。
// 谁要是改了 `MASK_CLASSES` 却忘了同步 shim，探针自检就会红 —— 漂移**在测试里可见**。

/** 规则的"命中形状"标签（**提示性**字段；判据权威仍是 `pattern` 正则） */
function maskEntryKind(pattern) {
  if (pattern.source.includes('(\\\\|$)')) return 'dir' // 同时命中目录自身与其后代
  if (pattern.source.endsWith('$')) return 'file'
  return 'glob'
}

/**
 * 导出机器可读的遮蔽清单（纯函数，无副作用）。
 *
 * 契约（`schema: winstage.mask.v1`）：
 *   `entries[]` 字段：`{ id, kind: 'file'|'dir'|'glob', pattern, flags, matchMode, reason, category }`
 *   `probes[]`  字段：`{ id, path, maskClass }`（**自检样本**：实现必须复现 maskClass）
 *   `normalizer`：归一化步骤与入口名（唯一来源 `maskKey()`）
 *
 * ⚠ 消费方（shim）必须**先归一化再匹配**：`maskKey()` 语义 = `realpathSync.native`
 * （解析 symlink/junction、8.3 短名、`\\?\` 长路径前缀、`.`/`..`）+ 去结尾分隔符 +
 * 统一 `\` 分隔符；匹配时按 `flags` 里的 `i` 做大小写不敏感。
 * ⚠ 这与工具面一样是**黑名单**：未列出的敏感对象仍可读；只覆盖被 hook 的打开路径。
 */
export function exportMaskList() {
  return {
    schema: 'winstage.mask.v1',
    source: 'src/paths.mjs',
    generatedAt: new Date().toISOString(),
    counts: {
      rules: MASK_CLASSES.length,
      probes: MASK_PROBES.length,
      selfMaskId: SELF_MASK_ID,
    },
    normalizer: {
      name: 'maskKey',
      steps: [
        'canonical(): realpathSync.native — 解析 symlink/junction、8.3 短名、\\\\?\\ 长路径前缀、. 与 ..',
        'strip-trailing-separator（目录自身与“目录\\”得到同一个键）',
        'unify-separator：/ → \\',
        '盘符大小写统一由 lexical() 完成；其余大小写由各规则的 i 标志覆盖',
      ],
      // 消费方**必须**用同一语义；这里给出一条判据，便于跨语言实现自检
      invariant: 'maskKey(directory) === maskKey(directory + "\\\\")，且短名/长名写法得到同一个键',
    },
    matchModeDefault: 'casefold-regex',
    entries: MASK_CLASSES.map((rule) => ({
      id: rule.id,
      kind: maskEntryKind(rule.pattern),
      pattern: rule.pattern.source,
      flags: rule.pattern.flags,
      matchMode: 'casefold',
      category: rule.category,
      reason: rule.reason,
    })),
    probes: MASK_PROBES.map((probe) => ({ id: probe.id, path: probe.path, maskClass: probe.maskClass ?? null })),
  }
}

/** 序列化（`pretty=false` 用于喂 shim；默认 pretty 便于人读与 diff） */
export function exportMaskJson(options = {}) {
  return JSON.stringify(exportMaskList(), null, options.pretty === false ? 0 : 2)
}

/**
 * 单独运行本模块时的 CLI：`node src/paths.mjs --export-mask <out.json|->`
 *
 * 为什么把入口放在模块里：`src/cli.mjs` 不在 T2 的写入边界内，而"导出"这件事必须
 * 与 `MASK_CLASSES` **同文件同版本**才有意义（跨文件导出就是漂移的入口）。
 * 用 `import.meta.url === pathToFileURL(argv[1])` 判定"是否被当作主模块运行"，
 * 因此 `import './paths.mjs'` 不会执行任何副作用。
 */
const runAsMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (runAsMain) {
  const argv = process.argv.slice(2)
  const flagIndex = argv.findIndex((value) => value === '--export-mask' || value.startsWith('--export-mask='))
  if (flagIndex === -1) {
    process.stderr.write(
      'usage: node src/paths.mjs --export-mask <out.json|->\n' +
        '       (导出 winstage.mask.v1 遮蔽清单供 shim 消费；`-` 表示写 stdout)\n',
    )
    process.exit(2)
  }
  const inline = argv[flagIndex].startsWith('--export-mask=') ? argv[flagIndex].slice('--export-mask='.length) : undefined
  const target = inline ?? argv[flagIndex + 1]
  if (target === undefined || target === '' || target.startsWith('--')) {
    process.stderr.write('paths.mjs --export-mask: 缺少输出路径（用 `-` 表示 stdout）\n')
    process.exit(2)
  }
  const payload = `${exportMaskJson()}\n`
  if (target === '-') {
    process.stdout.write(payload)
  } else {
    writeFileSync(target, payload)
    process.stderr.write(`mask export → ${target}（${MASK_CLASSES.length} 条规则）\n`)
  }
  process.exit(0)
}
