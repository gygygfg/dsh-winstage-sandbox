# R10-PKGS 缺陷台账（域二：pip / node 安装 · 镜像 · 完整性 · 隔离）

> 每条都带**原始输出**与**归因分层**（审批层 / WinStage 沙箱 / 工具链 / 我的探针），不混为一谈。
> 状态：`[实测]` = 有原始输出；`[推断]` = 只到现象层。

---

## D-P1 【阻断级】沙箱内**无法安装 node 包**：npm 的 `mkdir` 看不见虚拟可写根

- **现象（4 次独立尝试，4 个目标，同一错误）**
  - `run-7`：`npm error code ENOENT / npm error syscall mkdir / npm error path C:\wt\proj3 / npm error errno -4058`
  - `run-9`：`npm error path C:\wt\pkgs10x\np`（同）
  - `run-6`：`spawnSync C:\Program Files\nodejs\node.exe ENOENT`（`cwd` 指向同一虚拟根）
  - `run-9` 备用基：`BASE fallback -> C:\wt\pkgs10x (windows-temp unusable)`（`C:\Windows\Temp` 基 mkdir 探测就失败）
- **影响**：`task-3` 要求的"node 局部安装 ≥2 包"在沙箱内**不成立**；随之 `package-lock`
  `integrity` 反解、`npm ls problems=[]`、node 冒烟、npm tree digest **全部无法取证**。
- **归因**：**WinStage 沙箱**（不是镜像、不是审批层、不是 npm 版本）。同一次 run 里 npm 已成功
  `GET 200 https://registry.npmmirror.com/cowsay`，说明网络与镜像都正常；失败点纯粹是文件系统语义。
- **根因（`[实测]+[推断]`）**：WinStage 把工作区外的写重定向进暂存树，因此 `C:\wt` 这类路径
  **写得到但 `exists` 为假**（`run-5` 与 `run-9` 均记录 `writable: base=false work=false` 却仍写出文件）。
  npm 在写前自己 `mkdir`/`lstat`，对"父链不存在"直接 ENOENT；而唯一真实存在且可写的父目录
  （工作区 `.t\round10\pkgs\ws`）又被 shim 拒绝写（`Access to the path ... is denied.`）。
- **与上一轮的对比**：上一轮平台 `SandboxedFileSystem` 下 npm **能**装（`added 2 packages`）。
  所以这是**本轮沙箱引入的能力回退**。
- **原始证据**：`evidence/sbx-artifacts/run-7/fs__C__wt__work3__B-npm-install-http.log`、
  `…run-9/…runlog5.txt`、`evidence/threads/run-7/staged-list.txt`。
- **【2026-10-09 状态】仍未修**，且有可复用的最小复现 + 机器判据：
  `.t\round10\pkgs\fix-npm\run.cmd winstage <tag>` → `NPM_INSTALL_OK=0`（`platform` 对照 = 1）。
  | 时点 | 实际注入的 DLL | `NPM_INSTALL_OK` |
  |---|---|---|
  | shim 未修（`before-fix`） | `47DF4A5A…` | 0 |
  | R 边界修复后（`midfix-r-boundary-02C7418F`） | `02C7418F…` | 0 |
  | `out-13c` = R + D-R1（`after-fix-13c`、`judge-proof-13c`） | `5E7A010E…` / 251,392 B | **0（两次一致）** |
  - env-harness 已**独立否证** `out-13c` 的目录面钩子（挂 `NtQueryAttributesFile`/`NtQueryFullAttributesFile`
    后 node `existsSync`/`statSync` 与 npm 行为一字未变，见其 `evidence/D44`）⇒ 13c 不是目录面修复载体，
    下一步是 ntdll 入口命中计数定位 libuv 真 API，再做 **13d** 候选。
  - 受控替换窗口**实际未开**，`shim/out` 仍是 `02C7418F…`（本域只读复核）。
  - **判据缺陷（本域，已修）**：早期探针把 `SHIM_DLL_SHA256` 硬编码为 `shim\out\winstage-shim.dll` 的哈希，
    与"实际注入件"无关，曾导致 Lead 误判 `after-fix-13c` 作废；现改为解析当次 run 的
    `staged\shim.log` 的 `child injection armed: self=<path>`，并由 `judge.mjs` 在宿主侧**独立再推导**，
    不一致输出 `SHIM_DLL_MISMATCH=1`，拿不到则 `ATTRIBUTION_OK=0`。详见
    `.t\round10\pkgs\fix-npm\README.md` §3.1/§3.4 与 `evidence\fix-npm\after-fix-13c\ATTRIBUTION-FIX.txt`。

