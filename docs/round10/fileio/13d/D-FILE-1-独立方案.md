# `D-FILE-1` 独立方案：`g_targets[]` / `g_targetNames[]` 两表同步（**只写方案，不执行**）

> Lead 裁定（2026-10-10）：另立独立方案，**先不执行**；执行统一由唯一构建者 `pkgs` 在**窗口 #7 收尾后**做。
> 依存关系：**Stage 5 的计数依赖本修复**（未挂钩 ⇒ 永远计不到，且那个 0 是"未挂钩"而非"未调用"）。

## 0. 事实更正（我此前归因错误，自纠）

| 项 | 更正前（我 2026-10-10 早前的说法） | **更正后（实测）** |
|---|---|---|
| `FindFirstFileW` 在 `g_targetNames[]` 里？ | 我说"在" | **不在**。两表**都没有**它。|
| 那个字符串从哪来？ | 我以为是名字表条目 | 是 **`ws_file.c:635`、`ws_file.c:1023`、`ws_t3reg.c:362` 对 `FindFirstFileW` 的直接调用（import）**，外加一处注释。**我把"PE 里有这个字符串"错当成"名字表里有"——典型的字符串扫描混淆**。|
| 对既有结论的影响 | — | "`SKIP=FindFirstFileW` 不影响 `readdir`"**依然成立且解释更强**：该入口**根本没被挂钩**，SKIP 自然无对象可跳。|
| 不变的结论 | — | **`FindFirstFileW` 今天未被挂钩**（它只被 shim **自己调用**，用于内部枚举），这一条**仍然成立**，Stage 5 的依赖关系也仍然成立。|

## 1. 真正的缺陷（本次新建，取代原表述）

`shim/src/ws_hook.c` 维护两张**平行表**：

- `g_targets[]`：`{name, replacement, originalSlot}` —— **决定谁真的被挂钩**（`ws_patch_module` 按 `t->name` 匹配）；
- `g_targetNames[]`：只有名字 —— 由访问器 `ws_hook_target_names(size_t *count)`（`ws_hook.c:655-661`）对外交出 `(names, count)`。

**实测错位**（`check-target-tables.mjs`，当前树）：

```
g_targets     : 56
g_targetNames : 57
aligned       : false
only in names : ["LdrGetProcedureAddress"]
first misalignment: index 52: target=NtQueryValueKey   name=LdrLoadDll
                    index 53: target=NtEnumerateValueKey name=NtQueryValueKey
                    index 54: target=NtQueryKey        name=NtEnumerateValueKey
                    index 55: target=LdrLoadDll        name=NtQueryKey
```

成因：out-18 期间把新目标**追加到 `g_targets` 的 `LdrLoadDll` 之后**，而名字**插到 `g_targetNames` 的 `LdrLoadDll` 之前** ⇒ 从 index 52 起整体错位一格，且长度差 1。
（`v2-baseline` 快照：54 vs 55，同样错位 ⇒ **不是谁新引入的，是既有的表结构脆弱**。）

## 2. 严重性（如实定级：**潜在**，非行为缺陷）

- `g_targets` 决定挂钩，**按名字匹配** ⇒ 挂钩行为**不受错位影响**；
- `ws_hook_target_names()` 目前**没有任何调用者**（全仓 grep 只有声明与定义）⇒ 错位目前**不产生可观察影响**；
- 但它是一个**现成的"哪些 API 被挂钩"的假 oracle**：`count` 多报 1（57 vs 56），且 index→name 从 52 起全错。
  **任何未来的诊断/计数（包括我的 Stage 5）若用它当依据都会被误导** —— 这正是我们这轮一直在抓的那类陷阱，所以值得修。

## 3. 修复方案（两选一，推荐 B）

### A. 最小改动（低风险）
1. 把 `g_targetNames[]` **重排**为与 `g_targets[]` **逐条同序**（以 `g_targets` 为准），补上缺失项、删掉多余项；
2. 加编译期断言（C11，零运行时成本）：
   ```c
   _Static_assert(sizeof(g_targetNames) / sizeof(g_targetNames[0]) == WS_TARGET_COUNT,
                  "g_targetNames[] must have exactly one name per g_targets[] entry");
   ```
