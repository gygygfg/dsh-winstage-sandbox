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

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * **不是硬边界** —— 真正的读面硬边界是 T0（AppContainer），而 T0 目前 fail-closed。
 *
 * ── 不得把"原本可读"说成"被拒"（`[实测]` 事实，务必保持诚实）────────────────
 * `[实测]` 本机：`C:\Users\Administrator\.ssh` **不存在**（不是被拒）；
 * `SAM`/`SYSTEM` 存在但 `stat` 即 EPERM；`.npmrc` / `hosts` / `Unattend.xml`
 * 当前**可读**（残余边界 R1）。因此下表条目描述的是"**应当**被遮蔽"，
 * 而**不是**"已经挡住了"——真实读数由 `src\audit.mjs` 的沙箱内探针给出。
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
  { id: 'dpapi', category: 'DPAPI 主密钥', pattern: /\\microsoft\\protect\\/i, reason: 'DPAPI 主密钥' },
  // N4 的两条必须排在 dsh-home 之前，否则永远命中不到
  { id: 'dsh-credentials', category: '本工具自身凭据文件', pattern: /\\\.dsh\\\.credentials\.yaml$/i, reason: 'DSH 凭据文件（明文会话凭据）' },
  { id: 'dsh-profile-deps', category: '本工具 profile 的依赖树（可含第三方插件代码）', pattern: /\\\.dsh\\profiles\\[^\\]+\\node_modules(\\|$)/i, reason: 'DSH profile 依赖树：第三方插件代码及其可能内嵌的令牌' },
  { id: 'sam', category: '注册表配置单元', pattern: /^[a-z]:\\windows\\system32\\config\\/i, reason: '本地账户数据库 (SAM/SECURITY/SYSTEM)' },
  { id: 'ssh', category: 'SSH 私钥', pattern: /\\\.ssh\\/i, reason: 'SSH 私钥' },
  { id: 'aws', category: '云凭据', pattern: /\\\.aws\\/i, reason: '云凭据' },
  { id: 'gcloud', category: '云凭据', pattern: /\\\.config\\gcloud\\/i, reason: '云凭据' },
  { id: 'kube', category: '集群凭据', pattern: /\\\.kube\\/i, reason: '集群凭据' },
  { id: 'git-credentials', category: '明文凭据', pattern: /\\\.git-credentials$/i, reason: 'Git 明文凭据' },
  { id: 'npmrc', category: '包管理器令牌', pattern: /\\\.npmrc$/i, reason: '包管理器令牌' },
  { id: 'dsh-home', category: '本工具自身凭据/会话', pattern: /\\\.dsh\\/i, reason: 'DSH 主目录：会话日志、凭据库、profile 配置' },
  { id: 'stage-store', category: '本工具自身存储', pattern: /\\\.dshstage\\/i, reason: '沙箱自身存储（unmask 永不解除）', hard: true },
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
  {
    id: 'browser-profile-auth-db',
    category: '浏览器凭据库文件名族（位置无关；Chromium 固定文件名类）',
    pattern: /\\(login data( for account)?|web data)(\\|$)/i,
    reason: '浏览器凭据库（Chromium 固定文件名族；不再要求位于 AppData — S5 修复）',
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
  { id: 'wifi', category: 'Wi-Fi 配置（含明文密钥）', pattern: /\\programdata\\microsoft\\wlansvc\\/i, reason: 'Wi-Fi 配置含明文密钥' },

  // ── N1：凭据存储目录的通用命名 ─────────────────────────────────────────────
  // 类别：CI/云工具把**长期令牌**放在固定命名约定下（约定稳定，名字可枚举）。
  // 探针必须与规则形状一致：初次写成 `%APPDATA%\.config\gh\...`（多插了一层 AppData），
  // 被本测试当场判红——"探针写错"和"规则失效"必须能区分开。
  {
    id: 'cli-cred-dirs',
    category: '云/CI 工具凭据目录（命名约定类）',
    pattern: /\\\.terraform\.d[\\/]|\\\.pulumi[\\/]|\\\.config[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)|\\\.local[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)/i,
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
  // ── N3：凭据管理器 / DPAPI 的输出 ──────────────────────────────────────────
  {
    id: 'cred-vault',
    category: 'Windows 凭据管理器落盘位置',
    pattern: /\\appdata\\(local|roaming)\\microsoft\\(credentials|vault)(\\|$)/i,
    reason: 'Windows 凭据管理器/保管库落盘位置（与 DPAPI 主密钥同类）',
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
  // ── N7：编辑器/IDE 的令牌状态 ─────────────────────────────────────────────
  {
    id: 'editor-token-state',
    category: '编辑器/IDE 全局状态（扩展令牌类）',
    pattern: /\\appdata\\roaming\\(code|cursor)(\\logs)?\\user\\globalstorage(\\|$)/i,
    reason: '编辑器扩展把 PAT/令牌写进 globalStorage',
  },
  // ── N8：本机私钥/证书导出（**限定作用域**）───────────────────────────────
  // 限定在 \users\ 与 \programdata\ 之下：避免把源码/测试夹具里的 *.pem 一起封死（#16.8）。
  {
    id: 'private-key-files',
    category: '私钥/证书导出文件（扩展名约定类，限定作用域）',
    pattern: /\\(users|programdata)\\.*\.(pfx|p12|pvk|pem|key)$/i,
    reason: '私钥/证书导出文件（作用域限定在用户与程序数据目录，避免误伤源码夹具）',
  },
  // ── N9：凭据缓存 / SSO cookie ────────────────────────────────────────────
  {
    id: 'credential-cache',
    category: '凭据缓存与 SSO cookie',
    pattern:
      /\\appdata\\local\\microsoft\\windows\\inetcookies\\|\\appdata\\roaming\\microsoft\\windows\\cookies\\|\\appdata\\local\\google\\chrome\\user data\\[^\\]+\\network\\cookies$/i,
    reason: '会话 cookie 可直接复用为凭据',
  },
  // ── N10：进程/内存转储 ───────────────────────────────────────────────────
  {
    id: 'process-dumps',
    category: '进程/内存转储（可能含内存中的令牌）',
    pattern: /\.(dmp|mdmp)$|\\windows\\minidump\\/i,
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
]

/** 沙箱自身存储：unmask 永不解除（手册 16.2 第 8 条 / #16.8） */
export const SELF_MASK_ID = 'stage-store'

export function maskReason(anyPath, extraMasks = []) {
  const p = canonical(anyPath)
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
