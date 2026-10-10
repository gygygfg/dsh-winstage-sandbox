# env-harness 名下仪器：现行权威哈希表（单一事实来源）

> 用途：防止"登记滞后 / 抄录滞后"再次触发停手（本会话已发生 3 次同类：`d5-judge.mjs`、`verify-v2.mjs`、以及 `6372` 计数假阳性）。
> 纪律：**登记哈希必须在"最后一次编辑之后"取，取完立刻复跑一次证链**；广播时**件名 + 目录 + 哈希 + 字节 + 行数**齐备。
> 生成方式：本表全部为**现测**（`Get-FileHash`/字节数/行数）；下表 mtime 为本表初版时的值。
> 最近一次外部现测核对：`lane-runner` 24/24 相符（零漂移）。

## 1. `fileio\d5`（D-FILE-5 / ③ 载体与判据）

| 件名 | 目录 | 字节 | 行 | sha256 |
|---|---|---|---|---|
| `nqaf5-probe.c` | `.t\round10\fileio\d5` | 10,217 | 242 | `C21FFCFD3FE06A04B55FBB53F60243F6B1E3646AEA3CE2264C2BEBB9B8C4BA22` |
| `nqaf5-probe.exe` | 同上 | 154,112 | 412 | `F93066777A58880E584EA679A29BB44A6E36857E4F1640B800F3E964CDC23D06` |
| `d5-driver.cmd` | 同上 | 3,519 | 91 | `30528B8D7B8BD8EA88C380AD95EC53FC4A9F73F3DFF8C891CD858C577AAED857` |
| **`d5-judge.mjs`**（权威现值） | 同上 | **11,710** | 199 | **`F2C06FF48EC5E45F58291AE4F8635B2872F92707FA61F4CABCE924F8849468BB`** |
| `d5-demo-driver.cmd` | 同上 | 1,628 | 31 | `1B37DA70AE0B9134775EF6C56E3A09E5707DEE4F48813DA63F7DE99BF0FB9592` |
| `probe-selftest.cmd` | 同上 | 1,666 | 42 | `76C5CC52A80F86D794C85FEC2C5342F0A181C8BB861223E689DA98EB5479C095` |
| `probe-selftest.txt` | 同上 | 3,450 | 34 | `02025BE5BC7D6B6E13BECD7B72F9D0C75D99FA81AB88311D19230A3C6B993580` |
| `d5-show.mjs` | 同上 | 944 | 17 | `443520CF125BD3283C92861C4708E6E598C47C940B8D92E8AC4F4B1B5AAC2A68` |

## 2. `fileio\13d-t4`（车道入口 / 复检器）

| 件名 | 目录 | 字节 | 行 | sha256 |
|---|---|---|---|---|
| `cli-run.cmd` | `.t\round10\fileio\13d-t4` | 1,748 | 37 | `792FE3CFB1D2C676D192DC66E149F7F60E7D7CF39023F20A629CD0EB140C3510` |
| `verify-artifacts.mjs` | 同上 | 2,137 | 49 | `D6F5CA9CD60D2317CD7D2B70CBFB24BF10B5F53C5C873EF1E83747B60E9FC58C` |
| `driver.cmd` | 同上 | 2,400 | 51 | `72086183CB45FA706CFE0B51535BF900DE916C01A0A70AD64D27E4B6D2779D68` |
| `real-driver.cmd` | 同上 | 1,789 | 29 | `B992A361FB0B28978E4FE155E3EB6D567AE88431EB898FB8040F76646E172DFD` |
| `dir-ab-driver.cmd` | 同上 | 2,614 | 35 | `773597C0BF487FE6A5B0D549BE00A5F3BE0D651DA048DBA4889B327AF3B6CE65` |
| `dir-root-driver.cmd` | 同上 | 1,197 | 20 | `06184415F6DA41D164D53F6936397175FB0D4C8D7DB572B46F637D91FA406602` |
| `collect.mjs` | 同上 | **5,368** | 118 | `F4CFAE39488E931EC430FCE6E890708C83C96E8F7322F3902F86B195FC4F0655` |
| **`verify-v2.mjs`**（权威现值） | 同上 | **7,566** | 147 | **`AD764AFAA6AC75A84017DCB3AE3B4D5D494BBAB57A60186DDCD6337EE56707E3`** |
| `ab-dirs.mjs` | 同上 | 5,848 | 112 | `AA219E6995F9DF8D25888EE095C7C784C82F892C3AB09CFE726C915E26A8D55E` |

