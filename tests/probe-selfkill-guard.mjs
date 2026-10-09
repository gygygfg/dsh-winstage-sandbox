#!/usr/bin/env node
/**
 * tests\probe-selfkill-guard.mjs — FIX-E 回归测试：`probeWin32Abi()` 绝不允许杀死调用者
 *
 * 背景（[实测] `.t\sbx3\fixE\before-diag-probeabi.out.txt`、`.t\sbx3\fixE\before-cli-probe.out.json`）：
 *   上一轮的 tier 假阴性修复在 `probeWin32Abi()` 里加了
 *       AssignProcessToJobObject(job, GetCurrentProcess())   // 把调用者自己挂进 Job
 *   而该 Job 又置了 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE(0x2000)。自指派在本环境**成功**，
 *   于是 probe 结束时的 `CloseHandle(job)` 被内核解释为"作业关闭 → 杀掉作业内所有进程"，
 *   被杀死的正是调用者：exit=0、stdout/stderr 全 0 字节，异常吞不掉也来不及。
 *   `cli probe/init/audit`、worker 启动探针、插件 probeOnStart 全部因此自杀。
 *
 * 本测试的四组断言：
 *   A. **子进程里** import capability 并调用 `probeWin32Abi()`，必须打印末端哨兵
 *      `SURVIVED-TO-END`、exit=0、stdout 非空 —— 这就是修复前的失败形态。
 *   B. 把"自指派 + KILL_ON_JOB_CLOSE"这一形态**人为装回**（`--child=plant-selfkill`）时，
 *      同一观察方式必须能看到"哨兵前截断" ⇒ 证明本测试**有能力变红**。
 *   C. `node src\cli.mjs probe --json --no-cache` 的输出必须**非空且可解析**（修复前 0 字节）。
 *   D. `jobObject` 判定必须来自**子进程指派 + 回读 accounting** 这条路径（tier 假阴性修复的意图
 *      不得回退），且源码里不得再有自指派语句或 0x2000 标志。
 *   E. **fail-closed 未被放宽**：人为把"派生子进程"这条路弄坏（PLANTED-NOSPAWN）后，`jobObject`
 *      必须如实判 fail，而**调用者仍然存活**（失败路径同样不许自杀）。
 *
 * 为什么子进程输出用**文件 fd 重定向**而不是 `stdio:'pipe'`：
 *   ① 受限令牌下管道会 EPERM（残余边界 R10）；
 *   ② 本故障的表征恰恰是"exit=0 且输出为空"，用文件才能把
 *      "exit=0/空" 与 "exit=0/非空" 区分开（缺陷 11 的又一形态）。
 *
 * 用法：
 *   node tests\probe-selfkill-guard.mjs                          # 绿档（全断言）
 *   node tests\probe-selfkill-guard.mjs --plant-selfkill         # 红档：装回旧形态后重跑断言 A3
 *   node tests\probe-selfkill-guard.mjs --static-only --source-file <path>   # 只跑静态断言
 *   node tests\probe-selfkill-guard.mjs --target-module <path>   # 对指定 capability.mjs 跑动态断言
 *
 * 退出码：0 = 全绿；1 = 有断言失败。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WINDOWS_HIDE, suppressWindowsCriticalErrorDialogs } from '../src/spawn-window.mjs'

suppressWindowsCriticalErrorDialogs()

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const W = (s) => process.stdout.write(`${s}\n`)
const flagValue = (name, fallback) => {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`))
  if (withEq) return withEq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return fallback
}
const CHILD = flagValue('child', null)
const excerpt = (s, n = 320) => JSON.stringify(String(s).replace(/\s+/g, ' ').slice(0, n))
/** 被测模块 / 静态检查对象：默认仓库里的 src\capability.mjs */
const TARGET = resolve(flagValue('target-module', join(REPO, 'src', 'capability.mjs')))
const SOURCE = resolve(flagValue('source-file', join(REPO, 'src', 'capability.mjs')))
// 每一档用**独立**的输出目录：否则红档会把绿档的原始证据覆盖掉（"证据被后来的运行吃掉"）
const SCRATCH = join(REPO, '.t', 'sbx3', 'fixE', 'guard-scratch', dirname(TARGET).split(/[\\/]/).pop())

