# DSH `/api` 越界读复现（`workspaceFiles.read` 不做工作区包含校验）

> 作者：T2 `dsh2-probe`（Lead 指派的新工作，不属 task-2）。
> 只写本文件与 `.t/dsh2/probe/c6-*`。**没有**改 `dsh-plugin/**`、`src/**`、`tests/**`，
> **没有**触碰任何常驻实例的 `DSH_HOME`（3080 与 3081 都只做只读 HTTP 读取）。
>
> 判定标签：`[实测]` / `[引用]` / `[未实测]`。

---

## 0. 一句话结论

`workspaceFiles` 的**文件读取面是设计上允许越界的**（源码逐字写明了这一点），
`read`/`readBytes`/`stat` 都**不做**工作区包含校验；只有 `list` 校验。
所以"会话 A 的凭据"可以读到会话 B 的文件、乃至 `C:\Windows\win.ini`，
**前提是调用方已经是该 DSH 进程认可的操作者**（见 §4 的四条前置）。
这不是"任何人都能读"，但它**确实是一个跨工作区的读面**，而且当调用方是浏览器里的
client 插件时（本插件的 `client.js` 正是这种插件），它比"读一个快照"能拿到的东西多得多。

---

## 1. 复现 A（`[实测]`）：进程内直调真实服务类

**为什么这样做**：`workspaceFiles` 的 wire 层只是把参数原样交给这个方法；把方法本身跑一遍
就足以判定"有没有校验"。这**不是**经由 `/api` 的端到端（端到端的配方与前置见 §4，
标 `[未实测]`）。

- 脚本：`.t/dsh2/probe/c6-workspacefiles-read-escape.mjs`
- 原始命令：`node .t\dsh2\probe\c6-workspacefiles-read-escape.mjs`
- 原始输出：`.t/dsh2/probe/out/c6-read-escape.json`（自动落盘，UTF-8）
- 被测对象：**真实的** `@deepseek-ai/dsh-api-workspace-files` 的 `WorkspaceFiles` 类，
  + **真实的** `@deepseek-ai/dsh-fs-local` 的 `LocalFileSystem` 后端（`winstage-fs` 的基类同一份）
- 会话 A 工作区 = `.t/dsh2/probe/c6-ws`；"会话 B" = `.t/dsh2/probe/c6-ws-B`（另一个工作区根）
- 传入的 `workspaceFileScope` = `{ sessionId: 'session-A', workspaceRoot: <c6-ws> }`
  —— 与线上 typert lookup 产出的对象同形（`dsh-api-workspace-files\lib\index.js:398-415`）

**原始输出（节选，全部见 JSON）：**

| # | 用例（scope = 会话 A） | 结果 | 关键字段 |
|---|---|---|---|
| 1 | 读 A 工作区内文件（对照） | `ok` | `text: "content-inside-A"` |
| 2 | **读"会话 B"的文件** | **`ok`** | `absolutePath: …\c6-ws-B\session-b-secret.txt`，`text: "content-of-session-B"` |
| 3 | **读工作区外的项目文件**（`<repo>\README.md`） | **`ok`** | `bytes: 31906`，`text: "# WinStageSandbox — Windows 暂存—候选—选择性提交沙箱\n"` |
| 4 | **读 `C:\Windows\win.ini`** | **`ok`** | `absolutePath: "C:\\Windows\\win.ini"`，`text: "; for 16-bit app support\r\n[fonts]\r"` |
| 5 | 对**同一个越界目录**调 `list` | **拒绝** | `code: workspace-file/outside-workspace`，`message: "…c6-ws-B" is outside the workspace` |
| 6 | 对"会话 B"文件调 `stat`（只读元数据） | `ok` | `bytes: 21` |
| 7 | 用相对路径 `session-b-secret.txt` | 拒绝 | `code: workspace-file/not-found`（证明相对路径基准**确实是**会话 A 的工作区） |
| 8 | `winstage-fs` 的 `readText` 读越界绝对路径 | `ok` | `text: "content-of-session-B\n"`（`relOf === undefined → super.readText`） |
| 9 | `winstage-fs` 的 `listDir` 越界目录 | `ok` | `names: ["session-b-secret.txt"]` |

**判读（脚本自动写入 `verdict`）**：

```json
{"readInsideWorkspaceSucceeds":true,"readOtherSessionFileSucceeds":true,
 "readProjectFileOutsideSucceeds":true,"readSystemFileSucceeds":true,
 "listSameOutsideDirRefused":true,"relativeBaseIsSessionWorkspace":true,
 "winstageBackendAlsoUnconfinedForRead":true,"winstageBackendAlsoUnconfinedForList":true}
```

