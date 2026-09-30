/**
 * 包入口（thin shim）——真正的实现住在 `host-plugin.mjs`。
 *
 * 为什么入口是薄壳而不是实现本身：DSH 的 loader 按**模块 URL**缓存已导入的插件，
 * 改文件不会让运行中的进程重新执行 `apply()`（本 profile 启动时 `hmr.root` 为 `[]`，
 * 没有监听源码模块）。把实现放在另一个模块里、让 `exports` 指向它，就能在**不重启**
 * 的前提下让运行中的进程加载到新代码 —— 这是本插件开发期实测出来的迭代方式。
 *
 * 对使用者没有影响：入口导出与实现完全一致（`Config` / `name` / `inject` / `apply`）。
 */

export * from './host-plugin.mjs'
