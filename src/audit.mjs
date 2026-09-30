/**
 * 审计：从沙箱内部发起真实攻击探针
 *
 * 手册依据：
 *   附录 B.1  「所有安全声明必须有『从沙箱内部发起的真实攻击探针』证据」
 *   #16.10    无法消除的残余要写进文档并声明为非硬边界，不能假装没有
 *   第 17 章  验收看"保证覆盖"，不看测试数量；出口必须给出实际结果与仍未提供的保证
 *   第 4 章   空、无匹配、不存在、无权限是四种不同结果
 *   0.1       证据分层：每条都带 [实测]/[残余]/[未实测] 标记
 *
 * 纪律：
 *   - 探针**只读**宿主对象，唯一的写操作发生在沙箱自己的暂存根与垃圾目标上；
 *   - 不写注册表、不写系统目录、不建服务；
 *   - 无法实测的项目标 `not-run`，绝不以"推断"冒充"实测"（手册 0.1 / D.2 第 4 条）；
 *   - **空输出绝不解释为"拒绝"**（真实缺陷 11：曾导致读取面 10 项假通过）。
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowsStageExecutor, resolvePowerShell } from './executor.mjs'

/**
 * 仓库根（只用于**探针路径**的构造）。
 *
 * 为什么需要：S5 的证据在**仓库内**的非 AppData 浏览器 profile
 * （`.t\dsh2\browser\edge-profile\…`），既不在 `%APPDATA%` 也不在 `%USERPROFILE%` 下，
 * 用环境变量拼不出来。可用 `DSH_REPO_ROOT` 覆盖（迁移/测试用），
 * 默认按本模块位置推导（`<repo>\src\audit.mjs` → `<repo>`）。
 *
 * ⚠ 这个常量**不参与任何安全判定**，只出现在探针路径里；
 * 探针本身是**只读**的，且只回报判定 + 长度 + 前 4 字节哈希。
 */
const REPO_ROOT = (() => {
  const fromEnv = process.env.DSH_REPO_ROOT
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
})()

/**
 * 输出哨兵。用它而不是"能否 JSON.parse"判断脚本是否真的执行了：
 * 空输出与解析失败必须与"操作被拒绝"区分开（手册第 4 章）。
 */
const AUDIT_MARKER = 'DSH-AUDIT-JSON:'

/**
 * 所有沙箱内脚本的公共前导。
 *
 * 为什么显式设置控制台编码：Windows PowerShell 5.1 在受限令牌下若无法初始化
 * 控制台/编码子系统，可能直接以退出码 127（DLL 初始化失败类）结束且**不产出任何输出**。
 * 显式设定 UTF-8 输出 + 关闭进度条可减少这类静默失败面，也让非 ASCII 路径的
 * 字节表示稳定（否则按字符串匹配会全部落空）。
 */
const PS_PRELUDE = [
  "$ErrorActionPreference='Continue'",
  '$ProgressPreference="SilentlyContinue"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
].join('\n')

/**
 * 读取探针的**形态契约**（`kind` 决定沙箱内脚本走哪条判定路径）：
 *
 * | kind          | 沙箱内做什么                                          | 凭什么判"存在"                        |
 * |---|---|---|
 * | `file`        | `[System.IO.File]::ReadAllBytes`                      | `File::Exists`（**不是** `Test-Path`） |
 * | `directory`   | `[System.IO.Directory]::EnumerateFileSystemEntries`   | `Directory::Exists`                   |
 * | `pipe-absent` | 只对**不存在**的命名管道做存在性判定                   | 恒 `not-present`（预期如此）           |
 *
 * ── 为什么 `directory` 不再用 `Get-Content -TotalCount 1`（原实现）────────────────
 * 原实现用 `Get-Content` 读第一行来判"可读"。对**目录**这条路径在 PowerShell 里
 * 多数情况会**成功**（它枚举出目录项），于是"目录可枚举"与"文件内容可读"被混为一谈；
 * 而且 `Get-Content` 的成败与目录 ACL 并不一致。改成**显式目录枚举**，
 * 并把结论写成 `readable` + `entries` 计数 —— 判据与后果都能读出来。
 *
 * ── 为什么单列 `pipe-absent` 而不是让不存在走异常分支 ─────────────────────────
 * `[实测]` 本机 `.ssh\*` 四条**不存在**。若"不存在"只表现为异常，
 * 很容易被记成 `denied`（把"没有这个文件"说成"被拒绝了"——手册第 4 章明令禁止）。
 * 这里用一条**必然不存在**的命名管道把"不存在"这条路真实走一遍，
 * 与"存在但拒绝"（`SAM`/`SYSTEM`：`stat` 即 EPERM）形成对照。
 */
const READ_PROBE_KINDS = ['file', 'directory', 'pipe-absent']

/**
 * 宿主敏感对象读取探针：读得到就是泄露，读不到才是收敛。
 *
 * ⚠ **顺序即契约**：`sam-hive` … `npmrc` 这 10 条的 **id 与相对顺序**被
 * `tests\audit-parse.mjs` 逐字引用（"上报顺序必须与探针表一致"）。
 * 新增探针**只能追加**，不得插队或改名（改了必须同步改测试里的期望数组）。
 *
 * `maskClass` = 该路径**预期**命中的 `MASK_CLASSES.id`；缺省表示"对照项，不预期被遮蔽"。
 * 映射由 `tests\audit-parse.mjs` 双向校验，并与 `src\paths.mjs::MASK_PROBES` 对照：
 * 没有读取探针的遮蔽类必须在 `READ_PROBE_MISSING_MASK_CLASSES` 里**显式**登记。
 *
 * ── 秘密内容**绝不**进证据 ─────────────────────────────────────────────────
 * 沙箱内脚本每行只回报六个键（`READ_PROBE_ROW_KEYS` 是唯一权威，测试逐字断言）：
 * `id` / `path` / `verdict`（判定）/ `len`（字节长度；目录为**条目数**）/
 * `head4`（**前 4 字节**（不足 4 字节则全部）的 SHA-256，64 位十六进制 — 即**完整**摘要，
 * 不是前 8 位；字段名保留 `head4` 是指"被哈希的输入是前 4 字节"）/ `errCode`。
 * **没有任何一条路径会把文件内容写进 stdout**，因此证据里不可能出现秘密本体；
 * 4 字节的哈希只用于"同/异"比对，不可逆推内容（见报告 §脱敏声明）。
 *
 * `verdict` 的取值与含义（**五态**，全部由沙箱内脚本实测得出，不靠猜）：
 *   `readable`            —— 文件内容读出来了 / 目录枚举成功（`len` 有值）
 *   `denied`              —— 目录存在但**枚举被拒**（权限拒绝）
 *   `read-metadata-only`  —— 名字能列出、属性可读，但**内容读不出来**。
 *                            `[实测]` 本机 SAM/SYSTEM/浏览器凭据库/安全事件日志 5 条落在这一态。
 *                            **不记 pass**：读不到 ≠ 我们挡住了（来源无法归因）。
 *   `not-present`         —— 父目录都不存在（"本机没有"，**绝不是**被拒绝）
 *   `error`               —— 其余情形一律交回调用方标 fail 复看，**不猜**
 */