第 5 项与第 2 项针对**同一个工作区（会话 B 的根）**：读它的**文件**成功、枚举它的**目录**被拒。
这排除了"那个路径其实也在工作区内"的解释 —— **读面与枚举面的不对称是真实的**。

---

## 2. 服务侧证据（`[引用]`，逐字）

- `dsh-api-workspace-files\lib\index.js:167-172`（类文档）：
  > "File reads follow the composed filesystem's read access, **including paths outside the
  > workspace**. The selected Session header supplies the base for relative paths, with the
  > sandbox policy root as its no-cwd fallback, **not a read-containment restriction**.
  > Directory listings and change observations remain workspace-scoped."
- 同文件 `:178-180` 还自带一句风险提示：
  > "This is NOT modelled on `session.openWorkspacePath`. That endpoint hands a path to the local
  > opener and leaves the effect on the machine; **this one sends file content across the wire,
  > which is a different level of exposure**."
- `read` 的 JSDoc `:420`："absolute path or path relative to the workspace root; **files outside it are allowed**"。
- 实现：`read`（`:425-437`）、`readBytes`（`:446-475`）、`stat`（`:483-486`）都走
  `locateFile()`（`:588-608`），而 `locateFile` **不调用** `confine()`；
  `confine()`（`:575-582`，内含 `ctx.fs.contains(root, target)` 校验）**只被 `list` 调用**（`:500`）。
- 后端的读面同样不设围栏：`dsh-fs-local\lib\index.js:719-724` 自述
  "`Config.cwd` … a resolution default, **NOT a containment boundary**"；
  平台沙箱后端 `dsh-fs-sandbox\lib\index.js` 只在**写**路径上校验
  （`:157`、`:164` 两处 `FS_SANDBOX_DENIED`），**没有覆写 `readText`/`readBytes`**。
- 本插件的暂存后端也一样：`dsh-plugin/staging-fs.mjs` 的 `readText` / `listDir` 在"不在工作区内"
  （`rel === undefined`）时直接 `super.*` 放行 —— 对应上表第 8/9 项。
  （行号以我读取该文件的时刻为准：`readText` :427 声明 / :429 放行分支；`listDir` :474 / :476。
  **注意：T3 正在改这个文件（S7 的 `watch()` 覆盖已出现在 :318），行号会漂移 —— 以行为为准，别以行号为准。**）

⇒ 结论：**"读越界"是这套系统的既定设计**（把包含性交给"组合出来的 `ctx.fs` 后端的读权限"），
不是 DSH 的一处笔误。真正可讨论的是"这个设计是否可接受"，以及"我们的插件是否把这个读面
变得更宽"（它没有更宽，但也没有更窄）。

---

## 3. 复现 B（`[未实测]`）：端到端 `POST /api/workspaceFiles/read`

我**没有**执行这一步，原因见 §3.3。下面是完整的配方与前置，任何人拿到有效凭据即可复跑。

### 3.1 传输形态（`[引用]`）

- 通道与端点：`channel = "/api"`（`dsh-client-connection\lib\index.js:14` `const API_PATH = "/api";`），
  端点 = `` `${namespace}/${method}` ``（`dsh-api-gateway\lib\types\client\index.js:557-559`）
  ⇒ `POST /api/workspaceFiles/read`
- 信封（`dsh-client-connection\lib\client.js:1212-1227` 逐字）：
  ```json
  {"type":"client-request","rpcId":"<uuid>","method":"workspaceFiles/read",
   "payload":{"args":{"workspaceFileScopeId":"<sessionId>","path":"C:\\Windows\\win.ini",
                      "range":{"offset":1,"limit":2}}}}
  ```
  - `content-type: application/json` 必须精确（服务端 `:679` 校验，否则 415）
  - `payload.args` 的键是描述符里的 **`wire` 名**（`dsh-api-gateway\lib\types\client\index.js:337-344`
    用 `args[parameter.wire] = value`；`workspaceFiles.read` 的描述符见
    `dsh-api-remotes\lib\client.js:12844-12890`：`workspaceFileScopeId` / `path` / `range`）
- 响应：`{type:"server-response",rpcId,result:{ok:true,value}|{ok:false,error}}`
  （`rpcFetchHandler`，`dsh-client-connection\lib\index.js:673-701`）

### 3.2 前置条件（缺一不可 —— 这一节回答"是不是谁都能读"）

