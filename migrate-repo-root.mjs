#!/usr/bin/env node
/**
 * migrate-repo-root.mjs —— 把本仓的"自引用仓库根"从旧路径迁到新路径
 * ============================================================================
 * 背景：本仓曾位于 `C:\Users\Administrator\Desktop\WinStageSandbox`（旧根，开发期
 * 没有根 `package.json`，插件是以 `@local/dsh-winstage-sandbox -> 旧根\dsh-plugin`
 * 的方式 link 进 DSH profile 的）。现在它是可发布包，根为
 * `C:\Users\Administrator\Desktop\dsh-winstage-sandbox`。
 *
 * 一次 `--apply` 按固定顺序做这些事（顺序本身是安全属性）：
 *   1) 改写 `tests/*.mjs`、`tools/*.mjs` 里**硬编码的旧仓库根**（scratch 根、REPO
 *      常量、DSH 会话目录 slug）——不改的话，旧目录一旦回收，测试会**把旧目录重建**；
 *      改写前逐个备份到 `%TEMP%\winstage-migrate-backup-<时间戳>\`（保持相对路径）；
 *   2) 重新封印 `docs/源码基线.sha256`（直接调用 `tools/baseline-sha256.mjs` 的
 *      collectEntries/renderManifest/diffManifest，格式与 `--write` 逐字一致）；
 *      改写**前**先过一次前置漂移门（磁盘已漂移就拒绝动手，避免"改写了一半、封印还是旧的"），
 *      改写**后**再过一次封印漂移门：与本次改写无关的漂移一律拒绝（否则"重封"会把别人的改动
 *      一起洗白，封印 diff 就不再是复核记录）；确认为有意时加 `--accept-baseline-drift`；
 *   3) （`--patch-profile`）改 DSH profile 层：依赖改成 `link:新根`、插件名改成包名
 *      `dsh-winstage-sandbox`、`workspaceRoot` 改成新根；写前先断言结果里不含旧标识，
 *      写前备份 `.bak-<时间戳>`；
 *   4) （`--take-git`）把旧根的 `.git` **改名搬进**新根——旧根才是真仓库，
 *      新根不是；`--hard-delete` 会自动带上这一步；
 *   5) （`--archive-evidence`）把旧根里**被 docs 引用的证据**（以及 `.gitignore`
 *      明说"文件必须留在磁盘上"的 `esc/`、`filemod/` 全量）拷进
 *      `docs/evidence/`，并写 `docs/evidence/MANIFEST.sha256.txt`；
 *      `--hard-delete` 会自动带上这一步，没归档成功就**拒绝硬删除**；
 *   6) 处置旧根：`--retire-old` 改名归档（可逆）／`--hard-delete` 先改名到
 *      `<旧根>.deleted-<时间戳>` 墓碑再递归删除（删一半失败会**点名墓碑路径**并非零退出）。
 *
 * 为什么默认 dry-run：这是"会写盘 + 会重新封印 + 会删目录"的动作；封印 diff 本身是
 * 复核记录，必须由人**有意识地**跑 `--apply`。注意 `--patch-profile` 只等于"改写 + 重封 +
 * 改 profile"，**不**触发搬 .git / 归档证据 / 改名 / 删除旧根 —— 那四件事都要求显式的 `--apply`。
 *
 * 用法：
 *   node migrate-repo-root.mjs                            # 只打印计划（不改任何文件）
 *   node migrate-repo-root.mjs --apply                    # 改写 + 重新封印（不动 profile、不删旧根）
 *   node migrate-repo-root.mjs --apply --patch-profile    # 连 profile 一起改；随后必须
 *                                                         # pnpm install + 重启宿主（同一动作）
 *   node migrate-repo-root.mjs --apply --take-git --retire-old      # 搬 git + 归档改名（推荐的最小破坏组合）
 *   node migrate-repo-root.mjs --apply --hard-delete                # 自动 take-git + 归档证据，再墓碑式硬删除
 *   node migrate-repo-root.mjs --apply --hard-delete --allow-git-loss --allow-evidence-loss
 *                                                         # 明确弃置 git 历史 / 文档引用的证据
 *   node migrate-repo-root.mjs --apply --include-docs     # 连 docs/*.md 里的旧路径也改写
 *                                                         # （默认关闭：docs 是历史取证记录）
 *
 * 退出码：0 成功 / 1 用法错误或任一步失败（含拒绝硬删除） / 2 环境不符 / 4 旧根不存在
 *
 * 说明：本文件在仓库**根**目录，不在 `INCLUDED_ROOT_FILES` 封印面内，因此它自身
 * 不会让基线漂移，也不会随 npm 包发布（`package.json` 的 `files` 白名单未收录它）。
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEntries, diffManifest, renderManifest, MANIFEST_PATH } from './tools/baseline-sha256.mjs'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)))
const NEW_ROOT = HERE
const EXPECTED_NEW = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox'
const OLD_ROOT = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const PROFILE_DIR = join(process.env.USERPROFILE ?? 'C:\\Users\\Administrator', '.dsh', 'profiles', 'web')
const PROFILE_PACKAGE = join(PROFILE_DIR, 'package.json')
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
const EVIDENCE_DEST = join(NEW_ROOT, 'docs', 'evidence')
const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024
const MAX_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_WALK_DEPTH = 40

const EXIT = { OK: 0, FAIL: 1, ENV: 2, MISSING: 4 }

/** 仓库相对路径一律用 `/`。 */
const relPosix = (full) => relative(NEW_ROOT, full).split(sep).join('/')

/** 旧→新 的文面替换规则（同一路径在不同文件里有四种写法）。 */
function buildRules() {
  const withDouble = (s) => s.split('\\').join('\\\\')
  const withSlash = (s) => s.split('\\').join('/')
  const asSlug = (s) => withSlash(s).replace(/:/g, '').split('/').join('-')
  return [
    // ① JS 源码里的转义写法（'C:\\Users\\...\\WinStageSandbox'）
    [withDouble(OLD_ROOT), withDouble(NEW_ROOT)],
    // ② YAML / cmd / 注释里的原生写法（C:\Users\...\WinStageSandbox）
    [OLD_ROOT, NEW_ROOT],
    // ③ 正斜杠写法（C:/Users/.../WinStageSandbox）
    [withSlash(OLD_ROOT), withSlash(NEW_ROOT)],
    // ④ DSH 会话目录 slug（--C-Users-Administrator-Desktop-WinStageSandbox--）
    [asSlug(OLD_ROOT), asSlug(NEW_ROOT)],
  ]
}

