/**
 * environment-gate —— 插件启动环境监测的离线自测。
 *
 * 覆盖 `dsh-plugin/environment-gate.mjs` 的纯判定：
 *   · 关闭 / 显式跳过 ⇒ 放行（且标 skipped）；
 *   · 非 Windows ⇒ 判红（`WINSTAGE_ENV_UNSUPPORTED`）；
 *   · Windows 但受限令牌探测未通过 ⇒ 判红；
 *   · 探测结果缺失 ⇒ 判红；
 *   · 全通过 ⇒ 放行（`WINSTAGE_ENV_OK`）；
 *   · 失败原因是一句可读文本。
 *
 * 运行：node tests/environment-gate.mjs
 */
import { evaluateEnvironment, environmentFailureMessage } from '../dsh-plugin/environment-gate.mjs'

let checks = 0
let failures = 0
const check = (name, ok, detail) => {
  checks += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}\n`)
}

process.stdout.write('=== environment-gate（离线） ===\n')

const off = evaluateEnvironment({ enabled: false, platform: 'win32', probeResult: { ready: true } })
check('关闭开关 ⇒ 放行且标记 skipped', off.ok === true && off.skipped === true && off.code === 'WINSTAGE_DISABLED', JSON.stringify(off))

const skip = evaluateEnvironment({ enabled: true, skip: true, platform: 'linux', probeResult: { ready: false } })
check('显式跳过 ⇒ 放行（逃生口，不被强制）', skip.ok === true && skip.skipped === true && skip.code === 'WINSTAGE_ENV_GATE_SKIPPED', JSON.stringify(skip))

const linux = evaluateEnvironment({ enabled: true, platform: 'linux', probeResult: { ready: true } })
check('非 Windows ⇒ 判红', linux.ok === false && linux.code === 'WINSTAGE_ENV_UNSUPPORTED' && linux.failures.includes('platform'), JSON.stringify(linux))

const notReady = evaluateEnvironment({ enabled: true, platform: 'win32', probeResult: { ready: false, detail: '缺少 SeAssignPrimaryTokenPrivilege' } })
check('Windows 但令牌探测未通过 ⇒ 判红', notReady.ok === false && notReady.failures.includes('runtime'), JSON.stringify(notReady))

const noProbe = evaluateEnvironment({ enabled: true, platform: 'win32', probeResult: undefined })
check('探测结果缺失 ⇒ 判红（fail-closed，不默认通过）', noProbe.ok === false && noProbe.failures.includes('runtime'), JSON.stringify(noProbe))

const ok = evaluateEnvironment({ enabled: true, platform: 'win32', probeResult: { ready: true, detail: 'ok' } })
check('全部通过 ⇒ 放行 WINSTAGE_ENV_OK', ok.ok === true && ok.skipped === false && ok.code === 'WINSTAGE_ENV_OK', JSON.stringify(ok))

const msg = environmentFailureMessage(linux)
check('失败原因是可读文本且含项名', typeof msg === 'string' && msg.includes('WINSTAGE_ENV_UNSUPPORTED') && msg.includes('platform'), msg)

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures} mode=normal\n`)
process.exit(failures ? 1 : 0)