const READ_PROBES = [
  { id: 'sam-hive', path: 'C:\\Windows\\System32\\config\\SAM', kind: 'file', label: '本地账户数据库 SAM', maskClass: 'sam' },
  { id: 'system-hive', path: 'C:\\Windows\\System32\\config\\SYSTEM', kind: 'file', label: '系统配置单元', maskClass: 'sam' },
  { id: 'win-ini', path: 'C:\\Windows\\win.ini', kind: 'file', label: '系统文件（对照项，预期可读）' },
  { id: 'hosts-file', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', kind: 'file', label: 'hosts 主机名映射', maskClass: 'hosts' },
  { id: 'unattend', path: 'C:\\Windows\\Panther\\Unattend.xml', kind: 'file', label: '无人值守安装应答（可能含明文口令）', maskClass: 'unattend' },
  { id: 'dsh-sessions', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.dsh'), kind: 'directory', label: 'DSH 主目录（会话日志/凭据）', maskClass: 'dsh-home' },
  { id: 'ssh-keys', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.ssh'), kind: 'directory', label: 'SSH 私钥目录', maskClass: 'ssh' },
  // 注意：这一条探测的是 **dpapi-user 的目录本身**（S3 的核心口径），
  // 不是"目录里的某个文件"——`canonical()` 会去掉结尾分隔符，两者命中的规则不同。
  { id: 'dpapi-user', path: join(process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming', 'Microsoft', 'Protect'), kind: 'directory', label: '用户 DPAPI 主密钥目录', maskClass: 'dpapi-user' },
  { id: 'git-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.git-credentials'), kind: 'file', label: 'Git 明文凭据', maskClass: 'git-credentials' },
  { id: 'npmrc', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.npmrc'), kind: 'file', label: 'npm 令牌', maskClass: 'npmrc' },

  // ── 追加区（只有追加才是契约安全的；见上面的 ⚠）──────────────────────────────
  { id: 'dpapi-machine-protect', path: 'C:\\Windows\\System32\\Microsoft\\Protect', kind: 'directory', label: '机器 DPAPI 主密钥目录', maskClass: 'dpapi' },
  // S5：既有 `browser` 规则硬编码 `\appdata\...`，非 AppData 的浏览器 profile 完全不遮蔽。
  // `[实测]` 修复前六条全部 `readable` + `mask=(none)`，长度 129024/51200/25300/129024/51200/74863。
  { id: 'browser-logins-localappdata', path: join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'), kind: 'file', label: 'AppData 内浏览器凭据库（既有 browser 规则）', maskClass: 'browser' },
  { id: 'browser-logins-nonappdata', path: join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Login Data'), kind: 'file', label: 'AppData 外浏览器凭据库 Login Data（S5）', maskClass: 'browser-profile-auth-db' },
  { id: 'browser-logins-account-nonappdata', path: join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Default', 'Login Data For Account'), kind: 'file', label: 'AppData 外浏览器凭据库 Login Data For Account（S5）', maskClass: 'browser-profile-auth-db' },
  { id: 'browser-localstate-nonappdata', path: join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile', 'Local State'), kind: 'file', label: 'AppData 外浏览器 Local State（含加密密钥；S5）', maskClass: 'browser-profile-state' },
  { id: 'browser-localstate-headful-nonappdata', path: join(REPO_ROOT, '.t', 'dsh2', 'browser', 'edge-profile-headful', 'Local State'), kind: 'file', label: 'AppData 外浏览器 Local State（headful；S5）', maskClass: 'browser-profile-state' },
  { id: 'private-key-user-pfx', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', 'certs', 'client.pfx'), kind: 'file', label: '用户目录私钥导出（N8）', maskClass: 'private-key-files' },
  { id: 'private-key-programdata-key', path: 'C:\\ProgramData\\app\\server.key', kind: 'file', label: 'ProgramData 私钥导出（N8）', maskClass: 'private-key-files' },
  { id: 'unattend-family-autounattend', path: 'C:\\Windows\\Panther\\autounattend.xml', kind: 'file', label: '首次启动应答族（N5）', maskClass: 'unattend-family' },
  { id: 'sysprep-inf', path: 'C:\\Windows\\System32\\Sysprep\\sysprep.inf', kind: 'file', label: 'sysprep 应答（N5）', maskClass: 'unattend-family' },
  { id: 'net-config-networks', path: 'C:\\Windows\\System32\\drivers\\etc\\networks', kind: 'file', label: 'networks 配置（N6）', maskClass: 'net-config-family' },
  { id: 'security-evtx', path: 'C:\\Windows\\System32\\winevt\\Logs\\Security.evtx', kind: 'file', label: '安全事件日志（N6）', maskClass: 'net-config-family' },
  { id: 'vscode-globalstorage', path: join(process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'), kind: 'file', label: 'VS Code 扩展令牌状态（N7）', maskClass: 'editor-token-state' },
  { id: 'credential-manager', path: join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft', 'Credentials'), kind: 'directory', label: 'Windows 凭据管理器目录（N3）', maskClass: 'cred-vault' },
  { id: 'inetcookies', path: join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft', 'Windows', 'INetCookies'), kind: 'directory', label: '系统 cookie 缓存（N9）', maskClass: 'credential-cache' },
  { id: 'dsh-credentials-file', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.dsh', '.credentials.yaml'), kind: 'file', label: 'DSH 凭据文件（N4）', maskClass: 'dsh-credentials' },
  { id: 'dsh-profile-deps', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.dsh', 'profiles'), kind: 'directory', label: 'DSH profile 依赖树（N4）', maskClass: 'dsh-profile-deps' },
  { id: 'aws-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.aws', 'credentials'), kind: 'file', label: 'AWS 凭据', maskClass: 'aws' },
  { id: 'kube-config', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.kube', 'config'), kind: 'file', label: 'kubeconfig', maskClass: 'kube' },
  { id: 'gcloud-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.config', 'gcloud', 'credentials.db'), kind: 'file', label: 'gcloud 凭据', maskClass: 'gcloud' },
  { id: 'gh-hosts-yml', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.config', 'gh', 'hosts.yml'), kind: 'file', label: 'gh CLI 凭据（N1）', maskClass: 'cli-cred-dirs' },
  { id: 'terraform-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.terraform.d', 'credentials.tfrc.json'), kind: 'file', label: 'Terraform 凭据（N1）', maskClass: 'cli-cred-dirs' },
  { id: 'pypirc-token', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.pypirc'), kind: 'file', label: 'PyPI 令牌（N2）', maskClass: 'pkg-token-files' },
  { id: 'docker-config', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.docker', 'config.json'), kind: 'file', label: 'Docker 注册表令牌（N2）', maskClass: 'pkg-token-files' },
  { id: 'cargo-credentials', path: join(process.env.USERPROFILE || 'C:\\Users\\Default', '.cargo', 'credentials.toml'), kind: 'file', label: 'Cargo 令牌（N2）', maskClass: 'pkg-token-files' },
  { id: 'nuget-config', path: join(process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming', 'NuGet', 'NuGet.Config'), kind: 'file', label: 'NuGet 令牌（N2）', maskClass: 'pkg-token-files' },
  { id: 'wifi-profiles', path: 'C:\\ProgramData\\Microsoft\\WlanSvc', kind: 'directory', label: 'Wi-Fi 配置（含明文密钥）', maskClass: 'wifi' },
  { id: 'ntds-dit', path: 'C:\\Windows\\NTDS\\ntds.dit', kind: 'file', label: 'AD 数据库', maskClass: 'sysvol-copy' },
  { id: 'crashdump', path: join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'CrashDumps'), kind: 'directory', label: '进程转储目录（N10）', maskClass: 'process-dumps' },
  // "不存在"路径的形状回归（[实测] 本机这两条都不存在；必须记 not-present，**不得**记 denied）
  { id: 'absent-pipe-shape', path: '\\\\.\\pipe\\dsh-audit-absent-probe-7f3a', kind: 'pipe-absent', label: '必然不存在的命名管道（not-present 形状回归）' },
  { id: 'absent-sysprep-unattend', path: 'C:\\Windows\\System32\\Sysprep\\unattend.xml', kind: 'file', label: '不存在的 Sysprep 应答（not-present 形状回归）', maskClass: 'unattend-family' },
  // `stage-store`（`.dshstage`）是**本工具自身存储**，unmask 永不解除（手册 16.2/#16.8）。
  // 探针指向**仓库根**的 `.dshstage`（`[实测]` 存在），而不是某个具体工作区 ——
  // 探针表是模块级常量，拿不到 runAudit 的 workspace 参数；用 `DSH_REPO_ROOT` 推导即可，
  // 且"仓库根有没有 `.dshstage`"本身就是这台机器上一个可观测事实（存在 ⇒ 报告长度）。
  { id: 'stage-store', path: join(REPO_ROOT, '.dshstage'), kind: 'directory', label: '沙箱自身存储（unmask 永不解除）', maskClass: 'stage-store' },
]

/**
 * `[Console]::Out.Write` 的**唯一**一处行构造（见 `buildReadProbeScript`）。
 *
 * 把"上报哪些字段"收敛成**一个**显式构造点，是为了让"秘密不进证据"这条红线
 * 可以被审阅与测试：这里**只有** id / path / verdict / len / head4 / errCode，
 * 没有任何 `content` / 内容片段字段。PowerShell 的 `[ordered]@{}` + `Select-Object`
 * 不会像 `PSCustomObject` 那样额外带 `PSPath`/`PSParentPath`/`PSChildName` 元数据。
 */
const READ_PROBE_ROW_KEYS = ['id', 'path', 'verdict', 'len', 'head4', 'errCode']

/**
 * 把读取探针编译成一段**自包含**的 PowerShell 脚本，
 * 并把结果约定为 `[ { id, path, verdict, len, head4, errCode } ]`。
 *
 * 三条硬要求（每条都对应一个真实失效形态）：
 *  1. **判定分三态**：`readable` / `denied` / `not-present`（外加 `error`）。
 *     "不存在"绝不能表现成 `denied`（手册第 4 章；本机 `.ssh\*` 就是这一形态）。
 *  2. **只回报判定 + 长度 + 前 4 字节哈希**。脚本里**没有任何**把文件内容回传的路径，
 *     秘密本体不可能出现在 stdout/证据里。
 *  3. **逐项独立**：任一条异常只影响自己（单条 `try/catch`），
 *     不会让整批探针"没输出"而被误读成全体拒绝。
 *
 * ── 探针表**不进脚本正文**，而是落在命令行给的一个临时文件里 ─────────────────────
 * `[实测]` 把整表（42 条）内嵌成 base64 后 `-EncodedCommand` 长 **21356 字符**，
 * 该脚本在本机以 `status=-1 / stdout=0 字符 / stderr=空` 的方式**静默失败**
 * （分块降到 2 条则一切正常）—— 典型的命令行长度/转义上限问题。
 * 因此这里改成：脚本正文固定且很短，探针表由 `argv[0]` 指向的 JSON 文件提供。
 * 这同时让"脚本是纯 ASCII"更容易保证（路径完全不出现在命令行或正文里）。
 *
 * @param {string} argv0 探针表 JSON 文件的**绝对路径**（由 Node 侧落盘）
 */
function buildReadProbeScript(argv0, marker = AUDIT_MARKER) {
  if (typeof argv0 !== 'string' || argv0.length === 0) throw new TypeError('buildReadProbeScript: argv0 must be a non-empty path')
  return [
    `$probeFile = '${q(argv0)}'`,
    // 脚本自身不得写任何东西到 stdout（除末尾那一次哨兵输出）
    '$ErrorActionPreference = \'Continue\'',
    '$items = ConvertFrom-Json (Get-Content -LiteralPath $probeFile -Raw -Encoding UTF8)',
    '$sha = [System.Security.Cryptography.SHA256]::Create()',
    // 显式选择字段：让"上报什么"在生成脚本里**看得见**（与 READ_PROBE_ROW_KEYS 一一对应）。
    // 不用裸 `[ordered]@{}` 直接送进 ConvertTo-Json，是为了防 PSObject 额外附着元数据字段。
    `$keys = @(${READ_PROBE_ROW_KEYS.map((key) => `'${key}'`).join(',')})`,
    '$rows = @()',
    'foreach ($it in $items) {',
    "  $verdict = 'error'; $len = -1; $head4 = $null; $errCode = $null",
    '  try {',
    "    if ($it.kind -eq 'pipe-absent') {",
    '      if (Test-Path -LiteralPath $it.path) { $verdict = \'readable\' } else { $verdict = \'not-present\' }',
    "    } elseif ($it.kind -eq 'directory') {",
    '      if ([System.IO.Directory]::Exists($it.path)) {',
    '        $len = @([System.IO.Directory]::EnumerateFileSystemEntries($it.path)).Count',
    "        $verdict = 'readable'",
    '      } else {',
    "        $verdict = 'not-present'",
    '      }',
    '    } else {',
    '      if ([System.IO.File]::Exists($it.path)) {',
    // `head4` 的语义**逐字兑现**：恒为"**前 4 字节**（不足 4 字节则全部）的 SHA-256 十六进制"。
    // 早先的写法分成两支（>0 / ==0），语义变成"要么前 4 字节、要么全文件"，
    // 一个 64 位十六进制串在证据里无法区分这两种含义 —— 描述与实测必须一致。
    '        $bytes = [System.IO.File]::ReadAllBytes($it.path)',
    '        $len = $bytes.Length',
    '        $take = [Math]::Min(4, $len)',
    '        $head4 = ([BitConverter]::ToString($sha.ComputeHash($bytes, 0, $take))).Replace(\'-\', \'\').ToLowerInvariant()',
    "        $verdict = 'readable'",
    '      } else {',
    "        $verdict = 'not-present'",
    '      }',
    '    }',
    '  } catch {',
    '    $errCode = $_.Exception.GetType().Name',
    '    $inner = $_.Exception.InnerException',
    '    if ($inner -ne $null) { $errCode = $errCode + \'<\' + $inner.GetType().Name + \'>\' }',
    // ⚠ HResult 必须按 **32 位无符号** 格式化。
    // `[实测]` 两种错法都会给出不可读的证据：`-bxor 0` 之后 `ToString('X8')` 得到负数补码的
    // 短串（曾输出 `MethodInvocationException/0x` —— 后面什么都没有），
    // 而 `([uint32]$hr)` 在 $hr 为 $null 时**整条字符串拼接都不执行**（语句抛错被吞），
    // 结果只剩类型名。因此这里显式判空 + 逐段拼接。
    '    $hr = $_.Exception.HResult',
    '    if ($hr -ne $null) {',
    '      try { $errCode = $errCode + \'/0x\' + ([uint32]($hr -band 0xFFFFFFFF)).ToString(\'X8\') } catch { }',
    '    }',
    // ── "读不到"必须分类，且**必须实测**，不能靠异常类型猜 ────────────────────────
    // `[实测]` 一个关键事实：ACL 拒绝读的路径上 `[System.IO.File]::Exists()` 返回 **$false**
    // （它不走异常路径）。若据此记 `not-present`，`SAM` 与浏览器凭据库就被说成"本机没有"——
    // 正是手册第 4 章禁止的混淆。因此用两条**显式探测**区分四种结果：
    //   ① 父目录是否可枚举（可枚举 ⇒ 权限上我们能"看"这个目录）
    //   ② 文件名*字面*匹配能否列出（能列出 ⇒ 对象存在）
    '    $dir = [System.IO.Path]::GetDirectoryName($it.path)',
    '    $listable = $false',
    '    $dirReadable = $false',
    '    $dirOk = ($dir -ne $null) -and ($dir.Length -gt 0) -and ([System.IO.Directory]::Exists($dir))',
    '    if ($dirOk) {',
    '      try { $null = [System.IO.Directory]::GetFileSystemEntries($dir, \'*\'); $dirReadable = $true } catch { $dirReadable = $false }',
    '      if ($dirReadable) {',
    // 用 GetFiles(dir) 全量枚举再逐个比对**文件名**；不采用"带 pattern"的写法，
    // 因为模式里的 `[`/`]` 会被当成字符类（`Login Data` 这类名字里可能带）。
    '        try {',
    '          foreach ($f in [System.IO.Directory]::GetFiles($dir)) {',
    '            if ([System.IO.Path]::GetFileName($f) -eq [System.IO.Path]::GetFileName($it.path)) { $listable = $true; break }',
    '          }',
    '        } catch { $listable = $false }',
    '      }',
    '    }',
    '    if (-not $dirOk) {',
    "      $verdict = 'not-present'",
    '    } elseif (-not $dirReadable) {',
    // 目录在、但枚举被拒 ⇒ 权限拒绝（不是"没有这个文件"）
    "      $verdict = 'denied'",
    '    } else {',
    '      $attrsOk = $false',
    '      if ($listable) {',
    '        try { $null = [System.IO.File]::GetAttributes($it.path); $attrsOk = $true } catch { $attrsOk = $false }',
    '      }',
    '      if ($listable -and $attrsOk) {',
    // 能列出、能读属性，但**内容**读不出来 ⇒ 单独一态。
    // `[实测]` 本机 SAM/SYSTEM/浏览器凭据库/安全事件日志 共 5 条落在这里：
    // 若把它们记成 `denied`（读取被拒）就是**伪造一个安全拒绝**；
    // 若记成 `not-present` 就是把"存在"说成"不存在"。两种都是手册第 4 章禁止的。
    "        $verdict = 'read-metadata-only'",
    '      } elseif ($listable) {',
    "        $verdict = 'denied'",
    '      } else {',
    // 目录可枚举但名字列不出来：不猜（不记 denied），如实进 error 让调用方标 fail 复看。
    "        $verdict = 'error'",
    '      }',
    '    }',
    '  }',
    // 只把白名单里的键送出去：**没有任何内容字段**（红线由本行与上面 $keys 共同保证）
    '  $row = [ordered]@{}',
    '  foreach ($k in $keys) { $row[$k] = (Get-Variable -Name $k -ValueOnly -Scope 0 -ErrorAction SilentlyContinue) }',
    '  $row[\'id\'] = $it.id',
    '  $row[\'path\'] = $it.path',
    '  $row[\'verdict\'] = $verdict',
    '  $row[\'len\'] = $len',
    '  $row[\'head4\'] = $head4',
    '  $row[\'errCode\'] = $errCode',
    '  $rows += $row',
    '}',
    `[Console]::Out.Write('${marker}' + (ConvertTo-Json -Compress -Depth 4 -InputObject @($rows)))`,
  ].join('\n')
}

/** 探针表 → 落盘用的 JSON 文本（只含 id/path/kind，**不含** label/掩码类等无关字段） */
function readProbePayload(probes) {
  return JSON.stringify(probes.map((probe) => ({ id: probe.id, path: probe.path, kind: probe.kind })))
}

/**
 * 遮蔽类 → 读取探针的**缺口登记表**。
 *
 * 为什么需要它：`src\paths.mjs::MASK_CLASSES` 里有些类在**任何具体机器上**都可能
 * 一个样本都没有（例如 `sysvol-copy` 的 `ntds.dit` 只在域控上）。
 * "悄悄少一条映射"正是本测试要防的失效形态，因此规则是：
 * **要么有读取探针，要么在这里逐字登记为什么没有**。两边都没有 ⇒ 断言红。
 *
 * ⚠ 诚实声明：本表**当前为空**是**实测结论**，不是省事 ——
 * `MASK_CLASSES` 里 29 个遮蔽类每一个都已在本表上方落到一条具体候选路径上
 * （含 `stage-store` 指向仓库根 `.dshstage`）。空表由断言强制：
 * 一旦有人加了规则却忘了探针，测试立刻红，而不是让这张表变成"万能豁免"。
 */
const READ_PROBE_MISSING_MASK_CLASSES = Object.freeze({})

/** 单次沙箱调用里塞几条探针：8 条 ×（存在性 + 读/枚举 + 4 字节哈希）≈ 1 次几十毫秒 */
const READ_PROBE_CHUNK = 8

/**
 * PowerShell `-EncodedCommand` 的载荷：**UTF-16LE** 的 base64。
 * 这样脚本里不需要出现任何非 ASCII 字符，命令行也不会被代码页/引号规则改写。
 */
function encodePowerShellCommand(script) {
  if (typeof script !== 'string' || script.length === 0) throw new TypeError('encodePowerShellCommand: script must be a non-empty string')
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 静态校验探针表的**形态契约**（纯函数，不需要沙箱，因此可在离线测试里断言）。
 *
 * 检查四件事：
 *   1. 每条都有非空 `id` / `path` / `label`；
 *   2. `id` 不重复（重复会让"按 id 找结论"取到错误的那一条）；
 *   3. `kind` 必须是 `READ_PROBE_KINDS` 之一（拼错 kind 会让脚本静默退化成 file 分支）；
 *   4. 每条 `maskClass`（若有）都必须在 `knownMaskClasses` 里存在（遮罩类改名后探针会变孤儿）。
 *
 * @returns {{errors: string[], ok: boolean}}
 */
function validateReadProbes(probes = READ_PROBES, knownMaskClasses = undefined, missingAllowed = READ_PROBE_MISSING_MASK_CLASSES) {
  const errors = []
  const ids = probes.map((probe) => probe?.id)
  for (const [index, probe] of probes.entries()) {
    if (!probe || typeof probe !== 'object') {
      errors.push(`#${index + 1} 不是对象`)
      continue
    }
    if (typeof probe.id !== 'string' || probe.id.length === 0) errors.push(`#${index + 1} 缺 id`)
    if (typeof probe.path !== 'string' || probe.path.length === 0) errors.push(`${probe.id ?? `#${index + 1}`} 缺 path`)
    if (typeof probe.label !== 'string' || probe.label.length === 0) errors.push(`${probe.id ?? `#${index + 1}`} 缺 label`)
    if (!READ_PROBE_KINDS.includes(probe.kind)) {
      errors.push(`${probe.id ?? `#${index + 1}`} 的 kind=${JSON.stringify(probe.kind)} 不在 ${READ_PROBE_KINDS.join('/')} 内`)
    }
  }
  const dupes = [...new Set(ids.filter((id, index) => id !== undefined && ids.indexOf(id) !== index))]
  for (const dupe of dupes) errors.push(`重复探针 id：${dupe}`)
  if (Array.isArray(knownMaskClasses)) {
    const known = new Set(knownMaskClasses)
    for (const probe of probes) {
      if (probe?.maskClass !== undefined && !known.has(probe.maskClass)) {
        errors.push(`${probe.id} 指向不存在的遮蔽类 ${JSON.stringify(probe.maskClass)}`)
      }
    }
    // 反向：每个遮蔽类都必须有读取探针，或在缺口登记表里显式登记
    const covered = new Set(probes.map((probe) => probe?.maskClass).filter(Boolean))
    for (const id of knownMaskClasses) {
      if (!covered.has(id) && !(id in (missingAllowed ?? {}))) {
        errors.push(`遮蔽类 ${id} 既没有读取探针，也没有在缺口登记表里登记`)
      }
    }
  }
  return { errors, ok: errors.length === 0 }
}

const WRITE_PROBE_IDS = [
  ['write-inside-staging', '暂存根内写入'],
  ['write-outside-staging', '暂存根外写入'],
  ['write-system-dir', '系统目录写入'],
  ['delete-outside-staging', '暂存根外删除'],
  ['temp-rewritten', 'TEMP 重写'],
  ['secret-env-blocked', '敏感环境变量不注入'],
  ['proxy-env-blocked', '代理环境变量不注入'],
]

export async function runAudit(workspace, options = {}) {
  const findings = []
  const log = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`)
  }

  log('=== 沙箱审计：从沙箱内部发起真实探针 ===')
  log(`工作区: ${workspace.root}`)
  log('')

  // ---------- A. 能力探测 ----------
  const caps = WindowsStageExecutor.capabilities()
  findings.push({
    area: 'capability',
    id: 'acl-backend-loadable',
    status: caps.aclAvailable ? 'pass' : 'fail',
    evidence: '[实测]',
    detail: caps.aclAvailable
      ? `@deepseek-ai/dsh-sandbox-windows-acl@${caps.aclVersion} 从 ${caps.aclFrom} 加载成功`
      : `加载失败: ${caps.aclError}`,
  })
  findings.push({
    area: 'capability',
    id: 'win32-process-loadable',
    status: caps.win32Available ? 'pass' : 'fail',
    evidence: '[实测]',
    detail: caps.win32Available
      ? `@deepseek-ai/dsh-win32-process@${caps.win32Version} 从 ${caps.win32From} 加载成功`
      : `加载失败: ${caps.win32Error}`,
  })
  findings.push({
    area: 'capability',
    id: 'powershell-interpreter',
    status: 'informational',
    evidence: '[实测]',
    detail: (() => {
      try {
        const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
        return `选用 ${shell.name} → ${shell.command}（本机没有 pwsh 时自动回退 Windows PowerShell 5.1）`
      } catch (error) {
        return `未找到任何 PowerShell 解释器: ${error.message}`
      }
    })(),
  })

  // ---------- B. 建立沙箱内执行环境 ----------
  const executor = new WindowsStageExecutor({
    stagingRoot: workspace.store.stagedDir,
    mode: 'workspace-write',
  })
  let initReport
  let sandboxUsable = true
  /**
   * 探针未执行的归因。必须区分两种"没跑"：
   *   'nesting-limit' → 机制边界（已受限会话不能嵌套），标 `not-run`，不计 fail
   *   'defect'        → 实现缺陷，标 `fail`，必须修
   * 早先版本把两者混为一谈，让一个代码 bug 看起来像环境限制。
   */
  let blocked = undefined

  try {
    initReport = await executor.init()
    findings.push({
      area: 'capability',
      id: 'sandbox-init',
      status: 'pass',
      evidence: '[实测]',
      detail: `受限令牌与 ACL 授予建立成功（tier=T1，flags=${initReport.jobFlags}）`,
      data: { capturedFields: initReport.capturedFields, jobConfig: initReport.jobConfig },
    })
  } catch (error) {
    sandboxUsable = false
    const rights = WindowsStageExecutor.capabilities()
    const missing = []
    try {
      const { probeWin32Abi } = await import('./capability.mjs')
      const abi = probeWin32Abi()
      for (const [name, granted] of Object.entries(abi?.checks?.tokenRights?.granted ?? {})) {
        if (!granted) missing.push(name)
      }
    } catch {
      /* 探测失败不影响主结论 */
    }

    const code = error.code || '(no code)'
    // 只有"确实因令牌权限不足"才声称不可嵌套；其余一律如实报为需要修复的缺陷
    const isNestingLimit =
      missing.length > 0 && /OpenProcessToken|CreateRestrictedToken|SANDBOX_UNAVAILABLE/.test(error.message)
    const detail = isNestingLimit
      ? `无法在当前会话内建立嵌套沙箱：${error.message}。` +
        `精确原因：本会话令牌缺少 CreateRestrictedToken 所需的 ${missing.join(', ')}` +
        '（因为它本身就是一个 WRITE_RESTRICTED 受限令牌）。' +
        '这是"隔离不可嵌套"的实测边界，不是本沙箱的缺陷；' +
        '请在**未受限的终端**中重新运行本审计以取得完整证据。'
      : `建立沙箱失败：${code}: ${error.message}。` +
        '这**不是**令牌权限问题，而是需要修复的实现缺陷（例如绑定表契约不符）。' +
        '不要把该失败归因为"隔离不可嵌套"。'

    findings.push({
      area: 'capability',
      id: 'sandbox-init',
      status: isNestingLimit ? 'not-run' : 'fail',
      evidence: '[实测] 拒绝建立',
      detail,
      data: { errorCode: code, missingRights: missing, nestingLimit: isNestingLimit, aclAvailable: rights.aclAvailable },
    })
    blocked = isNestingLimit
      ? { kind: 'nesting-limit', status: 'not-run', reason: '嵌套沙箱不可用（机制边界），见 sandbox-init 结论' }
      : { kind: 'defect', status: 'fail', reason: `沙箱建立失败（实现缺陷）：${code}: ${error.message}` }
  }

  // ---------- B2. 预检：沙箱内的 shell 必须真的能产出输出 ----------
  //
  // 为什么必须有这一步（真实缺陷 11）：曾出现"读取面 10 项全部 ✓（拒绝读取 unknown）、
  // 写入面 7 项全部 ✗、TEMP=undefined"的结果 —— 真相是子进程**根本没产出任何输出**，
  // 而审计把"空输出"当成了"拒绝读取"。
  if (sandboxUsable) {
    const marker = `DSH-PREFLIGHT-${Date.now().toString(36)}`
    // 预检不只问"有没有输出"，还要在能出输出时**回报子进程真实拿到的关键环境变量**。
    // 目的：把"shell 起来了吗 / 缺哪个变量"从猜测变成一次可读的实测记录
    // （真实缺陷 11 的根因定位手段）。
    const preflightScript = [
      PS_PRELUDE,
      '$o=[ordered]@{}',
      "$o.SystemRoot=$env:SystemRoot",
      "$o.windir=$env:windir",
      "$o.PATHlen=($env:PATH | Measure-Object -Character).Characters",
      "$o.TEMP=$env:TEMP",
      "$o.USERPROFILE=$env:USERPROFILE",
      "$o.PSVersion=$($PSVersionTable.PSVersion.ToString())",
      "$o.comspec=$env:ComSpec",
      '[Console]::Out.Write(\'' + marker + '\' + ($o|ConvertTo-Json -Compress))',
    ].join('\n')
    let shellDiagnostic
    let shellReady = false
    let envProbe
    try {
      const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
      const outcome = await executor.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', preflightScript],
        cwd: workspace.store.stagedDir,
        timeoutMs: 60000,
      })
      shellReady = outcome.stdout.includes(marker)
      // 预检用的是自己的哨兵，必须显式传入（默认值是 AUDIT_MARKER）
      envProbe = parseMarkedJson(outcome.stdout, marker)
      shellDiagnostic = {
        shell: shell.command,
        shellName: shell.name,
        exitCode: outcome.exitCode,
        stdoutLength: outcome.stdout.length,
        stdoutPreview: outcome.stdout.slice(0, 300),
        stderrPreview: outcome.stderr.slice(0, 500),
        launchFailed: outcome.launchFailed === true,
        classification: outcome.classification,
        childEnvKeys: outcome.envKeys,
        resolvedCommand: outcome.resolvedCommand,
      }
    } catch (error) {
      shellDiagnostic = { error: error.message }
    }
    findings.push({
      area: 'capability',
      id: 'sandbox-shell-preflight',
      status: shellReady ? 'pass' : 'fail',
      evidence: '[实测] 从沙箱内部发起',
      detail: shellReady
        ? `沙箱内 shell 可执行并产出输出（${shellDiagnostic.shellName}）；` +
          `子进程关键变量=${JSON.stringify(envProbe)}`
        : '沙箱内 shell **无法产出任何输出**，因此读/写边界探针的结论一律无效' +
          '（不能把空输出当成拒绝）。诊断：' +
          `shell=${shellDiagnostic?.shellName} resolved=${shellDiagnostic?.resolvedCommand} ` +
          `退出码=${shellDiagnostic?.exitCode} stdout长度=${shellDiagnostic?.stdoutLength} ` +
          `launchFailed=${shellDiagnostic?.launchFailed} ` +
          `子进程环境变量个数=${shellDiagnostic?.childEnvKeys?.length} ` +
          `stderr=${JSON.stringify((shellDiagnostic?.stderrPreview ?? '').slice(0, 300))}`,
      data: shellDiagnostic,
    })
    if (!shellReady) {
      blocked = {
        kind: 'defect',
        status: 'fail',
        reason: '沙箱内 shell 无法产出输出（预检失败），边界探针无法取得有效证据；空输出不得解释为"拒绝"。',
      }
      sandboxUsable = false
    }
  }

  // ---------- C. 写入面探针 ----------
  const stamp = Date.now().toString(36)
  const insideTarget = join(workspace.store.stagedDir, `.audit-inside-${stamp}.txt`)
  const outsideTarget = join(workspace.root, '..', `.audit-outside-${stamp}.txt`)
  const systemTarget = `C:\\Windows\\audit-${stamp}.txt`

  if (sandboxUsable) {
    // 脚本必须用**换行**连接，不能用分号拼成一行：分号拼接在 PowerShell 5.1 下
    // 对 try/catch 等语句块很脆弱，而"有没有输出"是我们唯一的成败判据，风险过高。
    const script = [
      PS_PRELUDE,
      '$r=[ordered]@{}',
      `try { Set-Content -LiteralPath '${q(insideTarget)}' -Value x -ErrorAction Stop; $r.inside='ok' } catch { $r.inside='denied' }`,
      `try { Set-Content -LiteralPath '${q(outsideTarget)}' -Value x -ErrorAction Stop; $r.outside='ok' } catch { $r.outside='denied' }`,
      `try { Set-Content -LiteralPath '${q(systemTarget)}' -Value x -ErrorAction Stop; $r.system='ok' } catch { $r.system='denied' }`,
      `try { Remove-Item -LiteralPath '${q(join(workspace.root, 'package.json'))}' -ErrorAction Stop; $r.deleteOutside='ok' } catch { $r.deleteOutside='denied' }`,
      '$r.temp=$env:TEMP',
      '$r.cwd=(Get-Location).Path',
      '$r.secretPresent=($null -ne $env:DSH_AUDIT_SECRET)',
      '$r.proxyPresent=($null -ne $env:HTTP_PROXY)',
      `[Console]::Out.Write('${AUDIT_MARKER}' + ($r|ConvertTo-Json -Compress))`,
    ].join('\n')

    try {
      const shell = resolvePowerShell(process.env, workspace.store.stagedDir)
      const outcome = await executor.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script],
        cwd: workspace.store.stagedDir,
        timeoutMs: 120000,
        env: { DSH_AUDIT_SECRET: 'audit-canary-value', HTTP_PROXY: 'http://canary.invalid:8080' },
      })
      const parsed = parseMarkedJson(outcome.stdout)

      if (parsed === undefined) {
        // **关键**：没有可解析输出 ≠ 边界生效。绝不把空结果解释成"拒绝"。
        const detail =
          '沙箱内脚本未产出可解析输出，因此无法得出边界结论（空输出不是"拒绝"）。' +
          `退出码=${outcome.exitCode} stderr前300字符=${JSON.stringify(outcome.stderr.slice(0, 300))}`
        for (const [id, label] of WRITE_PROBE_IDS) {
          findings.push({ area: 'write', id, status: 'fail', evidence: '[实测] 未产出输出', detail: `${label}: ${detail}` })
        }
      } else {
        findings.push(writeFinding('write-inside-staging', parsed.inside === 'ok', `实测值=${parsed.inside}（预期允许，唯一可写根）`))
        findings.push(writeFinding('write-outside-staging', parsed.outside === 'denied', `实测值=${parsed.outside}（预期拒绝）`))
        findings.push(writeFinding('write-system-dir', parsed.system === 'denied', `实测值=${parsed.system}（预期拒绝）`))
        findings.push(writeFinding('delete-outside-staging', parsed.deleteOutside === 'denied', `实测值=${parsed.deleteOutside}（预期拒绝）`))
        findings.push(
          writeFinding('temp-rewritten', typeof parsed.temp === 'string' && parsed.temp.length > 0, `TEMP=${parsed.temp}`),
        )
        findings.push(writeFinding('secret-env-blocked', parsed.secretPresent === false, `DSH_AUDIT_SECRET present=${parsed.secretPresent}`))
        findings.push(writeFinding('proxy-env-blocked', parsed.proxyPresent === false, `HTTP_PROXY present=${parsed.proxyPresent}`))
      }
    } catch (error) {
      for (const [id, label] of WRITE_PROBE_IDS) {
        findings.push({ area: 'write', id, status: 'fail', evidence: '[实测] 抛错', detail: `${label}: ${error.message}` })
      }
    }
  } else {
    for (const [id, label] of WRITE_PROBE_IDS) {
      findings.push({
        area: 'write',
        id,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail: `${label}: ${blocked.reason}`,
      })
    }
  }

  // ---------- D. 读取面探针 ----------
  //
  // 与旧实现的差别（三条，都是为"能区分『不存在』与『被拒绝』"服务）：
  //   1. **不再按序号回传布尔值**，改为回传 `{id, verdict, len, head4, errCode}`。
  //      旧实现只能用 `true/false` 表达结果，于是"不存在"（异常）与"被拒绝"（异常）
  //      在证据里长得一模一样；本机 `.ssh\*` 四条全是这一类。
  //   2. **分块执行**（每块 8 条）：单条异常只影响自己所在块的判定，
  //      且不会因为脚本里一处拼写错误就让全部探针"无输出"→ 被误读成全体拒绝。
  //   3. **探针表经临时文件传递**：脚本正文不含任何路径（纯 ASCII、长度固定），
  //      因此不依赖控制台代码页，也不会撞上命令行长度上限
  //      （`[实测]` 把 42 条内嵌成 base64 时 `-EncodedCommand` 长 21356 字符并**静默失败**）。
  if (sandboxUsable) {
    const spec = validateReadProbes(READ_PROBES, undefined, READ_PROBE_MISSING_MASK_CLASSES)
    for (const error of spec.errors) {
      findings.push({ area: 'read', id: 'read-probes-spec', status: 'fail', evidence: '[静态] 探针表契约', detail: error })
    }
    const observed = new Map()
    const chunks = []
    for (let i = 0; i < READ_PROBES.length; i += READ_PROBE_CHUNK) chunks.push(READ_PROBES.slice(i, i + READ_PROBE_CHUNK))
    for (const [chunkIndex, chunk] of chunks.entries()) {
      // 探针表落在**暂存根内**（唯一可写根），用完即删；里面只有路径，没有内容。
      const payloadPath = join(workspace.store.stagedDir, `.audit-read-probes-${chunkIndex}.json`)
      const readScript = buildReadProbeScript(payloadPath)
      let outcome
      try {
        writeFileSync(payloadPath, readProbePayload(chunk), 'utf8')
        outcome = await executor.run({
          command: resolvePowerShell(process.env, workspace.store.stagedDir).name,
          args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-EncodedCommand', encodePowerShellCommand(readScript)],
          cwd: workspace.store.stagedDir,
          timeoutMs: 120000,
        })
      } catch (error) {
        for (const probe of chunk) observed.set(probe.id, { missing: `沙箱内脚本抛错：${error.message}` })
        continue
      } finally {
        try {
          if (existsSync(payloadPath)) rmSync(payloadPath, { force: true })
        } catch {
          /* 残留不影响结论 */
        }
      }
      const parsed = parseMarkedJson(outcome.stdout)
      if (parsed === undefined) {
        for (const probe of chunk) {
          observed.set(probe.id, {
            missing:
              '沙箱内脚本未产出可解析输出，因此无法判断该路径的可读性；**空输出不是"拒绝读取"**（手册第 4 章）。' +
              `退出码=${outcome.exitCode} stderr前300字符=${JSON.stringify(outcome.stderr.slice(0, 300))}`,
          })
        }
        continue
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      for (const probe of chunk) {
        const row = rows.find((candidate) => candidate && candidate.id === probe.id)
        if (!row) {
          observed.set(probe.id, { missing: `第 ${chunkIndex + 1} 块产出 ${rows.length} 行，未找到 id=${probe.id} 的行（不得默认判为"拒绝"）` })
          continue
        }
        observed.set(probe.id, row)
      }
    }

    for (const probe of READ_PROBES) {
      const row = observed.get(probe.id)
      const base = { path: probe.path, label: probe.label, kind: probe.kind, maskClass: probe.maskClass }
      if (!row || row.missing) {
        findings.push({
          area: 'read',
          id: `read-${probe.id}`,
          status: 'fail',
          evidence: '[实测] 未产出该探针的结果',
          detail: row?.missing ?? '探针未执行',
          data: base,
        })
        continue
      }
      const verdict = row.verdict
      // `data` 里**只有**判定 / 长度 / 前 4 字节哈希 / 错误码 —— 没有任何内容片段。
      const data = {
        ...base,
        // 让面板/消费者能拿到**原始判定字面量**（含 read-metadata-only 这类细分态），
        // 而不是只能从 status（pass/fail）反推。
        readVerdict: verdict,
        verdict,
        len: typeof row.len === 'number' && row.len >= 0 ? row.len : undefined,
        head4: typeof row.head4 === 'string' && row.head4.length > 0 ? row.head4 : undefined,
        errCode: typeof row.errCode === 'string' && row.errCode.length > 0 ? row.errCode : undefined,
      }
      const sizeNote = typeof data.len === 'number' ? `长度=${data.len} 字节` : '长度=—'
      const headNote = data.head4 ? `前4字节sha256=${data.head4}` : '前4字节sha256=—'
      if (verdict === 'readable') {
        findings.push({
          area: 'read',
          id: `read-${probe.id}`,
          status: probe.maskClass ? 'residual' : 'informational',
          evidence: '[实测] 从沙箱内部发起',
          detail:
            (probe.kind === 'directory' ? '可枚举' : '可读') +
            `（${sizeNote}，${headNote}）` +
            (probe.maskClass
              ? ` —— 属**残余边界**：本后端的 WRITE_RESTRICTED 与 Low 完整性标签都不限制读取。` +
                `DSH 侧只能靠遮蔽清单（mask class "${probe.maskClass}"）收敛，而**遮蔽清单不是硬边界**。`
              : '（对照项，符合预期）'),
          data,
        })
        continue
      }
      if (verdict === 'denied') {
        findings.push({
          area: 'read',
          id: `read-${probe.id}`,
          status: 'pass',
          evidence: '[实测] 从沙箱内部发起',
          detail: `拒绝读取（${probe.kind === 'directory' ? '枚举被拒' : '读取被拒'}；errCode=${data.errCode ?? '—'}）` +
            (probe.maskClass ? `；该路径同时命中 mask class "${probe.maskClass}"` : '') +
            '。⚠ 归因声明：`[实测]` 本沙箱的 `File::Exists` 在 ACL 拒绝时返回 $false，' +
            '因此这一条只能证明"读不到"，**不能**证明"是本工具的遮蔽挡住了"（脚本里的分类探测只排除' +
            '"不存在"与"元数据可读"两种情形）。',
          data,
        })
        continue
      }
      if (verdict === 'not-present') {
        // ⚠ 这一支是本次修复的重点：本机 `.ssh\*` 四条**不存在**，
        // 不得记成 denied（"没这个文件"与"被拒绝"是两回事）。
        findings.push({
          area: 'read',
          id: `read-${probe.id}`,
          status: 'not-run',
          evidence: '[实测] 不存在（非拒绝）',
          detail:
            '本机上该对象**不存在**，因此没有"是否被拒绝"可测；这是 not-present，不是 denied。' +
            (probe.maskClass ? `（遮蔽类 "${probe.maskClass}" 只能靠本测试与 tests\\paths-masks.mjs 的正则取证。）` : ''),
          data,
        })
        continue
      }
      if (verdict === 'read-metadata-only') {
        // **fail**，且必须 fail：这一态的字面含义是"这个敏感对象的内容其实读得出来吗？读不出来"
        // —— 读不出来是**好消息**，但**不是我们做的**（`[实测]`：`File::Exists` 在 ACL 拒绝时
        // 返回 $false，所以"读不到"这件事无法归因给本工具，见 detail）。
        findings.push({
          area: 'read',
          id: `read-${probe.id}`,
          status: 'fail',
          evidence: '[实测] 存在，但内容读不出来（来源未归因）',
          detail:
            `对象存在且元数据可列（父目录可枚举、名字可列出），但**内容读取失败**：errCode=${data.errCode ?? '—'}。` +
            '按纪律如实记 fail 而不是 pass：**读不到 ≠ 我们挡住了** —— 本沙箱的判定基准（`File::Exists`）' +
            '在 ACL 拒绝时返回 $false，因此"拒绝"可能来自 OS ACL、也可能来自别处，本探针**无法归因**。' +
            (probe.maskClass ? `该路径同时命中遮蔽类 "${probe.maskClass}"（工具层另有掩码）。` : ''),
          data,
        })
        continue
      }
      findings.push({
        area: 'read',
        id: `read-${probe.id}`,
        status: 'fail',
        evidence: '[实测] 结果无法归类',
        detail: `脚本回报 verdict=${JSON.stringify(verdict)}（errCode=${data.errCode ?? '—'}），不属于 readable/denied/not-present 三态；不得默认判为"拒绝"。`,
        data,
      })
    }
  } else {
    for (const probe of READ_PROBES) {
      findings.push({
        area: 'read',
        id: `read-${probe.id}`,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail:
          blocked.kind === 'defect'
            ? blocked.reason
            : '嵌套沙箱不可用；该项目的读面收敛只能由 DSH 工具层硬拒绝清单保证，本轮未取得沙箱内实测证据',
        data: { path: probe.path, label: probe.label, kind: probe.kind, maskClass: probe.maskClass },
      })
    }
  }

  // ---------- E. 进程树与资源回收 ----------
  if (sandboxUsable) {
    const lcMarker = `LIFECYCLE-OK-${Date.now().toString(36)}`
    try {
      const before = executor.launcher.activeProcesses(executor.job)
      const child = await executor.run({
        command: resolvePowerShell(process.env, workspace.store.stagedDir).name,
        args: [
          '-NoLogo',
          '-NonInteractive',
          '-NoProfile',
          '-Command',
          `${PS_PRELUDE}\nStart-Sleep -Milliseconds 300\n[Console]::Out.Write('${lcMarker}')`,
        ],
        cwd: workspace.store.stagedDir,
        timeoutMs: 30000,
      })
      const after = executor.launcher.activeProcesses(executor.job)
      // 只有"脚本真的跑出来"才算证据。退出码 127 / 无标记说明 shell 没起来，
      // 此时 Job 统计全为 0 也不能当作"回收正常"。
      const ran = child.stdout.includes(lcMarker)
      findings.push({
        area: 'lifecycle',
        id: 'job-accounting',
        status: ran ? 'pass' : 'fail',
        evidence: ran ? '[实测]' : '[实测] shell 未产出输出',
        detail: ran
          ? `Job 统计：before active=${before.activeProcesses} total=${before.totalProcesses}；` +
            `after active=${after.activeProcesses} total=${after.totalProcesses}；` +
            `本次总进程数增量=${after.totalProcesses - before.totalProcesses}`
          : `无法作为证据：沙箱内脚本未产出标记（退出码 ${child.exitCode}）。` +
            `Job 统计 before/after 均为 active=${after.activeProcesses} total=${after.totalProcesses}，说明期间没有任何被纳管进程。`,
      })
      findings.push({
        area: 'lifecycle',
        id: 'grandchild-contained',
        status: ran ? 'pass' : 'fail',
        evidence: ran ? '[实测]' : '[实测] shell 未产出输出',
        detail: ran
          ? `子进程退出码 ${child.exitCode}，Job 会计已确认进程被纳管；Job 关闭即整树回收（KILL_ON_JOB_CLOSE）`
          : `无法得出收敛结论：沙箱子进程退出码 ${child.exitCode}` +
            '（127 = DLL 初始化失败/组件缺失，属"命令根本没起来"），' +
            '而 Job 会计显示期间无纳管进程，因此"孙进程随 Job 回收"没有被实际验证。',
      })
    } catch (error) {
      findings.push({ area: 'lifecycle', id: 'job-accounting', status: 'fail', evidence: '[实测] 抛错', detail: error.message })
      findings.push({ area: 'lifecycle', id: 'grandchild-contained', status: 'fail', evidence: '[实测] 抛错', detail: error.message })
    }
  } else {
    for (const id of ['job-accounting', 'grandchild-contained']) {
      findings.push({
        area: 'lifecycle',
        id,
        status: blocked.status,
        evidence: blocked.kind === 'defect' ? '[实测] 无法执行' : '[未实测]',
        detail: blocked.reason,
      })
    }
  }

  // ---------- F. 收尾 ----------
  try {
    executor.dispose()
  } catch {
    /* 清理失败不影响结论 */
  }
  for (const target of [insideTarget, outsideTarget, systemTarget]) {
    try {
      if (existsSync(target)) rmSync(target, { force: true, recursive: true })
    } catch {
      /* 残留不影响结论 */
    }
  }

  const summary = summarize(findings)
  const executed = findings.filter((f) => f.status !== 'not-run').length
  const coverage = findings.length === 0 ? 0 : Math.round((executed / findings.length) * 100)
  const report = {
    time: new Date().toISOString(),
    workspaceRoot: workspace.root,
    sandboxUsable,
    coverage,
    // 版本出口必须有覆盖度：0% 覆盖的"无 fail"不构成任何保证（手册第 17 章）
    verdict:
      summary.fail > 0
        ? 'fail'
        : coverage === 100
          ? 'pass-with-residuals'
          : coverage === 0
            ? 'inconclusive-no-evidence'
            : 'partial-evidence',
    capabilities: {
      aclVersion: caps.aclVersion,
      win32Version: caps.win32Version,
      aclFrom: caps.aclFrom,
      win32From: caps.win32From,
    },
    init: initReport || null,
    summary,
    findings,
    passed: summary.fail === 0,
    coverageComplete: summary.fail === 0 && coverage === 100,
    residualCount: summary.residual,
    notRunCount: summary['not-run'],
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printReport(report)
  return report
}

function writeFinding(id, condition, detail) {
  return {
    area: 'write',
    id,
    status: condition ? 'pass' : 'fail',
    evidence: '[实测] 从沙箱内部发起',
    detail,
  }
}

function summarize(findings) {
  const counts = { pass: 0, fail: 0, residual: 0, informational: 0, 'not-run': 0 }
  for (const finding of findings) counts[finding.status] = (counts[finding.status] || 0) + 1
  return counts
}

function printReport(report) {
  const order = ['capability', 'write', 'read', 'lifecycle']
  const labels = { capability: '能力', write: '写入面', read: '读取面', lifecycle: '生命周期' }
  // 读取面新增了**带原因**的失败态：它们都算 fail（汇总里已在 fail 计数内），
  // 但面板上必须一眼能区分"被拒绝"与"存在但读不到"（否则又会回到"一律 denied"的老问题）。
  const readReasonMarks = { 'read-metadata-only': '⊘' }
  for (const area of order) {
    const items = report.findings.filter((f) => f.area === area)
    if (!items.length) continue
    process.stdout.write(`\n── ${labels[area] ?? area} ──\n`)
    for (const item of items) {
      const mark = { pass: '✓', fail: '✗', residual: '⚠', informational: 'ℹ', 'not-run': '–' }[item.status] ?? '?'
      const suffix = readReasonMarks[item.data?.readVerdict] ?? ''
      process.stdout.write(`${mark}${suffix} ${item.id}  ${item.evidence}\n`)
      process.stdout.write(`    ${item.detail}\n`)
    }
  }
  process.stdout.write(`\n汇总: ${JSON.stringify(report.summary)}\n`)
  process.stdout.write(`覆盖度: ${report.coverage}%  判定: ${report.verdict}\n`)
  if (report.verdict === 'inconclusive-no-evidence') {
    process.stdout.write(
      '结论: **不构成任何保证**。本轮没有任何项目在沙箱内实测成功，\n' +
        '      按手册第 17 章要求，这既不是通过也不是失败，而是"未取得证据"。\n',
    )
  } else if (report.verdict === 'partial-evidence') {
    process.stdout.write(
      `结论: 部分证据（${report.coverage}% 实测覆盖），${report.notRunCount} 项未实测。\n` +
        '      ⚠ 标记项为**残余边界**，必须写进文档且不得声明为硬边界（手册 #16.10）。\n',
    )
  } else if (report.verdict === 'pass-with-residuals') {
    process.stdout.write(
      '结论: 全项实测且无 fail。⚠ 标记项为**残余边界**，必须写进文档且不得声明为硬边界（手册 #16.10）。\n',
    )
  } else {
    process.stdout.write('结论: 存在 fail 项，按手册第 17 章要求不得作为版本出口。\n')
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 解析带哨兵标记的 JSON 输出。
 *
 * @param {string} stdout 子进程 stdout
 * @param {string} [marker] 哨兵；默认 `AUDIT_MARKER`。
 *   **必须可传**：预检用的是另一个哨兵（`DSH-PREFLIGHT-…`）。
 *   早先版本把哨兵硬编码成 `AUDIT_MARKER`，于是预检的环境探针永远解析不出结果
 *   （审计里表现为 `子进程关键变量=undefined`）—— 一个典型的"默认值与调用点不一致"缺陷。
 * @returns 解析出的对象；**未找到哨兵或解析失败时返回 undefined**。
 *   返回 undefined 的含义是"脚本没跑出结果"，调用方必须据此判 fail，
 *   绝不能把它当成"操作被拒绝"。
 */
function parseMarkedJson(stdout, marker = AUDIT_MARKER) {
  if (typeof stdout !== 'string') return undefined
  const index = stdout.lastIndexOf(marker)
  if (index < 0) return undefined
  const after = stdout.slice(index + marker.length).trim()
  if (after.length === 0) return undefined
  return safeJson(after)
}

function q(value) {
  return String(value).replace(/'/g, "''")
}

export const __internal = {
  parseMarkedJson,
  q,
  AUDIT_MARKER,
  PS_PRELUDE,
  READ_PROBES,
  READ_PROBE_KINDS,
  READ_PROBE_MISSING_MASK_CLASSES,
  READ_PROBE_CHUNK,
  READ_PROBE_ROW_KEYS,
  readProbePayload,
  buildReadProbeScript,
  encodePowerShellCommand,
  validateReadProbes,
  REPO_ROOT,
}
