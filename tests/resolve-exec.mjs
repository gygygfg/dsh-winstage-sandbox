/**
 * 可执行文件解析的确定性测试（不需要建立沙箱，也不需要真实子进程）
 *
 * 存在理由：`CreateProcessAsUserW` 不补 PATHEXT，裸命令名必然失败（Win32 2）。
 * 这个解析器是"命令名 → 绝对路径"的唯一保障，必须在任何环境都能被验证。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveExecutable, buildChildEnvironment, ENV_ALLOWLIST } from '../src/executor.mjs'

const W = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

const ROOT = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox\\.t\\resolve'
rmSync(ROOT, { recursive: true, force: true })
const binA = join(ROOT, 'binA')
const binB = join(ROOT, 'binB')
mkdirSync(binA, { recursive: true })
mkdirSync(binB, { recursive: true })
writeFileSync(join(binA, 'tool.exe'), 'x')
writeFileSync(join(binB, 'other.cmd'), 'x')
writeFileSync(join(binB, 'exact'), 'x')
writeFileSync(join(ROOT, 'local.bat'), 'x')

const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: `${binA};${binB}` }
// Windows 路径不区分大小写，因此比较时统一小写；
// `[实测]` 用 tool.EXE 读 tool.exe 内容成功，说明返回大写扩展名是可用的。
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

W('=== 1. 裸名字 + PATHEXT 补全 ===')
check('tool → binA\\tool.exe', same(resolveExecutable('tool', { cwd: ROOT, env }), join(binA, 'tool.exe')), resolveExecutable('tool', { cwd: ROOT, env }))
check('other → binB\\other.cmd', same(resolveExecutable('other', { cwd: ROOT, env }), join(binB, 'other.cmd')), resolveExecutable('other', { cwd: ROOT, env }))
check(
  'exact（无扩展名文件）也能命中',
  same(resolveExecutable('exact', { cwd: ROOT, env }), join(binB, 'exact')),
  resolveExecutable('exact', { cwd: ROOT, env }),
)

W('')
W('=== 2. 带扩展名 / 相对路径 / 绝对路径 ===')
check('tool.exe 直接命中', same(resolveExecutable('tool.exe', { cwd: ROOT, env }), join(binA, 'tool.exe')), resolveExecutable('tool.exe', { cwd: ROOT, env }))
check('local.bat 相对 cwd 命中', same(resolveExecutable('local.bat', { cwd: ROOT, env }), join(ROOT, 'local.bat')), resolveExecutable('local.bat', { cwd: ROOT, env }))
check(
  'binB\\other.cmd 含分隔符也命中',
  same(resolveExecutable(join('binB', 'other.cmd'), { cwd: ROOT, env }), join(binB, 'other.cmd')),
  resolveExecutable(join('binB', 'other.cmd'), { cwd: ROOT, env }),
)
const abs = join(binA, 'tool.exe')
check('绝对路径直接返回', resolveExecutable(abs, { cwd: ROOT, env }) === abs, resolveExecutable(abs, { cwd: ROOT, env }))

W('')
W('=== 3. 找不到必须显式失败（不得静默返回裸名字） ===')
let threw = false
let err
try {
  resolveExecutable('definitely-not-here-xyz', { cwd: ROOT, env })
} catch (error) {
  threw = true
  err = error
}
check('未知命令抛错', threw, threw ? `code=${err.code}` : '竟然没抛错')
check('错误里带 code=ENOENT', err?.code === 'ENOENT', String(err?.code))
check('错误里附上搜索过的位置', Array.isArray(err?.searched) && err.searched.length > 0, `searched=${err?.searched?.length} 项`)

W('')
W('=== 4. 这是 pwsh 失败（Win32 2）的根因回归 ===')
// 模拟真实场景：环境里只有 PATH、没有 PATHEXT → 必须回退到默认扩展名列表
check(
  'PATHEXT 缺省时仍补 .EXE',
  (() => {
    try {
      return same(resolveExecutable('tool', { cwd: ROOT, env: { PATH: binA } }), join(binA, 'tool.exe'))
    } catch {
      return false
    }
  })(),
  '无 PATHEXT 时回退 .COM;.EXE;.BAT;.CMD',
)
check(
  '返回的路径必须真实可读（大小写不敏感）',
  (() => {
    try {
      return readFileSync(resolveExecutable('tool', { cwd: ROOT, env }), 'utf8') === 'x'
    } catch {
      return false
    }
  })(),
  resolveExecutable('tool', { cwd: ROOT, env }),
)

W('')
W('=== 5. 子进程环境必须含 PATH（否则解析器无目录可搜） ===')
const { env: childEnv, rejected } = buildChildEnvironment({}, { tempDir: join(ROOT, 'tmp'), cwd: ROOT, tier: 'T1' })
check('ENV_ALLOWLIST 含 PATH', ENV_ALLOWLIST.includes('PATH'), 'PATH 必须在允许清单里')
check('构造出的子环境含 PATH', 'PATH' in childEnv, `keys=${Object.keys(childEnv).length}`)
check('构造出的子环境含 PATHEXT', 'PATHEXT' in childEnv, `PATHEXT=${childEnv.PATHEXT}`)
check('TMP/TEMP 被重写到私有 temp', childEnv.TEMP === join(ROOT, 'tmp') && childEnv.TMP === join(ROOT, 'tmp'), `TEMP=${childEnv.TEMP}`)
check('敏感变量仍被拒绝', rejected.length === 0, JSON.stringify(rejected))
const withSecret = buildChildEnvironment({ MY_API_KEY: 'x' }, { cwd: ROOT })
check('敏感名仍被拒（即使显式传入）', withSecret.rejected.includes('MY_API_KEY'), JSON.stringify(withSecret.rejected))
check('敏感名未出现在子环境', !('MY_API_KEY' in withSecret.env), JSON.stringify(Object.keys(withSecret.env)))

rmSync(ROOT, { recursive: true, force: true })
W('')
W('='.repeat(60))
W(failures === 0 ? '可执行文件解析测试：全部通过' : `可执行文件解析测试：${failures} 项失败`)
W('='.repeat(60))
process.exit(failures ? 1 : 0)