// ─────────────────────────── 子进程模式（被下面的运行器调用）───────────────────────────
if (CHILD === 'probe') {
  // 断言 A/D 的被测对象：真的在**子进程**里 import capability 并跑 probeWin32Abi()
  const target = flagValue('target-module', join(REPO, 'src', 'capability.mjs'))
  W(`CHILD-TARGET ${target}`)
  const mod = await import(pathToFileURL(target).href)
  W('CHILD-IMPORTED')
  const report = mod.probeWin32Abi()
  W(`CHILD-PROBE ${JSON.stringify(report?.checks?.jobObject ?? null)}`)
  W('SURVIVED-TO-END')
  process.exit(0)
}

if (CHILD === 'plant-selfkill') {
  // 断言 B：把 FIX-E 之前的形态**内联装回**（与 capability.mjs 当前内容无关，
  // 因此即使将来有人改回源码，本形态的可观测性证明依然成立）。
  const { loadFfi } = await import(pathToFileURL(join(REPO, 'src', 'capability.mjs')).href)
  const koffi = loadFfi()
  if (!koffi) {
    W('PLANT-SKIP koffi unavailable')
    W('SURVIVED-TO-END')
    process.exit(0)
  }
  const kernel32 = koffi.load('kernel32.dll')
  const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *a, const char16_t *name)')
  const SetInformationJobObject = kernel32.func('bool SetInformationJobObject(void *job, int infoClass, void *info, uint32 len)')
  const AssignProcessToJobObject = kernel32.func('bool AssignProcessToJobObject(void *job, void *process)')
  const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()')
  const CloseHandleK = kernel32.func('bool CloseHandle(void *h)')
  const GetLastError = kernel32.func('uint32 GetLastError()')
  W('PLANT-ARMED')
  const job = CreateJobObjectW(null, null)
  const info = Buffer.alloc(144)
  info.writeUInt32LE(0x2000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, info, info.length)
  const assigned = AssignProcessToJobObject(job, GetCurrentProcess()) === true
  W(`PLANT-ASSIGNED=${assigned} err=${assigned ? 0 : GetLastError()}`)
  CloseHandleK(job) // ← 旧形态的杀招：关句柄即杀掉调用者
  // 自指派成功的话这里已经不可达；留一点时间给内核终结本进程
  await new Promise((r) => setTimeout(r, 300))
  W('SURVIVED-TO-END')
  process.exit(0)
}

// ─────────────────────────── 运行器 ───────────────────────────
mkdirSync(SCRATCH, { recursive: true })

/** 起一个子 node，stdout/stderr 直接落到文件（**不用管道**） */
const runNode = (args, outName) => {
  const outFile = join(SCRATCH, outName)
  const fd = openSync(outFile, 'w')
  let r
  try {
    r = spawnSync(process.execPath, args, {
      cwd: REPO,
      stdio: ['ignore', fd, fd],
      // 见 src/spawn-window.mjs：不用会 0xC0000142 的那组创建标志；
      // 弹框由该模块的 SetErrorMode 抑制。
      windowsHide: WINDOWS_HIDE,
      timeout: 180_000,
    })
  } finally {
    closeSync(fd)
  }
  const stdout = readFileSync(outFile, 'utf8')
  return {
    status: r.status,
    signal: r.signal ?? null,
    error: r.error ? `${r.error.code ?? r.error.name}: ${r.error.message}` : null,
    bytes: Buffer.byteLength(stdout),
    stdout,
    outFile,
  }
}
const runChild = (mode, outName, extra = []) => runNode([SELF, `--child=${mode}`, ...extra], outName)