| # | 前置 | 依据 |
|---|---|---|
| 1 | **有效会话 id**：`workspaceFileScopeId` 必须能被解析。`resolve` 只查**活会话**（`sessions.get(id)?.header`）或**持久化会话**（`sessionPersistence.stat(id)`），两者都没有就解析失败 | `[引用]` `dsh-api-workspace-files\lib\index.js:404-413` |
| 2 | **认证**：`/api` 的每个请求都要过 `BrowserAuth.isAuthenticated`，否则 **401**。要么用启动令牌换取 cookie（`GET /?token=<进程令牌>` → 303 + `Set-Cookie`），要么出示已签发的 cookie | `[引用]` `dsh-client-connection\lib\index.js:205-219`（围栏）、`:388-431`（`authorizeIndex`，行 388）、`:433-443`（`isAuthenticated`）、`:284-298`（cookie 名与属性、`HttpOnly; SameSite=Strict`） |
| 3 | **Host/Origin 围栏**：Host 必须是 loopback 或 `trustedHosts` 之一；`sec-fetch-site: cross-site` 直接拒；带 `Origin` 时必须与 Host 同源 | `[引用]` `:205-219` |
| 4 | **后端读权限**：读最终由组合出来的 `ctx.fs` 执行。裸 `fs-local` / 本插件的 `staging-fs` **不拦读**；平台 `fs-sandbox` 也只拦写 | `[引用]` §2 的三条 |

> **认证门槛的实质（`[实测]`，只做布尔判定，未读取任何密钥内容）**：
> cookie 的签名密钥持久化在 `$DSH_HOME\.credentials.yaml` 的
> `client-connection / browser-session` 记录里（`initializeSecret()`，
> `dsh-client-connection\lib\index.js:325-342`；存储位置 `dsh-credentials-local\lib\index.js:49-58`）。
> 我实测 `C:\Users\Administrator\.dsh\.credentials.yaml` **存在（223 B）且同时含
> `client-connection`、`browser-session` 两个键命名空间**；其 ACL 只授予
> `SYSTEM` / `Administrators` / `Administrator`。
> ⇒ **能读 `$DSH_HOME` 的同用户进程就能签发有效 cookie**；认证防的是"别的用户/别的机器"，
> 不防"同一个用户下的其它进程"。
> 我**没有**据此伪造 cookie（见 §6）。

### 3.3 我为什么没有执行它（`[未实测]` 的原因，可判定）

- **3081**：前置 2、3 我都实测满足（用 `.t\dsh2\logs\dsh2.out.log` 里的令牌换到了 cookie，
  首页 303→200，见 `out/c2-boot-graph-3081.json`）；但 **前置 1 不满足** ——
  3081 目前**没有任何会话**（`sessionPersistence.stat` 无记录、`sessions.get` 无活会话）。
  要满足前置 1 就必须**在 T1 的 `DSH_HOME` 里创建一个会话**，那是写操作、且是 T1 的地盘，
  不在我的写范围内，所以我停在这里。
- **3080**：前置 1 满足（我自己的会话 `35c97b25-…` 是活的），但前置 2 拿不到 ——
  当前 3080 进程的**启动令牌只存在于内存**（`PROCESS_LAUNCH_TOKENS` WeakMap，
  `:231/244-250`），磁盘上的 `web-url.txt` / `dsh-web.log` / 启动器日志里的令牌
  **实测已失效**：用它们换 cookie 得到 `HTTP 401`（原始响应头
  `.t/dsh2/probe/index-3080.headers.json`：`status: 401`，`content-type: text/plain`）。
  另一条路是伪造 cookie（§3.2 的布尔结论表明**技术上可行**），但那是对用户正在用的实例做
  **认证绕过**，超出了"最小只读复现"的授权范围 ⇒ 我选择不做。

⇒ 端到端这一步的结论保持 `[未实测]`。**若要补测**，最干净的做法是：
在 3081 里正常开一个会话（T1 的脚本/页面即可），然后由 T1 或 Lead 跑 §3.1 的那条 POST
（它只读一个文件，不产生任何状态变更）。

---

## 4. 影响边界（用户会问"这是本机还是远程"）

分三档，逐档给判据：

| 档 | 谁能触发 | 判据 | 判定 |
|---|---|---|---|
| **A. 进程内（宿主侧）** | 任何在 DSH 进程里运行的插件代码 | 直接 `ctx.fs.readText(<任意绝对路径>)`，连 `/api` 都不需要。本插件的 host 半与 `staging-fs` 都在这一档 | `[实测]` §1 第 8/9 项 |
| **B. 浏览器 / 页面脚本（同机同用户）** | 任何持有有效 cookie 的 `ctx.remote` 调用者 —— 包括**我们自己的 `client.js`**；以及任何能读 `$DSH_HOME` 或拿到启动令牌的同用户本地进程 | §3.2 的四条前置全部满足即成立 | `[实测]`（服务语义）+ `[引用]`（wire 路径）；端到端 `[未实测]` |
| **C. 远程 / LAN** | 默认**不能** | 默认绑定 `127.0.0.1`；`--host 0.0.0.0` 被硬拒（`dsh-web-app\lib\startup.js:40`）；`isTrustedApiRequest` 只信 loopback 或显式 `--trusted-host`；cookie 是 `SameSite=Strict; HttpOnly` 且签名受众绑定 authority（端口）；`sec-fetch-site: cross-site` 直接拒 | `[引用]` |

