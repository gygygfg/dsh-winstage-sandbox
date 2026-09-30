/**
 * 插件 Config Schema —— **零依赖**的自包含实现。
 *
 * ── 为什么不 import @deepseek-ai/schemastery（实测踩到的坑）────────────────────
 *   1. bundle 以 `link:` 方式装进 profile，但 Node 解析裸模块说明符时使用包的
 *      **realpath**（即本项目内的 `dsh-plugin/`），于是去找**本项目**的
 *      `node_modules` —— 那里没有它，直接 `ERR_MODULE_NOT_FOUND`。
 *   2. 声明成 dependency 也没用（同一条 realpath 规则），而且本机 `pnpm`
 *      最初不在 PATH 上，安装链路本身就不可靠。
 *
 * ── Host 到底要求什么？这条路踩了四次，每次都是读源码才定位 ────────────────────
 *   a) **Cordis 激活**（@deepseek-ai/cordis `resolveConfig`）：
 *          runtime.Config["~standard"].validate(config)
 *      缺少 `~standard` 会在激活阶段报
 *      `Cannot read properties of undefined (reading 'validate')`。
 *
 *   b) **原生 schema 身份**（@deepseek-ai/dsh-app-boot `config-schema/native.js`，
 *      逐字）：
 *          if (value === null || typeof value !== "object" && typeof value !== "function") return false
 *          const meta = Reflect.get(value, "meta")
 *          return Reflect.get(value, Symbol.for("schemastery")) === true
 *              && typeof Reflect.get(value, "type") === "string"
 *              && meta !== null && typeof meta === "object"
 *      不满足时 `Config.listConfigs` 报 `status: 'unsupported'`，
 *      → `settings.describe()` 跳过该条目
 *      → 客户端 `configForms.get(ns)` 永远停在 `unavailable`
 *      → 界面上显示"Host 未提供该设置项"（实测就是这个症状）。
 *
 *   c) **字段必须标 volatile**（@deepseek-ai/dsh-settings `volatileForm`，逐字）：
 *          if (schema.meta.volatile) return plainSchema(schema)
 *          if (schema.type === "object") { ...递归子字段... }
 *          // 标量字段落到这里 → 返回 undefined
 *      标量字段缺少 `meta.volatile` 就返回 `undefined`，整个表单为空，
 *      命名空间同样不会被发布。
 *
 *   d) **设置页水合**：`settings.describe()` 与 `plainSchema()` 会用
 *      `new z(schema.toJSON())`，因此还需要 `toJSON()` 返回合法的
 *      schemastery 文档 `{ uid, refs }`。
 *
 * 所以下面的类同时提供**两套外观**，各自服务上面不同的读取方：
 *   - 原生外观（`type` / `meta` / `dict` / `Symbol.for('schemastery')`）→ (b)(c)
 *   - `~standard.validate` → (a)；`toJSON()` → (d)
 *
 * 这不是"重新实现 schemastery"，只是把框架**实际读取**的那几个属性摆在位。
 */

/** Standard Schema 接口键 */
const STANDARD_VERSION = '~standard'
/** schemastery 的品牌符号（`Symbol.for` 保证跨模块实例一致） */
const SCHEMASTER_BRAND = Symbol.for('schemastery')

/**
 * 一个字段节点：既满足原生身份检查（b），也携带 volatile 标记（c）。
 *
 * 为什么还必须有 `toJSON()`：`volatileForm` 对**标量字段**走的是
 * `if (schema.meta.volatile) return plainSchema(schema)`，而 `plainSchema` 第一行就是
 * `new z(schema.toJSON())` —— 所以**字段节点自身**也要能被序列化。
 * 只给根对象 `toJSON()` 不够：递归到子字段时会报
 * `TypeError: schema.toJSON is not a function`（实测踩到）。
 *
 * @param {'boolean'|'string'} type
 * @param {{default?: unknown, description?: string}} meta
 */
function field(type, meta) {
  return {
    type,
    /** (c) 标量字段必须 volatile，否则不会被投影进设置表单 */
    meta: { volatile: true, ...meta },
    /** (b) 原生身份：品牌 + type + meta 齐备后 `isNativeConfigSchema` 才为 true */
    [SCHEMASTER_BRAND]: true,
    /** (c) 字段级别的序列化，供 `plainSchema` 的 `new z(node.toJSON())` 使用 */
    toJSON() {
      return { type, meta: { volatile: true, ...meta } }
    },
  }
}

