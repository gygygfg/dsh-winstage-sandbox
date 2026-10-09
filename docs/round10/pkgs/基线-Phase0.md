# 域二基线（Phase 0 · 宿主未受限侧 · 采集于沙箱加载之前）

> 采集线程：`pkgs`（teammate）· 宿主会话 `DSH_SESSION_ID=ed8a89e9-a037-4bb4-a040-439593cf499a`、
> `DSH_PROFILE=web`、`DSH_SHELL=1`、**`WINSTAGE_SHELL=0`（本线程明确未加载 WinStage 沙箱）**
> 采集时刻（UTC）：2026-10-08T14:03Z 起
> 用途：1) 给 Phase 1 沙箱线程提供"装前/装后 + 宿主零残留"的对照基线；2) 固定"镜像尚未配置"这一事实。

---

## 1. 工具链版本（原始命令 + 输出）

```
$ node -v      → v24.21.0
$ npm -v       → 12.2.0
$ pnpm -v      → 10.34.5
$ uv --version → uv 0.12.19 (bea138450 2026-09-24 x86_64-pc-windows-msvc)
```

`Get-Command` 解析：

| 名字 | 实际路径 |
|---|---|
| `node` | `C:\Program Files\nodejs\node.exe` |
| `npm` | `C:\Program Files\nodejs\npm.ps1` |
| `pnpm` | `C:\Users\Administrator\AppData\Roaming\npm\pnpm.ps1` |
| `uv` | `C:\Users\Administrator\.local\bin\uv.exe` |
| `python` | `C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe` ← **WindowsApps stub** |
| `python3` | `…\WindowsApps\python3.exe` ← **stub** |
| `py` / `pip` / `pip3` | **`<none>`（不存在）** |

原始输出：`.t\round10\pkgs\baseline-pkgs-raw.txt`

> ⚠ 上一轮报告 §3.4 第 6 条说 WindowsApps `python.exe` 退出码 `9009`、stdout/stderr 全空。
> 本轮 Phase 0 只做了**存在性**核对（未重复运行 stub），该行为标 **not-rechecked**。

---

## 2. npm 侧现状：**用户级镜像已配、无项目级覆盖**

`npm config list`（原始输出见 `baseline-pkgs-raw.txt`）：

```
; "builtin" config from C:\Users\Administrator\AppData\Roaming\npm\node_modules\npm\npmrc
prefix = "C:\\Users\\Administrator\\AppData\\Roaming\\npm"

; "user" config from C:\Users\Administrator\.npmrc
registry = "https://registry.npmmirror.com"

; node bin location = C:\Program Files\nodejs\node.exe
; npm version = 12.2.0
; npm local prefix = C:\Users\Administrator\Desktop\dsh-winstage-sandbox
```

| 项 | 值 | 结论 |
|---|---|---|
| `npm root -g` | `C:\Users\Administrator\AppData\Roaming\npm\node_modules` | **全局安装目标 = 工作区外**（隔离判定用） |
| `npm prefix -g` | `C:\Users\Administrator\AppData\Roaming\npm` | 同上 |
| `npm config get cache` | `C:\Users\Administrator\AppData\Local\npm-cache` | 缓存也在工作区外 ⇒ 沙箱内 npm 若不能改 cache，会走这里 |
| 用户级 `.npmrc` | `C:\Users\Administrator\.npmrc`，40 B，`registry=https://registry.npmmirror.com` | **保留原始字节**：`C:\...\.npmrc` 内容与文件大小已在 §7 证据表登记 |
| `%APPDATA%\npm\etc\npmrc`（全局级） | **不存在** | 无全局级覆盖 |
| `C:\Program Files\nodejs\node_modules\npm\npmrc`（builtin） | 23 B，`prefix=${APPDATA}\npm` | 只定 prefix，不含 registry |
| 项目级 `.npmrc` | 工作区根 **无** `.npmrc`（Phase 1 需在沙箱内复验） | — |

镜像可达性（宿主侧 HEAD，**仅证明宿主可连，不等于沙箱线程生效**）：

```
HEAD https://registry.npmmirror.com/left-pad                      → 200  len=23356
HEAD https://pypi.tuna.tsinghua.edu.cn/simple/six/                → 200  len=11565
HEAD https://registry.npmmirror.com/-/binary/python-build-standalone/ → 200  len=30867
```

---

## 3. pip 侧现状：**镜像尚未配置（`exists: False`），且 `pip` 命令不存在**

环境变量探测（宿主）：`PIP_INDEX_URL=`（空）、`PIP_CONFIG_FILE=`（空）、
`UV_PYTHON_INSTALL_MIRROR=`（空）、`UV_CACHE_DIR=`（空）—— **全部未设置**。

`pip config debug`（用 uv 装的 CPython 3.12.14 运行；原始输出 `host-pip-config-debug.txt`）：

```
env_var:
env:
global:
  C:\ProgramData\pip\pip.ini, exists: False
site:
  C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\pip.ini, exists: False
user:
  C:\Users\Administrator\pip\pip.ini, exists: False
  C:\Users\Administrator\AppData\Roaming\pip\pip.ini, exists: False
```

