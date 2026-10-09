/**
 * audit-report —— 把 shim 的结构化审计（`WINSTAGE_AUDIT_LOG`，JSONL）聚合、分类成
 * 一份可呈现的报告：AI 在沙箱内**读了/改了/删了哪些文件**、**读了/改了哪些注册表键**。
 *
 * 数据来源（Method A，主线）：`dsh-plugin/shell-executor.mjs` 经执行器自动设置
 * `WINSTAGE_AUDIT_LOG`，shim（`shim/src/ws_util.c::ws_audit`）运行期钩住整条进程树的
 * 文件/注册表 API，逐操作写一行 JSONL。
 *
 * 本模块是**纯函数层**（无 fs、无 Win32），因此任何会话都能离线验证；CLI 包装在
 * `tools/sandbox-audit.mjs`，宿主侧接线在 `dsh-plugin/shell-executor.mjs`。
 */

/** 每一行的前缀：`[winstage-audit][<pid>][<tid>] <json>`。 */
export const AUDIT_PREFIX = /^\[winstage-audit\]\[\d+\]\[\d+\]\s*/

/**
 * 纯函数：把一批审计原始行聚合成分类统计。
 * @param {string[]} lines 原始 JSONL 行（可带 shim 前缀）
 * @param {{root?: string}} [opts] root = 工作区根，用于 workspace/outside 分类
 */
export function aggregateAudit(lines, opts = {}) {
  const root = opts.root
  const rootNorm = typeof root === 'string' && root.length > 0 ? root.replace(/[\\/]+$/, '').toLowerCase() : null
  const scopeOf = (p) =>
    rootNorm !== null && typeof p === 'string' && p.toLowerCase().startsWith(rootNorm) ? 'workspace' : 'outside'

  const files = { read: new Map(), written: new Map(), deleted: new Map(), moved: [] }
  const registry = { read: new Map(), written: new Map() }
  let parsed = 0
  let malformed = 0
  const malformedSamples = []

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)

  for (const raw of lines) {
    if (raw.length === 0) continue
    const body = AUDIT_PREFIX.test(raw) ? raw.replace(AUDIT_PREFIX, '') : raw
    let e
    try {
      e = JSON.parse(body)
    } catch {
      malformed += 1
      if (malformedSamples.length < 5) malformedSamples.push(raw.slice(0, 120))
      continue
    }
    parsed += 1
    switch (e.op) {
      case 'file.open':
        bump(e.mode === 'write' ? files.written : files.read, e.path)
        break
      case 'file.delete':
        bump(files.deleted, e.path)
        break
      case 'file.move':
        files.moved.push({ from: e.from, to: e.to })
        break
      case 'reg.open':
      case 'reg.query':
        bump(registry.read, e.value ? `${e.key}#${e.value}` : e.key)
        break
      case 'reg.create':
      case 'reg.set':
      case 'reg.deleteKey':
      case 'reg.deleteValue':
        bump(registry.written, e.value ? `${e.key}#${e.value}` : e.key)
        break
      default:
        break
    }
  }

  const toArr = (map) =>
    [...map.entries()].map(([path, count]) => ({ path, count, scope: scopeOf(path) })).sort((a, b) => a.path.localeCompare(b.path))
  const toArrReg = (map) => [...map.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path))
  const countScope = (arr, scope) => arr.filter((e) => e.scope === scope).length

  const writtenArr = toArr(files.written)
  const deletedArr = toArr(files.deleted)
  return {
    files: {
      read: toArr(files.read),
      written: writtenArr,
      deleted: deletedArr,
      moved: files.moved.map((m) => ({ ...m, scope: scopeOf(m.to) })),
    },
    registry: { read: toArrReg(registry.read), written: toArrReg(registry.written) },
    counts: { parsed, malformed, malformedSamples },
    summary: {
      filesRead: files.read.size,
      filesWritten: files.written.size,
      filesDeleted: files.deleted.size,
      filesMoved: files.moved.length,
      registryRead: registry.read.size,
      registryWritten: registry.written.size,
      filesWrittenInWorkspace: countScope(writtenArr, 'workspace'),
      filesWrittenOutside: countScope(writtenArr, 'outside'),
      filesDeletedInWorkspace: countScope(deletedArr, 'workspace'),
    },
  }
}

/**
 * 组装最终报告形状（CLI 与宿主侧共用同一份，保证"面板看到的" == "CLI 看到的"）。
 * @param {string[]} lines
 * @param {{root?: string, audits?: string[], generatedAt?: string}} [opts]
 */
export function buildAuditReport(lines, opts = {}) {
  const agg = aggregateAudit(lines, { root: opts.root })
  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    root: opts.root ?? null,
    source: {
      audits: opts.audits ?? [],
      lines: lines.length,
      parsed: agg.counts.parsed,
      malformed: agg.counts.malformed,
      malformedSamples: agg.counts.malformedSamples,
    },
    files: agg.files,
    registry: agg.registry,
    summary: agg.summary,
  }
}

/** 面向"人工侧一句话"的摘要（绝不进模型通道）。 */
export function summarizeAudit(summary) {
  if (!summary) return '审计：无'
  return (
    `审计：文件 读${summary.filesRead} 写${summary.filesWritten}` +
    `（工作区内${summary.filesWrittenInWorkspace}/外${summary.filesWrittenOutside}）` +
    ` 删${summary.filesDeleted}；注册表 读${summary.registryRead} 写${summary.registryWritten}`
  )
}
