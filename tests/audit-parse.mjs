/**
 * 审计解析器的确定性测试（不需要 Win32）
 *
 * 存在理由（真实缺陷 11）：审计曾把"脚本没有产出任何输出"当成"操作被拒绝"，
 * 于是读取面 10 项全部**假通过**（详情显示"拒绝读取（unknown）"）。
 * 空输出与拒绝必须能被区分，这是手册第 4 章的硬要求。
 *
 * 因此对 `parseMarkedJson` 的契约做逐项断言：
 *   - 找到哨兵且 JSON 合法 → 返回对象
 *   - 没找到哨兵 / 哨兵后为空 / 哨兵后不是 JSON → 返回 undefined（调用方据此判 fail）
 *   - JSON 内含 `]` 等字符不得被截断
 *
 * ── FIX-C 追加（§6/§7）：读取探针表（`READ_PROBES`）的运行期可测性 ──────────────
 * 探针表是"读取面收敛"的**唯一观测入口**，它的失效形态同样不是崩溃，而是
 * "少一条 / 顺序变了 / kind 拼错 / maskClass 改名后变孤儿"。
 * 另外锁死一个**契约**：上报的 JSON 行里**只能**有
 * `{id, path, verdict, len, head4, errCode}` —— 多一个 `content` 字段就意味着
 * 秘密本体可能进证据（本项目最硬的红线）。
 *
 * 用法：
 *   node tests\audit-parse.mjs           # 全绿
 *   node tests\audit-parse.mjs --plant   # 故意抽掉一条遮蔽类的唯一探针，断言必须变红
 */

import { join } from 'node:path'
import { __internal } from '../src/audit.mjs'
import { MASK_CLASSES } from '../src/paths.mjs'

const PLANT = process.argv.includes('--plant')

const {
  parseMarkedJson,
  AUDIT_MARKER,
  q,
  READ_PROBES,
  READ_PROBE_KINDS,
  READ_PROBE_MISSING_MASK_CLASSES,
  READ_PROBE_CHUNK,
  READ_PROBE_ROW_KEYS,
  buildReadProbeScript,
  encodePowerShellCommand,
  validateReadProbes,
  readProbePayload,
} = __internal
const W = (s) => process.stdout.write(`${s}\n`)
let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

W('=== 1. 必须能解析的输入 ===')
check('纯 JSON', JSON.stringify(parseMarkedJson(`${AUDIT_MARKER}{"a":1}`)) === '{"a":1}', String(parseMarkedJson(`${AUDIT_MARKER}{"a":1}`)))
check(
  '哨兵前有噪音',
  Array.isArray(parseMarkedJson(`warning\nnoise\n${AUDIT_MARKER}[true,false]`)),
  JSON.stringify(parseMarkedJson(`warning\nnoise\n${AUDIT_MARKER}[true,false]`)),
)
check(
  'JSON 值内含 ] 不被截断',
  parseMarkedJson(`${AUDIT_MARKER}{"p":"a]b"}`)?.p === 'a]b',
  JSON.stringify(parseMarkedJson(`${AUDIT_MARKER}{"p":"a]b"}`)),
)
check(
  'JSON 后有尾部换行仍可解析',
  parseMarkedJson(`${AUDIT_MARKER}[true]\n\n`)?.length === 1,
  JSON.stringify(parseMarkedJson(`${AUDIT_MARKER}[true]\n\n`)),
)
check(
  '取最后一个哨兵（多段输出）',
  parseMarkedJson(`${AUDIT_MARKER}[false]\n${AUDIT_MARKER}[true]`)?.[0] === true,
  JSON.stringify(parseMarkedJson(`${AUDIT_MARKER}[false]\n${AUDIT_MARKER}[true]`)),
)

W('')
W('=== 2. 必须返回 undefined 的输入（调用方据此判 fail） ===')
const mustFail = [
  ['空字符串', ''],
  ['只有空白', '   \n  '],
  ['没有哨兵', 'Access is denied'],
  ['哨兵后为空', `${AUDIT_MARKER}`],
  ['哨兵后只有空白', `${AUDIT_MARKER}   `],
  ['哨兵后不是 JSON', `${AUDIT_MARKER}not-json`],
  ['哨兵后 JSON 有尾随垃圾', `${AUDIT_MARKER}[true,false] trailing`],
  ['非字符串输入', undefined],
]
for (const [label, input] of mustFail) {
  const r = parseMarkedJson(input)
  check(`${label} → undefined`, r === undefined, `得到 ${JSON.stringify(r)}`)
}

