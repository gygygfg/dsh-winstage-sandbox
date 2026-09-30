# shell 执行面修复报告：档位不匹配不再让整条 shell 失效

> 执行者：Lead（本轮亲手实测与实现）
> 时间：2026-09-30
> 判定标记：`[实测]` = 真跑过并留原始输出；`[引用]` = 只读源码所得；`[未实测]` = 缺条件
> 受影响文件：`dsh-plugin/shell-executor.mjs`（唯一产品文件改动）

---

## 0. 一句话

用户报「关闭沙箱后 shell 全废」。根因不是开关没生效，而是 **`winstage-shell` 占着 `ctx.shell` 单例服务名，却在档位 ≠ `workspace-write` 时直接抛错拒执行** —— 用户没有第二个执行面可退。
**已修**：档位不匹配**不再抛错**，改为**在 WinStage 围栏内执行并显式报响**；shell 已恢复可用。

---

## 1. 现象与原始报错（`[实测]`）

会话档位为 `danger-full-access` 时，**每一条** `pwsh` 都返回：

```
winstage-shell: requested sandbox mode "danger-full-access" differs from what this
executor applies ("workspace-write"); WinStage 不支持升权，本次命令没有执行（绝不静默忽略）。
```

- 触发点 `[引用]`：`shell-executor.mjs` 的 `execute()` 里
  `if (requestedMode !== undefined && requestedMode !== 'workspace-write') throw shellFailure(...)`。
- 受影响面：`whoami`、`node --version`、`Get-ChildItem`……**全部**命令，无一例外。
- 同时实测：**subagent 完全继承同一档位**，三条命令同样被拒（说明"另开 subagent"无法绕过）。

---

## 2. 三条被实测否定的修法（**重要取证，勿重蹈**）

目标曾是"关掉开关就把执行面**交还**平台原生执行器"（`@deepseek-ai/dsh-pwsh-local`）。**三次均失败**：

| # | 尝试 | 原始报错 | 根因 |
|---|---|---|---|
| ① | `new PwshLocalExecutor(this.ctx, cfg)` | `service "shell" has been registered at <WinStageShellExecutor>` | `ShellExecutor extends Service`，基类构造即 `ctx.provide('shell', this)`（`cordis/lib/index.js:800-824`，第 813 行抛）；`ctx.shell` 已被 WinStage 占用 ⇒ **单例服务名不可共存** |
| ② | 用 no-op `provide` 的替身 ctx（`Object.create(ctx)` + `provide=()=>{}`）绕过注册 | `cannot get property "subprocess" without inject` | 构造通过，但原生 `execute()` 经 `this.ctx.subprocess.spawn(...)`（`dsh-pwsh-local/lib/index.js:306`）；`subprocess` **未注入本 fiber**，Cordis 的属性访问门拒绝 |
| ③ | 捕获 ② 并降级执行 | 报错**仍从 try 之外逸出** | 根因在 `ctx` 属性访问层，`[未实测]` 未定位 |

**结论**：**"交还平台执行器"在本装配下结构上不可行。**
根因与用户最初那句话是同一件事：**两套机制抢同一个 `ctx.shell` 槽位**。
fs 侧能回退是因为它**继承**平台提供方（可用 `super.*`）；shell 侧是**整体替换**，没有 `super`，也不能 `new` 一个同名的来用。

该方法的代码连同三次报错已**标注保留、不再调用**（`shell-executor.mjs` 的 `nativeExecutorFor()` 头部 JSDoc + `S3*` 断言钉住"不再参与执行路径"）。

---

## 3. 最终实现（已交付）

`dsh-plugin/shell-executor.mjs` 的 `execute()`：

```js
const requestedMode = spec?.sandboxPolicy?.mode
const mismatched = requestedMode !== undefined && requestedMode !== 'workspace-write'
if (mismatched) {
  this.logError(
    `请求的档位 "${requestedMode}" 比本执行器实现的宽（"workspace-write"）；` +
      '本次**在 WinStage 围栏内执行**（可写 = 暂存树），权限未被放大。' + …
  )
}
return this.executeConfined(spec, {
  requestedMode,
  ...(mismatched ? { degradeNote: `请求档位 "${requestedMode}" 宽于…；已按 WinStage 围栏执行…` } : {}),
})
```

配套：把原 `execute()` 的执行体抽成 `executeConfined(spec, context)`，`degradeNote` 经 `warn()` 进
`notes` ⇒ 随命令返回的 stderr 注记带出（**用户与断言都能看见**）。

