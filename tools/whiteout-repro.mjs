// Reproduce A2's whiteout regression: a single unrelated whiteout marker under
// <stageRoot>\wo breaks PowerShell cmdlet autoloading in injected carriers.
// Usage: node tools/whiteout-repro.mjs [--out-dir <dir>]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const OUT = process.argv.includes('--out-dir')
  ? path.resolve(REPO, process.argv[process.argv.indexOf('--out-dir') + 1])
  : path.join(REPO, 'esc', 'par', 'lead')
const INJ = path.join(OUT, 'winstage-inject.exe')
const DLL = path.join(OUT, 'winstage-shim.dll')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE = path.join(REPO, 'esc', `wo-repro-${Date.now().toString(36)}`)
fs.mkdirSync(BASE, { recursive: true })

const SCRIPT = "Write-Output ('PSOK' + (1+2))"

function run(label, { marker, disableFile = false, verbose = false }) {
  const stage = path.join(BASE, label)
  fs.mkdirSync(stage, { recursive: true })
  if (marker) {
    const wo = path.join(stage, 'wo', ...marker.split('/'))
    fs.mkdirSync(path.dirname(wo), { recursive: true })
    fs.writeFileSync(wo, '')
  }
  const outFile = path.join(stage, 'out.txt')
  const errFile = path.join(stage, 'err.txt')
  const o = fs.openSync(outFile, 'w'); const e = fs.openSync(errFile, 'w')
  let r
  try {
    const args = ['--dll', DLL,
      '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
      '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
      '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`]
    if (disableFile) args.push('--set-env', 'WINSTAGE_SHIM_DISABLE_FILE=1')
    if (verbose) args.push('--set-env', 'WINSTAGE_SHIM_VERBOSE=1')
    args.push('--report', path.join(stage, 'inj.json'), '--', PS, '-NoProfile', '-NonInteractive', '-Command', SCRIPT)
    r = spawnSync(INJ, args, { stdio: ['ignore', o, e], cwd: REPO, timeout: 120000, windowsHide: true })
  } finally { fs.closeSync(o); fs.closeSync(e) }
  const out = fs.readFileSync(outFile, 'utf8').replace(/\s+/g, ' ').trim()
  const err = fs.readFileSync(errFile, 'utf8').replace(/\s+/g, ' ').trim()
  let extra = ''
  if (verbose) {
    const logPath = path.join(stage, 'shim.log')
    const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean) : []
    const interesting = lines.filter((l) => /GetFileAttributes|CreateFile request|WHITEOUT|lockdown|PSScriptPolicy|Module|Utility|not found/i.test(l))
    extra = `\n    log=${lines.length} lines; interesting=${interesting.length}`
    for (const l of interesting.slice(-14)) extra += `\n      ${l.replace('[winstage-shim]', '').slice(0, 200)}`
    fs.writeFileSync(path.join(stage, 'interesting.txt'), interesting.join('\n'))
  }
  return `${label.padEnd(26)} exit=${String(r.status).padStart(4)} out=${JSON.stringify(out)} err=${JSON.stringify(err.slice(0, 140))}${extra}`
}

console.log(run('01-no-whiteout', {}))
console.log(run('02-whiteout-unrelated', { marker: 'C/Windows/Temp/zzz-unrelated.txt' }))
console.log(run('03-whiteout-desktop', { marker: 'C/Users/Administrator/Desktop/zzz.txt' }))
console.log(run('04-whiteout-file-family-off', { marker: 'C/Windows/Temp/zzz-unrelated.txt', disableFile: true }))
console.log(run('05-whiteout-verbose', { marker: 'C/Windows/Temp/zzz-unrelated.txt', verbose: true }))
console.log(run('06-no-whiteout-verbose', { verbose: true }))
console.log(`base: ${BASE}`)
