# WinStage R10 · 新线程交接：完成 13d 线 A 修复 + 线 B + 收尾

> 本文件 = 把下面内容整段复制到**新的 DSH 线程**即可继续。写于窗口 #8 采纳后、线 A 根因完全定名之时。
> 仓库：`C:\Users\Administrator\Desktop\dsh-winstage-sandbox`

---

## 0. 角色与硬边界

- **你（Lead）不得在本线程加载沙箱**：禁止 `run.cmd`、`src\cli.mjs exec`、`sbx-thread.cmd`、`autotest.cmd`、任何进入 WinStage 车道的命令。**所有沙箱内执行交给队友线程**。
- 单写者：**`pkgs` 是唯一构建者**（它跑 `build-shim`、apply 补丁、产出候选）。**`exe`** 是验证者 + 换件窗口操作者。**`registry`** 拥有注册表四回合 runner。探针/补丁作者：`fileio`（上下文已耗尽）或新建 `line-a-fix`。`env-harness` = shim 语义侧。
- 建员上限 8；满时复用现有成员（他们自称"额度耗尽"后仍可再干小单元）。
- 沙箱内跑探针一律**免换件**：`set "DSH_SESSION_ID="` + 同层 `WINSTAGE_SHIM_DLL=<候选绝对路径>` + `--tier TS`，并以 `shim.log` 的 `child injection armed: self=… ok=1` 断言注入件。

## 1. 目标与现状

| # | 目标 | 状态 |
|---|---|---|
| ① | 残余边界 R（崩溃 × `LdrLoadDll` 覆盖） | ✅ 已修复并采纳 |
| ② | shim 目录面一致性（13d） | **根因已完全定名；修复待做（本文件主线）** |
| ③ | 注册表 D-R1（写后读丢失） | ✅ 已修复并采纳（窗口 #8 四条件 4/4；采纳态回归 4/4） |
| ④ | GUI（阻塞级/误导文案） | 部分达标（D2/D3/D11 已测修；新载体只读复测通过） |
| ⑤ | 文件工具面 | ✅ 已修 + 已重封 |

**② 线根因（已定名，勿重查）**：沙箱内 `statSync`/`lstatSync` 报 `ENOENT`，因为 **`NtQueryInformationByName` 被挂钩但只做 pass-through、不感知 overlay** ⇒ 内核按**逻辑名**查真实盘 ⇒ `0xC000003A`（`STATUS_OBJECT_PATH_NOT_FOUND`）。
- 缺陷条目：**`D-FILE-6`（高 · 产品缺陷 · 已造成真实故障）**，在 `docs\round10\fileio\defects.md`。
- 三个同族缺陷分层：`D-FILE-4` = **看得见吗**（IAT 对 `GetProcAddress`/延迟导入不可见）／`D-FILE-5` = 看得见但**语义不对**（`NQAF`/`NQFAF`，无已知调用方）／**`D-FILE-6` = 语义不对且已造成真实故障**（`NQIFBN`）。
- 线 A 逐一排除链：`GetFileInformationByHandle` ③（0 次，有活性反证）→ `NtQueryInformationFile` ①（成功但只服务脚本句柄）→ `NtQueryAttributesFile` ③ → `NtQueryFullAttributesFile` ③（四进程全零）→ **`NtQueryInformationByName` ② 定案**。
- 四动作画像：`statSync`/`lstatSync` = `D-FILE-6` 根因；`existsSync` = **线 B**（`GetFileAttributesW` 成功、返回 ARCHIVE，调用方仍见 `false`）；`readFileSync` = 正常（走 `CreateFileW` + overlay）。

**必读材料**：
- 权威规格：`docs\round10\fileio\13d\修复规格-NQIFBN-overlay感知.md`（**与实现冲突时以它为准，并向 Lead 回报差异**）
- 收束件：`docs\round10\fileio\13d\线A-收束.md`（含 §5 更正）
- 第 0 步证据：`docs\round10\shim\evidence\D95-step0-isStaged-rawlines.txt`（`B914F0E3…0627`，2,433 B / 21 行）

## 2. 剩余目标（按序）