let assertions = 0
let failures = 0
const skips = []
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  // 用 ASCII 标记而不是 ✓/✗：证据文件是 UTF-8，但 cmd/PowerShell 5.1 控制台按 OEM
  // 代码页解码，非 ASCII 标记会变成乱码，进而让"红还是绿"看起来一样（缺陷 11 的形态）。
  W(`  [${ok ? 'OK  ' : 'FAIL'}] ${name}`)
  if (detail) W(`      证据: ${detail}`)
}
const skip = (name, reason) => {
  skips.push(name)
  W(`  [SKIP] ${name} —— ${reason}`)
}

/** 剥掉注释再做静态断言：FIX-E 的说明注释里**必然**会提到被禁的旧写法 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]\/\/.*$/, ''))
    .join('\n')

// ── 红档：把旧形态装回后重跑断言 A3（可失败性演示）───────────────────────────
if (argv.includes('--plant-selfkill')) {
  W('=== 红档演示：把"自指派 + KILL_ON_JOB_CLOSE"装回后重跑断言 A3 ===')
  const p = runChild('plant-selfkill', 'red-plant-selfkill.out.txt')
  W(`  子进程 exit=${p.status} signal=${p.signal ?? '-'} bytes=${p.bytes}`)
  W(`  子进程输出: ${excerpt(p.stdout)}`)
  const armed = p.stdout.includes('PLANT-ASSIGNED=true')
  check(
    'A3（红档）子进程必须打印末端哨兵 SURVIVED-TO-END',
    p.stdout.includes('SURVIVED-TO-END'),
    `旧形态装配=${armed ? '成功' : '未成功'} exit=${p.status} bytes=${p.bytes} 输出在哨兵前截断=${!p.stdout.includes('SURVIVED-TO-END')}`,
  )
  W('')
  W(`断言 ${assertions} 项，失败 ${failures} 项`)
  W(
    failures
      ? '结论: 红档符合预期 —— 旧形态确实会杀死调用者，因此本测试具备"能失败"的能力'
      : '结论: 意外全绿 —— 本测试可能已经无法检出该缺陷！',
  )
  process.exit(failures ? 1 : 0)
}

W('=== probeWin32Abi 自杀死回归测试（FIX-E）===')
W(`  被测模块 TARGET = ${TARGET}`)
W(`  静态检查 SOURCE = ${SOURCE}`)
W(`  子进程原始输出目录 = ${SCRATCH}`)
W('')

// ── 断言 A：子进程中调用 probeWin32Abi() 后必须活着走到末尾 ───────────────────
W('=== A. 子进程里 import capability + probeWin32Abi() 必须存活 ===')
const probe = runChild('probe', 'green-child-probe.out.txt', [`--target-module=${TARGET}`])
W(`  子进程 exit=${probe.status} signal=${probe.signal ?? '-'} bytes=${probe.bytes} out=${probe.outFile}`)
check(
  'A1 子进程 exit=0 且没有信号（不是被内核终结）',
  probe.status === 0 && probe.signal === null,
  `status=${probe.status} signal=${probe.signal ?? '-'} error=${probe.error ?? '-'}`,
)
check(
  'A2 子进程 stdout 非空（"exit=0 且全 0 字节"正是本故障的表征）',
  probe.bytes > 0,
  `${probe.bytes} 字节 → ${probe.outFile}`,
)
check('A3 子进程打印末端哨兵 SURVIVED-TO-END', probe.stdout.includes('SURVIVED-TO-END'), `输出=${excerpt(probe.stdout)}`)

let probeJob
const probeLine = probe.stdout.split('\n').find((l) => l.startsWith('CHILD-PROBE '))
if (probeLine) {
  try {
    probeJob = JSON.parse(probeLine.slice('CHILD-PROBE '.length))
  } catch {
    probeJob = undefined
  }
}
check('A4 子进程回传的 jobObject 证据行可解析为 JSON', probeJob !== undefined && probeJob !== null, `行=${excerpt(probeLine ?? '(缺失)')}`)
W('')

// ── 断言 B：装回旧形态后，同一观察方式必须变红（本测试"能失败"的证明）──────────
W('=== B. 装回"自指派 + KILL_ON_JOB_CLOSE"形态：必须观测到哨兵前截断 ===')
const plant = runChild('plant-selfkill', 'green-child-plant.out.txt')
W(`  子进程 exit=${plant.status} signal=${plant.signal ?? '-'} bytes=${plant.bytes} out=${plant.outFile}`)
if (plant.stdout.includes('PLANT-SKIP')) {
  skip('B 旧形态可观测性', '本环境 koffi 不可用，无法装配旧形态')
} else if (plant.stdout.includes('PLANT-ASSIGNED=false')) {
  skip('B 旧形态可观测性', '本环境自指派失败（外层 Job 限制），旧形态在此无法装配 —— 修复前该分支也不会被走到')
} else {
  check('B1 旧形态确实跑到装配点（PLANT-ARMED，且自指派成功）', plant.stdout.includes('PLANT-ARMED') && plant.stdout.includes('PLANT-ASSIGNED=true'), `输出=${excerpt(plant.stdout)}`)
  check(
    'B2 旧形态下子进程在哨兵前被截断（= 断言 A3 会变红）',
    !plant.stdout.includes('SURVIVED-TO-END'),
    `exit=${plant.status} bytes=${plant.bytes} 输出=${excerpt(plant.stdout)}`,
  )
  check(
    'B3 两种形态的观测量确实不同（对照：修复后可达哨兵）',
    probe.stdout.includes('SURVIVED-TO-END') && !plant.stdout.includes('SURVIVED-TO-END'),
    `fix=${probe.stdout.includes('SURVIVED-TO-END') ? '到哨兵' : '未到'} plant=${plant.stdout.includes('SURVIVED-TO-END') ? '到哨兵' : '截断'}`,
  )
}
W('')

// ── 断言 C：cli probe --json 必须非空且可解析 ────────────────────────────────
W('=== C. `cli probe --json --no-cache` 输出必须非空且可解析 ===')
const cliWs = join(SCRATCH, 'cli-ws')
mkdirSync(cliWs, { recursive: true })
const cli = runNode(
  [join(REPO, 'src', 'cli.mjs'), 'probe', '--json', '--workspace', cliWs, '--no-cache'],
  'green-cli-probe.json',
)
W(`  cli exit=${cli.status} bytes=${cli.bytes} out=${cli.outFile}`)
check('C1 cli probe --json exit=0', cli.status === 0, `status=${cli.status} error=${cli.error ?? '-'}`)
check('C2 cli probe --json stdout 非空（修复前为 0 字节）', cli.bytes > 0, `${cli.bytes} 字节 → ${cli.outFile}`)
let report
let jsonError = null
try {
  report = JSON.parse(cli.stdout)
} catch (error) {
  report = undefined
  jsonError = error.message
}
check('C3 输出是可解析 JSON', report !== undefined && report !== null, jsonError ? `JSON.parse: ${jsonError}` : 'parse ok')
check(
  'C4 JSON 里 tier 字段可读',
  typeof report?.tier?.tier === 'string' && report.tier.tier.length > 0,
  `tier=${JSON.stringify(report?.tier?.tier)} name=${JSON.stringify(report?.tier?.name)}`,
)
const cliJob = report?.win32?.checks?.jobObject
check('C5 JSON 里 win32.checks.jobObject 存在', cliJob !== undefined && cliJob !== null, `jobObject=${excerpt(JSON.stringify(cliJob ?? null))}`)
W('')

// ── 断言 D：jobObject 判定必须来自子进程指派路径（tier 修复意图不得回退）────────
// ── 套件分类（Lead 指示）：与 `diag-bindings` / `audit` 归为同一类 ────────────────
// `[实测]` 受限会话（无 SeDebugPrivilege 的 OpenProcess 权限）下，探测够不到
// "指派 + 回读 accounting"：派生的 `ping.exe` 子进程 `OpenProcess(pid, …)` 返回 NULL 且
// `GetLastError=5`（ACCESS_DENIED）。这是**会话边界**，不是产品缺陷：
// `src\capability.mjs` 因此把它记成 `unknown` + `boundary:'open-process-denied'`
// （**不是** pass；`selectTier()` 要求 `status=PASS`，unknown 与 fail 在档位上等价 ⇒
// fail-closed 未被放宽）。本段据此打印**机器可读**分类标记，并**只**跳过
// "指派成功路径"那一条（D4），其余断言照跑；任何**其它**形态一律判 fail。
W('=== D. jobObject 判定来源必须仍是"子进程指派 + 回读 accounting" ===')
const judged = probeJob ?? cliJob
const sessionBoundary = judged?.status === 'unknown' && judged?.boundary === 'open-process-denied'
W(`SUITE-CLASS: ${sessionBoundary ? 'requires-unconstrained-session' : 'offline-deterministic'}`)
if (sessionBoundary) {
  check(
    'D1（需未受限会话）OpenProcess 被拒 ⇒ 必须记 unknown + boundary=open-process-denied（**不得**记 pass）',
    judged.status === 'unknown' &&
      judged.boundary === 'open-process-denied' &&
      judged.win32Code === 5 &&
      judged.childSpawned === true &&
      judged.selfAssigned !== true,
    `status=${judged.status} boundary=${judged.boundary} win32Code=${judged.win32Code} childSpawned=${judged.childSpawned} detail=${excerpt(judged.detail)}`,
  )
  check(
    'D2（需未受限会话）fail-closed 未被放宽：unknown ≠ pass（`selectTier` 要求 status=pass）',
    judged.status !== 'pass',
    `status=${judged.status}（原始错误码 GetLastError=${judged.win32Code}，pid=${judged.childPid}）`,
  )
  skip(
    'D4 指派后回读 accounting（success 路径）',
    `本会话 OpenProcess(pid=${judged.childPid}) 被拒（GetLastError=${judged.win32Code} ACCESS_DENIED，会话边界）；` +
      '成功路径需在未受限会话复跑（Lead 已在该会话实测 28/0）',
  )
} else {
  check('D1 jobObject 判定仍为 pass（fail-closed 未被放宽，但也不能误判为 fail）', judged?.status === 'pass', `status=${judged?.status} detail=${excerpt(judged?.detail ?? '')}`)
  check('D2 判定来源是子进程指派（verifiedVia=child-process，而不是 self）', judged?.verifiedVia === 'child-process', `verifiedVia=${JSON.stringify(judged?.verifiedVia)}`)
  check(
    'D4 证据里含指派后**回读**的 accounting 且 totalProcesses>=1',
    judged?.accounting?.total >= 1,
    `accounting=${JSON.stringify(judged?.accounting ?? null)}`,
  )
}
check(
  'D3 证据里含真实派生出的子进程 pid',
  Number.isInteger(judged?.childPid) && judged.childPid > 0 && judged?.childSpawned === true,
  `childPid=${judged?.childPid} childKind=${judged?.childKind} childSpawned=${judged?.childSpawned}`,
)
check('D5 证据里没有自指派成功（selfAssigned 不为 true，也没有 self 分支）', judged?.selfAssigned !== true, `selfAssigned=${JSON.stringify(judged?.selfAssigned)}`)
W('')

// ── 断言 D（静态）：源码里不得再出现自指派语句与 0x2000 ─────────────────────
W('=== D. 静态：capability.mjs 不得再含自指派 / KILL_ON_JOB_CLOSE ===')
const raw = readFileSync(SOURCE, 'utf8')
const code = stripComments(raw)
if (!argv.includes('--static-only')) W(`  （动态断言 D1-D5 已在上方完成）`)
check(
  'D6 静态：无 `AssignProcessToJobObject(job, GetCurrentProcess())`',
  !/AssignProcessToJobObject\(\s*job\s*,\s*GetCurrentProcess\(\)\s*\)/.test(code),
  `SOURCE=${SOURCE}`,
)
check('D7 静态：无 KILL_ON_JOB_CLOSE 标志 0x2000', !/0x2000/.test(code), `SOURCE=${SOURCE}`)
check(
  'D8 静态：注释剥离器没把代码吃空（防 D6/D7 变成空断言）',
  code.includes('spawnAssignmentProbe') && code.includes('accountingOf') && code.length > raw.length * 0.5,
  `raw=${raw.length} 字节 code=${code.length} 字节`,
)
W('')

// ── 断言 E：拿不到任何指派证据时必须 fail（fail-closed 不放宽），且调用者仍存活 ──
W('=== E. 人为弄坏"派生子进程"这条路：必须判 fail 且调用者仍存活 ===')
/**
 * 造一个"无法派生子进程"的变体：整棵 src 复制到 scratch 下（保住 `./executor.mjs` 等相对
 * import），只在 `spawnAssignmentProbe()` 开头插一句无条件 `return undefined`。
 * 这是对**修复意图**的反向验证：tier 假阴性修复要求"能证明就 pass"，
 * 但**不能**顺手把"证明不了"也放宽成 pass。
 */