---

## D-P2 【中】`pip install --target` 无法完成：最终 move 阶段撞 `WinError 3`

- **现象**（`run-5`）：pip 已经 `Successfully installed idna-3.20 markupsafe-3.0.4 six-1.17.0`，
  随后在把安装树搬进 `--target` 时抛 `shutil.Error`：
  ```
  shutil.Error: [('…stage-root…\staged\fs\C\wt\t\pip-target-d136u6zp\lib\python\idna\cli.py',
                  'C:\\wt\\tgt\\idna\\cli.py', '[WinError 3] 系统找不到指定的路径。'), …]
  ```
- **派生问题**：`--find-links` 也看不见 overlay 路径 ——
  `WARNING: Location 'C:\wt\dl' is ignored: it is either a non-existing path or lacks a specific scheme.`
  ⇒ "先 download 再离线 install"这条路也被挡住（`run-6`）。
- **影响**：`--target`（清单式安装，最容易做逐文件哈希复核的形态）在沙箱内不可用；
  可用形态只剩 `--user`（见 §隔离），而 `--user` 又被 D-P3 影响。
- **归因**：**WinStage 沙箱**（路径可见性）。同一虚拟根下 pip 自己的 `mkdir`/写文件是成功的，
  失败集中在"对已存在性做判断"的那一步（`shutil.copytree` 的目标父目录、`--find-links` 的存在性检查）。
- **原始证据**：`evidence/sbx-artifacts/run-5/fs__C__wt__work__04-pip-install-verbose.log`、
  `…run-6/…E-pip-install.log`（`Location … is ignored`）。

---

## D-P3 【中】有控制台脚本的 wheel 会让 `pip install` 退出码变 1（文件其实都装好了）

- **现象**（`run-7`，装 `six idna markupsafe`）：
  ```
  FileNotFoundError: [WinError 2] 系统找不到指定的文件。:
    'C:\\Users\\Administrator\\AppData\\Roaming\\Python\\Python312\\Scripts\\idna.exe'
    -> '…\\Scripts\\idna.exe.deleteme'
  ```
  出自 `pip\_vendor\distlib\scripts.py:299  os.rename(outname, dfname)`；pip 最终 `rc=1`。
- **对照**：`run-6` 只装 `six`（**没有**控制台脚本入口）→ `Successfully installed six`，`rc=0`。
- **影响**：**"pip 安装成功"的判据不能只看退出码**。本轮三个包的文件（含三份 `dist-info\RECORD`）
  全部落进暂存树并被宿主侧哈希复核通过，但 pip 自己报失败 ⇒ 自动化脚本若只认 exit code 会误判为"装不上"，
  反之若忽略 exit code 又会漏掉真实错误。
- **归因**：**WinStage 沙箱**（shim 对"刚创建的文件"做 rename 时不可见）＋ distlib 的
  "写脚本后再改名"实现（`_write_script` 的 nor here 分支）。
- **原始证据**：`evidence/sbx-artifacts/run-7/fs__C__wt__work3__D-pip-install-vvv.log`（尾部 traceback）；
  `…run-6/…G-pip-user.log`（成功对照）。

---

## D-P4 【信息】Node ≥20 下 `spawnSync('npm.cmd')` 直接 EINVAL

- **现象**：`RUN npm -v rc=null err=spawnSync npm.cmd EINVAL`（`run-5` 全部 npm 调用）。
- **归因**：**工具链**（Node 对 `.cmd`/`.bat` 的 CVE-2024-27980 加固），**不是**沙箱问题。
- **绕行（已用）**：`node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" …`；
  或在 `.cmd` 包装里调用。报告里所有 npm 结论都来自这个绕行路径。
- **顺带事实**：沙箱内 `node npm-cli.js -v` = **11.19.0**（`C:\Program Files\nodejs\node_modules\npm`），
  宿主 PATH 的 `npm` = **12.2.0**（`%APPDATA%\npm`）⇒ 同一台机器两个 npm。

---

## D-P5 【信息】`C:\wt` 是"写得到但 `exists` 为假"的虚拟根（D-P1/D-P2 的共同根因）

