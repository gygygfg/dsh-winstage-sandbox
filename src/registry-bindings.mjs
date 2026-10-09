/**
 * registry-bindings —— 宿主侧（真实 hive、非沙箱）的注册表**读/写适配器**。
 *
 * ── 它补的是哪一段空白 ────────────────────────────────────────────────────────
 * 注册表暂存链在仓库里一直是**半截**的：
 *   · 沙箱内（shim）：IAT 钩子 → 写覆盖层 + 追加 WAL（`shim/src/ws_reg.c`、
 *     `ws_t3reg.c`）—— 这一半是实测可用的；
 *   · 宿主侧（`src/registry-stage.mjs::createRegistryStage()`）：读 WAL → 与真实 hive
 *     diff → 冻结候选 → 进审批队列 —— 这一半**只有 `tools/run-shim-closedloop.mjs`
 *     一个调用者**，产品路径（`dsh-plugin/**`、`src/cli.mjs`）一次都没调用过。
 *     `createRegistryStage` 需要 `reader`（`REG_READER_MISSING` 否则直接抛），而
 *     仓库里**没有**任何产品级的 `Reg*` 绑定实现 —— 那正是"半截"的具体形状。
 *
 * 本模块就是那份缺失的绑定，而且**刻意不引 FFI**：
 *   · 读：`reg.exe query`（宿主令牌下读真实 hive），解析 stdout；
 *   · 写：`reg.exe add|delete`（`apply()` 用）。
 * 口径与实现**逐字来自已在真实产物上跑绿的** `tools/run-shim-closedloop.mjs::makeRegReader()`
 * （该套件的 E9「宿主能把 WAL 冻结成候选」是绿的）——按本项目"原样提升"的纪律搬到 `src/`，
 * 不另写一套。
 *
 * ── 为什么用 `reg.exe` 而不是 koffi ─────────────────────────────────────────
 * koffi 在本机是**可解析的**，但 `RegEnumValueW` 的缓冲区/类型编组是另一整块
 * 需要单独取证的面（`docs/T3-注册表暂存设计.md:505-508` 明确把"真实 Win32 调用形状"
 * 列为 `[未实测]`）。而 `reg.exe` 路径**已经在真实 hive 上被 E9 证明过**，且它天然就是
 * "宿主令牌下的真实读取"——这正是 `reader` 的定义。少一个未验证的 FFI 面，
 * 换一个已验证的外部进程面，这笔交易在本轮是划算的。
 *
 * ── 纪律（与 `registry-guard` 同一套）────────────────────────────────────────
 *   1. **未知值类型是硬错误**，不是"跳过"：`REG_LINK`/`REG_RESOURCE_LIST` 等若被静默
 *      忽略，"读不到"就会伪装成"没有变化"（README 缺陷 11 的形态）。
 *   2. **非零 LSTATUS 如实返回**，绝不吞掉（`createRegistryWriter` 的契约）。
 *   3. 输出**走文件重定向**而不是管道：本仓库在受限令牌下实测过 `stdio:'pipe'`
 *      会以 EPERM 失败（残余边界 R10）。虽然宿主通常不受限，但"同一件事只写一份口径"
 *      更省心，也让本模块在受限宿主里同样可用。
 */

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `reg.exe` 的绝对路径（`SystemRoot` 缺失时退回裸名，交给 PATHEXT）。 */
export function regExePath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  const candidate = join(root, 'System32', 'reg.exe')
  return existsSync(candidate) ? candidate : 'reg.exe'
}

/** 允许的值类型（与 `registry-guard` 的 `VALUE_ENCODERS` 同一集合的子集）。 */
const SUPPORTED = new Set(['REG_SZ', 'REG_EXPAND_SZ', 'REG_DWORD', 'REG_BINARY', 'REG_MULTI_SZ'])