const RULES = buildRules()

/** 收集需要改写的文件：封印面里的 tests/*.mjs、tools/*.mjs，加上插件 bundle 默认值与两个说明文件。 */
function collectTargets({ includeDocs }) {
  const targets = []
  for (const dir of ['tests', 'tools']) {
    const abs = join(NEW_ROOT, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.mjs')) continue
      const full = join(abs, name)
      try {
        if (statSync(full).isFile()) targets.push(full)
      } catch {
        // 读目录后文件被删/被锁：跳过而不是崩掉（TOCTOU）
      }
    }
  }
  targets.push(join(NEW_ROOT, 'dsh-plugin', 'cordis.patch.yml'))
  targets.push(join(NEW_ROOT, 'README.md'))
  targets.push(join(NEW_ROOT, 'PUBLISHING.md'))
  if (includeDocs) {
    const docs = join(NEW_ROOT, 'docs')
    if (existsSync(docs)) {
      for (const name of readdirSync(docs)) {
        if (name.endsWith('.md')) targets.push(join(docs, name))
      }
    }
  }
  return targets
}

function rewriteText(text) {
  let out = text
  let hits = 0
  for (const [from, to] of RULES) {
    if (from.length === 0 || from === to) continue
    const parts = out.split(from)
    if (parts.length > 1) {
      hits += parts.length - 1
      out = parts.join(to)
    }
  }
  return { out, hits }
}

function planRewrites({ includeDocs, problems }) {
  const changed = []
  for (const full of collectTargets({ includeDocs })) {
    if (!existsSync(full)) continue
    let before
    try {
      before = readFileSync(full, 'utf8')
    } catch (error) {
      problems.push(`读取失败 ${relPosix(full)}：${error.message}`)
      continue
    }
    const { out, hits } = rewriteText(before)
    if (hits > 0 && out !== before) changed.push({ full, hits, after: out })
  }
  return changed
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  // 毫秒也带上：同一秒内的两次运行不能共用备份目录/墓碑名
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

function backup(path, tag) {
  if (!existsSync(path)) return undefined
  const dest = `${path}.bak-${tag}`
  copyFileSync(path, dest)
  return dest
}

/**
 * 递归列出文件（相对 base）；不跟 symlink/junction（含中间层 junction 的真实路径检查）；
 * 深度超限会在 state.truncated 标记（不静默丢）。
 */
function walkFiles(root, base, state, oldReal, depth = 0) {
  if (depth > MAX_WALK_DEPTH) {
    state.truncated = true
    return
  }
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    try {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!realInsideOld(full, oldReal)) continue
        walkFiles(full, base, state, oldReal, depth + 1)
      } else if (entry.isFile()) state.files.push(relative(base, full))
    } catch {
      // 无权限/被占用：跳过
    }
  }
}

/** 打印 DSH profile 侧要改的字段。 */
function profilePlan() {
  const rows = []
  if (existsSync(PROFILE_PACKAGE)) {
    let text = ''
    try {
      text = readFileSync(PROFILE_PACKAGE, 'utf8')
    } catch (error) {
      rows.push({ file: PROFILE_PACKAGE, field: '(读取失败)', has: false, label: error.message })
    }
    const dep = '"@local/dsh-winstage-sandbox": "link:C:/Users/Administrator/Desktop/WinStageSandbox/dsh-plugin"'
    rows.push({ file: PROFILE_PACKAGE, field: 'dependencies', has: text.includes(dep), label: dep })
    rows.push({ file: PROFILE_PACKAGE, field: 'dsh.profile.bundles', has: text.includes('"@local/dsh-winstage-sandbox"'), label: '"@local/dsh-winstage-sandbox"' })
  } else {
    rows.push({ file: PROFILE_PACKAGE, field: '(missing)', has: false, label: '' })
  }
  if (existsSync(PROFILE_PATCH)) {
    let text = ''
    try {
      text = readFileSync(PROFILE_PATCH, 'utf8')
    } catch (error) {
      rows.push({ file: PROFILE_PATCH, field: '(读取失败)', has: false, label: error.message })
    }
    rows.push({ file: PROFILE_PATCH, field: 'name:', has: text.includes('name: "@local/dsh-winstage-sandbox"'), label: 'name: "@local/dsh-winstage-sandbox"' })
    rows.push({ file: PROFILE_PATCH, field: 'workspaceRoot:', has: text.includes('workspaceRoot: ' + OLD_ROOT), label: 'workspaceRoot: ' + OLD_ROOT })
  } else {
    rows.push({ file: PROFILE_PATCH, field: '(missing)', has: false, label: '' })
  }
  return rows
}