/** 把字段定义展开成 schemastery 文档节点（用于 `toJSON()`，即 (d)） */
function nodeOf(spec) {
  return { type: spec.type, meta: { ...spec.meta } }
}

/** 构造可水合的 schemastery 文档 `{ uid, refs }` */
function encodeDocument(dict) {
  const refs = {}
  const uidDict = {}
  let next = 1
  for (const [key, spec] of Object.entries(dict)) {
    refs[String(next)] = nodeOf(spec)
    uidDict[key] = next
    next += 1
  }
  const rootUid = next
  refs[String(rootUid)] = { type: 'object', meta: { default: {} }, dict: uidDict }
  return { uid: rootUid, refs }
}

/** 按字段定义校验/补齐配置，返回 Standard Schema 的结果形状 */
function validateObject(dict, input) {
  const issues = []
  const value = {}
  const source = input === null || typeof input !== 'object' ? {} : input
  for (const [key, spec] of Object.entries(dict)) {
    const raw = source[key]
    if (raw === undefined || raw === null) {
      if ('default' in spec.meta) value[key] = spec.meta.default
      // 无 default 的可选字段保持缺省，与 schemastery 行为一致
      continue
    }
    if (typeof raw !== spec.type) {
      issues.push({ message: `expected ${spec.type} but got ${typeof raw}`, path: [key] })
      continue
    }
    value[key] = raw
  }
  return issues.length > 0 ? { issues } : { value }
}

class PluginConfigSchema {
  constructor(dict) {
    this.type = 'object'
    /**
     * ★ P0-6：根**不能**标 `volatile`。
     *
     * 平台契约：`dsh-app-boot` 的 `createConfigProjector()` 第一步就调
     * `validateVolatilePlacement()`，对"volatile 字段被包在 volatile 字段里"直接抛
     *   `config/enabled: volatile fields require a fixed object path without an enclosing volatile field`
     * （`dsh-app-boot/lib/index.js:2320-2332`，同一段校验被逐字打包进 10+ 个客户端包）。
     * 根 + 字段都标 volatile 正好命中这条 ⇒ **整份投影失败 ⇒ 设置页开关不可水合**。
     *
     * 去掉根上的 volatile 后，`volatileForm` 走 `type === 'object'` 分支递归子字段；
     * 每个字段自身仍是 volatile（`field()` 不动），因此**仍然会被投影**，
     * `enabled` 的 volatile 热写语义（设置页改它不重挂行、原地写回 apply 收到的 config
     * 对象）**逐字保留** —— 这是既有优点，不能被改成"必须重启"。
     */
    this.meta = { default: {} }
    /** 子字段表：值是满足原生身份检查的字段节点 */
    this.dict = dict
    this[SCHEMASTER_BRAND] = true

    const document = encodeDocument(dict)
    this._document = document

    /** (a) Standard Schema 接口 —— Cordis 的 `resolveConfig` 依赖它 */
    this[STANDARD_VERSION] = {
      version: 1,
      vendor: 'winstage-sandbox-local-schema',
      validate: (input) => validateObject(dict, input),
    }
  }

  /** (d) 设置页水合用的文档形式 */
  toJSON() {
    return this._document
  }

  /** 便于诊断：字段名清单 */
  keys() {
    return Object.keys(this.dict)
  }
}

const DICT = {
  enabled: field('boolean', {
    default: true,
    description: '启用 WinStage 沙箱（暂存—候选—选择性提交）。关闭后本插件不做任何检查。',
  }),
  workspaceRoot: field('string', {
    default: '',
    description: '沙箱工作区根目录；留空则使用插件所在项目的根目录。',
  }),
  probeOnStart: field('boolean', {
    default: true,
    description: '加载时执行一次真实能力探测（不创建沙箱，只报告本会话能否建立）。',
  }),
  verboseLog: field('boolean', {
    default: false,
    description: '把完整探测报告写入日志。',
  }),
}

/**
 * 插件 Config —— 同时就是「设置 → 通用」里这一行的表单定义。
 * `enabled` 会渲染成一个开关；`default` 决定初始状态。
 */
export const Config = new PluginConfigSchema(DICT)

/** 便于测试与文档：字段名清单 */
export const FIELD_NAMES = Object.keys(DICT)

export const __internal = { validateObject, encodeDocument, PluginConfigSchema, SCHEMASTER_BRAND }
