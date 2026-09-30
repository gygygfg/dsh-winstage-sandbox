/**
 * loader 行入口：`winstage-fs`。
 *
 * 为什么单独一个模块：`cordis.patch.yml` 的行需要一个**默认导出即可装配**的插件，
 * 而 `staging-fs.mjs` 还需要被自测直接 `import`（自测要自己构造实例、自己给日志）。
 * 入口只做"按环境选择策略 + 交给装配器"这一件事。
 *
 * ── 一个提供方，两种面（修复：关掉开关必须退回原来的审批模式）────────────────
 * 本行的基类就是平台自带的 `@deepseek-ai/dsh-fs-sandbox` 的 `SandboxedFileSystem`：
 *   - 开关**开**：`staging-fs.mjs` 的覆盖层生效 —— `write`/`edit` 落暂存树，读取走投影，
 *     等工作区/面板批准；`stageOutside` 默认 `'stage'`，工作区外的写入同样进暂存；
 *   - 开关**关**：每个覆盖层直接 `super.*` ⇒ **整体退回平台面**：按会话策略围栏、
 *     `FS_SANDBOX_DENIED`、同回合升权提示、`sandboxMode` 广告，与"没有装本插件"一致。
 *
 * 开关的读法是 `stagingEnabled()`（现读 host 行 `config.enabled`），因此**不需要卸载
 * 或重挂任何 loader 行**；`fs` 服务名在运行中始终只有一个提供方（行级热切换会崩的
 * 原因见 `staging-fs.mjs` 顶部说明）。
 *
 * 只有显式设置 `WINSTAGE_STAGE_OUTSIDE=direct` 才在开关**开**时直通真实磁盘
 * （逃生口，默认关闭）。任何其它值（含历史上的 `'deny'`）都归一为 `'stage'`。
 */

import { createStagingFileSystem, SandboxedFileSystem } from './staging-fs.mjs'

if (!SandboxedFileSystem) {
  // fail-closed：关掉开关时必须能退回平台的沙箱后端（审批模式）。定位不到它，
  // 要么停在暂存面、要么退化成"没有围栏的本地写"，两者都不能接受。
  throw new Error(
    'WinStage 暂存文件系统：无法定位 @deepseek-ai/dsh-fs-sandbox。' +
      '关闭开关要退回平台沙箱（审批）面，因此这里 fail-closed。' +
      '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。',
  )
}

const StagingFileSystem = createStagingFileSystem({
  stageOutside: process.env.WINSTAGE_STAGE_OUTSIDE === 'direct' ? 'direct' : 'stage',
  base: SandboxedFileSystem,
})

export default StagingFileSystem
export { StagingFileSystem }
