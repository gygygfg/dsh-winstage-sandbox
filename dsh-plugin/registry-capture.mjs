/**
 * registry-capture —— 把 shim 写下的注册表 WAL 变成**审批候选**（宿主侧闭合）。
 *
 * ── 它补的是哪一段空白（用户报障"注册表更改没有走暂存审批"的最后一段）───────────
 * 本轮之前，注册表这条链是**断成三截**的：
 *   ① `winstage-shell` 行从不装载（门控读进程环境变量 `WINSTAGE_SHELL`）⇒ 没有 shim；
 *   ② 即使 shim 在，注入出的**子进程**也 attach 不上共享覆盖层 hive
 *      （`REG_PROCESS_APPKEY` + `ERROR_SHARING_VIOLATION`）⇒ `reg add` 在子进程里
 *      被 fail-closed 硬拒；
 *   ③ 即使覆盖层写出了 WAL，**宿主侧没有任何调用者**读它
 *      （`createRegistryStage` 在仓库里只有 `tools/run-shim-closedloop.mjs` 一个调用者）
 *      ⇒ "沙箱里写成功了"与"审批面板看得到"永远接不上。
 * 本模块就是第 ③ 段的接线：执行完一条命令后，读 `<sessionDir>/registry/overlay.journal`，
 * 与**真实 hive** 做 diff，把净变化冻结成与文件候选**同构**的候选，登记进同一个
 * `queue.json` ⇒ 面板与 `/winstage approve|reject` 原样可用（不需要第二套审批面）。
 *
 * ── 幂等（必须，否则每次命令都重复入队）──────────────────────────────────────
 * WAL 是**追加**的，会跨多条命令一直存在；而 `freezeCandidate()` 每次都按"当前真实 hive
 * vs 覆盖层视图"算净变化 —— 于是同一条写入会被反复冻结成多个候选。
 * 这里用 `<sessionDir>/registry/host-capture.json` 记住**上次消费到的 WAL 字节数**：
 * 没有新记录就不冻结（`no-new-records`）。这个标记只属于本模块，不碰
 * `manifest.json` / `review.json` / `queue.json` 的既有契约。
 *
 * ── 失败必须响，且绝不打断命令 ────────────────────────────────────────────────
 * 捕获是**命令之后**的收尾动作：它失败不该让已经跑完的命令变成失败。因此 `capture()`
 * 永不抛；所有失败都进返回值 + `logError`（error 级日志，人工侧可见）。
 *
 * ── 清理 ──────────────────────────────────────────────────────────────────────
 * 每个"attach 失败后改用自己那份 hive"的进程会留下一个 `overlay.<pid>.hive`。
 * 进程退出本应由 shim 删除，但 DllMain 的 detach 阶段删除正在被自己加载的 hive 并不可靠，
 * 因此这里做一次**兜底清扫**：pid 已经不在的 `overlay.<数字>.hive*` 一律删掉。
 * 覆盖层 hive 是派生状态，WAL 才是唯一权威 —— 删它不丢信息。
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRegistryStage, registryWireBytes } from '../src/registry-stage.mjs'
import { createRegExeReader, createRegExeWriter } from '../src/registry-bindings.mjs'

/** 标记文件名（本模块私有） */
export const HOST_CAPTURE_MARKER = 'host-capture.json'

/** `<sessionDir>/registry/` */
export function registryDirOf(sessionDir) {
  return join(sessionDir, 'registry')
}

/** `<sessionDir>/registry/overlay.journal` */
export function journalPathOf(sessionDir) {
  return join(registryDirOf(sessionDir), 'overlay.journal')
}

/** `<sessionDir>/registry/host-capture.json` */
export function markerPathOf(sessionDir) {
  return join(registryDirOf(sessionDir), HOST_CAPTURE_MARKER)
}

/** 本进程（宿主）是否认为该 pid 还活着 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，但没有权限发信号（Windows 上常见）⇒ 视为存活
    return error?.code === 'EPERM'
  }
}

/**
 * 兜底清扫**死进程**留下的 `overlay.<pid>.hive{,.LOG1,.LOG2}`。
 *
 * ⚠ 只删"进程已不在"的那些；**活的** pid 一定跳过（那正是当前命令树正在用的覆盖层，
 * 删了会让它当场 fail-closed）。
 */
export function sweepDeadOverlayHives(sessionDir, options = {}) {
  const isAlive = options.isAlive ?? defaultIsAlive
  const dir = registryDirOf(sessionDir)
  if (!existsSync(dir)) return { removed: [], kept: 0 }
  const removed = []
  let kept = 0
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed, kept }
  }
  const dead = new Set()
  for (const name of entries) {
    const m = /^overlay\.(\d+)\.hive(?:\.LOG[12])?$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (isAlive(pid)) {
      kept += 1
      continue
    }
    dead.add(pid)
  }
  for (const name of entries) {
    const m = /^overlay\.(\d+)\.hive(?:\.LOG[12])?$/.exec(name)
    if (!m) continue
    if (!dead.has(Number(m[1]))) continue
    const full = join(dir, name)
    try {
      unlinkSync(full)
      removed.push(name)
    } catch {
      /* 删不掉不影响结果（WAL 才是权威） */
    }
  }
  return { removed, kept }
}

