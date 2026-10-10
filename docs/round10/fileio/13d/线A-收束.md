# 线 A 收束说明（13d · 目录面/存在性判定链路）

> 结论一句话：**node 的 `statSync`/`lstatSync` 在沙箱内失败，根因定名到 `NtQueryInformationByName` 只 pass-through、不感知 overlay（`D-FILE-6`，高）**；
> 前两个候选（`NtQueryAttributesFile`、`NtQueryFullAttributesFile`）以**有效否定**排除。判据全程用 `status`/`rc`/`attrs`/`staged`（不用 `LastError` 残留，`D88`）。

## 1. 已排除链路（按次序，均附活性反证）

| 候选 | 判定 | 关键原始证据 | 活性反证 | 证据（入仓） |
|---|---|---|---|---|
| `GetFileInformationByHandle` | **③ 未被调用** | node 进程 0 行 | 同 run 其它 pid `ATTRDBG-GFIBH` 91 行、`hit n=75/6/10` | `docs/round10/fileio/13d/stage-gfibh/` |
| `NtQueryInformationFile` | **① 被调用且成功**，但**只服务脚本句柄** `0x2F0`，夹具句柄未查 | `[5312] class=8/16 status=0x0` | `ATTRDBG-NTQIF` 599 行、`hit 410/71/69/46/3` | `docs/round10/fileio/13d/stage-ntqif/` |
| `NtQueryAttributesFile`（线A#1） | **③ 夹具绑定全 0** | `stat` 3924 / `lstat` 204 / `exists` 952 / `read` 9088 的 `NQAF_fixture` 全 0 | 全局 `ATTRDBG-NQAF` **12,408 行**、`hit n=13/10/10/13` | `stage-nqaf/evidence/shim.log` = `97AC9685A9860BC7AD09083C5E04A5BF2F59F0E23BFB02B8F307302C6D2E711` / 9,265,061 B / **50,749 行**；`pa-actions.jsonl` = `AFA21FCE4CC5A1CE5355E0FB3411A01B5A20443FAC7E25E80F3A43F8E2B382E6` / 778 B / 4 行 |
| `NtQueryFullAttributesFile`（线A#2） | **③ 更强：四进程全零** | `stat` 4768 / `lstat` 10148 / `exists` 7184 / `read` 1868 的 `NQFAF_total` 与 `_fixture` **全 0** | 全局 `ATTRDBG-NQFAF` **3,225 行**、`hit n=2357/314/554`（叠加 `pkgs` 车道内 3,971 行 / 2357+314+144） | `stage-nqfaf/evidence/shim.log` = `9681E4B6AAFC44D1D2752AA594904C65F9C46A4D907EAD389EE2D8235B45C6CF` / 9,945,585 B / **53,963 行**；`pa-actions.jsonl` = `33B951FE314E0D1F0905DE075E3B2E20D13E894805D50407ABEE7A93FAC12281` / 781 B / 4 行 |
| **`NtQueryInformationByName`（线A#3）** | **② 定案：被调用但返回失败** | `stat` 3932 / `lstat` 8384 / `exists` 2528 **各 1 条**夹具绑定：`path=\??\…\ws-stage17\probe\pa-fixture.txt **status=0xC000003A** class=77`；`read` 11064 夹具绑定 0 | 全局 `ATTRDBG-NQIFBN` **95 行**、`hit n=24/24/24/23` | `stage-nqifbn/evidence/shim.log` = `00219500CB44B994C8722212709334ECFA30A815B910E4F61C4484C38093FBBE` / 10,025,461 B / **54,104 行**；`pa-actions.jsonl` = `C8984BCA3A4112DC7BBB73A23BDA0CE2B0FA5007148334E95F8716B2D9B55DF8` / 781 B / 4 行 |

**逐动作归属方法**（关键方法学）：`per-action.mjs` **一进程只做一个动作** ⇒ 每进程 `seq=` 流只属于该动作；结果写入 **stage 的 passthrough 区**（写到 run 的 workspace 之外会被 shim 改写到 overlay ⇒ 曾两次"文件不落盘"，已记档）。

## 2. 四个动作的最终画像（夹具 = 已暂存文件）