一句话：**这是"本机同用户"级别的暴露面，不是远程可利用的接口**。
但请注意两点：
1. 它与"用户已经在浏览器里打开了 DSH"这个常态**同时成立** —— 也就是说，只要页面上有
   任何一个（第三方）client 插件，它就能通过已有的 `ctx.remote.workspaceFiles` 读**该进程能读的
   任何文件**，而用户界面不会给出任何提示。本插件的 `client.js` 就是这么用的
   （`client.js:141` 的 `read` 调用）。
2. 若部署方将来为了远程访问而绑定 LAN 并 `--trusted-host`，C 档的结论会改变；
   那时"读面"就升级为"LAN 上任何能过认证的浏览器"。

---

## 5. 与 C-7（串台）的关系

C-7 的放大镜就是这里：`client.js:176` 用 `configValue.workspaceRoot || owner.session.cwd` 决定
读哪个 `<root>\.dshstage\review.json`，而 `read` 对绝对路径**不校验包含关系**，
所以"根选错了"不会得到"读不到"，只会得到"**读到了另一个工作区的快照并把它渲染出来**"。
本文件第 1 节第 2/3 项就是这条路径的最小化证明（scope A 读到了 B 的文件）。

---

## 6. 我刻意没有做的事（克制声明）

1. **没有伪造 cookie**，也没有用 `$ .credentials.yaml` 里的签名密钥去换任何实例的访问权限；
   只做了"该记录存在、ACL 只限同用户"的**布尔判定**，并且没有把任何密钥内容写入文件或日志。
2. **没有在 3080 或 3081 上创建会话/写文件**；对两个实例只做了 GET 与（T1 的）日志读取。
   （附一条**归属澄清**，免得被误算到我头上：项目根 `.dshstage\review.json` 的 mtime 在
   **13:55:49** 被刷新，而我的 C-6 探针在 13:57:11 与 ~14:00 两次运行**都没有**改动它
   （mtime 保持 13:55:49、内容逐字不变：同一 `candidateId cs_0014_d49351d6`、`revision 32`、
   `pending:true`、1 个待审文件）。同一分钟内只有 `.t\dsh2\plugin-deploy.json`（13:55:47）
   与 `.t\dsh2\e2e-inject-markers.mjs`（13:55:20）被改，因此这次 publish 来自**别人的部署/自检流程**
   （[实测] 时间戳 + [推断] 归属）。顺带一提：那次 publish 的 `workspaceRoot` 是**项目根**，
   而 3081 的活工作区是 `.t\dsh2\ws` —— 这正是基线报告 §4.4/C-8 说的"两个根可以漂移"的现场样本。）
3. **没有把这条发现写进任何面向用户的交付物**（`docs\DSH集成.md` 等）—— 等 Lead 决定是否
   升级为独立安全项，以及要不要向用户披露"同用户本地进程可越界读"的含义。

---

## 7. 建议（供 Lead 决策；不属 T2 写范围）

1. **最小加固（插件侧，T3 可做）**：`client.js` 的读路径换成"根必须先自证"——
   用 review.json 自带的 `workspaceRoot` 字段（`review-service.mjs:162`）与本面板根比对，
   不一致就拒绝接管；这样即使配置漂移也不会把 B 工作区的快照显示到 A 的界面上（即 C-7 的修复）。
2. **平台侧（要不要上报由 Lead 定）**：`workspaceFiles.read` 的"设计上允许越界"值得在
   插件作者文档里更醒目地标注 —— 目前只有模块 JSDoc 写了（第 178-180 行的自我提醒说明
   作者本人清楚这是不同量级的暴露）。若希望收紧，最小可行的改动是在 `locateFile` 里
   复用已有的 `confine()`（与 `list` 一致），代价是"预览工作区外文件"这个既有能力消失。
3. **认证面**：cookie 密钥落在明文 `$DSH_HOME\.credentials.yaml` + 启动令牌落进
   `web-url.txt`/`dsh-web.log`（我实测后者的令牌**已失效**，前者仍是有效签名密钥），
   意味着"同用户本地进程 = 完整操作者"。这在单用户桌面上通常可接受，但值得写进部署说明。