- **现象**：`run-5`/`run-9` 日志里同一时刻既有
  `writable: base=false work=false childTemp=false`
  又有 `fs\C\wt\work\…` 文件成功落进暂存树；
  `node run-all.mjs` 的 `fs.mkdirSync('C:\wt\work')` 返回成功但 `fs.existsSync` 为 false。
- **影响**：一切"先判断存在性再做决定"的工具（npm、distlib、`shutil.copytree`、`pip --find-links`）
  在这个根上都会走错分支。**这不是"写被拒"，而是"可见性不一致"。**
- **建议**：若要让沙箱内能装包，需要让 shim 对虚拟根实现一致的 `stat`/`mkdir` 语义
  （或让沙箱同时提供一个**真实存在**的可写根）。

---

## D-P6 【信息】`pwsh` 工具在"往会话私有 temp 大量写"时随机崩：`0xE0434352` / `0xC0000005` / `COMMAND_FAILED`

- **现象**：
  - `run-3`/`run-8`：`[stderr] 由于 Exception.ToString() 失败，因此无法打印异常字符串。[exit code: 3762504530]`（`0xE0434352`，CLR 异常）
  - `diag-3` 第 2 次调用：`[exit code: 3221225477]`（`0xC0000005`，访问冲突）
  - `run-4`：`Error: COMMAND_FAILED: 命令失败。`
- **规律（`[实测]` 归纳）**：失败的三次都把工作目录/产物放在 `%TEMP%\dsh-stage-temp\<uuid>` 下；
  成功的 run-5/6/7/9 把一切放在固定的短路径 `C:\wt\...` 下。改用 `C:\wt` 后**再没复现**。
- **影响**：取证成本上升；`run-3/4/8` 因此无有效数据（已如实标 `not-run`）。
- **归因**：**工具/环境层**，根因 `[推断]`（未定论）：与 shim 重定向会话私有 temp 时互相干扰有关。
- **绕行（已用）**：产物一律落 `C:\wt\...`，再从暂存树 `staged\fs\C\wt\...` 取回。

---

## D-P7 【信息】宿主侧 auto-review 会拒绝工作区外写（与沙箱拒绝**分开归因**）

- **现象**：本轮在宿主侧执行 `New-Item -ItemType Directory -Force C:\wt\...` 时被
  `Error: Auto review rejected tool "pwsh"` 拦下（**审批层**，非 WinStage）。
- **处置（按 Lead 指令）**：**不改判定口径**、不绕过；如实登记为"审批层拒绝"，并改走
  "让沙箱内自己创建 `C:\wt`" 的路线。报告 §6/§7 里的"写被拒"因此严格区分为：
  - **审批层**：宿主侧写 `C:\wt`（auto-review）；
  - **WinStage 沙箱**：真实工作区写被 shim 拒（`Access to the path ... is denied.`）；
  - **虚拟根可见性**：`C:\wt` 写成功但 `exists=false`（D-P5）。

---

## D-P8 【信息 · 正面】全局/用户级写入被"捕获进暂存"而不是硬拒（这是期望行为）

- **现象**：`%APPDATA%\pip\pip.ini`、`C:\ProgramData\pip\pip.ini`、
  `%APPDATA%\Python\Python312\site-packages\**`、`C:\Users\Administrator\.dsh\pkgs-probe.txt`
  在沙箱内 `write=OK`，真实盘**全部 `exists=false`**，内容全部出现在
  `<stageRoot>\staged\fs\C\...`。
- **判定**：**通过**。这就是"选择性提交"的目标形态：全局安装/全局配置不落真实盘，而是成为候选。
- **配套要求（给下游）**：沙箱内 `pip install` 的"成功"必须由**暂存副本**判定
  （本轮用宿主侧重算 `RECORD`：37 行 / 34 ok / 0 mismatch），不能看退出码（见 D-P3）。

---

## 附：pip 镜像侧**未发现**缺陷

- `PIP_BANNED=NONE`（`run-7` 的 1153 条 URL 全在 `pypi.tuna.tsinghua.edu.cn`）。
- 仅当**故意不配镜像**时才出现 `files.pythonhosted.org`（`run-9` D 段，负控）。
- 清华索引的 JSON/HTML 两种形态都不引用官方域；`.whl.metadata` 返回 404（不提供 PEP 658），
  ⇒ 用该镜像时 pip 必须下整个 wheel 才能读元数据（性能代价，非缺陷）。
- npm 侧同理：`registry.npmmirror.com` 与 `cdn.npmmirror.com` 都在镜像域内（宿主侧四段哈希链已验证）。