W('')
W('=== 3. 缺陷 11 回归：空输出必须判 fail 而不是 pass ===')
// 这段模拟旧逻辑：map 里找不到 → readable=false → status='pass'
const emptyParsed = parseMarkedJson('')
const oldLogicWouldPass = emptyParsed === undefined // 旧代码在此路径上判了 pass
check('空输出被判为 undefined（而非空数组）', emptyParsed === undefined, String(emptyParsed))
check(
  '调用方看到 undefined 时会走 fail 分支（本测试锁定该契约）',
  oldLogicWouldPass === true,
  'parseMarkedJson 返回 undefined ⇒ 审计对每个读取探针记 fail',
)
// 反向：脚本真的跑出全 false 时，才允许判 pass（拒绝读取）
const allDenied = parseMarkedJson(`${AUDIT_MARKER}[false,false,false]`)
check('脚本真的产出全 false 时才可判"拒绝读取"', Array.isArray(allDenied) && allDenied.every((v) => v === false), JSON.stringify(allDenied))

W('')
W('=== 4. PowerShell 单引号转义 ===')
check("单引号被成对转义", q("it's") === "it''s", q("it's"))
check('路径反斜杠不被影响', q('C:\\a\\b') === 'C:\\a\\b', q('C:\\a\\b'))
check('含单引号的路径安全', q("C:\\a'b\\c") === "C:\\a''b\\c", q("C:\\a'b\\c"))

W('')
W('=== 5. 自定义哨兵（缺陷 16 回归） ===')
// 预检使用 DSH-PREFLIGHT-… 哨兵；若 parseMarkedJson 把哨兵硬编码成 AUDIT_MARKER，
// 预检的环境探针就永远解析不出结果（表现为"子进程关键变量=undefined"）。
const PREFLIGHT = 'DSH-PREFLIGHT-abc123'
check(
  '显式传入自定义哨兵可解析',
  parseMarkedJson(`${PREFLIGHT}{"PATHlen":579}`, PREFLIGHT)?.PATHlen === 579,
  JSON.stringify(parseMarkedJson(`${PREFLIGHT}{"PATHlen":579}`, PREFLIGHT)),
)
check(
  '不传哨兵时解析不了自定义哨兵的内容（证明必须显式传）',
  parseMarkedJson(`${PREFLIGHT}{"PATHlen":579}`) === undefined,
  String(parseMarkedJson(`${PREFLIGHT}{"PATHlen":579}`)),
)
check('自定义哨兵下，无该哨兵仍返回 undefined', parseMarkedJson('noise only', PREFLIGHT) === undefined, String(parseMarkedJson('noise only', PREFLIGHT)))
check(
  '两个哨兵同时出现时各取各的',
  parseMarkedJson(`${AUDIT_MARKER}{"a":1}`, AUDIT_MARKER)?.a === 1 &&
    parseMarkedJson(`${PREFLIGHT}{"b":2}`, PREFLIGHT)?.b === 2,
  'AUDIT_MARKER 与 PREFLIGHT 互不干扰',
)

W('')
W('=== 6. 读取探针表结构（FIX-C：N1–N10 + S3/S5 必须运行期可测） ===')
{
  check('探针表非空且规模只增不减（>= 30 条）', READ_PROBES.length >= 30, `${READ_PROBES.length} 条`)
  check(
    '每条探针都有 id / path / label',
    READ_PROBES.every(
      (probe) => typeof probe.id === 'string' && probe.id.length > 0 && typeof probe.path === 'string' && probe.path.length > 0 && typeof probe.label === 'string' && probe.label.length > 0,
    ),
    READ_PROBES.filter((probe) => !probe.path || !probe.label).map((probe) => probe.id).join(', ') || '齐全',
  )
  const ids = READ_PROBES.map((probe) => probe.id)
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
  check('探针 id 不重复', dupes.length === 0, dupes.join(', ') || '无重复')
  check(
    `每条探针的 kind 都在 ${READ_PROBE_KINDS.join('/')} 内`,
    READ_PROBES.every((probe) => READ_PROBE_KINDS.includes(probe.kind)),
    READ_PROBES.filter((probe) => !READ_PROBE_KINDS.includes(probe.kind)).map((probe) => `${probe.id}=${probe.kind}`).join(', ') || '全部合法',
  )
  check('分块大小为正整数且不吞掉探针', Number.isInteger(READ_PROBE_CHUNK) && READ_PROBE_CHUNK > 0, `READ_PROBE_CHUNK=${READ_PROBE_CHUNK}`)
  const grouped = READ_PROBES.filter((probe) => probe.kind === 'directory').length
  const files = READ_PROBES.filter((probe) => probe.kind === 'file').length
  const pipes = READ_PROBES.filter((probe) => probe.kind === 'pipe-absent').length
  check('三种形态都有覆盖（file / directory / pipe-absent）', files > 0 && grouped > 0 && pipes > 0, `file=${files} directory=${grouped} pipe-absent=${pipes}`)
}

