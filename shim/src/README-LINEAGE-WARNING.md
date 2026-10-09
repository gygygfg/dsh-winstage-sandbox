# ⚠ shim/src 血统警告 —— 本目录当前**不是**在用 DLL 的源码

> 写入者：Lead · 时间：2026-10-09 18:2x（+08:00）· 依据：`docs/round10/LEAD-修复记录.md` §V5、
> `docs/round10/shim/evidence/D39/D44/D45/D46-*`、`docs/round10/汇总报告.md` §8.5/§8.5.1

## 事实

| 项 | 现值 |
|---|---|
| **在用件** `shim/out/winstage-shim.dll` | `02C7418FF0F11AFD45FEEA601733E848ECB697FD393915565420F7A41248B76F`（246,784 B）= **只含 R 修复**（`LdrLoadDll` 单模块补丁），已通过 `carrier-flake 100 = 0/100`、回归驱动两 mode 宿主真实盘零写、5 套件绿 |
| `shim/src/ws_hook.c` | **task-11c 血统**（`ws_hook_converge`×6、`g_patchedBases`×7、`LdrLoadDll`×0 ⇒ 实测 70/100 崩），且**源码 ≠ 在用件** |
| `shim/src/ws_t3reg.c` / `ws_regstore.c` | 含 **registry 的 D-R1 改动** —— 该改动在受控替换窗口（候选 `5E7A010E…`）中被**并集门禁否决**：`reg delete /reg:32` 由 `ACCESS_DENIED(5)` 变为**返回 0**、**真实 hive 键真的消失**、UNSTAGED journal 记录缺失（`D46-2` §红项分类）⇒ **不得进入在用件** |
| 其余 `shim/src/*`（`ws_file.c` 等） | 含 13c 的**未采纳**目录面钩子（`NtQuery*File`，假设已被否证） |

## 禁令

1. **禁止**用当前工作树执行 `node tools/build-shim.mjs`（或任何重建）后**替换** `shim/out/**` ——
   产出会是"11c 血统 + 已否决的 D-R1 + 已否证的目录面钩子"，属**未验证/已否决件**。
2. 需要候选时：构建到隔离目录（如 `.t/round10/shim/out-<rev>`），用 `WINSTAGE_SHIM_DLL`/`WINSTAGE_SHIM_DIR` 指路
   仅能验证**宿主**侧行为；**注入态端到端必须走受控替换窗口**（见下方协议）。
3. 任何替换都必须：备份现值并记 sha256 → 冻结广播 → 只复制 DLL、**绝不覆盖** `winstage-inject.exe`/`winstage-probe.exe`
   → 跑完整门禁（血统三判据 + 并集门禁 + 相应的注入态用例）→ **全过保留 / 任一不过立刻回滚**。
4. 改 `shim/src` 前先备份到 `.t\round10\shim\backup-<ts>\` 并记 sha256；**禁止**定义与内置别名同名的函数
   （`rd`/`rm`/`ls`/`cp`/`mv`/`cat`…），删除/回退一律 `Remove-Item -LiteralPath <绝对路径>` 且先打印断言。

## 恢复到"源码 = 在用件"的可靠路径（见 §V5 的**签名锚点**，不要用注释文本定位）

削掉 11c 的 `g_patchedBases` 三件套与 `ws_hook_converge`、把 4 处 `ws_hook_converge(h)` 改回 `ws_hook_refresh_module(h)`、
重放 R 的 4 处增量（`WS_TARGET(LdrLoadDll)` / `"LdrLoadDll"` / map 行 / `ws_LdrLoadDll` 实现），
删掉 13c 的 NtQuery 残留；**并决定 D-R1 的处置**（修复 `/reg:32` 逃逸后再谈采纳，或整体回退）。
判据不是"看起来对"，而是**功能门禁**：`carrier-flake 100 = 0/100`、回归驱动两 mode 宿主真实盘零写、
15 exports + 0 warning + 注入器/探针原件未覆盖。