**⇒ 五个候选配置文件全部不存在，环境变量为空：pip 当前走的是官方默认 `https://pypi.org/simple`。**
这正是 task-3 要求"把 pip 镜像真正配置到全局"的缺口。

其他 pip 相关事实：

| 项 | 值 | 证据 |
|---|---|---|
| `pip cache dir` | `c:\users\administrator\appdata\local\pip\cache`，**该目录不存在** | `host-pip-cache-dir.txt` + `Test-Path`=False |
| `C:\ProgramData\pip` | 不存在 | 原始输出 |
| `%APPDATA%\pip`、`%APPDATA%\Python` | **均不存在** | 见 §4 digest（`exists:false`） |
| `uv` 全局配置 `%APPDATA%\uv\uv.toml` / `~\.config\uv\uv.toml` | **均不存在** | 原始输出 |

---

## 4. 已存在的真 Python（上一轮 uv 装的，可复用；也算"装前基线"）

```
C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe
Python 3.12.14 (main, Sep 24 2026, 17:57:31) [MSC v.1944 64 bit (AMD64)]
sys.prefix  = C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none
purelib     = …\cpython-3.12-windows-x86_64-none\Lib\site-packages
ensurepip 存在 = True
pip 26.2.1 from …\Lib\site-packages\pip (python 3.12)
```

- `uv python list` 显示该版本**已安装**（其余 19 个为 `<download available>`）。
- `site-packages` 里目前**只有** `pip`、`pip-26.2.1.dist-info`、`README.txt`。

> **Phase 1 备选**：此路径位于 `%APPDATA%`（工作区外）⇒ 在沙箱线程里**很可能不可写**。
> 若要在沙箱内真正 `pip install`，必须 `UV_PYTHON_INSTALL_DIR` / venv 指向**工作区内**；
> 或 `pip install --target <工作区>`。两条都要在 Phase 1 试，命中拒绝要如实记缺陷。

---

## 5. 隔离对照基线（Phase 1 结束时必须**逐项重算并比对**）

用 `.t\round10\pkgs\tree-digest.mjs`（工作区内脚本，递归 `relpath+size+sha256` 汇总 digest）：

| # | 目录 | exists | files | bytes | treeDigest | 基线文件 |
|---|---|---|---|---|---|---|
| B1 | `C:\Users\Administrator\AppData\Roaming\npm` | true | **29677** | 506,274,212 | `6b44fe66a199ab3d0610a2f45325bda784b9fa9eeaac7437d28040b824d57b78` | `baseline-npm-global.json` |
| B2 | `C:\Users\Administrator\AppData\Roaming\Python` | **false** | 0 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（空集） | `baseline-python-dirs.json` |
| B3 | `C:\Users\Administrator\AppData\Roaming\pip` | **false** | 0 | 0 | 同空集 | `baseline-python-dirs.json` |
| B4 | `C:\Users\Administrator\AppData\Roaming\uv\python` | true | 3412 | 64,535,942 | `9e5ace1b96861ca4920b333e7cc1074172299c768f6d57afd52fa9f13287356f` | `baseline-python-dirs.json` |
| B5 | `C:\Program Files\nodejs\node_modules` | true | 1981 | 13,133,523 | `2ed97a33d4fb23093cf09780e9ee7d8357f7307ce95da1e48d5cf426755edd30` | `baseline-more.json` |
| B6 | `…\uv\python\cpython-3.12.14-windows-x86_64-none\Lib\site-packages` | true | 884 | 10,710,959 | `e048b6c0f9daed1ccdca705cf7b323d681255abf91285fbae84653a0c880012a` | `baseline-more.json` |
| B7 | `C:\Users\Administrator\AppData\Local\pnpm` | true | 2 | 0 | `91b3afb4d829d5d3dcf0097ada3d38eabe30656236dd09043f1d9cf4a82dc997` | `baseline-pnpm-store.json` |
| B8 | `C:\Users\Administrator\AppData\Local\npm-cache` | true | 31339 | 1,058,555,004 | `cfd3c4195860817a7e32727bd280d292f5252c6a4ad5d007bf98148e62451ff5` | `baseline-npm-cache.json` |

> **B8 的口径注意（自我更正）**：B8 的 digest 是**宿主侧热身安装之后**算的 —— 见 §8，
> 我在 Phase 0 里跑了一次**宿主侧** `npm install`（方法预热），它确实向 `npm-cache` 写了东西。
> 因此 B8 **不是**纯净的"装前基线"，只应作为**方法预热后的时点快照**使用；
> Phase 1 的"宿主零残留"判定以 **B1（全局 npm root）** 与 **B2/B3（Python/pip 目录不存在）** 为主，
> B8 只用于"缓存有无被沙箱线程越界写入"的弱对照（且沙箱缓存理应指到工作区内）。
> B1/B2/B3/B4/B5/B6/B7 均在热身**之前或未受影响**（B1 是全局 npm root，`npm install` 非 `-g` 不写它）。