## 3. `fileio\d4`（我方 O1 / T15 仪器）

| 件名 | 目录 | 字节 | 行 | sha256 |
|---|---|---|---|---|
| `o1-probe.c` | `.t\round10\fileio\d4` | 20,541 | 355 | `D0FD7E39AD66C6FC48ECC8C1D8E33EEEF3B95CABED682A71B5642BED2086BCF6` |
| **`o1-probe.exe`** | 同上 | 162,816 | 434 | **`B9669503E7E963FD65BCA143C2C2CDC5325AD3E5DC7D9FC99B1DBE21EA4072BD`** |
| `o1-samename.c` | 同上 | 584 | 17 | `3909BF80C49587CB369C8200661DBD0E2FEB60CBE37D594D770443A366E4496A` |
| `o1-samename.dll` | 同上 | 144,384 | 383 | `FA49ADA5A4D55F114763B824339DDD43EE0FFD2F5E1CA786D672C7DE54171937` |
| `o1-lanefree-recipe.cmd` | 同上 | 2,071 | 40 | `B98498F4FA63A7D3CDCD2A41800CC5B458B7AE5911129BFB8BD5F015A310F2C7` |
| `d4-probe.c` | 同上 | 11,569 | 207 | `88F6B2DFF27FD3F71EDD467C43BE95478017FA89B375DED7746F0CF2988453F8` |
| **`d4-probe.exe`（我方）** | 同上 | 154,624 | 411 | **`6DDC7152C37FEE5E136DBBD0FF1FF3C69389FEE36975C12A5843A5A4DD27F541`** |
| `d4-driver.cmd` | 同上 | 1,830 | 40 | `E55927F1BF4AF3114F9057135EF24943CD97376EBB82E70B036FBD07C060D2AB` |

## 4. 两处登记更正（**我的登记滞后，非第三方改动**）

1. `d5-judge.mjs`：旧登记 `F63781AA…`/11,366 B = **换代中间态**（在 18:21:56 的 `key=value` 分词编辑**之前**取值）；权威 = **`F2C06FF4…`/11,710 B**。
   **证链复跑**（用现值跑已归档输入）：`out-d5-v2b` → `GATE carrierSafe=true … hitNqaf=true hitNqfaf=true realOk=true whiteoutOk=true`；`out-d5-b15b` → `GATE … hitNqaf=false hitNqfaf=false realOk=true whiteoutOk=false`，与登记判决逐项一致。
2. `verify-v2.mjs`：旧记 `7C6693EC…` → 权威 **`AD764AFA…`/7,566 B**（mtime 13:53:46，早于一切事故，同为我登记取早）。

## 5. 名称撞车警示（务必带目录引用）

`d4-probe.exe` 存在**两个不同文件**：
- 我方：`.t\round10\fileio\d4\d4-probe.exe` = `6DDC7152…` / 154,624 B —— **来源可自证**（T15 第二仪器）。
- `line-d4` 方：`.t\round10\shim\d4\probe\d4-probe.exe` = `E2928BB3…` / 167,936 B —— 阶段 1 仪器，因 `probe\build.cmd`（21:26 改）在 21:54 **原位重建**而覆盖了登记值 `33454B38…` ⇒ **PROVENANCE-UNVERIFIED**，其 `count19-o1` 轮已判 `NOT-RUN`。

另：判据类 grep 必须 **大小写敏感**；本机已有两次"按日志计数"假阳性（`attrdbg-nqifbn.txt` 文件名自匹配、`CFW-OVL valid=1` 被 `handle=` 夹断）。
