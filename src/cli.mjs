#!/usr/bin/env node
/**
 * dsh-stage — Windows 暂存—候选—选择性提交沙箱 CLI
 *
 * 使用方式（本机受限令牌会话下必须经 cmd 启动 node，见 run.cmd 说明）：
 *   run.cmd src\cli.mjs init    --workspace <dir>
 *   run.cmd src\cli.mjs status  --workspace <dir>
 *   run.cmd src\cli.mjs exec    --workspace <dir> -- pwsh -c "ni new.txt"
 *   run.cmd src\cli.mjs review  --workspace <dir>
 *   run.cmd src\cli.mjs diff    --workspace <dir> [--candidate <id>]
 *   run.cmd src\cli.mjs apply   --workspace <dir> [--candidate <id>] [--paths a,b]
 *   run.cmd src\cli.mjs discard --workspace <dir> --candidate <id>
 *   run.cmd src\cli.mjs probe   [--workspace <dir>]
 *   run.cmd src\cli.mjs audit   --workspace <dir>
 *   run.cmd src\cli.mjs gc      --workspace <dir> [--apply]
 *
 * 退出码：
 *   0 成功
 *   1 一般失败
 *   2 用法错误
 *   3 fail-closed 拒绝（SANDBOX_UNAVAILABLE / 能力不足）
 *   4 候选陈旧（STALE_BASELINE）
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveStageRoot } from './stage-guard.mjs'
import { Workspace } from './workspace.mjs'
import { ToolSurface, renderCandidateDiff } from './tools.mjs'
import { WindowsStageExecutor } from './executor.mjs'
import { formatReport, probe } from './capability.mjs'
import { canonical } from './paths.mjs'

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, FAIL_CLOSED: 3, STALE: 4 }

const USAGE = `dsh-stage — Windows 暂存—候选—选择性提交沙箱

命令：
  init     初始化暂存区（幂等），打印能力探测与实例检查
  status   显示暂存状态、待审计数、损坏项
  probe    仅运行能力探测（不创建暂存区）
  exec     在 Windows 受限令牌沙箱内执行命令，执行后提取变化
  review   列出待审候选（按文件数计）
  diff     展示候选 diff（before/after 均取自候选冻结内容）
  apply    选择性应用候选
  discard  丢弃候选（持久化状态，非删文件）
  gc       垃圾回收无引用 blob
  audit    从沙箱内部发起真实攻击探针并输出证据

通用参数：
  --workspace <dir>   工作区根（默认当前目录）
  --json              机器可读输出
  --session <id>      会话标识（默认取自暂存清单）
`

function parseArgv(argv) {
  const positional = []
  const flags = {}
  let passthrough
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      passthrough = argv.slice(i + 1)
      break
    }
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags, passthrough }
}

function out(value, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function fail(code, message, extra = {}) {
  process.stderr.write(`${code}: ${message}\n`)
  if (Object.keys(extra).length) process.stderr.write(`${JSON.stringify(extra, null, 2)}\n`)
  process.exit(code === 'SANDBOX_UNAVAILABLE' ? EXIT.FAIL_CLOSED : EXIT.FAIL)
}

async function main() {
  const { positional, flags, passthrough } = parseArgv(process.argv.slice(2))
  const command = positional[0]
  if (!command || flags.help) {
    process.stdout.write(USAGE)
    process.exit(command ? EXIT.OK : EXIT.USAGE)
  }

  const workspaceRoot = canonical(resolve(flags.workspace || process.cwd()))

  // WP11（2026-10-05）：探针缓存**不再落工作区** `<ws>\.dshstage\cache`。
  // owner 已决定工作区不再出现 `.dshstage`，暂存/缓存一律在 Windows 缓存面（`resolveStageRoot()`）。
  // `--no-cache` 仍然完全关闭缓存（传 `undefined`）。
  const probeCacheDir = () => resolve(resolveStageRoot({ workspaceRoot, sessionKey: flags.session }), 'probe-cache')

  if (command === 'probe') {
    const report = probe({
      root: workspaceRoot,
      cacheDir: flags['no-cache'] ? undefined : probeCacheDir(),
      useCache: flags['use-cache'] === true,
    })
    if (flags.json) out(report, flags)
    else process.stdout.write(`${formatReport(report)}\n`)
    process.exit(EXIT.OK)
  }

  const workspace = new Workspace({ workspaceRoot, sessionId: flags.session }).init()

  switch (command) {
    case 'init': {
      const report = probe({
        root: workspaceRoot,
        cacheDir: probeCacheDir(),
        useCache: flags['use-cache'] === true,
      })
      const payload = {
        workspaceRoot: workspace.root,
        storeDir: workspace.store.dir,
        sessionId: workspace.sessionId,
        tier: report.tier,
        instanceChecks: report.instanceChecks,
        // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复（机器可读面）
        staleAppContainerAces: report.staleAppContainerAces,
        corruption: workspace.corruption,
        entryCount: Object.keys(workspace.manifest.entries).length,
      }
      if (flags.json) out(payload, flags)
      else {
        process.stdout.write(`${formatReport(report, { workspace: { staleAceRepair: report.staleAppContainerAces } })}\n\n`)
        process.stdout.write(`workspace   = ${payload.workspaceRoot}\n`)
        process.stdout.write(`store       = ${payload.storeDir}\n`)
        process.stdout.write(`session     = ${payload.sessionId}\n`)
        process.stdout.write(`stagedItems = ${payload.entryCount}\n`)
        if (payload.corruption.length) {
          process.stdout.write(`⚠ 损坏项 ${payload.corruption.length} 个（禁止发布，见手册 3.1）:\n`)
          for (const item of payload.corruption) process.stdout.write(`   ${item.path}: ${item.reason}\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'status': {
      const pending = workspace.listReviews()
      const changes = workspace.diffEntries()
      const payload = {
        workspaceRoot: workspace.root,
        sessionId: workspace.sessionId,
        revision: workspace.manifest.revision,
        stagedEntries: Object.keys(workspace.manifest.entries).length,
        netChanges: changes.length,
        netChangeByOp: changes.reduce((acc, c) => ({ ...acc, [c.op]: (acc[c.op] || 0) + 1 }), {}),
        pendingCandidates: pending.length,
        pendingFiles: pending.reduce((sum, c) => sum + c.changes.length, 0),
        pendingHostOperations: pending.reduce((sum, c) => sum + (c.hostOperations?.length || 0), 0),
        corruption: workspace.corruption,
        candidates: pending.map((c) => ({
          id: c.id,
          status: c.status,
          createdAt: c.createdAt,
          files: c.changes.length,
          changes: c.changes.map((x) => `${x.op}:${x.path}`),
        })),
      }
      if (flags.json) out(payload, flags)
      else {
        process.stdout.write(`工作区      : ${payload.workspaceRoot}\n`)
        process.stdout.write(`会话        : ${payload.sessionId}  revision=${payload.revision}\n`)
        process.stdout.write(`暂存条目    : ${payload.stagedEntries}\n`)
        process.stdout.write(`净变化      : ${payload.netChanges} ${JSON.stringify(payload.netChangeByOp)}\n`)
        // 手册 12.2：明确分开展示"待审文件数"和"宿主操作数"
        process.stdout.write(`待审文件数  : ${payload.pendingFiles}（${payload.pendingCandidates} 份候选）\n`)
        process.stdout.write(`宿主操作数  : ${payload.pendingHostOperations}\n`)
        if (payload.corruption.length) process.stdout.write(`损坏项      : ${payload.corruption.length}\n`)
        for (const candidate of payload.candidates) {
          process.stdout.write(`  [${candidate.status}] ${candidate.id} — ${candidate.files} 个变更单元\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'exec': {
      const argv = passthrough && passthrough.length ? passthrough : positional.slice(1)
      if (!argv.length) fail('USAGE', 'exec 需要命令，例如: exec -- pwsh -c "ni a.txt"')
      const executor = new WindowsStageExecutor({
        stagingRoot: workspace.store.stagedDir,
        // 注册表覆盖层必须落在**会话存储根**，不能落在暂存树里 —— 否则
        // "提取暂存树变化"会把 shim 自己的 `registry/overlay.<pid>.hive*` 当成用户改动
        // 去摄取（本机实测 `EPERM ... overlay.<pid>.hive.LOG1`）。与 `dsh-plugin/
        // shell-executor.mjs` 的同一处参数保持一字不差。
        registryStageDir: workspace.store.dir,
        mode: flags['read-only'] === true ? 'read-only' : 'workspace-write',
        tier: flags.tier,
      })
      let report
      try {
        report = await executor.init()
      } catch (error) {
        fail(error.code === 'SANDBOX_UNAVAILABLE' ? 'SANDBOX_UNAVAILABLE' : 'SANDBOX_INIT_FAILED', error.message)
      }
      try {
        // 执行前物化当前工作区版本（#3.2 / A16）
        const materialize = workspace.materializeForExecution()
        const before = workspace.snapshotStagedTree()
        const execution = await executor.run({
          command: argv[0],
          args: argv.slice(1),
          cwd: workspace.store.stagedDir,
          logicalCwd: workspace.root,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        })
        // 执行后只提取相对该输入版本的新增变化（#3.2）
        const captured = workspace.captureAfterExecution(before)
        // ── D9 修复：捕获结果必须**并入清单并冻结候选**，否则 exec → review → apply 断链 ──
        // 原先这里只有 `captured.length` 一个统计数字：暂存树里有命令产出的文件，
        // 但 `diffEntries()` 看不到任何变化 → `review` 恒为空 → `apply` 无候选可应用。
        // 这一段原本被 tests\e2e-flow.mjs 在 CLI 之外手工补上（测试替被测代码干活）。
        const ingested = workspace.ingestCapturedChanges(captured)
        const frozen = workspace.freezeIfNeeded({ source: 'exec' })
        const payload = {
          execution: {
            argv: execution.argv,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            durationMs: execution.durationMs,
            stdout: execution.stdout,
            stderr: execution.stderr,
            classification: execution.classification,
            enforcement: execution.enforcement,
            tier: execution.tier,
            completedWithoutOutput: execution.completedWithoutOutput,
          },
          sandboxInit: report,
          materialized: materialize,
          capturedChanges: captured.length,
          /** 新增：并入清单的条数 / 删除条数 / 跳过原因（可观测，不静默） */
          ingested,
          /** 新增：候选冻结结果（frozen=false 且 reason=already-represented 表示幂等复用） */
          candidate: {
            frozen: frozen.frozen === true,
            reason: frozen.reason,
            id: frozen.candidate?.id,
            files: frozen.candidate?.changes?.length,
            pendingAfter: workspace.listReviews().length,
          },
        }
        if (flags.json) out(payload, flags)
        else {
          process.stdout.write(`$ ${execution.argv.join(' ')}\n`)
          if (execution.stdout) process.stdout.write(execution.stdout)
          if (execution.stderr) process.stderr.write(execution.stderr)
          process.stdout.write(`\n退出码=${execution.exitCode} 分类=${execution.classification.kind} 用时=${execution.durationMs}ms\n`)
          if (execution.completedWithoutOutput) process.stdout.write('（执行完成，无输出）\n')
          process.stdout.write(`沙箱内提取到 ${captured.length} 项变化，并入清单 ${ingested.ingested} 项，删除 ${ingested.deletions} 项\n`)
          if (frozen.frozen) process.stdout.write(`已冻结候选 ${frozen.candidate.id}（${frozen.candidate.changes.length} 个变更单元）→ 可用 review/apply 处理\n`)
          else process.stdout.write(`未新建候选：${frozen.reason}\n`)
          for (const skip of ingested.skipped) process.stdout.write(`  ⚠ 跳过 ${skip.path}: ${skip.reason}\n`)
        }
        process.exit(execution.exitCode === 0 ? EXIT.OK : EXIT.FAIL)
      } finally {
        executor.dispose()
      }
      break
    }

    case 'review': {
      const pending = workspace.listReviews()
      const payload = pending.map((c) => ({
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        files: c.changes.length,
        hostOperations: c.hostOperations?.length || 0,
        summary: c.summary,
        changes: c.changes.map((x) => ({ op: x.op, path: x.path, kind: x.kind })),
      }))
      if (flags.json) out(payload, flags)
      else if (payload.length === 0) process.stdout.write('待审队列为空（没有净变化就不会入队，见手册 #12.1）\n')
      else {
        for (const candidate of payload) {
          process.stdout.write(`候选 ${candidate.id}  [${candidate.status}]  ${candidate.files} 文件 / ${candidate.hostOperations} 宿主操作\n`)
          for (const change of candidate.changes) process.stdout.write(`   ${change.op.padEnd(7)} ${change.path}\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'diff': {
      let candidate
      if (flags.candidate) {
        candidate = workspace.resolveCandidate(flags.candidate).candidate
      } else {
        const pending = workspace.listReviews()
        candidate = pending[pending.length - 1]
      }
      if (!candidate) {
        process.stdout.write('没有可展示的候选\n')
        process.exit(EXIT.OK)
      }
      const lines = renderCandidateDiff(workspace.store, candidate, { maxLines: Number(flags['max-lines'] || 40) })
      if (flags.json) out({ candidate: candidate.id, lines }, flags)
      else {
        process.stdout.write(`候选 ${candidate.id} [${candidate.status}] — before/after 均冻结在候选内\n`)
        for (const line of lines) {
          if (line.type === 'change-header') process.stdout.write(`\n--- ${line.op} ${line.path}\n`)
          else if (line.type === 'add') process.stdout.write(`+ ${line.text}\n`)
          else if (line.type === 'remove') process.stdout.write(`- ${line.text}\n`)
          else process.stdout.write(`  (${line.text})\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'apply': {
      let candidateId = flags.candidate
      if (!candidateId) {
        const pending = workspace.listReviews()
        if (!pending.length) {
          process.stdout.write('没有待审候选\n')
          process.exit(EXIT.OK)
        }
        candidateId = pending[pending.length - 1].id
      }
      const paths = typeof flags.paths === 'string' ? flags.paths.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const result = workspace.applyCandidate(candidateId, { paths, force: flags.force === true })
      if (flags.json) out(result, flags)
      else {
        process.stdout.write(`候选 ${result.id} → 状态 ${result.status}\n`)
        process.stdout.write(`已应用 ${result.applied.length} 项，失败 ${result.failed.length} 项\n`)
        for (const item of result.failed) process.stdout.write(`  ✗ ${item.path}: ${item.code} — ${item.message}\n`)
        if (result.remaining?.length) {
          process.stdout.write(`未选择/未应用 ${result.remaining.length} 项，保留为可追踪修订（不会丢弃整份候选）\n`)
        }
      }
      process.exit(result.failed.some((f) => f.code === 'STALE_BASELINE') ? EXIT.STALE : EXIT.OK)
    }

    case 'discard': {
      if (!flags.candidate) fail('USAGE', 'discard 需要 --candidate <id>')
      const result = workspace.discardCandidate(flags.candidate, { reason: flags.reason })
      out(result, flags)
      process.exit(EXIT.OK)
    }

    case 'gc': {
      const report = workspace.store.collectGarbage({ apply: flags.apply === true })
      out(report, flags)
      process.exit(EXIT.OK)
    }

    case 'audit': {
      const { runAudit } = await import('./audit.mjs')
      const report = await runAudit(workspace, { json: flags.json === true })
      process.exit(report.passed ? EXIT.OK : EXIT.FAIL)
    }

    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`)
      process.exit(EXIT.USAGE)
  }
}

main().catch((error) => {
  process.stderr.write(`未捕获错误: ${error?.stack || error}\n`)
  process.exit(EXIT.FAIL)
})