/** `reg.exe` 的"拒绝访问"（英文/中文；中文 Windows 上是 OEM 代码页的解码文本）。 */
const QUERY_DENIED = /拒绝访问|Access is denied/i
/** `reg.exe` 的"这个键/值找不到"——**只有**这一种文本才允许被翻译成 `exists:false`。 */
const QUERY_NOT_FOUND = /unable to find the specified registry key|找不到指定的注册表项/i

/** 短 hive 名 → `reg query` 表头用的长名（表头写的是长名，拿短名去比永远比不中）。 */
const HIVE_LONG_NAME = Object.freeze({
  HKCR: 'HKEY_CLASSES_ROOT',
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKU: 'HKEY_USERS',
  HKCC: 'HKEY_CURRENT_CONFIG',
})

function longHivePath(canonical) {
  const head = canonical.split('\\')[0]
  const long = HIVE_LONG_NAME[head.toUpperCase()]
  return long === undefined ? canonical : long + canonical.slice(head.length)
}

/**
 * 非零 status 的**分类**（WP12 的核心：不与"键不存在"混淆）。
 *
 * 旧实现把所有非零都当成 `exists:false`（第 101-109 行原注释还写着"我们不猜"），
 * 但"没跑起来/超时/无法识别的错误"与"键确实不存在"是**两个不同的事实**：
 * 前者说成后者 ⇒ 覆盖层把已存在的键算成新建 ⇒ 真写 `reg add <已存在键> /f` ⇒ 被拒 ⇒ 整批批不动。
 * 这里只把 `reg.exe` **明确说找不到**的那一种翻成 `exists:false`，其余一律 fail-closed 报"读不到"。
 */
function classifyQueryFailure(result, canonical) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (QUERY_DENIED.test(text)) {
    return {
      exists: true,
      accessDenied: true,
      errorCode: 5,
      subKeysKnown: false,
      unreadableReason: `reg query ${canonical} was denied (ERROR_ACCESS_DENIED)`,
    }
  }
  if (QUERY_NOT_FOUND.test(text)) {
    return { exists: false, accessDenied: false, errorCode: 2, subKeysKnown: true }
  }
  return {
    exists: true,
    accessDenied: false,
    unreadable: true,
    errorCode: result.status ?? 5,
    subKeysKnown: false,
    unreadableReason:
      `reg query ${canonical} did not run or failed unrecognizably ` +
      `(status=${result.status}, via=${result.via ?? 'pipe'}, error=${result.error ?? 'none'}, ` +
      `stderr=${JSON.stringify(String(result.stderr ?? '').slice(0, 200))}): ` +
      'refusing to translate "we could not read it" into "the key does not exist"',
  }
}

/**
 * 跑一次 `reg.exe` 并把 stdout/stderr 收回来。
 *
 * ── WP12：为什么 pipe 失败必须**回退到文件重定向**，而不是把 status:null 交上去 ──────
 * 原实现只用管道（`spawnSync` 默认 stdio），并假定"调用方是宿主进程，没有命名管道约束"。
 * 该假定在**受限令牌/收窄档**下不成立：`[实测]` 2026-10-05 本机
 * `spawnSync(reg.exe, ['query', …])` → `{status: null, error: EPERM}`（残余边界 R10：
 * 受限进程开不了命名管道）。而 `status: null` 会被 `createRegExeReader` 归到
 * "键不存在"分支 ⇒ **每一个真实存在的键都被报成不存在** ⇒ 覆盖层把已存在的父键算成
 * `key-created` ⇒ apply 真的去 `reg add <已存在键> /f` ⇒ 被拒（ERROR_ACCESS_DENIED）
 * ⇒ 整批批不动。本文件第 58-59 行的原注释已经预言了这件事（"若将来被搬进受限进程使用，
 * 必须改成 fd 重定向"），WP12 就是补上那一手：**管道被拒 ⇒ 自动改用 fd 重定向**，
 * 并把 spawn 失败如实带回去（`error`/`via`），让上层能区分"没跑起来"与"跑了说没有"。
 *
 * `options.stdio`：`'auto'`（默认，管道优先、失败回退）/ `'pipe'`（只用管道）/ `'file'`。
 *
 * @returns {{status:number|null, stdout:string, stderr:string, error:string|null, via:'pipe'|'file',
 *            pipeError?:string, note?:string}}
 */
