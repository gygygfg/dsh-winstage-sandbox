# 沙箱文件修改测试报告

- **测试对象**：WinStageSandbox 会话沙箱
- **工作区**：`C:\Users\Administrator\Desktop\WinStageSandbox`
- **DSH 文件策略**：`workspace-write`
- **会话 ID**：`session-20477890-8053-44f2-b21c-2143763b3c2c`
- **主机**：`WIN-DV9KRECLBVS` / 用户 `Administrator`
- **Shell**：PowerShell 5.1.26100.33438（`FullLanguage`）
- **结论摘要**：**工作区内文件修改功能完全正常且完整性可验证；工作区外全部拒绝；发现一个重要的"暂存层（staging）"行为——harness 文件工具写入的文件在候选变更被 apply 之前，真实文件系统中并不存在。**

---

## 1. 可写范围（写入探针矩阵）

对 13 个位置逐一执行 `WriteAllText` + 回读校验：

| 位置 | 路径 | 结果 |
|---|---|---|
| 工作区根 | `...\WinStageSandbox\probe_ws.txt` | ✅ WRITE+READ OK |
| 工作区子目录 | `...\WinStageSandbox\sub\deep\probe_sub.txt` | ✅ WRITE+READ OK |
| DSH 会话临时目录 | `%TEMP%\dsh-3Miwbl\probe_temp.txt` | ✅ WRITE+READ OK |
| C: 根 | `C:\probe_root.txt` | ⛔ DENIED |
| D: 根 | `D:\probe_d.txt` | ⛔ DENIED |
| D: 子目录 | `D:\some\probe_d2.txt` | ⛔ DENIED（含建目录） |
| Windows | `C:\Windows\probe_win.txt` | ⛔ DENIED |
| Windows\Temp | `C:\Windows\Temp\probe_wintemp.txt` | ⛔ DENIED |
| Program Files | `C:\Program Files\probe_pf.txt` | ⛔ DENIED |
| ProgramData | `C:\ProgramData\probe_pd.txt` | ⛔ DENIED |
| 用户桌面（工作区外） | `C:\Users\Administrator\Desktop\probe_desktop.txt` | ⛔ DENIED |
| 用户文档 | `C:\Users\Administrator\Documents\probe_doc.txt` | ⛔ DENIED |
| 用户 AppData | `...\AppData\Local\probe_appdata.txt` | ⛔ DENIED |

**可写范围 = 工作区 + 会话专属临时目录，其余全部只读。**

---

## 2. 修改语义功能验证

| 操作 | 结果 | 证据 |
|---|---|---|
| 新建 | ✅ | `size=8 sha=377AF797…` |
| 追加 (Add-Content) | ✅ | `size=16 sha=543926F0…` |
| 覆盖 (Set-Content) | ✅ | `size=11 sha=53415936…` |
| 字节级原地改写 | ✅ | 首字节 `R`→`X`，sha 更新为 `BA90B4DE…` |
| 偏移寻址改写 (Seek) | ✅ | `0123456789` → `012XYZ6789`，`Seek` 返回位置=3 |
| 追加模式 (FileMode.Append) | ✅ | `A` → `ABC` |
| 截断 (SetLength) | ✅ | `ABCDEFGHIJ` → 长度 4 = `ABCD` |
| 重命名（工作区内） | ✅ | 旧路径消失，sha 不变 |
| 删除 | ✅ | `exists=False` |
| 零字节文件 | ✅ | `size=0 sha=E3B0C442…`（空 SHA256，正确） |
| 深目录（路径长度 134） | ✅ | 写入+回读 OK |
| 文件名边界 | ✅ | 空格 / 中文+emoji / 多点 / 大写 / 结尾双点 全部 OK |

---

## 3. 完整性校验（保存后校验）

### 3.1 二进制完整性
1 MiB 随机数据往返：

```
sha_in_memory  = 4256F477A9FEB7A39DF4DE918B1BAC0BD107E9702DB25FFE92FAD4DBDE2A413C
sha_on_disk    = 4256F477A9FEB7A39DF4DE918B1BAC0BD107E9702DB25FFE92FAD4DBDE2A413C
sha_after_read = 4256F477A9FEB7A39DF4DE918B1BAC0BD107E9702DB25FFE92FAD4DBDE2A413C
INTEGRITY_MATCH = True
```