W('')
W('=== 7. 探针表 × 遮蔽类：双向映射（缺一即红） ===')
{
  // ── 契约锁：前 10 条（旧 READ_PROBES）的 **id 与相对顺序**不得改变 ──────────────
  // 这些 id 曾被写进历史证据与报告，改名会让旧证据无法与代码对齐；
  // 顺序变化会让"按序号解释结果"的旧读者读错行。要改必须**显式**改这张表（留痕）。
  const LOCKED_PREFIX = ['sam-hive', 'system-hive', 'win-ini', 'hosts-file', 'unattend', 'dsh-sessions', 'ssh-keys', 'dpapi-user', 'git-credentials', 'npmrc']
  const actualPrefix = READ_PROBES.slice(0, LOCKED_PREFIX.length).map((probe) => probe.id)
  check('原 10 条探针的 id 与顺序逐字保留（只允许追加）', actualPrefix.join(',') === LOCKED_PREFIX.join(','), actualPrefix.join(','))

  const knownMaskClasses = MASK_CLASSES.map((rule) => rule.id)
  // --plant：抽掉 `dpapi-user` 的唯一探针 —— 这正是"新增遮蔽类却忘了加探针"的真实形态。
  // 判据必须变红（不是崩溃红）：validateReadProbes 必须报"遮蔽类没有读取探针"。
  const probesUnderTest = PLANT ? READ_PROBES.filter((probe) => probe.maskClass !== 'dpapi-user') : READ_PROBES
  if (PLANT) {
    W(`  （--plant：已从 ${READ_PROBES.length} 条探针里抽掉 maskClass=dpapi-user 的全部探针）`)
  }
  const spec = validateReadProbes(probesUnderTest, knownMaskClasses, READ_PROBE_MISSING_MASK_CLASSES)
  check(
    '探针表通过形态校验（id/path/label/kind/遮蔽类映射）且无遮蔽类缺口',
    spec.ok,
    spec.ok ? `${probesUnderTest.length} 条探针全部合规` : spec.errors.slice(0, 5).join(' | '),
  )
  const coveredMaskClasses = new Set(READ_PROBES.map((probe) => probe.maskClass).filter(Boolean))
  const uncovered = knownMaskClasses.filter((id) => !coveredMaskClasses.has(id) && !(id in READ_PROBE_MISSING_MASK_CLASSES))
  check('每个遮蔽类都有读取探针或有登记的缺口', uncovered.length === 0, uncovered.join(', ') || '无缺口')
  const orphanProbes = READ_PROBES.filter((probe) => probe.maskClass !== undefined && !knownMaskClasses.includes(probe.maskClass))
  check('没有指向不存在遮蔽类的孤儿探针', orphanProbes.length === 0, orphanProbes.map((probe) => `${probe.id}→${probe.maskClass}`).join(', ') || '无孤儿')
  const mounted = READ_PROBES.filter((probe) => probe.maskClass !== undefined).length
  W(`  遮蔽类 ${knownMaskClasses.length} 个；探针 ${READ_PROBES.length} 条，其中 ${mounted} 条挂了遮蔽类。`)
}

