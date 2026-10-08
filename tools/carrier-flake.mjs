// Quantify the flaky PowerShell carrier crash right after injection.
// Usage: node tools/_ps-flake.mjs [dllPath] [iterations]
//
// Exit codes: this tool is an informer and normally exits 0 even when carriers
// fail (the failure count is the product verdict). A missing/corrupt shim tree
// is NOT a product verdict, so it exits 2 (ENVIRONMENT) instead of printing a
// false "N carrier failures".
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { artifactNames, checkArtifactIntegrity } from './build-shim.mjs'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const OUT = process.argv.includes('--out-dir')
  ? path.resolve(REPO, process.argv[process.argv.indexOf('--out-dir') + 1])
  : path.join(REPO, 'shim', 'out')
const INJ = path.join(OUT, 'winstage-inject.exe')
const DLL = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : path.join(OUT, 'winstage-shim.dll')
const ITER = Number(process.argv.find((a) => /^\d+$/.test(a)) || 10)
const DIRECT = process.argv.includes('--direct')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE = path.join(REPO, 'esc', `ps-flake-${Date.now().toString(36)}`)

// Preflight: a quarantined/absent winstage-inject.exe (Defender) or a partial
// build would otherwise be measured as carrier flakiness. Reuse build-shim's
// integrity check so "missing/corrupt artifact" is an ENVIRONMENT error (exit 2).
const ENV_UNAVAILABLE_EXIT = 2
{
  const rep = checkArtifactIntegrity(OUT, artifactNames('full'))
  if (!rep.ok) {
    const bad = [...rep.missing, ...rep.malformed.map((m) => m.name)]
    console.error(`ENVIRONMENT UNAVAILABLE: missing/corrupt ${bad.join(', ')}; run node tools/build-shim.mjs`)
    process.exit(ENV_UNAVAILABLE_EXIT)
  }
}

const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Write-Output ('SMOKE-PS-' + (1+1))"]
let crashes = 0
const rows = []
for (let i = 1; i <= ITER; i++) {
  const stage = path.join(BASE, `run-${i}`)
  fs.mkdirSync(stage, { recursive: true })
  const outFile = path.join(stage, 'out.txt')
  const errFile = path.join(stage, 'err.txt')
  const rep = path.join(stage, 'inject.json')
  const o = fs.openSync(outFile, 'w'); const e = fs.openSync(errFile, 'w')
  let r
  try {
    if (DIRECT) {
      r = spawnSync(PS, args, { stdio: ['ignore', o, e], cwd: REPO, timeout: 120000, windowsHide: true })
    } else {
    r = spawnSync(INJ, ['--dll', DLL,
      '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
      '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
      '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`,
      // Verbose used to be forced here, which amplified the shim's own LastError
      // clobbering (a post-call log leaves ERROR_ALREADY_EXISTS=183 in the thread
      // and the CLR aborts with 0x800700b7). Production does not run verbose, so
      // measure the production path unless --verbose is asked for explicitly.
      ...(process.argv.includes('--verbose') ? ['--set-env', 'WINSTAGE_SHIM_VERBOSE=1'] : []),
      '--report', rep, '--timeout-ms', '60000',
      // ★ round-4：**不要**在这里加短 `--child-timeout-ms`。它看着像"清理"，实际是个观测旋钮：
      // 任何"慢但会成功"的载体（冷缓存、Defender 正在扫刚构建的 DLL）都会被判死成
      // `exit=0x7c`（124 = 注入器的超时码），把假失败混进真实率里（实测 8% 被抬到 27.5%）。
      // 清理**已经不需要它**了：注入器把孩子收进了 `KILL_ON_JOB_CLOSE` 的 Job，
      // 所以即使下面 `spawnSync` 在 120 s 时杀掉**注入器**，内核也会连带终止载体 —— 不再有孤儿。
      '--',
      PS, ...args], { stdio: ['ignore', o, e], cwd: REPO, timeout: 120000, windowsHide: true })
    }
  } finally { fs.closeSync(o); fs.closeSync(e) }
  const stdout = fs.readFileSync(outFile, 'utf8')
  const stderr = fs.readFileSync(errFile, 'utf8')
  const code = r.status
  const ok = code === 0 && /SMOKE-PS-2/.test(stdout)
  if (!ok) crashes++
  // ★ round-4：`r.status === null` 表示**进程没有给出退出码**（被上面的 `timeout` 杀掉、
  // 或创建失败）。旧代码把它当 0 打印（`null >>> 0 === 0` ⇒ `exit=0x0`），于是"挂住超时"
  // 被误报成"静默的 0 退出"，白白掩盖了整个失败族。这里显式区分，并把 signal/error 打出来。
  const timedOut = code === null
  const hex = timedOut ? 'null' : (code >>> 0).toString(16)
  rows.push({ i, code: timedOut ? 'null' : code, hex, ok, signal: r.signal === undefined ? null : r.signal,
    error: r.error ? (r.error.code || String(r.error)) : null,
    stdout: stdout.slice(0, 60), stderr: stderr.slice(0, 80).replace(/\s+/g, ' ') })
  // show the last few shim log lines for failures so the failing call is visible
  if (!ok) {
    const log = path.join(stage, 'shim.log')
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []
    rows[rows.length - 1].lastShimLines = lines.slice(-6)
  }
}
console.log(`dll=${path.basename(DLL)} iterations=${ITER} failures=${crashes}/${ITER}`)
for (const row of rows) {
  console.log(`  #${row.i} exit=${row.hex === 'null' ? 'null(超时/被杀, signal=' + (row.signal || '-') + ', error=' + (row.error || '-') + ')' : '0x' + row.hex} ok=${row.ok} out=${JSON.stringify(row.stdout)} err=${JSON.stringify(row.stderr)}`)
  if (row.lastShimLines) for (const l of row.lastShimLines) console.log(`      ${l.slice(0, 190)}`)
}