### 3.2 编码完整性
| 编码 | 结果 |
|---|---|
| UTF-8 无 BOM | ✅ 往返一致 |
| UTF-8 带 BOM | ✅ 前缀 `EF BB BF` 正确 |
| UTF-16 LE | ✅ 往返一致 |
| GBK / CP936 | ✅ 往返一致 |

### 3.3 换行符保真（逐字节）
```
LF    -> 61 0A 62        preserved = True
CRLF  -> 61 0D 0A 62     preserved = True
```
沙箱不会静默转换换行符。

### 3.4 元数据
| 项 | 结果 |
|---|---|
| `SetLastWriteTimeUtc` | ✅ 精确到 100ns（`2001-02-03T04:05:06.0000000Z` 完全一致） |
| `SetCreationTimeUtc` | ✅ 完全一致 |
| `ReadOnly` 属性 | ✅ 可设置，且随后写入被正确阻止 |
| `Hidden` 属性 | ✅ 可设置 |
| 独占锁 (FileShare.None) | ✅ 第二个写入者被阻止 |

> 注：第 1 轮报告里 `LastWriteTimeUtc MATCH=False` 与 `CRLF preserved=False` 是**测试脚本自身的比较缺陷**（本地时区格式化对比 UTC、期望值漏算 BOM），第 2 轮已逐字节复核，实际均通过。

---

## 4. ⚠️ 关键发现：harness 文件工具的「暂存层」行为

这是本次测试最重要的发现。

### 4.1 现象
| 动作 | harness `read` 工具看到 | Shell (`pwsh`) 看到 |
|---|---|---|
| `write` 创建 `guard_test.txt` | ✅ 存在 | ❌ **不存在** |
| `edit` 修改 `pwsh_created.txt` → `edited-by-tool` | ✅ `edited-by-tool` | ❌ 仍是 `changed-by-pwsh-externally` |

即：**`edit` 工具返回 “updated successfully”，但真实文件系统上的内容没有变。**

### 4.2 机制
DSH 文件工具不直接写工作区，而是写入**按会话隔离的候选（candidate）暂存层**：

```
<workspace>\.dshstage\sessions\<session-id>\
    staged\<相对路径>           # 暂存的工作副本
    blobs\<xx>\<sha256>         # 内容寻址存储
    candidates\cs_000N_*.json   # 候选变更记录
    manifest.json               # 条目 + base/staged 哈希 + revision
    queue.json                  # 候选状态机
    review.json                 # 待审阅 diff
```

候选状态机（实测）：
```
cs_0001 (write  test_filemod.ps1)  -> applied      # 已落到真实文件系统
cs_0002 (write  guard_test.txt)    -> superseded   # 被 cs_0003 取代
cs_0003 (write+edit 2 files)       -> pending      # 仍是 pending
```

`review.json` 明确标记：`"pending": true`, `"candidates":[{"id":"cs_0003_334ba541","status":"pending","appliedPaths":[]}]`

### 4.3 内容完整性
内容寻址存储的 blob **文件名 == 内容 SHA-256**，4/4 全部校验通过：

```
blob 1108eac1e174c7a5  size=14    MATCH=True
blob 1f2c2d718ea924d7  size=26    MATCH=True
blob 3468402e3074af5d  size=8474  MATCH=True
blob 7a9f856c4d1bac28  size=69    MATCH=True
```
暂存内容本身**没有损坏或篡改**，只是尚未 apply 到真实工作区。

### 4.4 影响与建议
- ✅ **数据完整性**：正确（blob 哈希可验证）
- ⚠️ **可见性/一致性风险**：同一个"文件"在 harness 视图与 shell 视图里内容不同 → **不能用 shell 命令去验证工具写入的结果**（反之亦然），否则会得到假失败/假通过。
- ⚠️ 若候选长期停留在 `pending`，harness 认为"已保存"的文件在真实磁盘上并不存在；会话中断可能导致丢失。
- 📌 建议：工具写入后，用 `read` 工具（而非 shell）复核；或显式等待候选状态变为 `applied`。

---

## 5. 版本守卫（stale write guard）

1. `read` 读取 `pwsh_created.txt`
2. Shell 在外部改写该文件（sha `A866301A…` → `1F2C2D71…`）
3. `edit` 工具尝试写入 →

```
Error: cannot edit "...\pwsh_created.txt": file changed since it was read
       — re-read the file, then retry
```

**✅ 守卫生效**：外部修改会被检测到，不会静默覆盖。重新 `read` 后重试成功。

---

## 6. 隔离性验证：宿主文件不可修改

对**已存在**的宿主文件执行修改/删除/重命名/改属性/改时间戳：

