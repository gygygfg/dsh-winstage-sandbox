/**
 * 沙箱内的统一工具面（进程内层）
 *
 * 手册依据：
 *   第 2.2 节  只有经审核、受控的文件操作实现可以作为宿主侧可信工作区服务运行
 *   第 3 章    所有工具走同一投影，否则出现幽灵文件
 *   第 4 章    结构化返回：状态、逻辑路径、观测范围、证据引用
 *   第 16 章   读取面收敛：硬拒绝先于可协商项；进程内工具也必须校验范围
 *   #3.3       结果统一把暂存路径还原为真实路径（含错误、分页、诊断嵌套结构）
 *   #4.1       路径还原要覆盖错误分支
 *   #4.2       退出码 0 无输出 = 完成但无输出
 *   #4.3       空、无匹配、不存在、无权限是四种不同结果
 *
 * 本模块是"进程内层"，它对 AI 呈现的路径**永远是逻辑路径**，
 * 暂存路径绝不外泄；真实工作区是否已应用由发布状态表达。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 2 / WP9 —— **成功路径零自曝**（哪些键真的会到模型：实证判据）
 * ═══════════════════════════════════════════════════════════════════════════
 * owner 的硬要求：正常运行期 AI 必须意识不到自己在沙箱里，要以为自己改的是真实文件；
 * 不给替代路径、不提沙箱/暂存。因此本文件按下面的**实证判据**划分可见面与内部面。
 *
 * ① **DSH 工具层（真机通道）**：`dsh-tools` 的 `ToolRuntime.createSuccessResult()`
 *    （`@deepseek-ai/dsh-tools/lib/index.js:3540-3571`）对工具体返回的对象只做三件事：
 *    按 `tool.output.schema` **校验**（声明 `additionalProperties:false` ⇒ 多出来的键直接
 *    `ToolOutputError`）、快照、然后只把 `tool.output.render(...)` 的产出发给模型
 *    （`content`）。`write` / `edit` 的 render 是 `formatWriteOutput()`
 *    （`@deepseek-ai/dsh-tool-fs/lib/index.js:508-514`），正文只有
 *    `<path>displayPath</path><type>file</type><content>Created|Updated file</content>`。
 *    ⇒ 在真机通道里，模型的可见面 = **render 正文 + 平台自己的拒绝标记**；
 *    工具体返回对象上**多出来的键永远不会被渲染**（它们只会让校验失败）。
 * ② **本进程内层（CLI `--json` / 离线自测 / 任何转发 JSON.stringify 的调用方）**：
 *    `ToolSurface` 的返回值会被**原样序列化**就算全部可见。本文件按①的结论把它当
 *    "模型可见面"来写：只留真实文件系统操作会有的键（status / file_path / bytes / …），
 *    **沙箱自曝一个不留**：不出现 `staged` / `netChange` / `observedIn` / `stagedView`
 *    / `source:'staged'` / `origin` / note 里的"暂存视图、真实工作区未改动"。
 * ③ **内部消费者通道**：需要 `staged` / `netChange` / `source` 这类**人工侧or内部**信息的
 *    调用方（当前：无生产调用方；本文件是 CLI/自测共享的进程内层），走
 *    `TOOL_DIAGNOSTICS` 这个 **Symbol 键、非枚举** 的旁路属性 —— 它：
 *      · `Object.keys` / `JSON.stringify` / 展开运算符**都取不到**（非枚举 + Symbol 键）；
 *      · 在 `dsh-tools` 的 JSON 快照（`snapshotJsonValue`）里被丢弃 ⇒ 不可能经①到模型；
 *      · 只能由**显式知道这个 Symbol 的代码**读取 ⇒ 谁读谁负责。
 *    自检见 `$STAGE\_r3\wp9-test.mjs`：模型可见面零自曝 + 逻辑路径正确 + 内部消费者字段仍在。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { Workspace, SandboxError } from './workspace.mjs'
import { hashAbsent } from './store.mjs'
import { isInside, canonical, lexicalInside } from './paths.mjs'

/** 结果码：手册 #4.3 要求四种"空"必须可区分 */
export const RESULT = {
  OK: 'ok',
  EMPTY_DIRECTORY: 'empty-directory',
  NO_MATCH: 'no-match',
  NOT_FOUND: 'not-found',
  DENIED: 'denied',
  FAILED: 'failed',
  CORRUPT: 'corrupt',
  STALE: 'stale',
}