/** profile 补丁：写前断言（结果必须是合法 JSON / 不得残留旧标识），失败即拒写并计入 problems。 */
function applyProfile(tag, problems) {
  const done = []
  const newLink = 'link:' + NEW_ROOT.split('\\').join('/')
  const depLiteral = '"@local/dsh-winstage-sandbox": "link:C:/Users/Administrator/Desktop/WinStageSandbox/dsh-plugin"'
  const migratedLiteral = '"dsh-winstage-sandbox": "' + newLink + '"'
  if (existsSync(PROFILE_PACKAGE)) {
    let before
    try {
      before = readFileSync(PROFILE_PACKAGE, 'utf8')
    } catch (error) {
      problems.push(`无法读取 ${PROFILE_PACKAGE}：${error.message}`)
      before = undefined
    }
    if (before !== undefined) {
      // 静默 no-op 防线：既没有旧字面量、也没有已迁移的 link:新根 ⇒ 必须报错（否则会把旧 link 留在原地）
      if (!before.includes(depLiteral) && !before.includes(migratedLiteral)) {
        problems.push(`profile 未迁移：既找不到旧依赖字面量，也没有 ${migratedLiteral}（请人工核对 ${PROFILE_PACKAGE}）`)
      }
      const after = before
        .split(depLiteral)
        .join(migratedLiteral)
        .split('"@local/dsh-winstage-sandbox"')
        .join('"dsh-winstage-sandbox"')
      if (after !== before) {
        let parsed = null
        try {
          parsed = JSON.parse(after)
        } catch (error) {
          problems.push(`拒绝写 ${PROFILE_PACKAGE}：改写结果不是合法 JSON（${error.message}）`)
          return done
        }
        const dep = parsed?.dependencies?.['dsh-winstage-sandbox']
        if (dep !== newLink) {
          problems.push(`拒绝写 ${PROFILE_PACKAGE}：断言失败，dependencies["dsh-winstage-sandbox"] = ${JSON.stringify(dep)}，期望 ${newLink}`)
          return done
        }
        if (after.includes('@local/dsh-winstage-sandbox') || after.includes('WinStageSandbox')) {
          problems.push(`拒绝写 ${PROFILE_PACKAGE}：改写后仍残留旧标识（可能把 link: 目标留在旧根）`)
          return done
        }
        const bak = backup(PROFILE_PACKAGE, tag)
        writeFileSync(PROFILE_PACKAGE, after, 'utf8')
        done.push(`已改写 ${PROFILE_PACKAGE}${bak ? `（备份 ${bak}）` : ''}`)
      }
    }
  }
  if (existsSync(PROFILE_PATCH)) {
    let before
    try {
      before = readFileSync(PROFILE_PATCH, 'utf8')
    } catch (error) {
      problems.push(`无法读取 ${PROFILE_PATCH}：${error.message}`)
      before = undefined
    }
    if (before !== undefined) {
      const alreadyMigrated = before.includes('name: "dsh-winstage-sandbox"') && before.includes('workspaceRoot: ' + NEW_ROOT)
      if (!before.includes('name: "@local/dsh-winstage-sandbox"') && !alreadyMigrated) {
        problems.push(`profile patch 未迁移：name 既不是旧值也不是已迁移值（请人工核对 ${PROFILE_PATCH}）`)
      }
      const after = before
        .split('name: "@local/dsh-winstage-sandbox"')
        .join('name: "dsh-winstage-sandbox"')
        .split('workspaceRoot: ' + OLD_ROOT)
        .join('workspaceRoot: ' + NEW_ROOT)
      if (after !== before) {
        if (after.includes('@local/dsh-winstage-sandbox') || after.includes(OLD_ROOT)) {
          problems.push(`拒绝写 ${PROFILE_PATCH}：改写后仍残留旧标识 / 旧根`)
          return done
        }
        if (!after.includes('workspaceRoot: ' + NEW_ROOT)) {
          problems.push(`拒绝写 ${PROFILE_PATCH}：断言失败，未出现 workspaceRoot: ${NEW_ROOT}`)
          return done
        }
        const bak = backup(PROFILE_PATCH, tag)
        writeFileSync(PROFILE_PATCH, after, 'utf8')
        done.push(`已改写 ${PROFILE_PATCH}${bak ? `（备份 ${bak}）` : ''}`)
      }
    }
  }
  return done
}

/** 把旧根 .git 改名搬进新根（相对路径不变）。 */
function takeGit(problems) {
  const oldGit = join(OLD_ROOT, '.git')
  const newGit = join(NEW_ROOT, '.git')
  if (!existsSync(oldGit)) return `旧根没有 .git（${oldGit}），跳过`
  if (existsSync(newGit)) {
    problems.push(`git 元数据未搬：新根已有 .git（${newGit}），请自行合并`)
    return `新根已有 .git，跳过`
  }
  try {
    renameSync(oldGit, newGit)
    return `已把 git 元数据 ${oldGit} 迁到 ${newGit}（工作树相对路径不变；docs/、package.json 与改写过路径的文件会显示为改动/新增）`
  } catch (error) {
    problems.push(`git 元数据迁移失败：${error.message}`)
    return `git 元数据迁移失败：${error.message}`
  }
}

/** 从 docs/*.md 里抽出被引用的旧根相对路径（去掉省略号与尾随标点），统一成反斜杠写法。 */
function cleanCitedPath(raw) {
  let s = raw
  // 省略号有两种写法：U+2026 与 ASCII `...`；都截断（ASCII 那版不处理会被误判成 `..` 路径穿越）
  for (const marker of ['…', '...']) {
    const at = s.indexOf(marker)
    if (at !== -1) s = s.slice(0, at)
  }
  // 注意：字符类里的 `]` 必须写成 `\]`，否则类会在 `)` 后提前闭合、整条替换变成空操作。
  // `→`（U+2192）等箭头/全角收尾符也要剥掉：docs 里有 `.json→ sessionId:` 这种写法。
  s = s.replace(/[,.;:)\]}>。，、）】”"'→》］｝！？]+$/u, '')
  // docs 里常把「文件 + 行号」写成 `path:57` / `path:59-63` / `path:1,2`。
  // 必须在**标点剥离之后**再剥行号：`path:59-63)` 这类写法若先剥行号会因为末尾是 `)` 而失配。
  // Windows 文件名不含 `:`（盘符是 `C:\` 而不是 `C:12`），所以只剥尾部的 `:行号` 不会误伤真实文件。
  // 不剥就会被当成真实文件名去 open，必然 ENOENT（实测 9 条）。
  s = s.replace(/:\d+(?:[-,]\d+)*$/, '')
  s = s.split('/').join('\\')
  return s
}

/**
 * 证据路径必须落在旧根内（挡 `..`、绝对路径、换盘符）。
 * @returns {string|undefined} 合法时返回规范化后的绝对路径
 */
function resolveInsideOld(rel) {
  if (rel.length === 0) return undefined
  // `..` 必须按**路径段**判定，不能用子串：子串检查会误杀合法文件名
  // （实测 `filemod\trailing.dot..txt` 被拒）。真正的围栏由下面的 resolve() + startsWith
  // 保证，所以这里只需要挡"显式穿越段"。
  if (rel.split(/[\\/]/).some((segment) => segment === '..')) return undefined
  const resolved = resolve(OLD_ROOT, rel)
  const base = resolve(OLD_ROOT) + sep
  return resolved.startsWith(base) ? resolved : undefined
}

/** 真实路径必须仍在旧根内（挡"中间层是 junction"这种词法检查抓不到的越界）。 */
function realInsideOld(full, oldReal) {
  if (oldReal === undefined) return false
  try {
    return realpathSync(full).startsWith(oldReal)
  } catch {
    return false
  }
}

/**
 * 收集 docs 里的旧根引用。
 * 值里的 `explicitDir` 来自**原始捕获**（未被省略号截断的原文）是否以分隔符结尾——
 * 只有它才能决定"是否递归整个目录"，否则 `.t\…` 截断成 `.t\` 会把整棵 `.t` 卷进来。
 * @returns {Map<string,{explicitDir:boolean}>}
 */
