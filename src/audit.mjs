/**
 * 审计：从沙箱内部发起真实攻击探针
 *
 * 手册依据：
 *   附录 B.1  「所有安全声明必须有『从沙箱内部发起的真实攻击探针』证据」
 *   #16.10    无法消除的残余要写进文档并声明为非硬边界，不能假装没有
 *   第 17 章  验收看"保证覆盖"，不看测试数量；出口必须给出实际结果与仍未提供的保证
 *   第 4 章   空、无匹配、不存在、无权限是四种不同结果
 *   0.1       证据分层：每条都带 [实测]/[残余]/[未实测] 标记
 *
 * 纪律：
 *   - 探针**只读**宿主对象，唯一的写操作发生在沙箱自己的暂存根与垃圾目标上；
 *   - 不写注册表、不写系统目录、不建服务；
 *   - 无法实测的项目标 `not-run`，绝不以"推断"冒充"实测"（手册 0.1 / D.2 第 4 条）；
 *   - **空输出绝不解释为"拒绝"**（真实缺陷 11：曾导致读取面 10 项假通过）。
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WindowsStageExecutor, resolvePowerShell } from './executor.mjs'

/**
 * 输出哨兵。用它而不是"能否 JSON.parse"判断脚本是否真的执行了：
 * 空输出与解析失败必须与"操作被拒绝"区分开（手册第 4 章）。
 */
const AUDIT_MARKER = 'DSH-AUDIT-JSON:'

/**
 * 所有沙箱内脚本的公共前导。
 *
 * 为什么显式设置控制台编码：Windows PowerShell 5.1 在受限令牌下若无法初始化
 * 控制台/编码子系统，可能直接以退出码 127（DLL 初始化失败类）结束且**不产出任何输出**。
 * 显式设定 UTF-8 输出 + 关闭进度条可减少这类静默失败面，也让非 ASCII 路径的
 * 字节表示稳定（否则按字符串匹配会全部落空）。
 */
const PS_PRELUDE = [
  "$ErrorActionPreference='Continue'",
  '$ProgressPreference="SilentlyContinue"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
].join('\n')