### 三条性质（这是判据，不是形容）
1. **不再失效**：`execute()` 内**没有任何**因档位而 `throw` 的分支。
2. **权限不放大**：可写面**始终**是暂存树（`workspace-write`）；请求更宽档位只得到注记。
3. **不静默**：档位不匹配必进 **error 级日志** + **返回注记**。

---

## 4. 验证证据（`[实测]`）

### 4.1 修复后活实例（重启 + sync 后）
```
shell-alive
v24.21.0
[winstage] executed inside the sandbox; real cwd = C:\Users\Administrator\.dshstage\sessions\session-b5a590d5-…\staged (real workspace: C:\Users\Administrator)
[winstage] captured 0 change(s), ingested 0, deletions 0; no new candidate (no-net-change)
[winstage] 请求档位 "danger-full-access" 宽于本执行器实现的 "workspace-write"；已按 WinStage 围栏执行（可写 = 暂存树），权限未放大。
```
⇒ 命令**执行成功**，且降级告警**按设计出现**（第 2、3 条性质同时成立）。

### 4.2 离线验证器：`docs/dsh2-shell-fallback-verify.mjs`
**16 ok / 0 bad，exit 0**。断言覆盖 S1（不再抛错）/ S2（必须报响）/ S3（死代码不参与执行）/ S4（2b 未被破坏）。

### 4.3 其它
- `node --check dsh-plugin/shell-executor.mjs`：exit 0。
- 源↔部署 sha256：`93A04ECBA43C15A5…` 双侧一致（用户执行）。
- `docs/dsh2-fix2-selftest.mjs`（2b 负路径 + 变异体）：**17 ok / 0 bad**。

### 4.4 `[未实测]`（如实标注）
- **装机级回归门**：`autotest.cmd --skip-audit` **未在本轮沙箱内跑通**。
  原因 `[实测]`：运行器要写 `.t\run-selftest.txt` ⇒ `EPERM: operation not permitted`
  （本会话 shell 只有暂存树可写；`.t`/`docs`/`src`/`dsh-plugin` 的 `Set-Content` 全部 `UnauthorizedAccessException`）。
  ⇒ **需用户在普通终端跑**：期望 `14 套件 / 646 ok / 0 bad / exit 0`。
- 第 2 节的 ③「报错逸出」未定因。

---

## 5. 给装配层的建议（**正解在这里，不在执行器内部**）

要真正做到"关掉沙箱 = 完全回到原生 shell 行为"，必须让**两个 `ctx.shell` 提供方按开关择一装载**，
而不是让 WinStage 永远占着名字再自己想办法退让。可选做法（需评估，本轮未实施）：

1. **profile 层按档位切 `disabled`**：档位为 `workspace-write` 时 `winstage-shell.disabled=false`，
   其余档位 `=true`（让 `pwsh-sandbox`/平台执行器接管）。代价：改档位需重启或热重载。
2. **让 WinStage 不注册 `shell` 服务名**，改为**包装**已有提供方（即平台先注册，WinStage 再取用）——
   若 DSH 支持"装饰/包装已有服务"，这是最干净的；**需先确认 Cordis 是否提供该能力**（`[未实测]`）。
3. 维持现状（本轮交付）：**不失效 + 不放大 + 不静默**，但"档位不匹配时不是真原生执行"。

**建议**：把本报告 §2 的三条报错作为约束条件，交给装配层评估；不要再次尝试 `new` 平台执行器。

---

## 6. 本轮同时确认的环境事实（对后续所有验证都有影响）

| 事实 | 证据 |
|---|---|
| shell 只有**暂存树**可写 | `Set-Content` 到 `.t`/`docs`/`src`/`dsh-plugin` 全部 `UnauthorizedAccessException` |
| `.t` 的 DACL 只授两个受限 SID 写权（`S-1-4-56185984-…`、`S-1-4-1039366120-…`），本会话 runner SID 不在内 | `Get-Acl` 逐条 |
| **管道接外部程序会失败** | `node … \| Out-String` ⇒ `Program 'node.exe' failed to run: Access is denied`；`node …` 裸调用 **成功** |
| `cmd.exe` / `whoami` 不可用 | `Program 'cmd.exe' failed to run: Access is denied`；`whoami` exit=1 且无输出 |
| ⇒ 回归门与任何写 `.t` 的套件**必须在沙箱外跑** | `autotest.mjs` 实测 `EPERM` 于 `.t\run-selftest.txt` |