function collectCitedEvidence() {
  const cited = new Map()
  const docsDir = join(NEW_ROOT, 'docs')
  if (!existsSync(docsDir)) return cited
  // ① 文档里的原生写法：C:\Users\...\WinStageSandbox\<rel>
  const absRe = /C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\([^\s`"'|)\]]+)/g
  // ② 代码块里被 JSON/JS 转义过的写法：C:\\Users\\...\\WinStageSandbox\\<rel>（文档里有实测命令）
  const absEscRe = /C:\\\\Users\\\\Administrator\\\\Desktop\\\\WinStageSandbox\\\\([^\s`"'|)\]]+)/g
  // ③ 相对写法：`.t\…`/`esc\…`/`filemod\…`；分隔符可能是正斜杠，前面可能是 markdown 链接/中英文标点
  const relRe = /(?:^|[\s`("'|>[{<=*：，,（“、。])((?:\.t|esc|filemod)[\\/][^\s`"'|)\]}]+)/gm
  const add = (rawRel, rawEndsWithSep) => {
    const rel = cleanCitedPath(rawRel)
    if (rel.length === 0) return
    const previous = cited.get(rel)
    cited.set(rel, { explicitDir: (previous?.explicitDir ?? false) || rawEndsWithSep })
  }
  for (const name of readdirSync(docsDir)) {
    if (!name.endsWith('.md')) continue
    let text
    try {
      text = readFileSync(join(docsDir, name), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(absRe)) add(m[1], /[\\/]$/.test(m[1]))
    for (const m of text.matchAll(absEscRe)) add(m[1].split('\\\\').join('\\'), m[1].endsWith('\\\\'))
    for (const m of text.matchAll(relRe)) add(m[1], /[\\/]$/.test(m[1]))
  }
  return cited
}

/**
 * 证据候选 = docs 引用且真实存在的文件（**显式**以分隔符结尾的目录引用才递归）+ `esc/`、`filemod/` 全量。
 * 全程 lstat：不跟随 symlink/junction；`..` 与越界一律拒绝；总量有全局上限（fail-closed）。
 * @returns {{items:Array<{rel:string,bytes:number,source:string}>, rawCount:number, skipped:string[]}}
 */
function planEvidence() {
  const items = new Map()
  const skipped = []
  const cited = collectCitedEvidence()
  const rawCount = cited.size
  let oldReal
  try {
    oldReal = realpathSync(OLD_ROOT) + sep
  } catch {
    return { items: [], rawCount, skipped: [] } // 旧根不存在：没有证据可归档（处置流程会另行返回 4）
  }
  for (const [rel, meta] of cited) {
    if (rel.length === 0) continue
    const full = resolveInsideOld(rel)
    if (full === undefined) {
      skipped.push(`${rel}（路径越界 / 含 ..，拒绝）`)
      continue
    }
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue // 引用的东西不存在（历史产物/省略号/占位符）——不算失败
    }
    if (st.isSymbolicLink()) {
      skipped.push(`${rel}（引用的是 symlink/junction，拒绝跟随）`)
      continue
    }
    // 词法检查抓不到"中间层是 junction"：再按真实路径确认一次
    if (!realInsideOld(full, oldReal)) {
      skipped.push(`${rel}（真实路径越出旧根（中间层 junction？），拒绝）`)
      continue
    }
    if (st.isFile()) {
      items.set(rel, { bytes: st.size, source: 'docs 引用' })
      continue
    }
    if (!st.isDirectory()) continue
    // 只有**原始捕获**就以分隔符结尾的目录引用才整目录收；省略号截断出来的尾分隔符（`.t\…` → `.t\`）
    // 与散文里的裸目录名（`.t\dsh2`）都不递归，否则会把整棵 `.t`（数万文件）卷进来。
    if (!meta.explicitDir) continue
    const state = { files: [], truncated: false }
    walkFiles(full, OLD_ROOT, state, oldReal)
    if (state.truncated) skipped.push(`目录引用 ${rel}（超过 ${MAX_WALK_DEPTH} 层，未完整枚举）`)
    let total = 0
    const staged = []
    for (const relFile of state.files) {
      try {
        const child = lstatSync(join(OLD_ROOT, relFile))
        if (child.isSymbolicLink()) continue
        total += child.size
        staged.push({ rel: relFile, bytes: child.size })
      } catch {
        // 跳过不可读
      }
    }
    if (total > MAX_EVIDENCE_TOTAL_BYTES) {
      skipped.push(`目录引用 ${rel}（${staged.length} 个文件 / ${total} B 超过 ${MAX_EVIDENCE_TOTAL_BYTES} B 上限）`)
      continue
    }
    for (const s of staged) items.set(s.rel, { bytes: s.bytes, source: `docs 引用目录 ${rel}` })
  }
  for (const dirName of ['esc', 'filemod']) {
    const abs = join(OLD_ROOT, dirName)
    let lst
    try {
      lst = lstatSync(abs)
    } catch {
      continue
    }
    if (lst.isSymbolicLink()) {
      skipped.push(`${dirName}/（是 symlink/junction，拒绝跟随）`)
      continue
    }
    if (!realInsideOld(abs, oldReal)) {
      skipped.push(`${dirName}/（真实路径越出旧根（中间层 junction？），拒绝）`)
      continue
    }
    const state = { files: [], truncated: false }
    walkFiles(abs, OLD_ROOT, state, oldReal)
    if (state.truncated) skipped.push(`${dirName}/（超过 ${MAX_WALK_DEPTH} 层，未完整枚举）`)
    for (const rel of state.files) {
      try {
        const child = lstatSync(join(OLD_ROOT, rel))
        if (child.isSymbolicLink()) continue
        items.set(rel, { bytes: child.size, source: `${dirName}/ 全量` })
      } catch {
        // 跳过
      }
    }
  }
  const entries = [...items.entries()].map(([rel, meta]) => ({ rel, ...meta }))
  const totalAll = entries.reduce((n, item) => n + item.bytes, 0)
  if (totalAll > MAX_EVIDENCE_TOTAL_BYTES) {
    // 全局超限：**不拷**，直接判失败（避免一边复制好几 GB 一边报错）
    return {
      items: [],
      rawCount,
      skipped: [...skipped, `全部候选合计 ${entries.length} 个文件 / ${totalAll} B 超过 ${MAX_EVIDENCE_TOTAL_BYTES} B 上限，未归档任何文件`],
    }
  }
  return { items: entries, rawCount, skipped }
}

/**
 * 归档证据到 docs/evidence/ 并写 sha256 清单。
 * @returns {{ok:boolean, lines:string[]}}
 */
function archiveEvidence(problems, plan = planEvidence()) {
  const items = plan.items
  const lines = [`证据归档：docs 原始引用命中 ${plan.rawCount} 处；候选文件 ${items.length} 个（含 esc|filemod 全量）`]
  const skipped = [...plan.skipped]
  if (items.length === 0) {
    if (plan.rawCount > 0 || skipped.length > 0) {
      lines.push('拒绝：docs 引用了旧根路径（或候选被全部跳过），但没有任何一项能归档 —— 证据门 fail-closed')
      lines.push('（若确认没有证据需要留，显式加 --allow-evidence-loss）')
      for (const s of skipped) lines.push(`   ${s}`)
      problems.push('证据未归档：没有任何一项候选能写入 docs/evidence（证据门 fail-closed）')
      return { ok: false, lines }
    }
    lines.push('没有可归档的证据（docs 未引用旧根路径，且旧根没有 esc/、filemod/）')
    return { ok: true, lines }
  }
  let copied = 0
  let bytes = 0
  const manifestLines = []
  const evidenceRoot = resolve(EVIDENCE_DEST) + sep
  let oldReal
  let evidenceReal
  try {
    oldReal = realpathSync(OLD_ROOT) + sep
  } catch (error) {
    problems.push(`证据未归档：旧根不可解析（${error.message}）`)
    return { ok: false, lines: [...lines, `旧根不可解析：${error.message}`] }
  }
  try {
    mkdirSync(EVIDENCE_DEST, { recursive: true })
    evidenceReal = realpathSync(EVIDENCE_DEST) + sep
  } catch (error) {
    problems.push(`证据未归档：无法建立/解析归档目录 ${EVIDENCE_DEST}（${error.message}）`)
    return { ok: false, lines: [...lines, `归档目录不可用：${error.message}`] }
  }
  for (const item of items) {
    const src = resolveInsideOld(item.rel)
    if (src === undefined) {
      skipped.push(`${item.rel}（路径越界，拒绝）`)
      continue
    }
    try {
      if (lstatSync(src).isSymbolicLink()) {
        skipped.push(`${item.rel}（复制前发现是 symlink/junction，拒绝）`)
        continue
      }
    } catch (error) {
      skipped.push(`${item.rel}（${error.message}）`)
      continue
    }
    if (!realInsideOld(src, oldReal)) {
      skipped.push(`${item.rel}（真实路径越出旧根，拒绝）`)
      continue
    }
    if (item.bytes > MAX_EVIDENCE_BYTES) {
      skipped.push(`${item.rel}（${item.bytes} B 超过 ${MAX_EVIDENCE_BYTES} B 上限）`)
      continue
    }
    const dest = join(EVIDENCE_DEST, item.rel)
    if (!resolve(dest).startsWith(evidenceRoot)) {
      skipped.push(`${item.rel}（归档目标词法越界，拒绝）`)
      continue
    }
    try {
      mkdirSync(dirname(dest), { recursive: true })
      // 目标侧也要按真实路径确认（docs/evidence 下若预存 junction，会写出去）
      if (!(realpathSync(dirname(dest)) + sep).startsWith(evidenceReal)) {
        skipped.push(`${item.rel}（归档目标真实路径越界，拒绝）`)
        continue
      }
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
        skipped.push(`${item.rel}（归档目标是一个已存在的 symlink，拒绝覆盖）`)
        continue
      }
      const buf = readFileSync(src)
      writeFileSync(dest, buf)
      copied += 1
      bytes += buf.length
      manifestLines.push(`${createHash('sha256').update(buf).digest('hex')}  ${item.rel.split(sep).join('/')}  <- ${item.source}`)
    } catch (error) {
      skipped.push(`${item.rel}（${error.message}）`)
    }
  }
  try {
    mkdirSync(EVIDENCE_DEST, { recursive: true })
    writeFileSync(
      join(EVIDENCE_DEST, 'MANIFEST.sha256.txt'),
      [
        `# 迁移前从旧根 ${OLD_ROOT} 归档的证据（本清单由 migrate-repo-root.mjs 生成）`,
        `# 格式: <sha256>  <旧根相对路径>  <- <来源>`,
        ...manifestLines,
        '',
      ].join('\n'),
      'utf8',
    )
  } catch (error) {
    skipped.push(`MANIFEST.sha256.txt（${error.message}）`)
  }
  lines.push(`已归档 ${copied}/${items.length} 个文件（${bytes} B）到 ${EVIDENCE_DEST}`)
  if (skipped.length > 0) {
    lines.push(`以下 ${skipped.length} 个未归档：`)
    for (const s of skipped) lines.push(`   ${s}`)
    for (const s of skipped) problems.push(`证据未归档：${s}`)
    return { ok: false, lines }
  }
  return { ok: true, lines }
}

/** 重新封印：先过漂移门（只允许本次改写文件的哈希变化）。 */
function reseal(rewrites, { acceptDrift }, problems) {
  const entries = collectEntries()
  let before
  try {
    before = readFileSync(MANIFEST_PATH, 'utf8')
  } catch {
    before = undefined
  }
  if (before !== undefined) {
    const diff = diffManifest(entries, before)
    const allowed = new Set(rewrites.map((r) => relPosix(r.full)))
    const unexpected = []
    for (const s of diff.changed) {
      const path = s.split('（')[0]
      if (!allowed.has(path)) unexpected.push('内容变化 ' + s)
    }
    for (const p of diff.added) if (!allowed.has(p)) unexpected.push('清单缺失 ' + p)
    for (const p of diff.removed) if (!allowed.has(p)) unexpected.push('已不存在 ' + p)
    for (const p of diff.malformed) unexpected.push('清单格式非法 ' + JSON.stringify(p))
    if (unexpected.length > 0 && !acceptDrift) {
      problems.push('拒绝重新封印：检测到与本次改写无关的基线漂移')
      return {
        ok: false,
        lines: [
          '拒绝重新封印：以下漂移不属于本次改写，重封会把它一起洗白（封印 diff 就不再是复核记录）：',
          ...unexpected.map((l) => '   ' + l),
          '确认这些漂移是有意的，加 --accept-baseline-drift 重跑。',
        ],
      }
    }
  }
  writeFileSync(MANIFEST_PATH, renderManifest(entries), 'utf8')
  return { ok: true, lines: [`已重新封印 docs/源码基线.sha256：${entries.length} 条（LF/UTF-8/无 BOM）`] }
}

/** 只读预览：本次改写会让封印清单发生哪些变化、有没有意外漂移。 */
function previewDrift(rewrites) {
  let before
  try {
    before = readFileSync(MANIFEST_PATH, 'utf8')
  } catch {
    return ['（没有现存清单，无法预览漂移）']
  }
  const diff = diffManifest(collectEntries(), before)
  const allowed = new Set(rewrites.map((r) => relPosix(r.full)))
  const lines = []
  for (const s of diff.changed) {
    const path = s.split('（')[0]
    lines.push(`   ${allowed.has(path) ? '本次改写' : '⚠ 意外漂移'}  ~ ${s}`)
  }
  for (const p of diff.added) lines.push(`   ${allowed.has(p) ? '本次改写' : '⚠ 意外漂移'}  + ${p}`)
  for (const p of diff.removed) lines.push(`   ${allowed.has(p) ? '本次改写' : '⚠ 意外漂移'}  - ${p}`)
  for (const p of diff.malformed) lines.push(`   ⚠ 清单格式非法 ${JSON.stringify(p)}`)
  if (lines.length === 0) lines.push('   封印清单无变化')
  return lines
}

/** 改写**之前**的前置漂移检查：此时磁盘上的任何漂移都与本次改写无关。 */
function precheckDrift(acceptDrift, problems) {
  let before
  try {
    before = readFileSync(MANIFEST_PATH, 'utf8')
  } catch {
    if (acceptDrift) return { blocked: false, lines: ['（没有现存清单，--accept-baseline-drift 已授权：将生成全新封印）'] }
    problems.push('拒绝改写：找不到 docs/源码基线.sha256，无法判断改写前是否已有漂移')
    return {
      blocked: true,
      lines: [
        '拒绝改写：找不到 docs/源码基线.sha256 —— 没有封印就无法判断改写前磁盘是否已经漂移，',
        '此时新建封印等于把现状直接"洗白"。确认要新建封印就加 --accept-baseline-drift 重跑。',
      ],
    }
  }
  const diff = diffManifest(collectEntries(), before)
  const unexpected = []
  for (const s of diff.changed) unexpected.push('内容变化 ' + s)
  for (const p of diff.added) unexpected.push('清单缺失 ' + p)
  for (const p of diff.removed) unexpected.push('已不存在 ' + p)
  for (const p of diff.malformed) unexpected.push('清单格式非法 ' + JSON.stringify(p))
  if (unexpected.length === 0) return { blocked: false, lines: ['改写前检查：磁盘与封印清单一致'] }
  if (acceptDrift) return { blocked: false, lines: ['改写前检查：存在漂移，但 --accept-baseline-drift 已授权', ...unexpected.map((l) => '   ' + l)] }
  problems.push('拒绝改写：改写前磁盘相对封印清单已有漂移')
  return {
    blocked: true,
    lines: [
      '拒绝改写：改写前磁盘相对封印清单**已经**有漂移（不是本次改写造成的）。先把这些改动弄清楚，',
      '否则改写 + 重封会把它们混在一起，封印 diff 就再也说不清"谁改了什么"：',
      ...unexpected.map((l) => '   ' + l),
      '确认这些漂移是有意的，加 --accept-baseline-drift 重跑。',
    ],
  }
}

function retireOldRoot(mode, { allowGitLoss, allowEvidenceLoss, evidenceOk }) {
  // 删除/改名只允许发生在**常量**旧根上。
  if (resolve(OLD_ROOT) !== OLD_ROOT) return { code: EXIT.FAIL, message: `拒绝：解析后的旧根 ${resolve(OLD_ROOT)} 与常量 ${OLD_ROOT} 不一致` }
  if (!existsSync(OLD_ROOT)) return { code: EXIT.MISSING, message: `旧根不存在，跳过：${OLD_ROOT}` }
  if (mode === 'hard') {
    if (!allowGitLoss) {
      if (existsSync(join(OLD_ROOT, '.git'))) {
        return { code: EXIT.FAIL, message: '拒绝硬删除：旧根里还有 .git（真实仓库历史）。先加 --take-git 把它搬进新根，或显式加 --allow-git-loss 弃置历史。' }
      }
      if (!existsSync(join(NEW_ROOT, '.git'))) {
        return { code: EXIT.FAIL, message: '拒绝硬删除：旧根与新根都没有 .git —— git 历史可能已经丢了。确认要放弃历史就加 --allow-git-loss。' }
      }
    }
    if (!evidenceOk && !allowEvidenceLoss) {
      return { code: EXIT.FAIL, message: '拒绝硬删除：文档引用的证据还没成功归档到 docs/evidence。修好归档，或显式加 --allow-evidence-loss 放弃证据。' }
    }
    const tomb = `${OLD_ROOT}.deleted-${stamp()}`
    try {
      renameSync(OLD_ROOT, tomb)
    } catch (error) {
      return { code: EXIT.FAIL, message: `硬删除中止（未动旧根）：改名到墓碑失败：${error.message}` }
    }
    try {
      rmSync(tomb, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
      return { code: EXIT.OK, message: `已硬删除旧根（先改名到 ${tomb} 再递归删除）` }
    } catch (error) {
      return {
        code: EXIT.FAIL,
        message: `**部分删除**：旧根已改名为墓碑 ${tomb}，递归删除未完成（${error.message}）。`
          + `数据就在该墓碑目录里，重试请直接对墓碑下手，不要以为"已删干净"。`,
      }
    }
  }
  const dest = `${OLD_ROOT}.retired-${stamp()}`
  try {
    renameSync(OLD_ROOT, dest)
    return { code: EXIT.OK, message: `已把旧根改名归档为 ${dest}（可逆：改回原名即可）` }
  } catch (error) {
    return { code: EXIT.FAIL, message: `旧根改名失败（多半是有进程占着里面的文件）：${error.message}` }
  }
}

const HELP = [
  '用法: node migrate-repo-root.mjs [--apply] [--patch-profile] [--take-git] [--archive-evidence] [--include-docs]',
  '                                    [--retire-old | --hard-delete] [--allow-git-loss] [--allow-evidence-loss]',
  '                                    [--accept-baseline-drift]',
  '',
  '  默认                dry-run：只打印要改的文件、profile 字段、封印漂移预览、证据候选，不写盘。',
  '                      搬 .git / 归档证据 / 改名 / 删除旧根都要求**显式 --apply**；只给处置开关就是干跑预览。',
  '  --apply             改写 tests/tools 的旧仓库根 + 重新封印 docs/源码基线.sha256（逐文件备份到 %TEMP%）',
  '  --patch-profile     同时改 DSH profile 层（依赖 link 与插件名/workspaceRoot，写前断言 + .bak 备份）。',
  '                      它本身也执行改写 + 重封，但**不**触发搬 .git / 归档 / 改名 / 删除。',
  '                      必须与随后的 pnpm install + 宿主重启视为**同一个动作**；profile 是 live reload，',
  '                      建议先停宿主再跑本步，否则重载可能打断本脚本自身。',
  '  --take-git          把旧根的 .git 改名搬进新根（旧根才是有 .git 的那个）。--hard-delete 会自动带上。',
  '  --archive-evidence  把 docs 引用的旧根文件 + esc/、filemod/ 全量拷进 docs/evidence/（带 sha256 清单）。',
  '                      --hard-delete 会自动带上，未成功即拒绝硬删除。',
  '  --include-docs      连 docs/*.md 里的旧路径也改写（默认关闭：docs 是历史取证记录）。',
  '                      注意它发生在证据抽取之前，会让绝对路径式引用失配，不要与 --hard-delete 同用。',
  '  --retire-old        旧根改名归档为 <旧根>.retired-<时间戳>（需 --apply；可逆）',
  '  --hard-delete       硬删除旧根（需 --apply；不可逆）：自动 take-git + 归档证据，先改名到',
  '                      <旧根>.deleted-<时间戳> 墓碑再递归删除；任一门未过则拒绝执行。',
  '  --allow-git-loss    允许在没有成功搬运 .git 的情况下硬删除（不可逆地弃置 git 历史）',
  '  --allow-evidence-loss  允许在证据归档失败时仍然硬删除（不可逆地弃置被引用的证据）',
  '  --accept-baseline-drift  允许把与本次改写无关的封印漂移一起重新封印（默认拒绝）',
  '',
  '退出码: 0 成功 / 1 用法错误或任一步失败 / 2 环境不符 / 4 旧根不存在',
  '',
]

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP.join('\n'))
    return EXIT.OK
  }
  const hard = args.includes('--hard-delete')
  const retire = args.includes('--retire-old')
  if (hard && retire) {
    process.stderr.write('用法错误：--hard-delete 与 --retire-old 互斥，只能选一个\n')
    return EXIT.FAIL
  }
  const patchProfile = args.includes('--patch-profile')
  const applyLiteral = args.includes('--apply')
  const apply = applyLiteral || patchProfile
  const allowGitLoss = args.includes('--allow-git-loss')
  const allowEvidenceLoss = args.includes('--allow-evidence-loss')
  const acceptDrift = args.includes('--accept-baseline-drift')
  const includeDocs = args.includes('--include-docs')
  // 硬删除自动带上保命的两步（除非用户显式弃置）
  const takeGitFlag = args.includes('--take-git') || (hard && !allowGitLoss)
  const archiveEvidenceFlag = args.includes('--archive-evidence') || (hard && !allowEvidenceLoss)
  if (includeDocs && (hard || archiveEvidenceFlag)) {
    process.stderr.write('用法错误：--include-docs 会先改写 docs/*.md，而证据抽取依赖 docs 里的旧根引用（改写后绝对路径式引用会失配）。\n')
    process.stderr.write('  正确顺序：--apply --archive-evidence 先归档，再单独跑 --apply --include-docs。\n')
    return EXIT.FAIL
  }
  if (!applyLiteral) {
    const previewFlags = [
      retire && '--retire-old',
      hard && '--hard-delete',
      takeGitFlag && '--take-git',
      archiveEvidenceFlag && '--archive-evidence',
      allowGitLoss && '--allow-git-loss',
      allowEvidenceLoss && '--allow-evidence-loss',
      acceptDrift && '--accept-baseline-drift',
    ].filter(Boolean)
    if (previewFlags.length > 0) {
      process.stdout.write(`注意：没有显式 --apply，${previewFlags.join(' / ')} 只用于**预览**：本次不会搬 .git、不会归档、不会改名或删除旧根。\n`)
      process.stdout.write('      （--patch-profile 只等于"改写 + 重封 + 改 profile"，不等于 --apply。）\n\n')
    }
  }
  if (resolve(NEW_ROOT) !== resolve(EXPECTED_NEW)) {
    process.stderr.write(`环境不符：本脚本位于 ${NEW_ROOT}，预期新根为 ${EXPECTED_NEW}\n（如新根已换位置，请同步改本文件顶部的 EXPECTED_NEW 常量）\n`)
    return EXIT.ENV
  }

  const problems = []
  process.stdout.write(`新根：${NEW_ROOT}\n旧根：${OLD_ROOT}\n模式：${apply ? 'APPLY（写盘）' : 'DRY-RUN（不写盘）'}${includeDocs ? ' + docs' : ''}\n\n`)

  const rewrites = planRewrites({ includeDocs, problems })
  process.stdout.write(`① 需要改写的仓内文件：${rewrites.length} 个，共 ${rewrites.reduce((n, r) => n + r.hits, 0)} 处旧路径\n`)
  for (const r of rewrites) process.stdout.write(`   ${relPosix(r.full)}  (${r.hits} 处)\n`)

  process.stdout.write('\n② 封印漂移预览（本次改写 vs 存量清单）：\n')
  for (const line of previewDrift(rewrites)) process.stdout.write(line + '\n')

  process.stdout.write('\n③ DSH profile 侧要改的字段（只有 --patch-profile 才动它）：\n')
  for (const row of profilePlan()) {
    process.stdout.write(`   [${row.has ? '命中' : '未命中'}] ${row.file}\n      ${row.field}  ${row.label}\n`)
  }

  // 证据候选只算一次（apply 模式下 ④ 的预览与 ⑤ 的归档共用，避免把 esc/filemod 走两遍）
  const evidencePlan = archiveEvidenceFlag ? planEvidence() : undefined

  process.stdout.write('\n④ 旧根处置计划：\n')
  if (!hard && !retire) {
    process.stdout.write('   （未指定 --retire-old / --hard-delete：旧根保持原样）\n')
  } else if (retire) {
    process.stdout.write(`   --retire-old：改名归档为 ${OLD_ROOT}.retired-<时间戳>\n`)
  } else {
    process.stdout.write(`   --hard-delete：${allowGitLoss ? '不搬 .git（已弃置历史）' : '自动 --take-git 搬走 .git'}；`)
    process.stdout.write(`${allowEvidenceLoss ? '不归档证据（已弃置）' : '自动 --archive-evidence 归档 docs 引用 + esc|filemod'}；`)
    process.stdout.write('再改名到 .deleted-<时间戳> 墓碑并递归删除\n')
    const plan = evidencePlan ?? { items: [], rawCount: 0, skipped: [] }
    process.stdout.write(`   证据候选：docs 原始引用命中 ${plan.rawCount} 处 → ${plan.items.length} 个文件${plan.skipped.length > 0 ? `（${plan.skipped.length} 项被跳过，会导致拒绝硬删除）` : ''}\n`)
  }
  if (archiveEvidenceFlag && !hard) {
    const plan = evidencePlan ?? { items: [], rawCount: 0, skipped: [] }
    process.stdout.write(`   证据候选（--archive-evidence）：docs 原始引用命中 ${plan.rawCount} 处 → ${plan.items.length} 个文件${plan.skipped.length > 0 ? `（${plan.skipped.length} 项被跳过）` : ''}\n`)
  }

  process.stdout.write('\n⑤ 收尾（脚本不做，必须由 shell 完成）：\n')
  process.stdout.write(`   cd ${PROFILE_DIR}\n   pnpm install     # 若改了 profile：让 link:新根 落到 node_modules\n`)
  process.stdout.write('   # 重启 DSH 宿主（插件装配发生在启动期）；再检查旧根遗留计划任务/看门狗：\n')
  process.stdout.write('   #   schtasks /query /tn WinStageSandbox-Keeper\n')
  process.stdout.write('   # 注意：4 个会话 slug 工具（approval-audit*/gen-audit2/session-inspect）改写后指向新 slug 的\n')
  process.stdout.write('   #       %USERPROFILE%\\.dsh\\sessions\\--C-Users-Administrator-Desktop-dsh-winstage-sandbox--\n')
  process.stdout.write('   #       该目录要等新根下产生会话才存在；旧 slug 的会话目录**不在旧根里**，不会被删除，历史仍可查。\n')

  if (!apply) {
    if (problems.length > 0) {
      process.stdout.write(`\n✗ 有 ${problems.length} 项问题：\n`)
      for (const p of problems) process.stdout.write(`   - ${p}\n`)
    }
    process.stdout.write('\nDRY-RUN 结束：没有改任何文件。确认无误后加 --apply（必要时再加 --patch-profile）重跑。\n')
    return problems.length > 0 ? EXIT.FAIL : EXIT.OK
  }

  const tag = stamp()
  const backupRoot = join(tmpdir(), `winstage-migrate-backup-${tag}`)

  // ⓪ 前置漂移门：改写前磁盘已经漂移就拒绝动手（避免留下"改写了一半、封印还是旧的"状态）
  const pre = precheckDrift(acceptDrift, problems)
  for (const line of pre.lines) process.stdout.write(line + '\n')
  if (pre.blocked) return EXIT.FAIL

  // ① 改写（逐个先备份到 %TEMP%，任一失败即计入 problems，不静默继续）
  let rewritten = 0
  for (const r of rewrites) {
    const rel = relPosix(r.full)
    try {
      const dest = join(backupRoot, rel.split('/').join(sep))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(r.full, dest)
      writeFileSync(r.full, r.after, 'utf8')
      rewritten += 1
    } catch (error) {
      problems.push(`改写失败 ${rel}：${error.message}`)
    }
  }
  process.stdout.write(`\n已改写 ${rewritten}/${rewrites.length} 个文件；改写前副本在 ${backupRoot}\n`)

  // ② 重新封印（漂移门）
  const sealed = reseal(rewrites, { acceptDrift }, problems)
  for (const line of sealed.lines) process.stdout.write(line + '\n')
  if (rewritten !== rewrites.length || !sealed.ok) {
    process.stdout.write('\n✗ 改写/封印没有全部成功：后续 profile / git / 证据归档 / 删除**一律不执行**（避免在旧路径还残留时把旧根删掉，\n')
    process.stdout.write('   也避免留下"改写了一半、封印被拒"的状态）。修好后重跑（改写与封印都是幂等的）。\n')
    return EXIT.FAIL
  }

  // ③ profile
  if (patchProfile) {
    process.stdout.write('注意：profile 是 live reload —— 改完 cordis.patch.yml 的插件名后，正在跑的宿主可能立刻\n')
    process.stdout.write('      尝试解析尚不存在的 node_modules/dsh-winstage-sandbox，甚至重载打断本脚本。\n')
    process.stdout.write('      最稳的做法是**先停宿主**，再跑 --patch-profile，然后 pnpm install + 重启。\n')
    for (const line of applyProfile(tag, problems)) process.stdout.write(line + '\n')
  } else {
    process.stdout.write('未动 DSH profile（要动请加 --patch-profile）。\n')
  }

  // ④ git
  if (takeGitFlag && applyLiteral) {
    process.stdout.write(takeGit(problems) + '\n')
  } else if (takeGitFlag) {
    process.stdout.write('未搬 .git：缺少显式 --apply（本次只做改写 / 重新封印 / profile）。\n')
  }

  // ⑤ 证据归档
  let evidenceOk = true
  if (archiveEvidenceFlag && applyLiteral) {
    const archived = archiveEvidence(problems, evidencePlan)
    evidenceOk = archived.ok
    for (const line of archived.lines) process.stdout.write(line + '\n')
  } else if (archiveEvidenceFlag) {
    process.stdout.write('未归档证据：缺少显式 --apply。\n')
  } else {
    process.stdout.write('未归档证据（要归档请加 --archive-evidence）。\n')
  }

  // ⑥ 处置旧根（硬删除还要求前面没有任何未解决的失败项；且必须有显式 --apply）
  let code = EXIT.OK
  if ((retire || hard) && !applyLiteral) {
    process.stdout.write('未改名/删除旧根：缺少显式 --apply —— --patch-profile 只等于"改写 + 重封 + 改 profile"。\n')
    code = EXIT.FAIL
  } else if (retire || hard) {
    if (hard && problems.length > 0) {
      process.stdout.write('拒绝硬删除：前面还有未解决的失败项（改写/封印/profile/git/证据）。先逐条修完再重跑。\n')
      code = EXIT.FAIL
    } else {
      const result = retireOldRoot(hard ? 'hard' : 'retire', { allowGitLoss, allowEvidenceLoss, evidenceOk })
      process.stdout.write(result.message + '\n')
      if (result.code !== EXIT.OK) code = result.code
    }
  }

  if (problems.length > 0) {
    process.stdout.write(`\n✗ 有 ${problems.length} 项失败/拒绝：\n`)
    for (const p of problems) process.stdout.write(`   - ${p}\n`)
    if (code === EXIT.OK) code = EXIT.FAIL
  }
  process.stdout.write(code === EXIT.OK
    ? '\n完成。下一步：pnpm install + 重启 DSH 宿主，然后跑 .\\autotest.cmd --skip-audit 复验。\n'
    : '\n未全部完成：按上面的失败项处理后重跑（改写与封印是幂等的）。\n')
  return code
}

process.exitCode = main(process.argv)
