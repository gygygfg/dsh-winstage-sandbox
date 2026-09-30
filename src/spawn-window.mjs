/**
 * Windows 子进程「控制台 / 弹框」策略 —— 单一权威定义
 *
 * 一、弹框是怎么来的（本模块要治的东西）
 *   子进程在**用户态 DLL 初始化阶段**失败时（最典型就是 `0xC0000142`
 *   = `STATUS_DLL_INIT_FAILED`），Windows 会弹一个模态「Application Error」框，
 *   标题就是失败的可执行文件名（例如 `node.exe`）。它阻塞交互桌面，
 *   而且因为 `CreateProcess` 早就返回成功了，日志里只有一个退出码。
 *   抑制办法是父进程调 `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX)`：
 *   该错误模式由子进程**继承**，于是失败如实变成退出码，不再弹框。
 *
 * 二、`windowsHide` 不是本机弹框的原因（实测证伪，重要）
 *   曾经的推断是「Node 的 `windowsHide: true` ⇒ `CREATE_NO_WINDOW` ⇒ 受限令牌下必死」。
 *   本机实测**推翻**了这一步：在 DSH 真实受限令牌（`WRITE_RESTRICTED` + Low 完整性，
 *   由 `@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js --mode read-only` 铸出）里，
 *   `spawnSync(node, ['-v'], ...)` 的四种组合（windowsHide true/false × `stdio: 'ignore'`
 *   与继承式 stdout）**全部 `status=0`、正常打印 `v24.21.0`**，一个都没死。
 *   证据：`.t\wcg\matrix.mjs`；对照 `.t\wcg\compare.mjs`。
 *
 *   仍然成立的是**原生 `CreateProcess` 的创建标志**这一层（本项目自己的实测）：
 *   `.t/sbx3/fixA/out/s1-flag-diff.json` —— 同一个 `cmd.exe /c ver`，只改标志：
 *   `0x00000000` → exit `0x0`；`0x08000000` (`CREATE_NO_WINDOW`) → `0xC0000142`；
 *   `0x00000010` (`CREATE_NEW_CONSOLE`) → `0xC0000142`。
 *   `@deepseek-ai/dsh-win32-process` 的原生受限令牌路径正是因此只用
 *   `STARTF_USESHOWWINDOW + SW_HIDE`，**不碰**这两个标志。
 *
 * 三、因此本项目的策略
 *   - `WINDOWS_HIDE = false`：**防御性**，不是本次弹框的修复。走 libuv 默认的
 *     `creationFlags = 0`，子进程附着父控制台（不新开窗口），从而与上面那组
 *     "被证明会死"的标志彻底脱钩；代价是父进程若无控制台，子进程可能可见。
 *   - `suppressWindowsCriticalErrorDialogs()`：**这才是治弹框的那一步**，在任何
 *     可能 spawn 子进程的进程入口调用一次即可（子进程继承）。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

export const WINDOWS_HIDE = false

const require_ = createRequire(import.meta.url)
let applied = false
/** 最近一次失败原因（koffi 解析不到 / 调用抛错）；成功时为 undefined */
let lastFailure

/** `SEM_FAILCRITICALERRORS(0x0001) | SEM_NOOPENFILEERRORBOX(0x8000)` */
const SUPPRESS = 0x0001 | 0x8000

/**
 * 抑制本进程及其全部子进程的模态「应用程序无法正常启动」错误框。
 *
 * 尽力而为：拿不到 koffi 时静默降级（什么都不做），绝不抛进 spawn 路径。
 * `[实测]` 在受限令牌（Low 完整性）下同样生效：`.t\wcg\check.mjs` 返回
 * `hideSafe=false suppress=true`。
 *
 * @returns {boolean} 是否成功设置
 */
/**
 * 解析 koffi。**不能用裸 `require('koffi')`**：本机实测在项目目录下解析不到
 * （`MODULE_NOT_FOUND`）——koffi 是随 DSH 安装的 FFI，真实落点是
 * `%USERPROFILE%\.dsh\profiles\node_modules\koffi`（见 `src/capability.mjs` 的 loadFfi 注释）。
 */
function loadKoffi() {
  const candidates = ['koffi']
  const push = (base) => {
    if (base) candidates.push(join(base, 'node_modules', 'koffi'))
  }
  push(process.env.DSH_PROFILE_DIR)
  push(process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles'))
  push(process.env.USERPROFILE && join(process.env.USERPROFILE, '.dsh', 'profiles'))
  for (const candidate of candidates) {
    try {
      return require_(candidate)
    } catch {
      // 继续下一个候选
    }
  }
  return undefined
}

export function suppressWindowsCriticalErrorDialogs() {
  if (applied) return true
  try {
    const koffi = loadKoffi()
    if (koffi === undefined) {
      // 不 latch：以后一次调用仍可成功（例如环境变量/解析路径变化后）
      lastFailure = 'koffi could not be resolved from any candidate path'
      return false
    }
    const kernel32 = koffi.load('kernel32.dll')
    const SetErrorMode = kernel32.func('uint32 SetErrorMode(uint32 mode)')
    SetErrorMode(SUPPRESS)
    applied = true
    lastFailure = undefined
    return true
  } catch (error) {
    lastFailure = error?.message ?? String(error)
    return false
  }
}

/**
 * 上次抑制失败的原因（成功或尚未调用时为 `undefined`）。
 *
 * 为什么要有它：原实现把 `applied` 在**调用前**就置 true，于是第一次失败之后
 * 每次调用都返回 `true` —— 那是"看起来成功"的假证据。现在只有真正调用了
 * `SetErrorMode` 才 latch，失败原因可被调用方（如 `src/executor.mjs`）读出并如实上报。
 *
 * @returns {string|undefined}
 */
export function dialogSuppressionFailure() {
  return lastFailure
}