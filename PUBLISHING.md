# 发布与安装（GitHub / npm / dsh-plugin.org）

本仓现在是一份**可发布的 DSH 插件包**：根目录 `package.json` 是包清单（`name: dsh-winstage-sandbox`），
`exports` 指向 `dsh-plugin/*`，`dsh.bundle.patch` 指向 `dsh-plugin/cordis.patch.yml`。

> ⚠ 本轮把包名从开发占位符 `@local/dsh-winstage-sandbox` 改成 **`dsh-winstage-sandbox`**
> （`package.json`、`dsh-plugin/cordis.patch.yml` 的三条 `name:`、`client.js` 的 id 同步改名）。
> 因此**开发机的 profile 若仍 link `@local/dsh-winstage-sandbox`，必须同步改名并重装**，
> 否则 bundle 的 `name:` 断言匹配不到、整行（含 config）会被静默跳过。

## 1. 发布到 GitHub（dsh-plugin.org 靠它自动收录）

`dsh-plugin.org` 的收录机制（官网 Submit 页原话）：**把插件发布成公开 GitHub 仓库，并打上
`dsh-plugin` topic**；站点定期扫描该 topic 自动收录、社区再审核分类。不需要在站点手工提交。

```bash
# 仓库已初始化；创建远程并推送（gh 已登录）
gh repo create gygygfg/dsh-winstage-sandbox --public --source=. --remote=origin \
  --description "DSH plugin: Windows staging–candidate–selective-commit sandbox" --push

# 打 topic（收录的关键）
gh repo edit gygygfg/dsh-winstage-sandbox --add-topic dsh-plugin
```

## 2. 发布到 npm（让 `dsh plugin add dsh-winstage-sandbox` 直接可用）

npm 需要**你的账号 token**（本机未登录，`npm whoami` 报 ENEEDAUTH；且当前 registry 是
`registry.npmmirror.com`，它不接受发布）：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

（若用 scope，如 `@your-scope/dsh-winstage-sandbox`，则把根 `package.json` 的 `name`
与 `dsh-plugin/cordis.patch.yml` 的三条 `name:` 一起改成该 scope 名再发布。）

> 没有 npm 也不影响安装：DSH 的 `dsh plugin add` 转发 pnpm，**可直接从 Git 安装**：
> ```bash
> dsh plugin --profile web add github:gygygfg/dsh-winstage-sandbox
> ```

## 3. 用户在 dsh-plugin.org 上"一键安装"

收录后，站点给出的安装命令形如 `dsh plugin --profile web add <package>`。两种都可用：

- npm 已发布：`dsh plugin --profile web add dsh-winstage-sandbox`
- 仅 GitHub：`dsh plugin --profile web add github:gygygfg/dsh-winstage-sandbox`

## 4. 安装后的前置与配置（必须读）

- **环境监测（fail-closed）**：插件启动时会检查 `platform==='win32'` 且本会话能建立受限令牌；
  不通过则**拒绝启动**。显式逃生口：设置里 `probeOnStart:false` 或环境变量 `WINSTAGE_SKIP_ENV_GATE=1`。
  详见 `docs/插件启动-环境监测与开关保证.md`。
- **workspaceRoot**：`dsh-plugin/cordis.patch.yml` 里的默认值是开发机占位符
  （`C:\Users\Administrator\Desktop\dsh-winstage-sandbox`）。**首次安装后请在设置里把它改成你的工作区**，
  或在 profile 覆盖层重述（`winstage-fs` 行要同时重述 `cwd` 与 `workspaceRoot`，二者必须一致）。
- **shim 二进制**：发行包只带 shim 的 **C 源码**（`shim/src` 等），不含构建产物
  （`shim/out/*.dll`）。需要透明模式时在本机执行 `node tools/build-shim.mjs`（需
  `node tools/fetch-toolchain.mjs` 取得 zig）。未构建时插件退化为受限令牌档。
- **开关关闭时**：文件面立即退回平台 `SandboxedFileSystem`；命令面按 profile 开关在**装配期**交还
  平台 `pwsh-sandbox`（运行中切换需重启宿主）。见 `docs/插件启动-环境监测与开关保证.md` §2。

## 5. 版本与校验

```bash
npm pack --dry-run        # 先看将随包发布哪些文件（对照 package.json 的 files 白名单）
npm publish --access public
```