export function runReg(args, options = {}) {
  const mode = options.stdio ?? 'auto'
  if (mode === 'file' || (mode === 'auto' && pipesRefused)) return runRegRedirected(args, options)
  const piped = spawnCaptured(args, options)
  if (piped.status !== null || mode === 'pipe') return piped
  // 管道被拒是**粘性**的：记住它，后续调用不再每次白挨一次 EPERM。
  pipesRefused = true
  const redirected = runRegRedirected(args, options)
  redirected.pipeError = piped.error ?? 'unknown'
  redirected.note =
    `piped stdio was refused (${redirected.pipeError}); retried with file redirection ` +
    '(residual boundary R10: a confined host cannot open named pipes)'
  return redirected
}

/** 管道 stdio 是否已被宿主拒过（残余边界 R10 的粘性记忆；`[实测]` 2026-10-05 EPERM）。 */
let pipesRefused = false

function describeSpawnError(error) {
  return `${error?.code ?? error?.name ?? 'ERR'}: ${error?.message ?? error}`
}

function decodeRegOutput(value) {
  if (Buffer.isBuffer(value)) return value.toString(guessEncoding(value))
  return typeof value === 'string' ? value : ''
}

/** 管道版：输出按行解析需要 Buffer，所以不走 `encoding: 'utf8'`。 */
function spawnCaptured(args, options) {
  try {
    const result = spawnSync(regExePath(options.env), args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
    })
    return {
      status: result.status,
      stdout: decodeRegOutput(result.stdout),
      stderr: decodeRegOutput(result.stderr),
      error: result.error ? describeSpawnError(result.error) : null,
      via: 'pipe',
    }
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: describeSpawnError(error), via: 'pipe' }
  }
}