const buildNoSpawnVariant = () => {
  const dir = join(SCRATCH, 'no-spawn-src')
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(REPO, 'src'), dir, { recursive: true })
  const file = join(dir, 'capability.mjs')
  const src = readFileSync(file, 'utf8')
  const from = `  const spawnAssignmentProbe = () => {\n    const { spawn } = require_('node:child_process')`
  if (src.split(from).length - 1 !== 1) return undefined
  const to = `  const spawnAssignmentProbe = () => {\n    // [PLANTED-NOSPAWN] 强制走"拿不到任何指派证据"的失败路径\n    if (true) return undefined\n    const { spawn } = require_('node:child_process')`
  writeFileSync(file, src.replace(from, to), 'utf8')
  return file
}
const noSpawn = argv.includes('--static-only') ? null : buildNoSpawnVariant()
if (argv.includes('--static-only')) {
  skip('E fail-closed 反向验证', '--static-only 只跑静态断言')
} else if (!noSpawn) {
  skip('E fail-closed 反向验证', '找不到 spawnAssignmentProbe 的锚点，变体未生成')
} else {
  const r = runChild('probe', 'green-child-nospawn.out.txt', [`--target-module=${noSpawn}`])
  W(`  子进程 exit=${r.status} bytes=${r.bytes} out=${r.outFile}`)
  let noSpawnJob
  const line = r.stdout.split('\n').find((l) => l.startsWith('CHILD-PROBE '))
  if (line) {
    try {
      noSpawnJob = JSON.parse(line.slice('CHILD-PROBE '.length))
    } catch {
      noSpawnJob = undefined
    }
  }
  check(
    'E1 失败路径上调用者仍然存活（exit=0 + 哨兵，证明不自杀与判定无关）',
    r.status === 0 && r.stdout.includes('SURVIVED-TO-END'),
    `status=${r.status} 输出=${excerpt(r.stdout)}`,
  )
  check(
    'E2 拿不到指派证据时 jobObject 必须判 fail（fail-closed 未被放宽）',
    noSpawnJob?.status === 'fail',
    `status=${JSON.stringify(noSpawnJob?.status)} detail=${excerpt(noSpawnJob?.detail ?? '')}`,
  )
  check(
    'E3 fail 的理由必须如实写明"无法证明进程树回收"',
    typeof noSpawnJob?.detail === 'string' && noSpawnJob.detail.includes('cannot prove process-tree reclamation'),
    `detail=${excerpt(noSpawnJob?.detail ?? '')}`,
  )
}
W('')

