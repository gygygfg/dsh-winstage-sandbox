# `patches/dsh/pristine/` 原样副本的来源与许可（MIT 归属）

> **为什么有这份文件**：`pristine/` 下的 4 个文件是**上游 `@deepseek-ai/*` 编译产物的逐字节副本**
> （共 **99,660 B**）。上游四个包都是 **MIT** 许可（`[官方]`：逐个读各包 `package.json` 的
> `license` 字段），MIT 要求在再分发副本中**保留版权与许可声明** —— 此前 `pristine/` 只有
> `index.js`/`client.js`，没有随附许可，这一节把它补齐。
> 副本本身的完整性仍由 `tests/dsh-patch-guard.mjs` §2 守着（副本哈希 == 清单 `beforeSha256`、
> `before` 锚点恰好一处、派生 `after` 哈希 == `afterSha256`），本文件只负责**来源与许可归属**。

- harness 根（副本来源）：`C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`
  （`[实测]`：`node tools\dsh-patches.mjs --check` 命中 `known-npx-path`）。
- 复制方式：**只读复制**（`Copy-Item` / 读取后写入仓库）；**harness 根一字未写**（`[实测]`：harness 根下
  无任何 `*.dsh-patch-backup`，`node tools\dsh-patches.mjs --check` 报 4/4 未应用、锚点完好，
  见 `.t/patchcheck.txt`、`.t/v7-dshcheck.txt` 与本轮 `.t/seal-fix-verify.txt`）。
- 上游仓库：`git+https://github.com/deepseek-ai/deepseek-harness.git`，版本 **0.2.0-rc.2**（`[官方]`：各包 `package.json`）。

## 1. 逐文件来源

| 仓库内副本 | 字节 | sha256（`[实测]`：等于清单 `beforeSha256`） | 上游包 | 版本 | harness 根内原路径 | 许可 |
|---|---|---|---|---|---|---|
| `patches/dsh/pristine/P1-escalation-policy-denied/index.js` | 15210 | `b56373befbfcfe281c17c8892e9a4b2cdcb96851290b3ed0ff56b08915e2f743` | `@deepseek-ai/dsh-sandbox` | 0.2.0-rc.2 | `node_modules/@deepseek-ai/dsh-sandbox/lib/index.js` | MIT |
| `patches/dsh/pristine/P2-escalation-advertisement-gate/index.js` | 30425 | `1a49cd8de831423a4ae0a2c57a4674a64cec538f64ae603aaa2c388d78aec790` | `@deepseek-ai/dsh-tool-pwsh` | 0.2.0-rc.2 | `node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js` | MIT |
| `patches/dsh/pristine/P3-permission-custom-default/index.js` | 16503 | `4f23c620145098d611d04d8363bc6716f49b26930c9141a21dc9a8df2b72ba63` | `@deepseek-ai/dsh-permission-presets` | 0.2.0-rc.2 | `node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js` | MIT |
| `patches/dsh/pristine/P3-permission-custom-default/client.js` | 37522 | `7f89170dd32aff34961cc86d388eb8f800fbfdab87b88894c991d28ee0f92c4f` | `@deepseek-ai/dsh-client-ui-permission-presets` | 0.2.0-rc.2 | `node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js` | MIT |

四个文件级 entry 与副本的对应关系（`manifest.json` 的 4 条 `patches[]`）：`P1-escalation-policy-denied` /
`P2-escalation-advertisement-gate` / `P3-permission-custom-default`（host）/ `P3-permission-custom-default`（client），
逐条见 `patches/dsh/manifest.json` 的 `pristine` 字段。

## 2. 许可声明副本（`LICENSES/`）

| 仓库内许可副本 | 字节 | sha256 | 来源（harness 根内原路径） |
|---|---|---|---|
| `patches/dsh/pristine/LICENSES/dsh-sandbox.LICENSE` | 1065 | `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be` | `node_modules/@deepseek-ai/dsh-sandbox/LICENSE` |
| `patches/dsh/pristine/LICENSES/dsh-tool-pwsh.LICENSE` | 1065 | `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be` | `node_modules/@deepseek-ai/dsh-tool-pwsh/LICENSE` |
| `patches/dsh/pristine/LICENSES/dsh-permission-presets.LICENSE` | 1065 | `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be` | `node_modules/@deepseek-ai/dsh-permission-presets/LICENSE` |
| `patches/dsh/pristine/LICENSES/dsh-client-ui-permission-presets.LICENSE` | 1065 | `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be` | `node_modules/@deepseek-ai/dsh-client-ui-permission-presets/LICENSE` |

四个 `LICENSE` 的内容**逐字节相同**（`[实测]`：同一 sha256），抬头是 MIT License、
版权行 `Copyright (c) 2026 DeepSeek`；这里仍**按包各留一份**，好让"哪个副本来自哪个包"能一对一核对。
许可原文为上游 `LICENSE` 的**逐字节副本**，未做任何改写。

## 3. 维护

- 换到新的上游版本时：重新**只读**复制四个目标文件与对应 `LICENSE`（见 `../README.md` §"维护"），
  并同步本文件的字节数 / sha256 与版本号；`node tests\dsh-patch-guard.mjs` 应保持全绿。
- `patches/**` **不在** `docs/源码基线.sha256` 的收录面内（只收 `src/`、`tests/`、`dsh-plugin/`、`tools/` 与四个根入口），
  因此 `pristine/` 的静默漂移由 `tests/dsh-patch-guard.mjs` §2 兜住（`[实测]`：副本哈希与清单逐条相符，
  见 `.t/dpg-normal.txt` 与本轮 `.t/seal-fix-verify.txt` 里的 `dsh-patch-guard` 30/0）。