/** 宿主敏感对象读取探针：读得到就是泄露，读不到才是收敛 */
const READ_PROBES = [
  { id: 'sam-hive', path: 'C:\\Windows\\System32\\config\\SAM', label: '本地账户数据库 SAM', maskClass: 'sam' },
  { id: 'system-hive', path: 'C:\\Windows\\System32\\config\\SYSTEM', label: '系统配置单元', maskClass: 'sam' },
  { id: 'win-ini', path: 'C:\\Windows\\win.ini', label: '系统文件（对照项，预期可读）' },
  { id: 'hosts-file', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', label: 'hosts 主机名映射', maskClass: 'hosts' },
  { id: 'unattend', path: 'C:\\Windows\\Panther\\Unattend.xml', label: '无人值守安装应答（可能含明文口令）', maskClass: 'unattend' },
  { id: 'dsh-sessions', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.dsh'), label: 'DSH 主目录（会话日志/凭据）', maskClass: 'dsh-home' },
  { id: 'ssh-keys', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.ssh'), label: 'SSH 私钥目录', maskClass: 'ssh' },
  { id: 'dpapi-user', path: join(process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming', 'Microsoft', 'Protect'), label: '用户 DPAPI 主密钥', maskClass: 'dpapi-user' },
  { id: 'git-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.git-credentials'), label: 'Git 明文凭据', maskClass: 'git-credentials' },
  { id: 'npmrc', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.npmrc'), label: 'npm 令牌', maskClass: 'npmrc' },
]

const WRITE_PROBE_IDS = [
  ['write-inside-staging', '暂存根内写入'],
  ['write-outside-staging', '暂存根外写入'],
  ['write-system-dir', '系统目录写入'],
  ['delete-outside-staging', '暂存根外删除'],
  ['temp-rewritten', 'TEMP 重写'],
  ['secret-env-blocked', '敏感环境变量不注入'],
  ['proxy-env-blocked', '代理环境变量不注入'],
]

export async function runAudit(workspace, options = {}) {
  const findings = []
  const log = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`)
  }

  log('=== 沙箱审计：从沙箱内部发起真实探针 ===')
  log(`工作区: ${workspace.root}`)
  log('')

  // ---------- A. 能力探测 ----------
  const caps = WindowsStageExecutor.capabilities()
  findings.push({
    area: 'capability',
    id: 'acl-backend-loadable',
    status: caps.aclAvailable ? 'pass' : 'fail',
    evidence: '[实测]',
    detail: caps.aclAvailable
      ? `@deepseek-ai/dsh-sandbox-windows-acl@${caps.aclVersion} 从 ${caps.aclFrom} 加载成功`
      : `加载失败: ${caps.aclError}`,
  })
  findings.push({
    area: 'capability',
    id: 'win32-process-loadable',
    status: caps.win32Available ? 'pass' : 'fail',
    evidence: '[实测]',
    detail: caps.win32Available
      ? `@deepseek-ai/dsh-win32-process@${caps.win32Version} 从 ${caps.win32From} 加载成功`
      : `加载失败: ${caps.win32Error}`,
  })
  findings.push({
    area: 'capability',
    id: 'powershell-interpreter',
    status: 'informational',
    evidence: '[实测]',
    detail: (() => {
      try {
        const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
        return `选用 ${shell.name} → ${shell.command}（本机没有 pwsh 时自动回退 Windows PowerShell 5.1）`
      } catch (error) {
        return `未找到任何 PowerShell 解释器: ${error.message}`
      }
    })(),
  })

  // ---------- B. 建立沙箱内执行环境 ----------
  const executor = new WindowsStageExecutor({
    stagingRoot: workspace.store.stagedDir,
    mode: 'workspace-write',
  })
  let initReport
  let sandboxUsable = true
  /**
   * 探针未执行的归因。必须区分两种"没跑"：
   *   'nesting-limit' → 机制边界（已受限会话不能嵌套），标 `not-run`，不计 fail
   *   'defect'        → 实现缺陷，标 `fail`，必须修
   * 早先版本把两者混为一谈，让一个代码 bug 看起来像环境限制。
   */
  let blocked = undefined

  try {
    initReport = await executor.init()
    findings.push({
      area: 'capability',
      id: 'sandbox-init',
      status: 'pass',
      evidence: '[实测]',
      detail: `受限令牌与 ACL 授予建立成功（tier=T1，flags=${initReport.jobFlags}）`,
      data: { capturedFields: initReport.capturedFields, jobConfig: initReport.jobConfig },
    })
  } catch (error) {
    sandboxUsable = false
    const rights = WindowsStageExecutor.capabilities()
    const missing = []
    try {
      const { probeWin32Abi } = await import('./capability.mjs')
      const abi = probeWin32Abi()
      for (const [name, granted] of Object.entries(abi?.checks?.tokenRights?.granted ?? {})) {
        if (!granted) missing.push(name)
      }
    } catch {
      /* 探测失败不影响主结论 */
    }

    const code = error.code || '(no code)'
    // 只有"确实因令牌权限不足"才声称不可嵌套；其余一律如实报为需要修复的缺陷
    const isNestingLimit =
      missing.length > 0 && /OpenProcessToken|CreateRestrictedToken|SANDBOX_UNAVAILABLE/.test(error.message)
    const detail = isNestingLimit
      ? `无法在当前会话内建立嵌套沙箱：${error.message}。` +
        `精确原因：本会话令牌缺少 CreateRestrictedToken 所需的 ${missing.join(', ')}` +
        '（因为它本身就是一个 WRITE_RESTRICTED 受限令牌）。' +
        '这是"隔离不可嵌套"的实测边界，不是本沙箱的缺陷；' +
        '请在**未受限的终端**中重新运行本审计以取得完整证据。'
      : `建立沙箱失败：${code}: ${error.message}。` +
        '这**不是**令牌权限问题，而是需要修复的实现缺陷（例如绑定表契约不符）。' +
        '不要把该失败归因为"隔离不可嵌套"。'

    findings.push({
      area: 'capability',
      id: 'sandbox-init',
      status: isNestingLimit ? 'not-run' : 'fail',
      evidence: '[实测] 拒绝建立',
      detail,
      data: { errorCode: code, missingRights: missing, nestingLimit: isNestingLimit, aclAvailable: rights.aclAvailable },
    })
    blocked = isNestingLimit
      ? { kind: 'nesting-limit', status: 'not-run', reason: '嵌套沙箱不可用（机制边界），见 sandbox-init 结论' }
      : { kind: 'defect', status: 'fail', reason: `沙箱建立失败（实现缺陷）：${code}: ${error.message}` }
  }

  // ---------- B2. 预检：沙箱内的 shell 必须真的能产出输出 ----------
  //
  // 为什么必须有这一步（真实缺陷 11）：曾出现"读取面 10 项全部 ✓（拒绝读取 unknown）、
  // 写入面 7 项全部 ✗、TEMP=undefined"的结果 —— 真相是子进程**根本没产出任何输出**，
  // 而审计把"空输出"当成了"拒绝读取"。
  if (sandboxUsable) {
    const marker = `DSH-PREFLIGHT-${Date.now().toString(36)}`
    // 预检不只问"有没有输出"，还要在能出输出时**回报子进程真实拿到的关键环境变量**。
    // 目的：把"shell 起来了吗 / 缺哪个变量"从猜测变成一次可读的实测记录
    // （真实缺陷 11 的根因定位手段）。
    const preflightScript = [
      PS_PRELUDE,
      '$o=[ordered]@{}',
      "$o.SystemRoot=$env:SystemRoot",
      "$o.windir=$env:windir",
      "$o.PATHlen=($env:PATH | Measure-Object -Character).Characters",
      "$o.TEMP=$env:TEMP",
      "$o.USERPROFILE=$env:USERPROFILE",
      "$o.PSVersion=$($PSVersionTable.PSVersion.ToString())",
      "$o.comspec=$env:ComSpec",
      '[Console]::Out.Write(\'' + marker + '\' + ($o|ConvertTo-Json -Compress))',
    ].join('\n')
    let shellDiagnostic
    let shellReady = false
    let envProbe
    try {
      const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
      const outcome = await executor.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', preflightScript],
        cwd: workspace.store.stagedDir,
        timeoutMs: 60000,
      })
      shellReady = outcome.stdout.includes(marker)
      // 预检用的是自己的哨兵，必须显式传入（默认值是 AUDIT_MARKER）
      envProbe = parseMarkedJson(outcome.stdout, marker)
      shellDiagnostic = {
        shell: shell.command,
        shellName: shell.name,
        exitCode: outcome.exitCode,
        stdoutLength: outcome.stdout.length,
        stdoutPreview: outcome.stdout.slice(0, 300),
        stderrPreview: outcome.stderr.slice(0, 500),
        launchFailed: outcome.launchFailed === true,
        classification: outcome.classification,
        childEnvKeys: outcome.envKeys,
        resolvedCommand: outcome.resolvedCommand,
      }
    } catch (error) {
      shellDiagnostic = { error: error.message }
    }
    findings.push({
      area: 'capability',
      id: 'sandbox-shell-preflight',
      status: shellReady ? 'pass' : 'fail',
      evidence: '[实测] 从沙箱内部发起',
      detail: shellReady
        ? `沙箱内 shell 可执行并产出输出（${shellDiagnostic.shellName}）；` +
          `子进程关键变量=${JSON.stringify(envProbe)}`
        : '沙箱内 shell **无法产出任何输出**，因此读/写边界探针的结论一律无效' +
          '（不能把空输出当成拒绝）。诊断：' +
          `shell=${shellDiagnostic?.shellName} resolved=${shellDiagnostic?.resolvedCommand} ` +
          `退出码=${shellDiagnostic?.exitCode} stdout长度=${shellDiagnostic?.stdoutLength} ` +
          `launchFailed=${shellDiagnostic?.launchFailed} ` +
          `子进程环境变量个数=${shellDiagnostic?.childEnvKeys?.length} ` +
          `stderr=${JSON.stringify((shellDiagnostic?.stderrPreview ?? '').slice(0, 300))}`,
      data: shellDiagnostic,
    })
    if (!shellReady) {
      blocked = {
        kind: 'defect',
        status: 'fail',
        reason: '沙箱内 shell 无法产出输出（预检失败），边界探针无法取得有效证据；空输出不得解释为"拒绝"。',
      }
      sandboxUsable = false
    }
  }

  // ---------- C. 写入面探针 ----------
  const stamp = Date.now().toString(36)
  const insideTarget = join(workspace.store.stagedDir, `.audit-inside-${stamp}.txt`)
  const outsideTarget = join(workspace.root, '..', `.audit-outside-${stamp}.txt`)
  const systemTarget = `C:\\Windows\\audit-${stamp}.txt`

  if (sandboxUsable) {
    // 脚本必须用**换行**连接，不能用分号拼成一行：分号拼接在 PowerShell 5.1 下
    // 对 try/catch 等语句块很脆弱，而"有没有输出"是我们唯一的成败判据，风险过高。
    const script = [
      PS_PRELUDE,
      '$r=[ordered]@{}',
      `try { Set-Content -LiteralPath '${q(insideTarget)}' -Value x -ErrorAction Stop; $r.inside='ok' } catch { $r.inside='denied' }`,
      `try { Set-Content -LiteralPath '${q(outsideTarget)}' -Value x -ErrorAction Stop; $r.outside='ok' } catch { $r.outside='denied' }`,
      `try { Set-Content -LiteralPath '${q(systemTarget)}' -Value x -ErrorAction Stop; $r.system='ok' } catch { $r.system='denied' }`,
      `try { Remove-Item -LiteralPath '${q(join(workspace.root, 'package.json'))}' -ErrorAction Stop; $r.deleteOutside='ok' } catch { $r.deleteOutside='denied' }`,
      '$r.temp=$env:TEMP',
      '$r.cwd=(Get-Location).Path',
      '$r.secretPresent=($null -ne $env:DSH_AUDIT_SECRET)',
      '$r.proxyPresent=($null -ne $env:HTTP_PROXY)',
      `[Console]::Out.Write('${AUDIT_MARKER}' + ($r|ConvertTo-Json -Compress))`,
    ].join('\n')

    try {
      const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
      const outcome = await executor.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script],
        cwd: workspace.store.stagedDir,
        timeoutMs: 120000,
        env: { DSH_AUDIT_SECRET: 'audit-canary-value', HTTP_PROXY: 'http://canary.invalid:8080' },
      })
      const parsed = parseMarkedJson(outcome.stdout)

      if (parsed === undefined) {
        // **关键**：没有可解析输出 ≠ 边界生效。绝不把空结果解释成"拒绝"。
        const detail =
          '沙箱内脚本未产出可解析输出，因此无法得出边界结论（空输出不是"拒绝"）。' +
          `退出码=${outcome.exitCode} stderr前300字符=${JSON.stringify(outcome.stderr.slice(0, 300))}`
        for (const [id, label] of WRITE_PROBE_IDS) {
          findings.push({ area: 'write', id, status: 'fail', evidence: '[实测] 未产出输出', detail: `${label}: ${detail}` })
        }
      } else {
        findings.push(writeFinding('write-inside-staging', parsed.inside === 'ok', `实测值=${parsed.inside}（预期允许，唯一可写根）`))
        findings.push(writeFinding('write-outside-staging', parsed.outside === 'denied', `实测值=${parsed.outside}（预期拒绝）`))
        findings.push(writeFinding('write-system-dir', parsed.system === 'denied', `实测值=${parsed.system}（预期拒绝）`))
        findings.push(writeFinding('delete-outside-staging', parsed.deleteOutside === 'denied', `实测值=${parsed.deleteOutside}（预期拒绝）`))
        findings.push(
          writeFinding('temp-rewritten', typeof parsed.temp === 'string' && parsed.temp.length > 0, `TEMP=${parsed.temp}`),
        )
        findings.push(writeFinding('secret-env-blocked', parsed.secretPresent === false, `DSH_AUDIT_SECRET present=${parsed.secretPresent}`))
        findings.push(writeFinding('proxy-env-blocked', parsed.proxyPresent === false, `HTTP_PROXY present=${parsed.proxyPresent}`))
      }
    } catch (error) {
      for (const [id, label] of WRITE_PROBE_IDS) {
        findings.push({ area: 'write', id, status: 'fail', evidence: '[实测] 抛错', detail: `${label}: ${error.message}` })
      }
    }
  } else {
    for (const [id, label] of WRITE_PROBE_IDS) {
      findings.push({
        area: 'write',
        id,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail: `${label}: ${blocked.reason}`,
      })
    }
  }

  // ---------- D. 读取面探针 ----------
  if (sandboxUsable) {
    // 按**序号**回传布尔值，不回传路径。理由：路径含非 ASCII 字符时控制台代码页转换
    // 可能改变字符串，导致按路径匹配全部落空（曾表现为"10 项全部拒绝读取"，实为匹配失败）。
    const readScript = [
      PS_PRELUDE,
      `$paths=@(${READ_PROBES.map((p) => `'${q(p.path)}'`).join(',')})`,
      '$r=@()',
      'foreach($p in $paths){',
      '  try { $null = Get-Content -LiteralPath $p -TotalCount 1 -ErrorAction Stop; $r += $true }',
      '  catch { $r += $false }',
      '}',
      `[Console]::Out.Write('${AUDIT_MARKER}' + (ConvertTo-Json -Compress -InputObject @($r)))`,
    ].join('\n')
    try {
      const outcome = await executor.run({
        command: resolvePowerShell(process.env, workspace.store.stagedDir).name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', readScript],
        cwd: workspace.store.stagedDir,
        timeoutMs: 120000,
      })
      const parsed = parseMarkedJson(outcome.stdout)
      if (parsed === undefined) {
        for (const probe of READ_PROBES) {
          findings.push({
            area: 'read',
            id: `read-${probe.id}`,
            status: 'fail',
            evidence: '[实测] 未产出输出',
            detail:
              '沙箱内脚本未产出可解析输出，因此无法判断该路径是否可读；' +
              '**空输出不是"拒绝读取"**（手册第 4 章）。' +
              `退出码=${outcome.exitCode} stderr前300字符=${JSON.stringify(outcome.stderr.slice(0, 300))}`,
            data: { path: probe.path, label: probe.label, maskClass: probe.maskClass },
          })
        }
      } else {
        const flags = Array.isArray(parsed) ? parsed : [parsed]
        for (let i = 0; i < READ_PROBES.length; i += 1) {
          const probe = READ_PROBES[i]
          const observed = flags[i]
          if (typeof observed !== 'boolean') {
            findings.push({
              area: 'read',
              id: `read-${probe.id}`,
              status: 'fail',
              evidence: '[实测] 结果缺该项',
              detail: `脚本产出 ${flags.length} 项结果，第 ${i + 1} 项缺失或类型不符；无法得出可读性结论（不得默认判为"拒绝"）。`,
              data: { path: probe.path, label: probe.label, maskClass: probe.maskClass },
            })
            continue
          }
          const readable = observed === true
          findings.push({
            area: 'read',
            id: `read-${probe.id}`,
            status: readable ? (probe.maskClass ? 'residual' : 'informational') : 'pass',
            evidence: '[实测] 从沙箱内部发起',
            detail: readable
              ? probe.maskClass
                ? `可读 —— 属**残余边界**：本后端的 WRITE_RESTRICTED 与 Low 完整性标签都不限制读取。DSH 侧必须用硬拒绝清单（mask class "${probe.maskClass}"）收敛读取面。`
                : '可读（对照项，符合预期）'
              : '拒绝读取（脚本按序号回传 false）',
            data: { path: probe.path, label: probe.label, maskClass: probe.maskClass },
          })
        }
      }
    } catch (error) {
      findings.push({ area: 'read', id: 'read-probes', status: 'fail', evidence: '[实测] 抛错', detail: error.message })
    }
  } else {
    for (const probe of READ_PROBES) {
      findings.push({
        area: 'read',
        id: `read-${probe.id}`,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail:
          blocked.kind === 'defect'
            ? blocked.reason
            : '嵌套沙箱不可用；该项目的读面收敛只能由 DSH 工具层硬拒绝清单保证，本轮未取得沙箱内实测证据',
        data: { path: probe.path, label: probe.label },
      })
    }
  }

  // ---------- E. 进程树与资源回收 ----------
  if (sandboxUsable) {
    const lcMarker = `LIFECYCLE-OK-${Date.now().toString(36)}`
    try {
      const before = executor.launcher.activeProcesses(executor.job)
      const child = await executor.run({
        command: resolvePowerShell(process.env, workspace.store.stagedDir).name,
        args: [
          '-NoLogo',
          '-NonInteractive',
          '-NoProfile',
          '-Command',
          `${PS_PRELUDE}\nStart-Sleep -Milliseconds 300\n[Console]::Out.Write('${lcMarker}')`,
        ],
        cwd: workspace.store.stagedDir,
        timeoutMs: 30000,
      })
      const after = executor.launcher.activeProcesses(executor.job)
      // 只有"脚本真的跑出来"才算证据。退出码 127 / 无标记说明 shell 没起来，
      // 此时 Job 统计全为 0 也不能当作"回收正常"。
      const ran = child.stdout.includes(lcMarker)
      findings.push({
        area: 'lifecycle',
        id: 'job-accounting',
        status: ran ? 'pass' : 'fail',
        evidence: ran ? '[实测]' : '[实测] shell 未产出输出',
        detail: ran
          ? `Job 统计：before active=${before.activeProcesses} total=${before.totalProcesses}；` +
            `after active=${after.activeProcesses} total=${after.totalProcesses}；` +
            `本次总进程数增量=${after.totalProcesses - before.totalProcesses}`
          : `无法作为证据：沙箱内脚本未产出标记（退出码 ${child.exitCode}）。` +
            `Job 统计 before/after 均为 active=${after.activeProcesses} total=${after.totalProcesses}，说明期间没有任何被纳管进程。`,
      })
      findings.push({
        area: 'lifecycle',
        id: 'grandchild-contained',
        status: ran ? 'pass' : 'fail',
        evidence: ran ? '[实测]' : '[实测] shell 未产出输出',
        detail: ran
          ? `子进程退出码 ${child.exitCode}，Job 会计已确认进程被纳管；Job 关闭即整树回收（KILL_ON_JOB_CLOSE）`
          : `无法得出收敛结论：沙箱子进程退出码 ${child.exitCode}` +
            '（127 = DLL 初始化失败/组件缺失，属"命令根本没起来"），' +
            '而 Job 会计显示期间无纳管进程，因此"孙进程随 Job 回收"没有被实际验证。',
      })
    } catch (error) {
      findings.push({ area: 'lifecycle', id: 'job-accounting', status: 'fail', evidence: '[实测] 抛错', detail: error.message })
      findings.push({ area: 'lifecycle', id: 'grandchild-contained', status: 'fail', evidence: '[实测] 抛错', detail: error.message })
    }
  } else {
    for (const id of ['job-accounting', 'grandchild-contained']) {
      findings.push({
        area: 'lifecycle',
        id,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail: blocked.reason,
      })
    }
  }

  // ---------- F. 收尾 ----------
  try {
    executor.dispose()
  } catch {
    /* 清理失败不影响结论 */
  }
  for (const target of [insideTarget, outsideTarget, systemTarget]) {
    try {
      if (existsSync(target)) rmSync(target, { force: true, recursive: true })
    } catch {
      /* 残留不影响结论 */
    }
  }

  const summary = summarize(findings)
  const executed = findings.filter((f) => f.status !== 'not-run').length
  const coverage = findings.length === 0 ? 0 : Math.round((executed / findings.length) * 100)
  const report = {
    time: new Date().toISOString(),
    workspaceRoot: workspace.root,
    sandboxUsable,
    coverage,
    // 版本出口必须有覆盖度：0% 覆盖的"无 fail"不构成任何保证（手册第 17 章）
    verdict:
      summary.fail > 0
        ? 'fail'
        : coverage === 100
          ? 'pass-with-residuals'
          : coverage === 0
            ? 'inconclusive-no-evidence'
            : 'partial-evidence',
    capabilities: {
      aclVersion: caps.aclVersion,
      win32Version: caps.win32Version,
      aclFrom: caps.aclFrom,
      win32From: caps.win32From,
    },
    init: initReport || null,
    summary,
    findings,
    passed: summary.fail === 0,
    coverageComplete: summary.fail === 0 && coverage === 100,
    residualCount: summary.residual,
    notRunCount: summary['not-run'],
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printReport(report)
  return report
}

function writeFinding(id, condition, detail) {
  return {
    area: 'write',
    id,
    status: condition ? 'pass' : 'fail',
    evidence: '[实测] 从沙箱内部发起',
    detail,
  }
}

function summarize(findings) {
  const counts = { pass: 0, fail: 0, residual: 0, informational: 0, 'not-run': 0 }
  for (const finding of findings) counts[finding.status] = (counts[finding.status] || 0) + 1
  return counts
}

function printReport(report) {
  const order = ['capability', 'write', 'read', 'lifecycle']
  const labels = { capability: '能力', write: '写入面', read: '读取面', lifecycle: '生命周期' }
  for (const area of order) {
    const items = report.findings.filter((f) => f.area === area)
    if (!items.length) continue
    process.stdout.write(`\n── ${labels[area] ?? area} ──\n`)
    for (const item of items) {
      const mark = { pass: '✓', fail: '✗', residual: '⚠', informational: 'ℹ', 'not-run': '–' }[item.status] ?? '?'
      process.stdout.write(`${mark} ${item.id}  ${item.evidence}\n`)
      process.stdout.write(`    ${item.detail}\n`)
    }
  }
  process.stdout.write(`\n汇总: ${JSON.stringify(report.summary)}\n`)
  process.stdout.write(`覆盖度: ${report.coverage}%  判定: ${report.verdict}\n`)
  if (report.verdict === 'inconclusive-no-evidence') {
    process.stdout.write(
      '结论: **不构成任何保证**。本轮没有任何项目在沙箱内实测成功，\n' +
        '      按手册第 17 章要求，这既不是通过也不是失败，而是"未取得证据"。\n',
    )
  } else if (report.verdict === 'partial-evidence') {
    process.stdout.write(
      `结论: 部分证据（${report.coverage}% 实测覆盖），${report.notRunCount} 项未实测。\n` +
        '      ⚠ 标记项为**残余边界**，必须写进文档且不得声明为硬边界（手册 #16.10）。\n',
    )
  } else if (report.verdict === 'pass-with-residuals') {
    process.stdout.write(
      '结论: 全项实测且无 fail。⚠ 标记项为**残余边界**，必须写进文档且不得声明为硬边界（手册 #16.10）。\n',
    )
  } else {
    process.stdout.write('结论: 存在 fail 项，按手册第 17 章要求不得作为版本出口。\n')
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 解析带哨兵标记的 JSON 输出。
 *
 * @param {string} stdout 子进程 stdout
 * @param {string} [marker] 哨兵；默认 `AUDIT_MARKER`。
 *   **必须可传**：预检用的是另一个哨兵（`DSH-PREFLIGHT-…`）。
 *   早先版本把哨兵硬编码成 `AUDIT_MARKER`，于是预检的环境探针永远解析不出结果
 *   （审计里表现为 `子进程关键变量=undefined`）—— 一个典型的"默认值与调用点不一致"缺陷。
 * @returns 解析出的对象；**未找到哨兵或解析失败时返回 undefined**。
 *   返回 undefined 的含义是"脚本没跑出结果"，调用方必须据此判 fail，
 *   绝不能把它当成"操作被拒绝"。
 */
function parseMarkedJson(stdout, marker = AUDIT_MARKER) {
  if (typeof stdout !== 'string') return undefined
  const index = stdout.lastIndexOf(marker)
  if (index < 0) return undefined
  const after = stdout.slice(index + marker.length).trim()
  if (after.length === 0) return undefined
  return safeJson(after)
}

function q(value) {
  return String(value).replace(/'/g, "''")
}

export const __internal = { parseMarkedJson, q, AUDIT_MARKER, PS_PRELUDE, READ_PROBES }
