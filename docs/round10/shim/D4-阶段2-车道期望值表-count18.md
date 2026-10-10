# D-FILE-4 阶段2 · **车道期望值表（count18 / tag `count18-s2`）** — 预登记，跑前冻结

> 供 `lane-runner` 逐字对照、**不下 PASS/FAIL**（判定由 `line-d4` 做）。作者：`line-d4`（task-14）｜2026-10-10
> 候选：`.t/round10/shim/out-13d-count18/winstage-shim.dll` = `BDF0672C449B7C70C7EB0B432068BA3DCBE40B67E312B45C74507E2CADA50AF7` / 266,240 B（= v2(D99+guard) + D4S2）
> 本表**在车道跑之前**冻结；表中"修前"一列取自**阶段 1 的 count15 轮实测**（`D4-rawlines-c15.txt` / `analysis-c15.txt`），不是推测。

---

## 1. 车道命令（复用阶段 1 冻结件，**不改参数、不写树**）

```
cmd /c "call .t\round10\shim\d4\run-d4.cmd count18-s2 C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\shim\out-13d-count18\winstage-shim.dll"
```

- 产物：`d4\out-count18-s2\`、`d4\stage-count18-s2\`（证据在 `stage-count18-s2\staged\evidence\`）、`d4\ws-count18-s2\`；**不覆盖**任何既有 `stage-d4-*`。
- 驱动内部逐条跑 12 个路由（一进程一路由），并把 `shim.log`/`injection.txt`/`attrdbg-nqifbn.txt`/`attrdbg-w.txt` 抄进 evidence。
- 仪器哈希（我复核 = 你给的）：`run-d4.cmd` `C1D90885…`/1,233、`d4-driver.cmd` `F314428E…`/2,118、`probe\d4-probe.exe` `33454B38…`/167,936。三者核对通过后即可开跑。

---

## 2. 判读口径（四条，避免挑错字段）

1. **只按前缀 pid 关联**：`shim.log` 每行形如 `[winstage-shim][<pid>][<seq>] …`；驱动一个路由一个进程 ⇒ **路由 ↔ 计数只按前缀 pid join**。不得跨 pid、不得跨时刻 join。
2. **`ATTRDBG-W` 只数夹具路径**：判据是 `ATTRDBG-W … in=<ws>\probe\d4-fixture.txt`（同一 run 里还有大量其它进程/路径的 W 行，**不计入**）。
3. **不看 `err=` 残留**：`GetFileAttributesW` 成功不清 `LastError` ⇒ `err=183/0` 只是残留（阶段 1 两轮实测 `183` 与 `0` 都出现）。判据用 `attrs=` / `rc=` / `status=` / `staged=`。
4. **跨构建不比绝对指针**：只比**指针归属**（`owner=…\winstage-shim.dll` vs `owner=…\ntdll.dll`/`KERNELBASE.dll`）。同一 run 内可以比 `static(iat-slot)` 与 `gpa` **是否同址**。
5. **0 行必须有活性正对照**：`static-w`/`static-nq` 命中即证明钩子活、日志在写、注入到位；否则该轮记 `inconclusive`。

---

## 3. 逐路由期望值表（12 条）

记法：`W` = 夹具路径上的 `ATTRDBG-W` 行数（前缀 pid 归属）；`NQ` = `ATTRDBG-NQIFBN` 行数；`…CAND…` = 候选 dll 路径；所有 `RC_*` 期望 **0**。

| # | 路由 | 修前（count15）观测形态（逐字/计数） | **count18 应有形态** | 判据字段 | 定性 |
|---|---|---|---|---|---|
| 1 | `identity` | `IDENT … route=static(iat-slot) ptr=<shim>`、`route=gpa ptr=<同一 shim 地址>`；`IDENT api=GetProcAddress route=static(iat-slot) ptr=<shim>`；`route=manual ptr=<ntdll/kernelbase 真身>`；`IDENT ntdll-export LdrGetProcedureAddressEx present=1 (#140)`、`LdrResolveDelayLoadedAPI present=1 (#170)`、`Ldrp*` `present=0`；`NQIFBN manual-ordinal ordinal=495`；W 的 `static(iat-slot)` 与 `gpa` 同址 | **同形**；`NQIFBN`/`W` 的 `static(iat-slot)` 与 `gpa` **仍同址**、owner **仍** `winstage-shim.dll`；三条 `manual*` 仍 owner `ntdll.dll`/`KERNELBASE.dll` | `owner=` 字段；同 run 内同址 | **必须不变**（护栏） |
| 2 | `static-w` | `W=3`；`CALLCALL tag=static-w attrs=0x00000020 err=183` ×3 | `W=3`；`attrs=0x00000020` ×3（`err` 不计） | `W` 计数 + `attrs` | **必须不变** |
| 3 | `gpa-w` | `RESOLVE route=gpa api=GetFileAttributesW … owner=…count15…`；`W=3`；`attrs=0x20` ×3 | `RESOLVE … owner=…count18…`；`W=3`；`attrs=0x20` ×3 | `W` 计数 + `RESOLVE owner` | **必须不变** |
| 4 | `manual-w` | `RESOLVE route=manual … ptr=<KERNELBASE 真身> owner=…KERNELBASE.dll`；`W=0`；`attrs=0xFFFFFFFF err=3` ×3 | **同前**（私有解析不修） | `W=0` + `owner=KERNELBASE.dll` + `attrs=0xFFFFFFFF` | **必须不变**（负对照） |
| 5 | `static-nq` | `NQ=3`，全 `staged=1 status=0x0 class=77`；`CALLCALL st=0x00000000` ×3 | `NQ=3`、`status=0x0`；`st=0x0` ×3 | `NQ` 计数 + `status` | **必须不变**（活性正对照之一） |
| 6 | `gpa-nq` | `RESOLVE … owner=…count15…`；`NQ=3` `status=0x0`；`st=0x0` ×3 | `RESOLVE … owner=…count18…`；`NQ=3`；`st=0x0` ×3 | `NQ` 计数 | **必须不变** |
| 7 | `manual-nq` | `RESOLVE … ptr=<ntdll 真身> owner=…ntdll.dll`；`NQ=0`；`st=0xC000003A` ×3 | **同前** | `NQ=0` + `owner=ntdll.dll` + `st=0xC000003A` | **必须不变**（负对照） |
| 8 | `rawgpa-nq` | `RESOLVE route=rawgpa resolver=kernelbase!GetProcAddress ptr=<真身> owner=KERNELBASE.dll`；`RESOLVE … api ptr=<ntdll 真身>`；`NQ=0`；`st=0xC000003A` ×3 | **同前** | `NQ=0` + 两个 `owner` 都是真身 | **必须不变**（负对照） |
| 9 | `rawldr-nq` | `RESOLVE route=rawldr resolver=ntdll!LdrGetProcedureAddress ptr=<真身> owner=ntdll.dll`；`RESOLVE … st=0x0 ptr=<ntdll 真身>`；`NQ=0`；`st=0xC000003A` ×3 | **同前** | `NQ=0` + `owner=ntdll.dll` | **必须不变**（负对照） |
| 10 | `ordinal-nq` | `RESOLVE route=ordinal api=NtQueryInformationByName ordinal=495 raw=<ntdll 真身> gpa=<ntdll 真身> owner=…ntdll.dll`；`NQ=0`；`st=0xC000003A` ×3 | **`gpa=<shim 包装>`、`owner=…count18\winstage-shim.dll`**（`raw=` 仍为 ntdll 真身）；`NQ=3` 全 `staged=1 status=0x0 class=77`；`st=0x00000000` ×3 | `RESOLVE … gpa=` 的 **owner** + `NQ` 计数 + `st` | **★ 本次应变成真（item ii）**：`NQ 0→3` |
| 11 | `wrongmod-nq` | `RESOLVE route=wrongmod api=NtQueryInformationByName hmodule=kernel32 ptr=<shim 包装> owner=…count15…`；随后 `CALLCALL st=0x0` ×3；`NQ=3` | `RESOLVE … ptr=0000000000000000 owner=<NULL>`；随后探针打印 `RESOLVE route=wrongmod result=NULL (real loader semantics)`；**无 `CALLCALL`**；`NQ=0` | `ptr` 全 0 + `owner=<NULL>` + `NQ` 计数 | **★ 本次应变成真（item i）**：`NQ 3→0` |
| 12 | `mixed-nq` | 同进程 `st=0x0` ×6（3 static + 3 gpa）；`NQ=6` | `st=0x0` ×6；`NQ=6` | `NQ` 计数 | **必须不变** |

**注**：`ordinal-nq` 的 `raw=` 字段是"手工走导出表拿到的真身"，**它必须始终是真身**（本阶段不修私有解析）；变的只有 `gpa=`（真实解析器结果经同一性比对后换成包装）。

---

## 4. 接受面 vs 护栏（聚焦回报用）

| 类别 | 路由 | 条件 |
|---|---|---|
| **接受面（必须变）** | `ordinal-nq`、`wrongmod-nq` | `ordinal-nq`：`NQ 0→3` 且 `RESOLVE gpa` owner = shim；`wrongmod-nq`：`NQ 3→0` 且 `ptr=NULL`、无 `CALLCALL` |
| **护栏（必须不变）** | `static-w`、`gpa-w`、`static-nq`、`gpa-nq`、`mixed-nq` | 计数与 `status/attrs` 同表 |
| **负对照（必须保持"不命中"）** | `manual-w`、`manual-nq`、`rawgpa-nq`、`rawldr-nq` | 命中数 = 0，且解析出的指针 owner 是**真身**（不得变成 shim） |
| **同址不变式** | `identity` | `static(iat-slot)` 与 `gpa` 在**同一 run 内同址**；`manual*` 一律真身 |

**车道级附加门禁**（你已在做，一并记账）：`tierEffective=TS` **且** `launchMode=shim` **且** `fallbackReason` 缺席/空 **且** 无 `carrierExits=0xC00000FD`；**12/12 探针 pid** 各有 `child injection armed: self=…out-13d-count18… ok=1`。

---

## 5. 机器校验器（跑完即可跑）

```
cmd /c "call run.cmd .t\round10\shim\d4\analyze-count18.mjs ^
      .t\round10\shim\d4\stage-count18-s2\staged\evidence\shim.log ^
      .t\round10\shim\d4\stage-count18-s2\staged\evidence\d4-probe-raw.txt"
```

- `analyze-count18.mjs`（`441BC48F…`）**内含本表 3 的 count18 预登记档案**：对 12 路由逐条 `MATCH/MISMATCH`，并对两条应变路由做字段断言（`wrongmod ptr=NULL`；`ordinal gpa` 在 shim 模块内），最后打印 `VERDICT`。
- ⚠ **不要用阶段 1 的 `analyze.mjs`**：它的档案是**修前**的，跑到 count18 上会给出**两处预期内的 DIFF**（那正是本表第 10/11 行）。若一定要用，先把这两条当"应该 DIFF"读。
- 自测（用阶段 1 的 count15 数据跑本档案 ⇒ **必须**恰好在这两条上报 MISMATCH/ASSERT-FAIL）：`.t/round10/shim/d4/D4S2-analyze-count18-selftest-on-c15.txt` = `7E425CDE…`。

---

## 6. 该驱动**判不了**的项 + 最小补充（**离线件，不构成车道证据**）

| 项 | 为什么判不了 | 最小补充（已做） |
|---|---|---|
| "**非覆盖的导出名**在覆盖模块上仍为真身"（如 `NtClose`、`GetModuleHandleW`） | 驱动的 12 路由里没有这类正对照（只有 `manual-*` 这种"解析路径绕开"的对照） | lane-free 探针 `probe\d4-offline-gpa.exe`（`LoadLibraryW` 候选后进程内直接 `GetProcAddress`）——**已对 count18 预跑**：`not-covered:NtClose` → `ntdll.dll` 真身、`not-covered:GetModuleHandleW` → `KERNEL32.DLL` 真身；`ordinal-496` → ntdll 真身（**无误伤**）。原始件 `D4S2-offline-gpa-count18.txt` = `7998BC7B…`。**声明：这是离线证据，不替代车道 ③。** |
| `hModule=NULL` 的 `GetProcAddress` | 驱动无此路由 | 同上离线探针：count18 = `NULL`（count15 = 包装） |
| `LdrGetProcedureAddress` 的**序数**分支 | 驱动无此路由（阶段 1 的 `rawldr` 测的是真身解析器） | 同上离线探针：count18 `ldr-ordinal-495` → shim 包装、`496` → ntdll 真身 |

**count18 离线预跑（表 6，供你交叉核对；仍非车道证据）**

| 探针项 | before（真身） | count15（修前） | count18（v2+D4S2） |
|---|---|---|---|
| `GPA kernel32!NQIFBN`（错模块） | `NULL` | 包装 | **`NULL`** |
| `GPA hModule=NULL, NQIFBN` | `NULL` | 包装 | **`NULL`** |
| `GPA ntdll!NQIFBN`（对模块） | ntdll 真身 | 包装 | 包装 |
| `GPA kernel32!CreateFileW` | KERNEL32 | 包装 | 包装 |
| `GPA ordinal-495` | ntdll 真身 | ntdll 真身 | **包装** |
| `GPA ordinal-496` | ntdll 真身 | ntdll 真身 | ntdll 真身 |
| `LDR ldr-ordinal-495` | ntdll 真身 | ntdll 真身 | **包装** |
| `LDR ldr-ordinal-496` | ntdll 真身 | ntdll 真身 | ntdll 真身 |
| `NtClose` / `GetModuleHandleW` | 真身 | 真身 | 真身 |

---

## 7. 仪器与候选哈希（你跑前核对）

| 件 | sha256 | 字节 |
|---|---|---|
| `out-13d-count18\winstage-shim.dll` | `BDF0672C449B7C70C7EB0B432068BA3DCBE40B67E312B45C74507E2CADA50AF7` | 266,240 |
| `run-d4.cmd` | `C1D90885AF5F03295A64EE7A54F8D645DA6486813C35194850C318EF10532C51` | 1,233 |
| `d4-driver.cmd` | `F314428E284D9D2346C21D2D51266CB09190F511A6048205B022BDEAD98BFA98` | 2,118 |
| `probe\d4-probe.exe` | `33454B386B1DE12475998A13C90CF73B7B6743365DFF0B1573C381CE792AB347` | 167,936 |
| `analyze-count18.mjs`（新，跑后用） | `441BC48F4826A0AFAB0EDDD9FFFB739D9E5CFA17C2613AA07EA1018D38FA2C44` | 5,846 |
| `strscan-count18.txt`（目标名/标记扫描） | `E4C41C052139CDF43C47F994196E1CCABED637473FCA9AFB09EDF1541A0A49` | 370 |

`strscan-count18.txt` 证明该候选**含** `NtQueryInformationByName`/`GetFileInformationByHandleEx`/`NtQueryAttributesFile`/`NtQueryFullAttributesFile` 目标名与 `ATTRDBG-NQIFBN`/`ATTRDBG-W `/`ATTRDBG-GFIBHEX` 标记（否则本表第 5–12 行的日志判据不成立）。

---

## 8. 禁止事项（与你的执行承诺一致）

- **不得**写 `shim/src/**`、不得 apply/复原任何补丁（作者与执行者的分工见 Lead 2026-10-10 纪律）。
- 跑前核对上表四件哈希；跑后**只逐字回报**（12 路由输出原文 + `RC_*` + 注入断言 + 档位/载体字段 + `shim.log` 指纹），**不下 PASS/FAIL**。
- 发现任何树写入或通道异常 ⇒ 立即停下上报。
