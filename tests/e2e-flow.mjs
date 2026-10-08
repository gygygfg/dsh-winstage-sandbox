/**
 * 端到端链路验证：物化 → (模拟沙箱内写入) → 捕获 → 冻结 → diff → 选择性应用
 *
 * 说明：本机受限会话无法建立嵌套沙箱，因此这里用**直接写入暂存树**来模拟
 * "沙箱内进程写文件"的效果，从而验证沙箱外的捕获与提交链路。
 * 沙箱内执行的实测留待未受限环境（见 docs 第 12 节）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.mjs'
import { renderCandidateDiff } from '../src/tools.mjs'

const ROOT = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.t\\e2e-flow'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'src'), { recursive: true })
writeFileSync(join(ROOT, 'src', 'app.js'), 'export const x = 1\n')
writeFileSync(join(ROOT, 'README.md'), 'v1\n')

const ws = new Workspace({ workspaceRoot: ROOT }).init({ sessionId: 'e2e' })
let failures = 0
const check = (name, manualRef, ok, evidence) => {
  if (!ok) failures += 1
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}  [${manualRef}]`)
  if (!ok) console.log(`      证据: ${JSON.stringify(evidence)}`)
}

console.log('阶段 1：物化当前工作区到暂存树（执行前）')
ws.writeFile(join(ROOT, 'src', 'app.js'), 'export const x = 2\n', { origin: 'exec-before' })
const before = ws.snapshotStagedTree()
console.log(`  快照 ${before.size} 个文件`)

console.log('阶段 2：模拟沙箱内进程写入暂存树')
// 直接写暂存树，等价于受限进程在其唯一可写根内落盘
writeFileSync(ws.store.stagedPath(join('src', 'app.js')), 'export const x = 3\n')
writeFileSync(ws.store.stagedPath('generated.txt'), 'created by sandbox\n')
mkdirSync(ws.store.stagedPath('out'), { recursive: true })
writeFileSync(ws.store.stagedPath(join('out', 'build.log')), 'log\n')

console.log('阶段 3：执行后捕获净变化')
const captured = ws.captureAfterExecution(before)
console.log(`  捕获 ${captured.length} 项: ${captured.map((c) => `${c.deleted ? 'del' : 'mod'}:${c.path}`).join(', ')}`)
check('捕获到沙箱内新建文件 generated.txt', '#3.2', captured.some((c) => c.path === 'generated.txt'), captured)
check('捕获到嵌套新建 out/build.log', '#3.2', captured.some((c) => c.path.includes('build.log')), captured)
check('捕获到内容修改 src/app.js', '#3.2', captured.some((c) => c.path === 'src\\app.js' || c.path === 'src/app.js'), captured)

console.log('阶段 4：把捕获结果并入逻辑工作区（D9 修复后由 Workspace 自己承担）')
// 修复前：这两步是**测试在 CLI 之外手工补的**，而 src\cli.mjs 的 exec 只打印
// capturedChanges 的条数 → 真实链路上 review 永远为空。现在同一份逻辑在
// Workspace 里（ingestCapturedChanges / freezeIfNeeded），CLI 与测试都调用它。
// 这里刻意保留对**返回计数**的断言，防止实现退化成"什么都不做也不报错"。
const ingested = ws.ingestCapturedChanges(captured)
check('并入清单的条数等于捕获条数', '#3.2', ingested.ingested + ingested.deletions === captured.length, ingested)
check('并入过程没有静默跳过', '#3.2', ingested.skipped.length === 0, ingested.skipped)

console.log('阶段 5：冻结候选（幂等）')
const frozen = ws.freezeIfNeeded({ source: 'exec' })
check('候选已入队', '#12.1', frozen.frozen === true, frozen)
check('冻结返回的实际候选对象', '#12.1', frozen.candidate?.id !== undefined, frozen)
console.log(`  候选 ${frozen.candidate.id} — ${frozen.candidate.changes.length} 个变更单元`)
for (const change of frozen.candidate.changes) console.log(`    ${change.op.padEnd(7)} ${change.path}`)

console.log('阶段 5b：重复冻结必须幂等（不得产生第二份候选）')
const again = ws.freezeIfNeeded({ source: 'exec' })
check('重复冻结被识别为已覆盖', '#12.1/#3.10', again.frozen === false && again.reason === 'already-represented', again)
check('候选总数仍为 1', '#3.10', ws.listReviews().length === 1, { pending: ws.listReviews().length })

console.log('阶段 6：diff 渲染（两侧取自候选冻结内容）')
const lines = renderCandidateDiff(ws.store, ws.store.loadCandidate(frozen.candidate.id), { maxLines: 50 })
const headers = lines.filter((l) => l.type === 'change-header')
check('diff 覆盖全部变更单元', '#12.6', headers.length === frozen.candidate.changes.length, headers)
check('diff 里出现新增行', '#12.6', lines.some((l) => l.type === 'add'), lines.slice(0, 6))

console.log('阶段 7：真实磁盘在提交前未被改动')
check('真实 src/app.js 仍是 x = 1', '#1.2', readFileSync(join(ROOT, 'src', 'app.js'), 'utf8') === 'export const x = 1\n', {
  actual: readFileSync(join(ROOT, 'src', 'app.js'), 'utf8'),
})
check('真实 generated.txt 尚不存在', '#1.2', !existsSync(join(ROOT, 'generated.txt')), {
  realExists: existsSync(join(ROOT, 'generated.txt')),
})
check('真实 out/ 尚不存在', '#1.2', !existsSync(join(ROOT, 'out')), { realExists: existsSync(join(ROOT, 'out')) })

console.log('阶段 8：选择性应用（只提交 generated.txt）')
const applied = ws.applyCandidate(frozen.candidate.id, { paths: ['generated.txt'] })
check('只应用所选文件', '#12.2', applied.applied.length === 1 && applied.applied[0].path === 'generated.txt', applied)
check('真实 generated.txt 现已存在', '#12.2', existsSync(join(ROOT, 'generated.txt')), {
  content: existsSync(join(ROOT, 'generated.txt')) ? readFileSync(join(ROOT, 'generated.txt'), 'utf8') : null,
})
check('其余变更未应用且仍可追踪', '#12.2', applied.remaining.length === 2, { remaining: applied.remaining })
check('真实 src/app.js 仍未被改动', '#12.2', readFileSync(join(ROOT, 'src', 'app.js'), 'utf8') === 'export const x = 1\n', {
  actual: readFileSync(join(ROOT, 'src', 'app.js'), 'utf8'),
})

console.log('阶段 9：提交剩余变更')
const rest = ws.applyCandidate(frozen.candidate.id, { paths: applied.remaining })
check('剩余变更全部应用', '#12.2', rest.applied.length === 2, rest)
check('真实 src/app.js 现为 x = 3', '#12.2', readFileSync(join(ROOT, 'src', 'app.js'), 'utf8') === 'export const x = 3\n', {
  actual: readFileSync(join(ROOT, 'src', 'app.js'), 'utf8'),
})
check('嵌套新建 out/build.log 已提交', '#3.5', existsSync(join(ROOT, 'out', 'build.log')), {
  realExists: existsSync(join(ROOT, 'out', 'build.log')),
})

console.log(`\n${'='.repeat(60)}`)
console.log(failures === 0 ? '端到端链路：全部通过' : `端到端链路：${failures} 项失败`)
console.log('='.repeat(60))
process.exit(failures ? 1 : 0)