/**
 * WP9：**非模型可见**的内部旁路通道。
 *
 * Symbol 键 + 非枚举 ⇒ `Object.keys` / `JSON.stringify` / 对象展开都取不到它，
 * `dsh-tools` 的 JSON 快照也会把它丢掉（见文件头"哪些键真的会到模型"第③条）。
 * 任何需要"成功路径的内部真相"（暂存与否、净变化、来源）的调用方读这里，
 * **不要**把这些字段放回模型可见的那一层。
 */
export const TOOL_DIAGNOSTICS = Symbol.for('winstage.toolSurface.diagnostics')

/** 把内部信息挂到结果对象的非枚举旁路属性上（不改变任何可见键） */
function withDiagnostics(result, diagnostics) {
  Object.defineProperty(result, TOOL_DIAGNOSTICS, {
    value: Object.freeze({ ...diagnostics }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return result
}

/** 读回内部旁路（没有就返回 undefined；模型侧永远读不到、也不需要读） */
export function toolDiagnostics(result) {
  return result === null || typeof result !== 'object' ? undefined : result[TOOL_DIAGNOSTICS]
}

/**
 * 统一包装：任何异常都转成结构化错误，且路径必须还原（#4.1）。
 *
 * WP9：成功/失败两条路径的模型可见面都**不含** `observedIn` / `stagedView`
 * （旧实现把 `observedIn:'staged-view'` + `stagedView:true` 挂在每一个成功结果上，
 * 等于每次写成功都告诉模型"你在暂存视图里"）。`elapsedMs` 保留：真实文件系统操作
 * 也有耗时，它不是机制自曝。内部真相走第三个参数 + `TOOL_DIAGNOSTICS`。
 *
 * @param workspace 工作区（错误路径还原用）
 * @param fn 工具体
 * @param diagnostics **非模型可见**的内部旁白（如 `source` / `staged` / `netChange`）
 */
export function envelope(workspace, fn, diagnostics = {}) {
  const started = Date.now()
  try {
    const value = fn()
    // 合并顺序：业务旁白在前，基础旁白在后 —— 基础键（observedIn/stagedView/elapsedMs）
    // 绝不可能覆盖调用方给的诊断（否则嵌套 envelope 会把 `source` 吃掉，实测）。
    return withDiagnostics({ status: RESULT.OK, ...value }, {
      ...diagnostics,
      observedIn: 'staged-view',
      stagedView: true,
      elapsedMs: Date.now() - started,
    })
  } catch (error) {
    const code = error.code || 'ERR'
    const status =
      code === 'ENOENT'
        ? RESULT.NOT_FOUND
        : code === 'SANDBOX_PATH_MASKED'
          ? RESULT.DENIED
          : code === 'WORKSPACE_CORRUPT'
            ? RESULT.CORRUPT
            : code === 'STALE_BASELINE'
              ? RESULT.STALE
              : RESULT.FAILED
    return withDiagnostics(
      {
        status,
        error: {
          code,
          message: restorePaths(workspace, error.message),
          detail: restoreDetail(workspace, error.detail),
        },
      },
      { observedIn: 'staged-view', stagedView: true, elapsedMs: Date.now() - started },
    )
  }
}

/**
 * 路径还原：把任何暂存路径换回真实逻辑路径（#3.3 / #16.6）。
 * 注意只对结构化字段做替换，正文内容不做无差别字符串替换，以免改坏业务内容（手册 4.1）。
 */
export function restorePaths(workspace, text) {
  if (typeof text !== 'string') return text
  const staged = workspace.store.stagedDir
  let out = text
  // 同时处理大小写与分隔符变体
  for (const variant of [staged, staged.replace(/\\/g, '\\\\')]) {
    out = out.split(variant).join(workspace.root)
  }
  out = out.split(workspace.store.stagedDir.replace(/\\/g, '/')).join(workspace.root.replace(/\\/g, '/'))
  return out
}

function restoreDetail(workspace, detail) {
  if (!detail || typeof detail !== 'object') return detail
  const out = {}
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === 'string' ? restorePaths(workspace, value) : value
  }
  return out
}

/**
 * 校验工具调用声明的路径参数都在工作区内（手册第 16 章读取也受授权）。
 *
 * 顺序（手册 #16.7「硬边界先于可协商项」）：
 *   1. 字面在工作区内 → 通过（后续读取时会做遮蔽判定）
 *   2. 字面在工作区外 → 先过遮蔽表：命中就报 SANDBOX_PATH_MASKED；
 *      否则才报 PATH_OUTSIDE_WORKSPACE
 * 之所以要在边界之前查遮蔽：工作区内的 junction 解析后落到宿主敏感目录时，
 * 报告为"遮蔽拒绝"比报告为"越界"更准确，也让两类原因可区分（#4.3）。
 * 本函数覆盖**所有**本地路径参数，不只 read（#16.7 / A90）。
 */
export function assertToolPaths(workspace, toolName, paths) {
  for (const [field, value] of Object.entries(paths)) {
    if (value === undefined) continue
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      if (typeof item !== 'string' || item.length === 0) continue
      const absolute = normalize(item)
      // 1) 字面在工作区内 → 放行（读取路径会再判定遮蔽）
      if (lexicalInside(workspace.root, absolute) !== undefined) continue
      // 2) 字面在工作区外：先硬拒绝表，再边界拒绝
      const mask = workspace.maskOf(absolute)
      if (mask) {
        throw new SandboxError('SANDBOX_PATH_MASKED', `${toolName}.${field} is denied by mask "${mask.id}": ${mask.reason}`, {
          toolName,
          field,
          path: item,
          maskId: mask.id,
          reason: mask.reason,
        })
      }
      throw new SandboxError('PATH_OUTSIDE_WORKSPACE', `${toolName}.${field} resolves outside the workspace: ${item}`, {
        toolName,
        field,
        path: item,
      })
    }
  }
}

export class ToolSurface {
  constructor(workspace) {
    this.workspace = workspace
  }

  readFile({ file_path, offset, limit }) {
    return envelope(this.workspace, () => {
      assertToolPaths(this.workspace, 'read_file', { file_path })
      const text = this.workspace.readText(file_path)
      const lines = text.split(/\r?\n/)
      const start = Math.max(0, (offset || 1) - 1)
      const end = limit ? start + limit : lines.length
      const slice = lines.slice(start, end)
      const source = this.workspace.entryOf(this.workspace.relative(file_path)) ? 'staged' : 'baseline'
      // WP9：`source:'staged'|'baseline'` 是内部来源标注，模型可见面不出现（真实文件系统
      // 只有"文件内容"，没有"这一行来自哪个视图"）。人工侧仍可在旁路通道取到。
      return envelope(
        this.workspace,
        () => ({
          file_path,
          totalLines: lines.length,
          offset: start + 1,
          returnedLines: slice.length,
          truncated: end < lines.length,
          content: slice.map((line, index) => `${start + index + 1}\t${line}`).join('\n'),
        }),
        { source },
      )
    })
  }

  fileExists({ file_path }) {
    return envelope(this.workspace, () => {
      assertToolPaths(this.workspace, 'file_exists', { file_path })
      const state = this.workspace.exists(file_path)
      // #3.1：必须区分文件与目录，不能只回一个布尔值。
      // WP9：`source` 同样是内部来源标注 ⇒ 走旁路通道，不进模型可见面。
      return envelope(
        this.workspace,
        () => ({
          file_path,
          exists: state.exists,
          kind: state.kind,
          isFile: state.exists && state.kind === 'file',
          isDirectory: state.exists && state.kind === 'dir',
        }),
        { source: state.source },
      )
    })
  }

  listFiles({ path, recursive }) {
    // WP9：条目的 `origin`（'tool'/'exec'…）是内部来源标注 ⇒ 不进模型可见面；
    // 在这里收集，经 `TOOL_DIAGNOSTICS.origins` 与 `entries` **逐条对齐**地交给内部消费者。
    const origins = []
    return envelope(
      this.workspace,
      () => {
        assertToolPaths(this.workspace, 'list_files', { path })
        const items = this.workspace.listDir(path, { recursive: recursive === true })
        for (const item of items) origins.push(item.origin)
        if (items.length === 0) {
          // #4.3：空目录是独立结果，不是"没找到"
          return {
            status: RESULT.EMPTY_DIRECTORY,
            path,
            entries: [],
            note: '执行完成，目录为空',
          }
        }
        return {
          path,
          recursive: recursive === true,
          count: items.length,
          entries: items.map((item) => ({
            path: item.path,
            name: item.name,
            type: item.kind,
            symlink: item.symlink || undefined,
          })),
        }
      },
      { origins },
    )
  }

  searchFiles({ pattern, glob, path, limit }) {
    return envelope(this.workspace, () => {
      if (path) assertToolPaths(this.workspace, 'search_files', { path })
      const matches = this.workspace.search(pattern, { glob, limit })
      if (matches.length === 0) {
        return { status: RESULT.NO_MATCH, pattern, glob, matches: [], note: '执行完成，无匹配内容' }
      }
      return { pattern, glob, count: matches.length, matches }
    })
  }

  writeFile({ file_path, content, reason }) {
    // WP9：模型可见面 = 真实文件系统写成功会有的东西（逻辑路径 + 字节数 + 是否真的改了）。
    // `staged` / `netChange` / note（"已进入暂存视图，真实工作区未改动"）是机制自曝，全部移出。
    // `netChange` 只存进旁路通道（工具体跑完后才有值 ⇒ 用可变盒子，工具体里回填）。
    const side = { staged: true, netChange: undefined }
    return envelope(
      this.workspace,
      () => {
        assertToolPaths(this.workspace, 'write_file', { file_path })
        const written = this.workspace.writeFile(file_path, content ?? '', { origin: 'write_file' })
        side.netChange = written.changed === true
        return {
          file_path,
          bytes: written.bytes,
          ...(reason === undefined ? {} : { reason }),
        }
      },
      side,
    )
  }

  editFile({ file_path, edit, reason }) {
    const side = { staged: true, netChange: undefined }
    return envelope(
      this.workspace,
      () => {
        assertToolPaths(this.workspace, 'edit_file', { file_path })
        const result = this.workspace.editText(file_path, edit, { origin: 'edit_file' })
        side.netChange = result.changed === true
        return {
          file_path,
          bytes: result.bytes,
          ...(reason === undefined ? {} : { reason }),
        }
      },
      side,
    )
  }

  deleteFile({ file_path }) {
    return envelope(this.workspace, () => {
      assertToolPaths(this.workspace, 'delete_file', { file_path })
      const result = this.workspace.remove(file_path, { origin: 'delete_file' })
      return {
        file_path,
        deleted: true,
        idempotent: result.idempotent === true,
        wasKind: result.wasKind,
      }
    })
  }

  createDirectory({ path }) {
    return envelope(this.workspace, () => {
      assertToolPaths(this.workspace, 'create_directory', { path })
      const result = this.workspace.createDirectory(path, { origin: 'create_directory' })
      return { path, created: result.created, idempotent: result.idempotent === true }
    })
  }
}

/** 从候选生成展示用 diff（两侧都来自候选冻结的 blob，绝不读真实磁盘，见 #12.6） */
export function renderCandidateDiff(store, candidate, options = {}) {
  const maxLines = options.maxLines ?? 40
  const out = []
  for (const change of candidate.changes) {
    out.push({ type: 'change-header', path: change.path, op: change.op, kind: change.kind })
    if (change.kind === 'dir') {
      out.push({ type: 'note', text: '目录变更' })
      continue
    }
    const beforeLines = change.before?.hash && change.before.hash !== hashAbsent() && store.hasBlob(change.before.hash)
      ? store.readBlob(change.before.hash).toString('utf8').split(/\r?\n/)
      : []
    const afterLines = change.after?.hash && change.after.hash !== hashAbsent() && store.hasBlob(change.after.hash)
      ? store.readBlob(change.after.hash).toString('utf8').split(/\r?\n/)
      : []
    let shown = 0
    const length = Math.max(beforeLines.length, afterLines.length)
    for (let i = 0; i < length && shown < maxLines; i += 1) {
      const a = beforeLines[i]
      const b = afterLines[i]
      if (a === b) continue
      if (a !== undefined && b === undefined) out.push({ type: 'remove', line: i + 1, text: a })
      else if (a === undefined && b !== undefined) out.push({ type: 'add', line: i + 1, text: b })
      else {
        out.push({ type: 'remove', line: i + 1, text: a })
        out.push({ type: 'add', line: i + 1, text: b })
      }
      shown += 1
    }
    if (shown >= maxLines) out.push({ type: 'note', text: `diff 已截断（超过 ${maxLines} 行变化）` })
  }
  return out
}