/** 文件重定向版（`stdio: ['ignore', fd, fd]`）：受限令牌下唯一能拿到 `reg.exe` 输出的方式。 */
function runRegRedirected(args, options) {
  let dir
  try {
    dir = mkdtempSync(join(options.tmpDir ?? tmpdir(), 'winstage-reg-'))
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: `cannot create redirect dir: ${describeSpawnError(error)}`, via: 'file' }
  }
  const outPath = join(dir, 'stdout.bin')
  const errPath = join(dir, 'stderr.bin')
  let fdOut
  let fdErr
  try {
    fdOut = openSync(outPath, 'w')
    fdErr = openSync(errPath, 'w')
    const result = spawnSync(regExePath(options.env), args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      stdio: ['ignore', fdOut, fdErr],
    })
    closeSync(fdOut)
    fdOut = undefined
    closeSync(fdErr)
    fdErr = undefined
    return {
      status: result.status,
      stdout: readRedirected(outPath),
      stderr: readRedirected(errPath),
      error: result.error ? describeSpawnError(result.error) : null,
      via: 'file',
    }
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: describeSpawnError(error), via: 'file' }
  } finally {
    if (fdOut !== undefined) {
      try {
        closeSync(fdOut)
      } catch {
        /* 关闭失败只影响句柄残留 */
      }
    }
    if (fdErr !== undefined) {
      try {
        closeSync(fdErr)
      } catch {
        /* 同上 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

function readRedirected(path) {
  try {
    return decodeRegOutput(readFileSync(path))
  } catch {
    return ''
  }
}

/** `reg.exe` 在中文 Windows 上按 OEM 代码页输出；含 NUL 的偶数字节则是 UTF-16LE。 */
function guessEncoding(buffer) {
  if (buffer.length > 1 && buffer[1] === 0x00) return 'utf16le'
  return 'utf8'
}

/**
 * 宿主令牌下的**真实 hive 读取器**（喂给 `createRegistryStage({ reader })`）。
 *
 * 契约（`src/registry-guard.mjs::createRegistryReader` 同形）：
 *   `read(canonicalPath) → { exists, accessDenied?, errorCode?, subKeys?, subKeysKnown?, values? }`
 * `values[name] = { type: 'REG_*', data: <快照口径字符串> }`。
 *
 * ── WP12：三个字段的**含义**必须被调用方区分（否则"已存在的父键被算成新建"） ──────────
 *   ① 正常枚举成功（键存在，子键**已枚举**）：`{exists:true, subKeys:[…], subKeysKnown:true, values}`；
 *   ② 键确实不存在（`reg.exe` 明确报找不到）：`{exists:false, errorCode:2, subKeysKnown:true}`；
 *   ③ 读不到/枚举失败/拒绝访问/spawn 失败：`{exists:true, accessDenied|unreadable:true, subKeysKnown:false, unreadableReason}`
 *      —— **绝不**报 `exists:false`，也**绝不**报一个"已知为空"的 `subKeys: []`。
 * ②与③的区别就是本缺陷的根：把③当②用，`RegCreateKeyExW` 的"打开或创建"就会被写成
 * "创建"，候选里出现 `reg add <已存在键> /f`，在受限令牌下被拒 ⇒ 整批批不动。
 * `subKeysKnown:false` 明确告诉 `registry-stage`"这个枚举是**未知**，不是空"。
 */
export function createRegExeReader(options = {}) {
  const exec = options.exec ?? runReg
  return {
    read(canonical) {
      const r = exec(['query', canonical], options)
      if (r.status !== 0) return classifyQueryFailure(r, canonical)
      const values = {}
      const subKeys = []
      const self = canonical.toLowerCase()
      const selfLong = longHivePath(canonical).toLowerCase()
      const prefixes = [`${self}\\`, `${selfLong}\\`]
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '')
        if (!line) continue
        if (!/^\s/.test(line)) {
          const base = line.trim()
          const lower = base.toLowerCase()
          // `reg query` 在**有值**的键上会先打一行"键自己"的表头，而且用的是**长 hive 名**
          // （`HKEY_CURRENT_USER\Software\X`）。旧实现只跟 `HKCU\…` 比 ⇒ 表头比不中 ⇒
          // 被当成一个名叫 `X`（键自己的最后一段）的**幻影子键**混进 `subKeys`
          // （`[实测]` 2026-10-05：`reg query HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`
          // 第 1 行就是 `HKEY_LOCAL_MACHINE\SOFTWARE\…\CurrentVersion`）。
          if (lower === self || lower === selfLong) continue
          const prefix = prefixes.find((candidate) => lower.startsWith(candidate))
          subKeys.push(prefix === undefined ? base.split('\\').pop() : base.slice(prefix.length))
          continue
        }
        const m = line.match(/^\s{2,}(.*?)\s{4,}(REG_[A-Z_]+)(?:\s{0,4}(.*))?$/)
        if (!m) continue
        const name = m[1] === '(Default)' ? '' : m[1]
        const type = m[2]
        const data = (m[3] ?? '').trim()
        if (!SUPPORTED.has(type)) {
          // 硬错误：「读不到」不得伪装成「没有变化」。
          throw Object.assign(new Error(`reader: unsupported value type ${type} for ${name} in ${canonical}`), {
            code: 'REG_READ_UNSUPPORTED_TYPE',
          })
        }
        values[name] = { type, data: type === 'REG_BINARY' ? data.replace(/\s+/g, '') : data }
      }
      // 一次 `reg query`（不带 /s）就把该键的**全部**直接子键与值打出来了；走到了这里
      // 说明枚举是**完整**的 ⇒ `subKeysKnown:true`（"已知为空"与"未知"是两件事，必须显式说）。
      return { exists: true, accessDenied: false, errorCode: 0, subKeys, subKeysKnown: true, values }
    },
  }
}

/**
 * 宿主令牌下的**真实 hive 写入器**（喂给 `createRegistryStage({ writer })`）。
 *
 * 契约同 `src/registry-stage.mjs::createRegistryWriter`：四个方法各返回 `{status}`，
 * **非零即失败**，调用方（`apply()`）据它记账。
 *
 * ⚠ 与 koffi 版的一处能力差异**如实声明**：`REG_OPTION_VOLATILE` 无法经 `reg.exe`
 * 表达（它没有该开关）。因此 `createKey` 遇到该选项时**返回非零 status 并把原因写进
 * `message`**，而不是悄悄按普通键创建 —— "重启即失"的语义不能丢。
 */
export function createRegExeWriter(options = {}) {
  const exec = options.exec ?? runReg
  const log = options.log ?? (() => {})
  const REG_OPTION_VOLATILE = 0x0000_0001
  const wire = options.wireBytes // (type, dataHex) => Buffer, 由调用方注入（registry-stage.registryWireBytes）

  const statusOf = (r) => {
    if (r.status === 0) return 0
    if (r.status === null) return 5
    return r.status
  }

  return {
    createKey(path, opts = {}) {
      if (((opts.dwOptions ?? 0) & REG_OPTION_VOLATILE) !== 0) {
        log(`writer: refusing REG_OPTION_VOLATILE via reg.exe (unsupported): ${path}`)
        return { status: 87, message: 'REG_OPTION_VOLATILE cannot be expressed through reg.exe' }
      }
      const r = exec(['add', path, '/f'], options)
      return { status: statusOf(r) }
    },
    setValue(path, valueName, type, dataHex) {
      const typeName = typeof type === 'string' && type.startsWith('REG_') ? type : String(type)
      let rendered
      try {
        rendered = renderValue(typeName, dataHex, wire)
      } catch (error) {
        return { status: 87, message: `${error?.message ?? error}` }
      }
      const args =
        valueName === undefined || valueName === null || valueName === ''
          ? ['add', path, '/ve', '/t', typeName, '/d', rendered, '/f']
          : ['add', path, '/v', valueName, '/t', typeName, '/d', rendered, '/f']
      const r = exec(args, options)
      return { status: statusOf(r) }
    },
    deleteValue(path, valueName) {
      const args =
        valueName === undefined || valueName === null || valueName === ''
          ? ['delete', path, '/ve', '/f']
          : ['delete', path, '/v', valueName, '/f']
      const r = exec(args, options)
      return { status: statusOf(r) }
    },
    deleteKey(path) {
      const r = exec(['delete', path, '/f'], options)
      return { status: statusOf(r) }
    },
  }
}

/**
 * 快照口径（`0x…` / 裸 hex）→ `reg.exe /d` 能接受的**文本**。
 *
 * 这一步不能省：把 UTF-16LE 的线格式字节直接当字符串写进去，非 ASCII 会变成乱码；
 * 而 `REG_DWORD` 的字节序写错会把 1 变成 16777216。两者都是"看起来成功"的静默错。
 */
export function renderValue(typeName, dataHex, wire) {
  const buffer = typeof wire === 'function' ? wire(typeName, dataHex) : undefined
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`cannot render ${typeName}: no wire encoder was provided`)
  }
  if (typeName === 'REG_DWORD') {
    if (buffer.length !== 4) throw new Error(`REG_DWORD wire length must be 4, got ${buffer.length}`)
    return String(buffer.readUInt32LE(0))
  }
  if (typeName === 'REG_BINARY') return buffer.toString('hex')
  if (typeName === 'REG_SZ' || typeName === 'REG_EXPAND_SZ') {
    return buffer.toString('utf16le').replace(/\u0000+$/, '')
  }
  if (typeName === 'REG_MULTI_SZ') {
    // 双 NUL 结尾的多字符串：`reg.exe` 用 `\0` 分隔，末尾空串代表结束。
    return buffer.toString('utf16le').replace(/\u0000+$/, '').split('\u0000').join('\\0')
  }
  throw new Error(`unsupported value type ${typeName}`)
}

/** 读 + 写两件套（`createRegistryStage` 的 `reader` / `writer` 都齐了）。 */
export function createHostRegistryBindings(options = {}) {
  return {
    reader: createRegExeReader(options),
    writer: createRegExeWriter(options),
  }
}