// ── 断言 F（静态）：T0 闸门不得被"顺手放宽"───────────────────────────────────
W('=== F. 静态：T0 闸门必须只认实测证据（fail-closed 不得被绕过）===')
/**
 * 为什么这些断言放在"自杀死守卫"这个套件里：
 * 那个 P0 的成因是"为了让 tier 判定更好看而顺手改判定"。同一条路上紧跟着的第二个诱惑是
 * "为了让 T0 可选而硬写 `proven: true`" —— 动机、形态、后果都是同一族
 * （把判定改成想要的样子，而不是让证据说话）。因此把 T0 闸门的静态不变量钉在这里。
 *
 * 四条不变量：
 *   F1  `selectTier` 只读 `appContainerIsolation.proven === true`；
 *   F2  源码里**没有**任何 `proven: true` / `proven = true` 的写入
 *       （`proven` 只能由 `assessAppContainerIsolation()` 推导）；
 *   F3  真实测量的调用点用的是 `readProcessTokenFacts` + `assessAppContainerIsolation`
 *       （**同一份实现**，不允许在探测侧另写一套判据）；
 *   F4  隔离探针**不是无条件真跑**：存在纯决策函数与显式开关解析。
 */
const codeForGate = stripComments(raw)
check(
  'F1 selectTier 的 T0 条件仍是 `report.appContainerIsolation?.proven === true`（严格比较，不是真值判断）',
  /appContainerIsolation\?\.proven === true/.test(codeForGate),
  `SOURCE=${SOURCE}`,
)
check(
  'F2 源码里没有任何地方直接写 `proven: true` / `proven = true`（硬编码即最坏形态）',
  !/proven\s*[:=]\s*true/.test(codeForGate),
  `命中=${excerpt((codeForGate.match(/proven\s*[:=]\s*true/g) ?? []).join(','))}`,
)
check(
  'F3 真实测量调用点同时用到 readProcessTokenFacts 与 assessAppContainerIsolation（判据同源）',
  codeForGate.includes('readProcessTokenFacts') && codeForGate.includes('assessAppContainerIsolation'),
  `readProcessTokenFacts=${codeForGate.includes('readProcessTokenFacts')} assessAppContainerIsolation=${codeForGate.includes('assessAppContainerIsolation')}`,
)
check(
  'F4 隔离探针默认不无条件真跑：存在"何时真跑"的纯决策函数、显式开关解析与 TTL 缓存键',
  codeForGate.includes('planAppContainerIsolationProbe') &&
    codeForGate.includes('readAppContainerIsolationSwitches') &&
    codeForGate.includes('APPCONTAINER_ISOLATION_TTL_MS'),
  'planAppContainerIsolationProbe / readAppContainerIsolationSwitches / APPCONTAINER_ISOLATION_TTL_MS',
)
// F2 的**判定力**反证：把 `proven: true` 人为种进一份源码副本，同一条正则必须命中。
// 不做这一步的话，F2 有可能是一条"永远为真"的空断言（正则写错时最典型）。
{
  const planted = `${codeForGate}\nconst plantedGate = { proven: true }\n`
  check(
    'F5 F2 的正则确实有判定力（把 `proven: true` 种进副本后必须命中）',
    /proven\s*[:=]\s*true/.test(planted),
    '红档自证：planted 副本命中 `proven: true`',
  )
}
W('')

W('='.repeat(64))
W(`断言 ${assertions} 项，失败 ${failures} 项${skips.length ? `，跳过 ${skips.length} 项（${skips.join('; ')}）` : ''}`)
W(`结果: ${failures ? 'FAIL' : 'ALL PASS'}（exit=${failures ? 1 : 0}）`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
