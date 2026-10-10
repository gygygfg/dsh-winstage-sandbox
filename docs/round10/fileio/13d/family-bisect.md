# R11-D-13d 族级二分（在用件 02C7418F…，运行时开关，免源码/免替换）

生成：2026-10-09T17:18:23.494Z　载体：`env-override-harness.mjs` → `WindowsStageExecutor{tier:TS}` → `ShimLauncher`（注入子进程）
目标（shim 暂存文件，真实盘不存在）：`C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\ws\probe\ts2.txt`

| 配置 | 稳定 | node existsSync | node stat | node read(正对照) | node readdir | .NET Exists(正对照) | cmd if exist | cmd dir | cmd type |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | true | NO | FAIL | FAIL |
| `SKIP-GetFileAttributesExW` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | false | NO | FAIL | FAIL |
| `SKIP-GetFileAttributesW` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | true | NO | FAIL | FAIL |
| `SKIP-GetFileAttributesWAEx` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | false | NO | FAIL | FAIL |
| `SKIP-FindFirstFileW` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | true | NO | FAIL | FAIL |
| `SKIP-NtOpenFile` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | true | NO | FAIL | FAIL |
| `SKIP-CreateFileW` | 3/3 | false | ERR:ENOENT | FAIL | ERR:ENOENT | true | NO | FAIL | FAIL |
| `DISABLE_FILE` | 3/3 | false | ERR:ENOENT | FAIL | ERR:ENOENT | false | NO | FAIL | FAIL |
| `DISABLE_REG(control)` | 3/3 | false | ERR:ENOENT | OK | ts2.txt | true | NO | FAIL | FAIL |

> 判读规则：跳过某钩子只会让路径**更不可见**（回落真实盘）⇒ 只有"正对照由 True 翻 False"才能证明该开关**真的生效**，并指出该信号依赖哪个 API。