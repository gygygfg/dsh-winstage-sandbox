/**
 * sandbox-audit —— 审计聚合器（`tools/sandbox-audit.mjs`）的离线自测。
 *
 * 为什么需要：审计聚合是 Method A 主线的"读侧权威"——沙箱跑完要把进程树的
 * 文件/注册表操作变成宿主侧的分类统计。聚合器是纯函数（`aggregateAudit`），
 * 因此可以在任何会话离线钉死它的判定，不必起 Windows。
 *
 * 覆盖：
 *   · 非法行**不静默忽略**（计入 malformed 并留样本）；
 *   · 文件读/写/删/移动的识别；
 *   · `--root` 的 workspace/outside 分类；
 *   · 注册表读/写的识别与键名带值。
 *
 * 运行：node tests/sandbox-audit.mjs
 */
import { aggregateAudit } from '../tools/sandbox-audit.mjs'

let checks = 0
let failures = 0
const check = (name, ok, detail) => {
  checks += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}\n`)
}

const lines = [
  '[winstage-audit][100][200] {"op":"file.open","mode":"read","path":"C:\\\\ws\\\\a.txt","disp":3}',
  '[winstage-audit][100][200] {"op":"file.open","mode":"write","path":"C:\\\\ws\\\\b.txt","disp":2}',
  '[winstage-audit][100][201] {"op":"file.delete","path":"C:\\\\ws\\\\old.txt"}',
  '[winstage-audit][100][201] {"op":"file.move","from":"C:\\\\ws\\\\c.txt","to":"C:\\\\ws\\\\d.txt"}',
  '[winstage-audit][100][202] {"op":"reg.set","key":"HKCU\\\\Software\\\\X","value":"V"}',
  '[winstage-audit][100][202] {"op":"reg.query","key":"HKCU\\\\Software\\\\X","value":"V"}',
  '[winstage-audit][100][202] {"op":"file.open","mode":"read","path":"C:\\\\Windows\\\\win.ini","disp":3}',
  'this line is not json',
  '',
]

process.stdout.write('=== sandbox-audit 聚合器（离线） ===\n')
const agg = aggregateAudit(lines, { root: 'C:\\ws' })

check('非法行被计数（不静默忽略）', agg.counts.malformed === 1, `malformed=${agg.counts.malformed} samples=${JSON.stringify(agg.counts.malformedSamples)}`)
check('合法行解析计数正确', agg.counts.parsed === 7, `parsed=${agg.counts.parsed}`)
check(
  '文件读被识别（含 workspace 内与系统文件）',
  agg.files.read.length === 2 && agg.files.read.some((e) => e.path === 'C:\\ws\\a.txt') && agg.files.read.some((e) => /win\.ini$/i.test(e.path)),
  JSON.stringify(agg.files.read),
)
check('文件写在 workspace 内', agg.summary.filesWrittenInWorkspace === 1 && agg.summary.filesWrittenOutside === 0, JSON.stringify(agg.summary))
check('文件删除被识别且判为 workspace', agg.files.deleted.length === 1 && agg.files.deleted[0].scope === 'workspace', JSON.stringify(agg.files.deleted))
check('文件移动被识别且判为 workspace', agg.files.moved.length === 1 && agg.files.moved[0].scope === 'workspace', JSON.stringify(agg.files.moved))
check('系统文件读判为 outside', agg.files.read.find((e) => /win\.ini$/i.test(e.path))?.scope === 'outside', JSON.stringify(agg.files.read))
check('注册表读/写被识别', agg.registry.read.length === 1 && agg.registry.written.length === 1, JSON.stringify({ read: agg.registry.read, written: agg.registry.written }))
check('注册表键名带值（key#value）', agg.registry.written[0]?.path === 'HKCU\\Software\\X#V', agg.registry.written[0]?.path)

/* --root 缺失时不做 workspace 分类（全部 outside 语义上应是 unknown；这里只断言不崩且 scope 存在） */
const noRoot = aggregateAudit(['[winstage-audit][1][2] {"op":"file.open","mode":"write","path":"C:\\\\ws\\\\x.txt","disp":2}'])
check('无 --root 时不误判为 workspace', noRoot.files.written[0]?.scope === 'outside', JSON.stringify(noRoot.files.written))

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures} mode=normal\n`)
process.exit(failures ? 1 : 0)