| 攻击 | 目标 | 结果 | 文件是否改变 |
|---|---|---|---|
| 追加 | `C:\Windows\System32\drivers\etc\hosts` | ⛔ DENIED | 否（哈希不变） |
| 追加 | `C:\Windows\win.ini` | ⛔ DENIED | 否 |
| 覆盖 | `C:\Users\Administrator\NTUSER.DAT` | ⛔ DENIED | 否 |
| 覆盖 | `C:\Program Files\nodejs\node.exe` | ⛔ DENIED | 否 |
| 删除 | `hosts` / `win.ini` | ⛔ DENIED | 仍存在 |
| 重命名 | `win.ini` → `win_renamed.ini` | ⛔ DENIED | 仍存在 |
| 改属性 | `win.ini` → ReadOnly | ⛔ DENIED | 否 |
| 改时间戳 | `win.ini` | ⛔ DENIED | 否 |
| 建目录 | `C:\sandbox_escape_dir`、`Desktop\escape_dir` | ⛔ DENIED | — |

### 逃逸向量测试（全部被阻止）
| 向量 | 结果 |
|---|---|
| 工作区内建 **junction** 指向 `C:\Windows` | ⛔ DENIED |
| 工作区内建 **symlink** 指向 `C:\` | ⛔ DENIED（需要特权） |
| 建 **hardlink** 指向 `C:\Windows\win.ini` | ⛔ DENIED |
| `File.Copy` 工作区 → `C:\` | ⛔ DENIED |
| `File.Move` 工作区 → `C:\` | ⛔ DENIED |
| **NTFS 备用数据流 (ADS)** `file:stream` | ⛔ 路径被拒绝 |
| **子进程**（node.js，自带 libuv）写 `C:\`、`C:\Windows\Temp`、`Documents` | ⛔ `EPERM` |

> 子进程隔离已确认：`node` 写工作区成功，写工作区外全部 `EPERM`。说明限制由内核级过滤驱动实施，**不是** PowerShell 层面的检查，无法通过换语言/换进程绕过。

---

## 7. ❌ 已知限制：原子替换 `File.Replace` 失效

```powershell
[System.IO.File]::Replace($tmp, $dst, $null, $true)
# => "The path is not of a legal form."
```

在两个不同位置均复现（工作区 `filemod\` 与会话临时目录），且 `at2.txt` 保持 `v1`、`at2.tmp` 残留：

```
Replace in ...\WinStageSandbox\filemod            -> FAILED :: The path is not of a legal form.
Replace in ...\Temp\dsh-3Miwbl                    -> FAILED :: The path is not of a legal form.
```

**影响**：依赖 `ReplaceFile` API 的"原子保存/安全写入"模式（许多编辑器的保存实现）在此沙箱中不可用。

**可用替代**（实测通过）：
```powershell
Move-Item -LiteralPath $tmp -Destination $dst -Force    # ✅ OK，内容=v2，tmp 已消失
```

---

## 8. 测试结论

| 维度 | 结论 |
|---|---|
| 工作区读写/修改/删除 | ✅ 全部正常 |
| 保存后二进制/编码/换行完整性 | ✅ 通过（SHA-256 逐字节验证） |
| 元数据（时间戳、属性、锁） | ✅ 正常 |
| 并发写保护 | ✅ 独占锁生效 |
| 外部篡改检测（版本守卫） | ✅ 生效 |
| 工作区外写入/删除/改名/改属性 | ⛔ 全部拒绝 |
| junction/symlink/hardlink/ADS 逃逸 | ⛔ 全部拒绝 |
| 子进程绕过 | ⛔ 拒绝（内核级 `EPERM`） |
| `File.Replace` 原子替换 | ❌ 不支持（可用 `Move -Force` 替代） |
| harness 工具写入可见性 | ⚠️ 暂存候选未 apply 前，真实磁盘无此文件 |

**总体评价**：文件修改的**隔离性与内容完整性表现优秀**；主要需要留意的是 harness 工具的"暂存候选（pending candidate）"语义，它会让人误以为文件已落盘。

---

## 附：原始证据文件

| 文件 | 说明 |
|---|---|
| `esc\filemod_report.txt` | 第 1 轮完整输出（17 项） |
| `filemod\test_filemod.ps1` | 测试脚本 |
| `filemod\bin.dat` | 1 MiB 二进制往返样本 |
| `.dshstage\sessions\session-20477890-.../` | 暂存层：manifest / queue / candidates / blobs |