/** 读标记（解析失败一律当"没消费过"：宁可重复冻结一次，也不静默丢失一条写入） */
function readMarker(sessionDir) {
  try {
    const parsed = JSON.parse(readFileSync(markerPathOf(sessionDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMarker(sessionDir, marker) {
  try {
    writeFileSync(markerPathOf(sessionDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  } catch {
    /* 标记写不下去只会导致重复冻结，不影响正确性 */
  }
}

/**
 * 消费一次 WAL：有**新**记录就冻结候选。
 *
 * @param {object} options
 * @param {string} options.sessionDir   会话存储根（`<workspace>/.dshstage/sessions/<sid>`）
 * @param {string} [options.sessionId]
 * @param {string} [options.workspaceRoot]
 * @param {(m:string)=>void} [options.log]
 * @param {(m:string)=>void} [options.logError]
 * @param {number} [options.nowMs]      仅自测用（时间无关，这里只是便于诊断）
 * @returns {{handled:boolean, reason:string, changes?:number, enqueued?:boolean, candidateId?:string|null, errors?:string[]}}
 */
export function captureRegistryChanges(options = {}) {
  const sessionDir = typeof options.sessionDir === 'string' ? options.sessionDir : ''
  const log = options.log ?? (() => {})
  const logError = options.logError ?? (() => {})
  const errors = []
  const fail = (reason, error) => {
    const detail = `${reason}: ${error?.message ?? error ?? ''}`.trim()
    errors.push(detail)
    logError(`注册表捕获失败 —— ${detail}`)
    return { handled: false, reason, errors }
  }

  if (sessionDir.length === 0) return { handled: false, reason: 'no-session-dir', errors }
  const journalPath = journalPathOf(sessionDir)
  if (!existsSync(journalPath)) return { handled: false, reason: 'no-wal', errors }

  let size = 0
  try {
    size = statSync(journalPath).size
  } catch (error) {
    return fail('wal-unreadable', error)
  }
  if (size <= 0) return { handled: false, reason: 'no-wal-records', errors }

  const marker = readMarker(sessionDir)
  const consumed = Number.isInteger(marker?.bytes) ? marker.bytes : -1
  if (consumed === size) return { handled: false, reason: 'no-new-records', errors }
  // WAL 只会追加；若它反而变小（被外部清空/替换），按"从零开始"处理并如实记一句。
  if (consumed > size) log(`注册表 WAL 变小（${consumed} → ${size}）：按新 WAL 重新冻结。`)

  let stage
  try {
    stage = createRegistryStage({
      sessionDir,
      ...(typeof options.sessionId === 'string' && options.sessionId.length > 0 ? { sessionId: options.sessionId } : {}),
      ...(typeof options.workspaceRoot === 'string' ? { workspaceRoot: options.workspaceRoot } : {}),
      reader: createRegExeReader(options.bindingOptions),
      writer: createRegExeWriter({
        ...(options.bindingOptions ?? {}),
        wireBytes: registryWireBytes,
        log,
      }),
    })
  } catch (error) {
    return fail('stage-construct-failed', error)
  }

  let frozen
  try {
    stage.open()
    frozen = stage.freezeCandidate()
  } catch (error) {
    // 注意：**不**推进标记 —— 下一次还要再试（比如真实 hive 那一刻读不到）。
    return fail('freeze-failed', error)
  }

  if (frozen?.enqueued === true) {
    log(
      `注册表候选已冻结：${frozen.changes?.length ?? 0} 条净变化（候选 ${frozen.candidate?.id ?? '?'}）。` +
        `${frozen.unreadable?.length ? ` 其中 ${frozen.unreadable.length} 个键读不到基线。` : ''}`,
    )
    for (const unit of frozen.unreadable ?? []) errors.push(`unreadable-baseline: ${unit}`)
  } else {
    log(`注册表 WAL 有记录但没有净变化（${frozen?.reason ?? 'no-net-change'}）。`)
  }

  sweepDeadOverlayHives(sessionDir, { isAlive: options.isAlive })
  writeMarker(sessionDir, {
    bytes: size,
    records: frozen?.changes?.length ?? 0,
    enqueued: frozen?.enqueued === true,
    candidateId: frozen?.candidate?.id ?? null,
    at: new Date(options.nowMs ?? Date.now()).toISOString(),
  })

  return {
    handled: true,
    reason: frozen?.enqueued === true ? 'enqueued' : (frozen?.reason ?? 'no-net-change'),
    changes: frozen?.changes?.length ?? 0,
    enqueued: frozen?.enqueued === true,
    candidateId: frozen?.candidate?.id ?? null,
    errors,
  }
}
