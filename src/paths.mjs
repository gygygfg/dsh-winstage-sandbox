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
 */
export const MASK_CLASSES = [
  { id: 'sam', pattern: /^[a-z]:\\windows\\system32\\config\\(\?!.*\.log$)/i, reason: '本地账户数据库 (SAM/SECURITY/SYSTEM)' },
  { id: 'dpapi', pattern: /\\microsoft\\protect\\/i, reason: 'DPAPI 主密钥' },
  { id: 'dpapi-user', pattern: /\\appdata\\roaming\\microsoft\\protect\\/i, reason: '用户 DPAPI 主密钥' },
  { id: 'ssh', pattern: /\\\.ssh\\/i, reason: 'SSH 私钥' },
  { id: 'aws', pattern: /\\\.aws\\/i, reason: '云凭据' },
  { id: 'gcloud', pattern: /\\\.config\\gcloud\\/i, reason: '云凭据' },
  { id: 'kube', pattern: /\\\.kube\\/i, reason: '集群凭据' },
  { id: 'git-credentials', pattern: /\\\.git-credentials$/i, reason: 'Git 明文凭据' },
  { id: 'npmrc', pattern: /\\\.npmrc$/i, reason: '包管理器令牌' },
  { id: 'dsh-home', pattern: /\\\.dsh\\/i, reason: 'DSH 主目录：会话日志、凭据库、profile 配置' },
  { id: 'stage-store', pattern: /\\\.dshstage\\/i, reason: '沙箱自身存储（unmask 永不解除）', hard: true },
  { id: 'browser', pattern: /\\appdata\\(local|roaming)\\(google|microsoft\\edge|mozilla)\\.*(login data|cookies|key4\.db|logins\.json)/i, reason: '浏览器凭据库' },
  { id: 'unattend', pattern: /\\unattend\.xml$/i, reason: '可能含明文口令' },
  { id: 'sysvol-copy', pattern: /\\ntds\.dit$/i, reason: 'AD 数据库' },
  { id: 'hosts', pattern: /\\windows\\system32\\drivers\\etc\\(hosts|lmhosts)$/i, reason: '主机名映射' },
  { id: 'wifi', pattern: /\\programdata\\microsoft\\wlansvc\\/i, reason: 'Wi-Fi 配置含明文密钥' },
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