| 动作 | 已挂钩调用（夹具绑定） | 结果 | 定名 |
|---|---|---|---|
| `existsSync` | 1×`GetFileAttributesW`（**成功**、`attrs=0x20`）、1×`NQIFBN`（失败 `0xC000003A`） | `false` | **线 B**：post-call 返回值被丢弃/改写（调用本身成功） |
| `statSync` | 1×`NQIFBN`（失败 `0xC000003A`） | `ENOENT` | **`D-FILE-6` 根因** |
| `lstatSync` | 1×`NQIFBN`（失败 `0xC000003A`） | `ENOENT` | **`D-FILE-6` 根因** |
| `readFileSync` | 1×`CreateFileW(0x120089)`（overlay 命中、`valid=1`） | **成功** | 读路径正常 |

## 3. 剩余候选（未挂钩/未修）

1. **`NtQueryInformationByName` overlay 感知修复**（`D-FILE-6`，**下一个修复候选**，规格见 `修复规格-NQIFBN-overlay感知.md`）；
2. `NtQueryAttributesFile` / `NtQueryFullAttributesFile` 的 **overlay 感知**（`D-FILE-5`；目前无已知调用方 ⇒ 优先级低，但它们**对已暂存文件会误报"不存在"**）；
3. **尚未挂钩的按名/路径查询家族**：`NtOpenFile` 之外的 `NtCreateFile`、`NtQueryInformationByName` 的兄弟 `NtSetInformationByName`、以及 `GetFileInformationByHandleEx` 的其它 class（`FileAttributeTagInfo` 等）——**每个都要先做同车道活性正对照**（`D-FILE-4`），否则 0 行只能记 `inconclusive`；
4. **动态解析类调用**（`GetProcAddress`/延迟导入）**IAT 钩子天然不可见**（`D-FILE-4`）⇒ 若要覆盖，需 **非 IAT 手段**（`GetProcAddress`/`LdrGetProcedureAddress` 钩子或内核侧），属**另一立项**。

## 4. 缺陷索引

| 编号 | 一句话 | 层级 |
|---|---|---|
| `D-FILE-4` | IAT 对**动态解析**不可见（覆盖边界） | **看得见吗** |
| `D-FILE-5` | `NQAF`/`NQFAF` 看得见但**语义不对**（对已暂存文件误报不存在） | 语义 |
| **`D-FILE-6`** | `NQIFBN` 语义不对**且已造成真实故障**（`statSync`/`lstatSync` 失败） | **语义 + 真实故障（高）** |

> 三条**不是回归**、**不是 fail-open**；与 `D-R8`（拦截失败时是否裸跑，窗口 #8 仍未被演示）**不同层**。

---

## 5. 更正/补注（第 0 步诊断后，`pkgs`；证据 `D95-step0-isStaged-rawlines.txt` = `B914F0E30F718BD240AE98538A2358D58788012BD5FE432078F6F250A62C0627`）

1. **活性正对照那次"仅 1 行且 `status=0xC000000D`"属探针调用形态非法**（裸路径串调用该 API ⇒ `STATUS_INVALID_PARAMETER`，连 `kernel32.dll` 目标亦同），**不是钩子问题** ⇒ 该项**不计入任何否定**。
2. **主探针那条不受影响、`②` 定案仍成立**：`path=\??\C:\…\ws-stage17\probe\pa-fixture.txt status=0xC000003A class=77` 是**合法绝对 NT 路径**（`OBJECT_ATTRIBUTES` 形态），且活性反证 95 行 / `hit 24/24/24/23` 来自探针自身的合法调用链。
3. **但下一步的活性/行为验收必须改用合法 `OBJECT_ATTRIBUTES`**（绝对 `ObjectName` + `OBJ_CASE_INSENSITIVE`），否则**无法区分"修好了"与"根本没走到"**。
4. **另据第 0 步实测**：`ws_stat_resolve` **只覆盖"绝对 + 被重定向"形态**（相对名 ⇒ `isStaged=0`、`mapped == in`，no-op；`staged` 字段活性对照 93 vs 7,140 证明其为活字段）⇒ 修复**必须先把名规范化成绝对**；且**相对名"看起来成功"（`attrs=0x20`）是 CWD 已在 `<stage>\staged` 所致，不是 overlay 生效**。详见 `修复规格-NQIFBN-overlay感知.md` §6/§7。