> B1 的 29,677 文件 / 506 MB 是**全局 npm root 当前真实内容**（`@deepseek-ai`、`npm`、`pnpm` 三个包 +
> `dsh/npm/npx/pnpm/pnpx` 的 cmd/sh/ps1 垫片）——即"宿主上确实存在全局 npm 安装面"，所以
> Phase 1 的 `npm install -g` 拒绝判定是**写真实已存在的目录被拒**，不是"目录不存在所以失败"。
> 该目录必须在 Phase 1 结束后 digest 不变，才能说"零残留"。

---

## 6. 线程隔离与宿主守护（铁律校验）

| 项 | 值 | 说明 |
|---|---|---|
| `WINSTAGE_SHELL` | **`0`** | 本线程强制关沙箱；Phase 1 必须在 `WINSTAGE_SHELL=1` 的新 `dsh web --port 3091` 线程里做 |
| `DSH_SHELL` | `1` | DSH shell 服务在 |
| 3080 监听 | `TCP 127.0.0.1:3080 LISTENING PID 7812` | **未触碰、未 kill**；PID 7812 = DSH Web GUI |

---

## 7. 证据文件清单（Phase 0）

| 文件 | 内容 |
|---|---|
| `baseline-pkgs-raw.txt` | `Get-Command` / AppData 存在性 / `.npmrc` 原文 / uv 环境 / `uv python list` |
| `host-pip-config-debug.txt` | `pip config debug`（五候选全 False） |
| `host-pip-config-list.txt` | `pip config list`（空） |
| `host-pip-cache-dir.txt` | `pip cache dir` |
| `host-python-info.txt` | CPython 3.12.14 版本 / prefix / purelib / ensurepip |
| `baseline-npm-global.json`、`baseline-python-dirs.json`、`baseline-more.json`、`baseline-pnpm-store.json`、`baseline-npm-cache.json` | tree digest 基线（含逐文件行） |
| `tree-digest.mjs` | digest 计算脚本（工作区内，Phase 1 复用） |
| `PHASE1-配方.md` | 交给沙箱线程的操作配方 |

**未做（诚实标注）**：`not-run` — pip 镜像的实际配置与验证、任何安装、任何沙箱内测试（属 Phase 1）；
WindowsApps stub `python.exe` 的行为未重跑；`C:\Program Files` 全树 digest 未算（域三负责）；
PIP 侧未做任何安装热身（Phase 1 才做）。

---

## 8. 宿主侧方法预热（Phase 0 附加，**不是** task-3 的验收结论）

为了把 Phase 1 要用的探针脚本先跑通（并留出"宿主侧可控对照"），在**宿主未受限侧**做了一次最小
npm 安装演练。产物在 `evidence\host-rehearsal-phase0\`；**脚本已删除 `node_modules`，宿主不留依赖树**。

| 项 | 实测 | 证据 |
|---|---|---|
| 命令 | `npm install lodash@4.17.21 left-pad@1.3.0 --loglevel http --no-audit --no-fund` | `01-npm-install-http.log` |
| 退出码 / 耗时 | **exit=0 / 12,496 ms**（`added 2 packages in 11s`） | 同上 |
| 下载域名 | **只有 `registry.npmmirror.com` 与 `cdn.npmmirror.com`**；机器判定 `hasOfficialNpmjs=false`、`hasPypiOrg=false` | `machine-checks.txt` |
| lock `resolved` | `https://registry.npmmirror.com/lodash/-/lodash-4.17.21.tgz` / `…/left-pad-1.3.0.tgz` | `lock-integrity.txt` |
| 四段哈希链一致 | lock `integrity` ＝ registry `dist.integrity` ＝ cacache index `integrity` ＝ `content-v2` 内容重算 sha512（base64 与 hex 双口径，`ALL_FOUR_B64_IDENTICAL=true`、`hexChainOk=true`） | `npm-integrity.json`、`registry-integrity.json`、`machine-checks.txt` |
| `npm ls --json` | `problems` 为空（npm 12 无问题时**不输出该字段**；归一化后 `problemsIsEmpty=true`）、2 个依赖 | `npm-ls.json`、`machine-checks.txt` |
| 冒烟 | `lodash.chunk([1,2,3,4],2)=[[1,2],[3,4]]`、`leftPad("x",3)="  x"`、`lodash 4.17.21`、`left-pad 1.3.0` | `smoke.out.txt` |

**新增（本轮才查清）的工程事实**：
1. `npm` 的 packument 与 tarball **域名不同**：`registry.npmmirror.com`（元数据）
   → `cdn.npmmirror.com`（tarball）。cacache 的 key 用的是**实际下载 URL**，
   所以"用 lock 的 `resolved` 直接寻址 cacache"会 `ENOENT` —— 必须按 tarball basename + integrity 回退匹配
   （脚本已实现，`matchedByTarballBasenameFallback=true`）。
2. `npm ls --json` 在**无问题时不输出 `problems` 字段**；判 `problems=[]` 必须先做
   `ls.problems ?? []` 归一化，否则会把"没字段"误判成"有问题"。
3. 本次演练给 `%LOCALAPPDATA%\npm-cache` 增加了缓存内容 ⇒ 见 §5 对 B8 的口径更正。