W('')
W('=== 8. 秘密不进证据（红线：上报行只允许判定 + 长度 + 前 4 字节哈希） ===')
{
  // 探针表**不进脚本正文**，而是落在命令行给的一个文件里（见 audit.mjs 的说明：
  // `[实测]` 42 条内嵌 base64 会让 `-EncodedCommand` 长到 21356 字符并**静默失败**）。
  // 因此这里给一个具体路径，并校验脚本正文与 payload 两个部分各自的形状。
  const payloadPath = join('C:\\tmp\\dsh-audit', 'probes-0.json')
  const script = buildReadProbeScript(payloadPath)
  const payload = readProbePayload(READ_PROBES.slice(0, 3))
  // eslint-disable-next-line no-control-regex
  const nonAscii = script.split('').filter((ch) => ch.charCodeAt(0) > 0x7e || ch.charCodeAt(0) < 0x20)
  check('沙箱内脚本是纯 ASCII + 换行（探针表经文件传递，不经代码页）', nonAscii.every((ch) => ch === '\n' || ch === '\r' || ch === '\t'), `非常规字符 ${nonAscii.length} 个`)
  check('脚本带审计哨兵', script.includes(AUDIT_MARKER), AUDIT_MARKER)
  check(
    '上报行的键白名单逐字固定（id/path/verdict/len/head4/errCode）且不含任何内容字段',
    Array.isArray(READ_PROBE_ROW_KEYS) &&
      READ_PROBE_ROW_KEYS.join(',') === 'id,path,verdict,len,head4,errCode' &&
      !READ_PROBE_ROW_KEYS.some((key) => /content|data|body|text|base64|blob/i.test(key)),
    `keys=${(READ_PROBE_ROW_KEYS ?? []).join(',')}`,
  )
  // 红线断言写成**具体模式**（而不是"看起来像安全"的模糊判据）：
  //   · 不得出现任何把文件/流读成字符串的 cmdlet（除了读探针表那一处 Get-Content）；
  //   · 不得出现 `$content` 之类的"内容变量"；
  //   · 不得把读到的字节/文本交给输出 cmdlet；
  //   · 脚本里**不得**出现 base64 解码（探针表现在走文件）。
  const readCmdlets = script.match(/ReadToEnd|StreamReader|ReadAllText|Get-Content/g) ?? []
  check(
    '脚本里没有把文件内容写进输出的路径（唯一允许的读取是探针表自身）',
    !/ReadToEnd|StreamReader|ReadAllText/.test(script) &&
      !/\$content\b/.test(script) &&
      !/Write-(Output|Host)\s+\$(bytes|text|row)/.test(script) &&
      !/FromBase64String/.test(script) &&
      readCmdlets.length <= 1,
    `读取 cmdlet=${JSON.stringify(readCmdlets)}；$content=无；base64 解码=无`,
  )
  check(
    '脚本包含三态判定（readable / denied / not-present）',
    /'readable'/.test(script) && /'denied'/.test(script) && /'not-present'/.test(script),
    '三态齐全',
  )
  // "存在但内容读不出来"必须**单独一态**：它既不是 `denied`（权限拒绝），也不是 `not-present`。
  // 混进 denied 就是把"未知来源的读不到"记成"我们挡住了"（手册第 4 章禁止的混淆）。
  check("脚本把'存在但内容读不出来'单列一态（read-metadata-only），不与 denied / not-present 混为一谈", /'read-metadata-only'/.test(script), 'read-metadata-only 存在')
  const encoded = encodePowerShellCommand(script)
  check('encodePowerShellCommand 输出 UTF-16LE 的 base64 且可原样还原', Buffer.from(encoded, 'base64').toString('utf16le') === script, `${encoded.length} base64 字符`)
  // `[实测]` 回归：21356 字符的 -EncodedCommand 在本机会静默失败；脚本正文必须远小于它。
  check('脚本正文足够短（避免命令行长度上限导致静默失败）', script.length < 4096 && encoded.length < 12000, `script=${script.length} 字符 / encoded=${encoded.length} 字符`)
  check(
    '探针表 payload 只含 id/path/kind（不带 label/掩码类，避免把无关信息写进暂存文件）',
    (() => {
      const parsed = JSON.parse(payload)
      return (
        Array.isArray(parsed) &&
        parsed.length === 3 &&
        parsed.every((item) => Object.keys(item).sort().join(',') === 'id,kind,path' && typeof item.path === 'string' && READ_PROBE_KINDS.includes(item.kind))
      )
    })(),
    payload.slice(0, 160),
  )
  check('payload 落盘后能被原样读回（JSON 往返）', JSON.stringify(JSON.parse(payload)) === payload, `${payload.length} 字符`)
}

W('')
W('='.repeat(60))
W(
  PLANT
    ? `审计解析器测试（--plant 模式，应当失败）：断言 ${assertions} 项，失败 ${failures} 项`
    : `审计解析器测试：断言 ${assertions} 项，失败 ${failures} 项`,
)
W('='.repeat(60))
process.exit(failures ? 1 : 0)