- **A（主线）**：实现 `NQIFBN` overlay 感知修复 → 三层验收 → 行为转绿。
- **B**：`exists` 的 **post-call 返回值/`LastError` 通路**（只日志、单独候选）。**A→B 不并车。**
- **C（可选）**：`D-FILE-5` —— 让 `NQAF`/`NQFAF` 也 overlay 感知。
- **D（收尾）**：末次 **commit+push**（证据不入库）→ 按用户"**不保留**"回滚 **Defender 排除项** → **终版汇总报告**。

## 3. A 的实现规格（照抄即可开工）

**位置**：`shim\src\ws_file.c` 末尾 `ws_NtQueryInformationByName`（原 `:1433-1461`）。`extern NTSTATUS NTAPI NtQueryInformationByName(...)` 声明与 `ws_nqifbn_orig` 懒解析（`GetModuleHandleW`+`GetProcAddress`+`InterlockedCompareExchange` CAS）**保留**。

**复用既有语义（不要另写解析）**：
- `static int ws_stat_resolve(LPCWSTR name, wchar_t *mapped, DWORD cch, int *isStaged)`（`ws_file.c:832-865`）：**返回 1 = whiteout/必须报"不存在"**；返回 0 时 `mapped` 是交给真实 API 的路径、`*isStaged` 表示是否为覆盖层副本。
- `ws_should_intercept`（`:107`）、`ws_resolve_file`（`:153`）、`ws_normalize_path`（`ws_util.c:809`，含 `\\?\` 剥离）、`t_wsFileBusy`（`:36`，`_Thread_local`）、`ws_strlcpy_w`（`ws_util.c:357`）。
- 现有用户示范：`ws_GetFileAttributesW`（`:896-924`）——含 `LastError` 保存/恢复写法。

**行为契约**：
1. **先绝对化名字**：入参是 `ObjectAttributes->ObjectName`（`UNICODE_STRING`，**不一定 NUL 结尾**）。若为相对形态，**先用 CWD 拼成绝对**（可用 `GetFullPathNameW`，注意它会改 last error ⇒ 保存/恢复；用法参考 `ws_mask.c:603`），否则按第 0 步实测是 **no-op**。
2. **命中覆盖层** ⇒ 用**本地** `OBJECT_ATTRIBUTES` 副本，`ObjectName` 指向**覆盖层绝对路径**的 `UNICODE_STRING`、`RootDirectory = NULL`、其余字段逐字保留 ⇒ 调真实 API。
3. **whiteout（`ws_stat_resolve` 返回 1）** ⇒ 填 `IoStatusBlock->Status = (NTSTATUS)0xC0000034`（`STATUS_OBJECT_NAME_NOT_FOUND`）、`Information = 0`，**直接返回、不调真实 API**。
4. **未命中 / 路径未变** ⇒ **原样透传**（行为零变化）。
5. **安全**：`t_wsFileBusy > 0` ⇒ 直调真实 API（绝不重入暂存机）；`ws_nqifbn_orig` 未解析 / `ObjectName` 空或超长 / 异常 ⇒ **一律回落真实 API、绝不 fail-closed**；**不就地改写调用方结构**；**包装内零 I/O**；**不碰** `LdrLoadDll` 修复、injection/路径逻辑、其它挂钩目标、`ws_regstore.c`。
6. **日志**：保留 `ATTRDBG-NQIFBN … status/class/seq`，增打 `mapped=`/`staged=`（便于验收区分"修好 / 没走到"）。

**代码骨架（以规格为准）**：
```c
const UNICODE_STRING *us0 = ObjectAttributes ? ObjectAttributes->ObjectName : 0;
if (!t_wsFileBusy && ws_nqifbn_orig && us0 && us0->Buffer && us0->Length > 0 &&
    us0->Length < (ULONG)(WS_PATH_MAX * sizeof(wchar_t))) {
    wchar_t namez[WS_PATH_MAX], abs[WS_PATH_MAX], mapped[WS_PATH_MAX];
    DWORD n = us0->Length / sizeof(wchar_t);
    memcpy(namez, us0->Buffer, us0->Length); namez[n] = 0;
    DWORD save = GetLastError();
    if (GetFullPathNameW(namez, WS_PATH_MAX, abs, NULL) == 0) ws_strlcpy_w(abs, namez, WS_PATH_MAX);
    SetLastError(save);
    int isStaged = 0;
    if (ws_stat_resolve(abs, mapped, WS_PATH_MAX, &isStaged)) {
        NTSTATUS gone = (NTSTATUS)0xC0000034L;
        if (IoStatusBlock) { IoStatusBlock->Status = gone; IoStatusBlock->Information = 0; }
        ws_log("ATTRDBG-NQIFBN pid=%lu path=%ls mapped=<whiteout> staged=0 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), namez, (unsigned long)gone,
               (unsigned long)FileInformationClass, ws_seq());
        return gone;
    }
    if (isStaged && _wcsicmp(mapped, namez) != 0) {
        OBJECT_ATTRIBUTES oa = *ObjectAttributes; UNICODE_STRING un;
        un.Buffer = mapped;
        un.Length = (USHORT)(wcslen(mapped) * sizeof(wchar_t));
        un.MaximumLength = un.Length + (USHORT)sizeof(wchar_t);
        oa.ObjectName = &un; oa.RootDirectory = NULL;
        NTSTATUS st = ws_nqifbn_orig(&oa, IoStatusBlock, FileInformation, Length, FileInformationClass);
        ws_log("ATTRDBG-NQIFBN pid=%lu path=%ls mapped=%ls staged=1 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), namez, mapped, (unsigned long)st,
               (unsigned long)FileInformationClass, ws_seq());
        return st;
    }
}
/* 其余情况：原样走 ws_nqifbn_orig / NtQueryInformationByName（现有代码） */
```

**纪律（硬性）**：
- `pwsh` 备份：`.t\round10\shim\backup-v14-ws_file.c` **已存在**（= 当前树哈希 `60ACEC39…`）；再改前请先确认树未被他人在改。
- **副本编译**：`node tools\build-shim.mjs --out-dir .t\round10\shim\out-13d-count14` ⇒ 期望 **exit 0 / 0 warning / 15 exports**（本仓库 `build-shim.mjs` 在 `tools\`）。
- **双前置**：副本编译零告警 **且** `git apply --check`（或 `git diff` 可逆 + `git checkout -- shim/src/ws_file.c` 回滚）exit 0。
- 交件给 `pkgs`：补丁路径 + **唯一锚点清单（代码调用点，不要注释文本）** + **三文件 apply 前后完整 64 位 hex** + 回滚命令。
- **当前树基线（v13 态；Lead 只做了备份，未改任何源码）**：
  - `ws_file.c = 60ACEC390146DDA60970D1D28D576CF3C6EF14833C81943BD6883353FCBF8D39`（68,078 B）
  - `ws_hook.c = 3E2EBEE63573E9E0886960B6ED1A26EDC8C6A8A0D4E529AFCC76F557309E2224`
  - `winstage_internal.h = 9627EFBAE3DCE981A94A307E92FB219C907E28F785FC584A6B25A9D615DC1005`
  - `ws_reg.c = F5695A951EA08534B495C520C48EE2C7A199060E88E05C2E91848221F9D23223`（**必须不变**）

**验收三层（由 `pkgs`/`exe` 在车道内执行）**：
1. 离线：`dshregprobe2 read` = **`ALL=True`**。
2. **零语义复跑**：`step2a` 与 `step2b` **逐字节一致**、sha `12AA39D1F31AF899…`；**D-R1 四条件不回归**（① `query-value-exit=0` ② `query2-value-exit=0` ③ `step2a` 非空 ④ `replayedBytes>0`）。
3. **行为验收**（同车道、免换件、**必须用合法 `OBJECT_ATTRIBUTES`**）：`statSync`/`lstatSync` 对**已暂存文件转为成功**、`readFileSync` 不变、`existsSync` 现状不变（其异常属**线 B**）；**必须附夹具绑定原始行**（`ATTRDBG-NQIFBN` 命中行 + 对应 `statSync` 返回值），否则无法区分"修好"与"没走到"。
**任一不过 ⇒ 立即回滚（`git checkout -- shim/src/ws_file.c` 或恢复备份）+ 停手上报。**

## 4. 必须遵守的纪律（血泪清单）

1. **双前置**：副本编译零告警 + `git apply --check` exit 0 —— 已连续 4 次拦下坏补丁（含 `winternl.h` 不声明这两个 API 需 `extern`）。
2. **零语义复跑必过**：`step2a`/`step2b` 逐字节 + D-R1 四条件。
3. **0/阴性结论必须附同 run 活性反证**，否则只记 `inconclusive`（不得记 ③）。
4. **不可信字段先证活性**（`D88` 三例）：`maxValueLenWritten` 是硬编 `0ul`；`GetFileAttributesW` 的 `err` 是**陈旧残留**（成功不清 `LastError`）；按 `canonical=` join 句柄集是**作用域错误**。
5. **判据用 `status`/`rc`/`attrs`/`staged`，不用 `LastError` 残留**。
6. **只设 `WINSTAGE_SHIM_DLL` ≠ 注入** —— 裸宿主进程不会被注入；注入来自 executor/车道（executor 层该 env 经 `--dll` 传递）。
7. **证据/输出/临时文件路径纯 ASCII**；**证据必须写 stage 的 passthrough 区**（`<stage>\staged\evidence\`，因为越界写会被 shim 重定向进 overlay）；**载体级 `shim.log` 必须复制进 `docs\**\evidence\`** 并给 sha256/大小/行数（否则事后不可复核）。
8. **按 pid 关联**；句柄**按数值** `>0x100000` 判伪句柄，**不按字符串长度**。
9. **红线**：不替换 `shim/out\winstage-shim.dll`（现 = `63808F51…`，**已采纳件**）；不动 inject/probe 原件；不动冻结候选（`.t\round10\shim\out-13d-count2`…`count13`、`out-16`/`out-18`/`out-18b`/`out-18c`/`out-19`/`out-20`/`out-21`/`out-22`）；不动 `ws_regstore.c`；不动 injection/路径逻辑；不动 `LdrLoadDll` 既有修复；**不开换件窗口**。

## 5. 关键路径与命令

- 构建候选：`node tools\build-shim.mjs --out-dir .t\round10\shim\out-13d-count14`
- 在用件：`shim\out\winstage-shim.dll` = `63808F5188643C085BDC71E86AC843BB8758579938A4CB61781044B93C8A99EB`（257,024 B，`.text 6ec5a5da…`）；回滚点 `.t\round10\shim\backup-20261010-040949-pre-swap-win8.dll`（= 旧 `02C7418F…`）
- 封印面自检：`node tools\baseline-sha256.mjs --check`（应 exit 0 / 115 条；`shim/**` 不在封印面）
- 证据不入库：`.gitignore` 已排除 `docs/round10/*/evidence/`
- 收尾（D）：commit+push → `Remove-MpPreference` 回滚 **Defender 排除项**（本仓根、`%LOCALAPPDATA%\Temp\winstage-stage`、进程 `winstage-inject.exe`；用户明确"**不保留**"）→ 终版汇总报告

## 6. 立刻可做的第一步

把新线程第一条指令设为：

```
按 docs\round10\fileio\13d\修复规格-NQIFBN-overlay感知.md 与 docs\round10\shim\evidence\D95-step0-isStaged-rawlines.txt，
实现 shim\src\ws_file.c 末尾 ws_NtQueryInformationByName 的 overlay 感知修复：
先用 CWD 绝对化 ObjectName；whiteout ⇒ 填 IoStatusBlock.Status=0xC0000034 并直接返回；
staged ⇒ 本地 OBJECT_ATTRIBUTES 副本、ObjectName 指向覆盖层绝对路径、RootDirectory=NULL；
未命中/未变 ⇒ 原样透传；t_wsFileBusy>0 或任何异常 ⇒ 直调真实 API、绝不 fail-closed；
包装内零 I/O；保留并增打 ATTRDBG-NQIFBN 的 mapped=/staged=。
离线出件 + 副本编译（node tools\build-shim.mjs --out-dir .t\round10\shim\out-13d-count14）零告警，
交 pkgs 构建，再由 exe/pkgs 做三层验收：
① 离线 dshregprobe2 read ALL=True
② 零语义复跑 step2a=step2b 逐字节 12AA39D1F31AF899… + D-R1 四条件不回归
③ 行为验收（合法 OBJECT_ATTRIBUTES、免换件）：statSync/lstatSync 对已暂存文件转成功、readFileSync 不变、
   existsSync 现状不变，并附夹具绑定原始行。
任一不过 ⇒ 立即回滚 + 停手上报。
红线：不碰 shim/out（63808F51…）、inject/probe 原件、冻结候选、ws_regstore.c、injection 与路径逻辑、
LdrLoadDll 修复；不在 Lead 线程加载沙箱。
```
