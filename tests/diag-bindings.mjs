/**
 * 诊断：验证启动所需的三个件是否齐备，并验证环境块注入补丁。
 *
 * 三个件（缺一不可，早先把它们搞混过）：
 *   1. 低层原语表        loadWin32ProcessBindings()  → 含 createProcessAsUserW / createPipe / Job 原语
 *   2. 模块级 spawn 函数  module.spawnPipedProcess    → 签名 (api, options)，**不在**绑定表里
 *   3. ACL 安全扩展       AclSandbox 私有表            → ConvertStringSidToSidW / LocalFree 等
 *
 * 输出约定：与其它套件统一用 ✓/✗，并写 **stdout**。
 * 早先这里用 `OK/FAIL` 写 stderr，导致自动测试报告把它统计成 "0 ok / 0 bad" ——
 * 检查其实跑了，只是计数看不到。统计口径必须一致。
 */

import { WindowsStageExecutor, mergeBindingTables, encodeEnvironmentBlock } from '../src/executor.mjs'

const W = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

const cap = WindowsStageExecutor.capabilities()
W('--- 件 1：低层原语表 ---')
const low = cap.processBindings
check('processBindings 存在', !!low)
check('含 createProcessAsUserW', typeof low?.createProcessAsUserW === 'function')
check('含 createPipe', typeof low?.createPipe === 'function')
check('含 assignProcessToJobObject', typeof low?.assignProcessToJobObject === 'function')
check('含 setInformationJobObject', typeof low?.setInformationJobObject === 'function')
check('含 queryInformationJobObject', typeof low?.queryInformationJobObject === 'function')
W(`  低层键数 = ${low ? Object.keys(low).length : 0}`)
W(`  低层键: ${low ? Object.keys(low).sort().join(', ') : '(none)'}`)

W('')
W('--- 件 2：模块级 spawn 函数（不应出现在绑定表里） ---')
check('spawnPipedProcess 是函数', typeof cap.spawnPipedProcess === 'function', `typeof = ${typeof cap.spawnPipedProcess}`)
check('spawnPipedProcess 不在低层表里（契约确认）', typeof low?.spawnPipedProcess !== 'function')

W('')
W('--- 件 3：合成结果 ---')
const { merged, added, skipped } = mergeBindingTables(low ?? {}, { ConvertStringSidToSidW: () => {}, createProcessAsUserW: () => {} })
check('合成后保留 createProcessAsUserW', typeof merged.createProcessAsUserW === 'function')
check('合成后补入 ACL 独有扩展', added.includes('ConvertStringSidToSidW'), `added=[${added.join(',')}]`)
check('合成不覆盖基底已有实现', skipped.includes('createProcessAsUserW'), `skipped=[${skipped.join(',')}]`)

W('')
W('--- 环境块编码（#8.3 显式 lpEnvironment 的基础） ---')
const block = encodeEnvironmentBlock({ PATH: 'C:\\x', TEMP: 'C:\\y', dsh_sandbox: 'win-stage' })
const text = block.toString('utf16le')
check('以双 NUL 结尾', text.endsWith('\u0000\u0000'), JSON.stringify(text.slice(-4)))
check('键名按不区分大小写排序', text.indexOf('dsh_sandbox') < text.indexOf('PATH'), text.replace(/\u0000/g, '|'))
check('UTF-16LE 编码', block.length === (text.length) * 2)

W('')
W('--- 完整 init()（需要未受限会话） ---')
const ex = new WindowsStageExecutor({ stagingRoot: process.env.STAGING })
let nestingLimited = false
try {
  const r = await ex.init()
  check('init() 成功建立受限令牌与 ACL 授予', true, `tier 建立；jobFlags=${r.jobFlags}`)
  W(`  capturedFields = ${JSON.stringify(r.capturedFields)}`)
  W(`  bindingTable   = added=[${r.bindingTable.addedFromAcl.join(',')}] keptFromLibrary=${r.bindingTable.keptFromProcessLibrary}`)
  W(`  jobFlags       = ${r.jobFlags}  jobAccounting = ${JSON.stringify(r.jobAccounting)}`)
  W(`  tempDir        = ${r.tempDir}`)
  W(`  enforcement    = ${r.enforcement}`)
  // 把 init 内自检的每一项都计入统计，别只打印
  for (const c of r.checks) {
    check(`init 自检 ${c.name}`, c.status === 'pass' || c.status === 'documented-residual', `${c.status}: ${c.detail}`)
  }
} catch (error) {
  // **关键**：区分"机制边界导致的跳过"与"真正的失败"。
  // 早先版本在 catch 里既不计失败也不标记跳过，于是无论 init 成功还是失败，
  // 退出码都是 0、结论都打印"全部通过" —— 又一处"假通过"。
  const message = `${error.code ?? ''}: ${error.message}`
  nestingLimited = /OpenProcessToken|CreateRestrictedToken|SANDBOX_UNAVAILABLE/.test(message)
  if (nestingLimited) {
    W(`  SKIP  init() 不可用（本会话已受限，机制边界）：${message}`)
  } else {
    check('init() 成功建立受限令牌与 ACL 授予', false, message)
  }
} finally {
  W(`  dispose = ${JSON.stringify(ex.dispose())}`)
}

W('')
if (failures > 0) {
  W(`诊断结论：${failures} 项失败`)
  process.exit(1)
}
W(nestingLimited ? '诊断结论：契约检查全部通过（init 因机制边界跳过）' : '诊断结论：全部通过')
process.exit(0)