3. 把 `.t/round10/fileio/13d-count-probe/check-target-tables.mjs` 纳入**构建/评审门禁**（退 1 即不动）。

### B. 单一来源（推荐：结构上不可能漂移）
用 X-macro 从**一张列表**同时生成两张表：
```c
#define WS_TARGET_LIST(X)      \
    X(CreateFileW) X(CreateFileA) ... X(LdrLoadDll)
static const WsHookTarget g_targets[] = {
#define X(n) WS_TARGET(n),
    WS_TARGET_LIST(X)
#undef X
};
static const char *const g_targetNames[] = {
#define X(n) #n,
    WS_TARGET_LIST(X)
#undef X
};
_Static_assert(sizeof(g_targetNames)/sizeof(g_targetNames[0]) == WS_TARGET_COUNT, "table drift");
```
⇒ 两表由同一次展开产生，**同长同序**由构造保证；`check-target-tables.mjs` 退化为回归判据。

## 4. 判据

**静态（必过，任何窗口都可离线做）**
1. `node .t/round10/fileio/13d-count-probe/check-target-tables.mjs shim/src/ws_hook.c` → **exit 0**，且 `targets == names`、`onlyInNames == []`、`firstMisalignment == []`；
2. `_Static_assert` 参与编译（`zig cc … -std=c11`）**exit 0 / 零告警**；
3. `ws_hook_target_names()` 的 `*count` 与 `WS_TARGET_COUNT` 一致（该断言已覆盖）。

**动态（只在 Stage 5 真的要挂钩 `FindFirstFileW` 时才做；判据同 `V2-HANDOFF.md §7.1`）**
- ㈠ **门槛**：`tierEffective == "TS"`、`fallbackReason` 无 `carrier-init-failed`（否则该入口判"CLR 宿主下不安全"，回滚）；
- ㈡ **双向验证"它现在确实被挂钩"**：同一夹具各跑一次
  - 基线（不设 SKIP）：`shim.log` 出现 `R11-D-13d hit FindFirstFileW n>0`；
  - `--env WINSTAGE_SHIM_SKIP=FindFirstFileW`：该行**消失/为 0**（站点未被挂钩）；
  ⇒ 一正一反才算"挂钩成立且计数可信"。仅一侧有数据 ⇒ `not-run`。

> 注意：**不要**把"表同步修复"和"给 `FindFirstFileW` 加挂钩"混为一件事。前者是修既有错位（本方案）；
> 后者是新增计数目标（Stage 5），要遵守 `D-FILE-2` 的安全写法（绝不 fail-closed、per-site trampoline、包装内零 I/O）。

## 5. 回滚点（三件套）

| 项 | 内容 |
|---|---|
| 源码 | 单独补丁 `d-file-1-target-tables.patch`（与计数补丁**分开**）；回滚 `git apply -R` |
| 产物 | 构建只写隔离目录（`.t/round10/shim/out-<...>`）；**永不触碰 `shim/out`** |
| 证据 | 修复前后：两表数量/错位清单（`check-target-tables.mjs --json`）、构建 `exit/告警数`、`_Static_assert` 编译日志，落 `docs/round10/fileio/13d/D-FILE-1/` |

## 6. 与 Stage 5 的依赖（写清）

```
D-FILE-1 表同步（本方案）  ──必须先做──▶  Stage 5：给 FindFirstFileW 加挂钩 + 计数
                                            └─ 否则该入口永远不在 g_targets ⇒ 计不到 ⇒ 0 是"未挂钩"而非"未调用"
```
另注：`FindFirstFileW` **未必**是 node `readdir` 的真正入口（候选还有 `FindFirstFileExW`/`NtQueryDirectoryFile`）；
所以 **表同步可以先做**（纯结构修复、无行为变化），**新增挂钩要等 Stage 1–4 的结果**再决定值不值得做。
