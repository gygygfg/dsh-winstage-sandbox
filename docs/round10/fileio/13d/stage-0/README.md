# Stage 0 证据位（**预登记：判据先于数据**）

> 状态：**`pending`** —— 等 ① `pkgs` 套用 `counts-v2b.patch` 并构建 `.t\round10\shim\out-13d-count2`，② Lead 放行信号。
> Lead 裁定（2026-10-10）：**Stage 0 排在枚举问题（`out-19` + registry 三问）之后**；本案只做 Stage 0，不预生成 Stage 1–4 片段。
> 红线：**不触碰 `shim/src`**（归 `pkgs`）、**绝不触碰 `shim/out`**（`02C7418F…`）与已冻结候选。

## 0. 本 Stage 要回答的问题

**"七个已挂钩入口里，哪些真的被 `node existsSync/statSync` 与 `cmd if exist` 这条路径调用过？"**
这是唯一能在 **零新增挂钩目标** 的前提下安全回答的问题（v1 的新挂钩让 CLR 宿主崩溃 ⇒ `D-FILE-2`）。

被计数的入口（v2b 本体）：`CreateFileW`、`GetFileAttributesW`、`GetFileAttributesA`、`GetFileAttributesExW`、`GetFileAttributesExA`、`NtOpenFile`、`NtSetInformationFile`。

**不做**：不新增任何挂钩目标；不解释未挂钩入口（那是"未挂钩"，**不是**"未被调用"）。

## 1. 判据（**先登记，后取数**；不通过即停）

- **㈠ 门槛（载体存活）**：当次运行 `tierEffective == "TS"` **且** `fallbackReason` **不含** `carrier-init-failed`。
  **不通过 ⇒ 本 Stage 判 `not-run`，不产出命中表**，回滚仅限"不套用/撤下该构建"，并附 `fallbackReason` 原文上报 Lead。
- **㈡ 命中**：`<stage>\staged\shim.log` 中该入口的 `R11-D-13d hit <Name> n=<count>` 行。
  **未出现的名字记"未命中"** —— 该结论**仅在㈠通过时成立**（v1 的 0 行就是㈠不通过导致的无意义 0，不得复用为结论）。
- **正对照**：同一 run 内 `.NET [IO.File]::Exists` 对**暂存文件**为 `true`（证明 overlay 真在）。
- **注入件身份**：`shim.log` 出现 `child injection armed: self=…out-13d-count2\winstage-shim.dll ok=1`
  （**用 `self=` 断言，不用 `shim/out` 哈希** —— 免换件路径下 `shim/out` 仍是 `02C7418F…`）。

## 2. 照跑命令（免换件；`--shim-dll` 必须在 executor `init()` 之前生效）

```powershell
set "DSH_SESSION_ID="
set "WINSTAGE_STAGE_ROOT=<repo>\.t\round10\fileio\13d-stage0"
node <repo>\.t\round10\fileio\13d-count-probe\env-override-harness.mjs `
  --stage-root <repo>\.t\round10\fileio\13d-stage0 --ws <repo>\.t\round10\fileio\ws-stage0 `
  --shim-dll <repo>\.t\round10\shim\out-13d-count2\winstage-shim.dll `
  -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\.t\round10\fileio\13d-count-probe\all-probes.ps1 `
     -Ws <repo>\.t\round10\fileio\ws-stage0 -P <repo>\.t\round10\fileio\13d-count-probe -Ev <stage>\staged\evidence
```
（`all-probes.ps1` 在**同一次 run 内**跑四件：pwsh 造暂存文件 → `.NET Exists` 正对照 → `node exists/stat/read/readdir` → `cmd /c if exist/dir/type`；输出写文件，避开受限管道。）

## 3. 目录内应有（取数后填）

| 文件 | 内容 |
|---|---|
| `harness-json.txt` | harness 的 JSON：`tiers.launchMode`/`tier`、`resolvedDllPath`、exit、stdout |
| `lane.txt` | 当次 `tierEffective` / `launchMode` / `fallbackReason`（判据㈠的原始件） |
| `shim.log` | 全量；含 `child injection armed: self=…` 与 `R11-D-13d hit …` |
| `summary.json` / `node-probe.json` / `cmd-probe.txt` | 四件读数原始输出 |
| `dll-hashes.txt` | 候选与在用件的整件 + `.text` sha256（`pe-text-hash.mjs`） |
| `命中表.md` | 本 Stage 的命中/未命中表（含每个名字的 `n=`；0 与"未出现"分别标注） |

## 4. 判读约定（防串味）

1. **七个已挂钩入口**是本案主体；`n=0` 与"该行完全未出现"在**本 Stage 等价**（计数只在该入口被调用时自增）。
2. `pkgs` 已在其**新增的三个 reg 目标**（`NtQueryValueKey`/`NtEnumerateValueKey`/`NtQueryKey`）包装体首行加了同样的 `ws_callhit_named(...)`
   ⇒ 若它们出现在 `shim.log`，**属预期**，要与**文件面**结论分开陈述（注册表面另有 `registry` 域的结论）。
3. 任何"某入口未被调用"的表述都**必须**同时附：㈠通过的原件、当次 DLL 整件+`.text`、`self=` 行。
4. 若 `out-13d-count2` 的实测哈希与 `pkgs` 广播值不一致 ⇒ **先停**，按"过期/漂移补丁"纪律（defects 置顶第 4 条）重新核对，不得带疑取数。
