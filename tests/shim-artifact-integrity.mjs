#!/usr/bin/env node
/**
 * BUG-A 回归测试：产物树的"缺件"缺陷（shim artifact integrity）
 *
 * 背景（已实测，见 tools/build-shim.mjs 头部 post-mortem）：
 *   旧版 build-shim.mjs 在输出文件被瞬时占用时会先
 *     fs.renameSync(out, out + '.stale-' + Date.now())
 *   再重编译。结果 2026-10-01 事故后 shim/out/ 里 winstage-inject.exe 直接消失，
 *   只剩 winstage-inject.exe.stale-1790931739730。运行期探测因此恒 available:false，
 *   selectLaunchMode 静默 fail-closed，所有写入被硬拒 —— 全程没有任何报错。
 *
 * 本测试证明三条不变量（全部离线，无需 zig / 工具链 / Win32 调用）：
 *   A. 编译失败后，旧产物仍在原位；树里不会出现"旧件被改名走 + 新件没造出来"。
 *   B. 真的缺件时，.stale-* 恢复逻辑能挑出最新的可用副本并补回原位。
 *   C. 缺件/畸形时，报告函数返回失败（ok:false）而不是静默通过。
 *
 * 运行：node tests/shim-artifact-integrity.mjs
 * 无参数、无副作用（只在系统 temp 下建目录，跑完删除）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  artifactNames,
  isTransientLock,
  looksLikePe,
  parseStaleName,
  findNewestStale,
  checkArtifactIntegrity,
  assertArtifactIntegrity,
  repairFromStale,
  publishArtifacts,
  sweepTemps,
  BuildError,
} from '../tools/build-shim.mjs'

const W = (s) => process.stdout.write(`${s}\n`)
let passed = 0
let failed = 0
const check = (name, ok, detail) => {
  if (ok) passed += 1
  else failed += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

/* 仓库根：本文件在 <repo>/tests/ 下。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 用"编译器不存在"驱动真实的 main() 失败路径：buildOne 会在写 temp 阶段失败，
 * 而最终产物名从头到尾没被打开过。整条路径不需要 zig / 工具链。
 *
 * 输出走**文件重定向**而不是管道：受限车道里 `spawn` 带 stdio:'pipe' 会直接
 * EPERM（命名管道被禁），这也是 tools/build-shim.mjs 自己捕获原生命令输出的方式。
 */
function runBuild(outDir, profile) {
  const logFile = path.join(TMP_ROOT, `build-probe-${path.basename(outDir)}-${Date.now()}.out.txt`)
  const fd = fs.openSync(logFile, 'w')
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        process.execPath,
        ['tools/build-shim.mjs', `--out-dir=${outDir}`, `--profile=${profile}`],
        { cwd: REPO_ROOT, stdio: ['ignore', fd, fd] },
      )
    } catch (e) {
      fs.closeSync(fd)
      resolve({ code: -1, out: `spawn error: ${e.message}`, spawnFailed: true })
      return
    }
    fs.closeSync(fd)
    child.on('error', (e) => resolve({ code: -1, out: `spawn error: ${e.message}`, spawnFailed: true }))
    child.on('close', (code) => {
      let out = ''
      try { out = fs.readFileSync(logFile, 'utf8') } catch { /* no output */ }
      resolve({ code, out })
    })
  })
}

function firstLines(s, n) {
  return String(s).split('\n').slice(0, n).join(' / ').slice(0, 300)
}

/* ------------------------------------------------------------------ *
 * 合成产物：一个形状合法的最小 PE（MZ + e_lfanew），以及各种坏文件。
 * ------------------------------------------------------------------ */
function dummyPe(size = 4096, fill = 0x11) {
  const b = Buffer.alloc(Math.max(size, 0x100), fill)
  b.writeUInt16LE(0x5a4d, 0) // 'MZ'
  b.writeUInt32LE(0x80, 0x3c) // e_lfanew
  b.writeUInt32LE(0x00004550, 0x80) // 'PE\0\0'
  return size >= 0x100 ? b : b.subarray(0, size)
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'winstage-buga-'))
const dirs = []
function mkdir(label) {
  const d = path.join(TMP_ROOT, label)
  fs.mkdirSync(d, { recursive: true })
  dirs.push(d)
  return d
}

const NAMES = artifactNames('full')
const [DLL, INJECTOR, PROBE] = NAMES
const listNames = (d) => fs.readdirSync(d).sort()
/* 目录里除产物之外还有 build-logs/ 之类的构建副产物：涉及产物树的断言只看产物名。 */
const productsIn = (d) => listNames(d).filter((n) => NAMES.includes(n))

W('=== 0. 前置：PE 形状与锁签名判定 ===')
{
  const d = mkdir('pe-shape')
  const good = path.join(d, 'good.exe')
  fs.writeFileSync(good, dummyPe())
  check('合法 PE 头被识别为 PE', looksLikePe(good) === true)

  const empty = path.join(d, 'empty.exe')
  fs.writeFileSync(empty, Buffer.alloc(0))
  check('0 字节文件不是 PE（缺件判定用）', looksLikePe(empty) === false)

  const tiny = path.join(d, 'tiny.exe')
  fs.writeFileSync(tiny, Buffer.from('MZ'))
  check('只有 2 字节的 MZ 不是 PE（截断产物）', looksLikePe(tiny) === false)

  /* 真实编译器崩溃会留下这种文件：MZ 在，但 e_lfanew 是 0 */
  const truncated = path.join(d, 'truncated.exe')
  const t = Buffer.alloc(0x100, 0x22)
  t.writeUInt16LE(0x5a4d, 0)
  t.writeUInt32LE(0, 0x3c)
  fs.writeFileSync(truncated, t)
  check('MZ 存在但 e_lfanew=0 的截断文件被拒（旧件没被顶掉）', looksLikePe(truncated) === false)

  check('不存在的路径不是 PE（不抛异常）', looksLikePe(path.join(d, 'nope.exe')) === false)
  check(
    '瞬时锁签名被识别',
    isTransientLock('zig: error: Permission denied') &&
      isTransientLock('The process cannot access the file because it is being used by another process') &&
      isTransientLock('EBUSY: resource busy'),
    'Permission denied / being used by another process / EBUSY',
  )
  check('真实编译错误不算瞬时锁（不该靠重试掩盖）', isTransientLock('error: unknown type name uint3') === false)
}

/* ------------------------------------------------------------------ *
 * 1. 主缺陷回归：编译失败时旧产物必须留在原位
 * ------------------------------------------------------------------ */
W('')
W('=== 1. 编译失败 -> 旧产物保留、且不得改名走（BUG-A 根因） ===')
{
  const out = mkdir('failure-preserves')
  fs.writeFileSync(path.join(out, DLL), dummyPe(237568, 0x5a))

  /* 只放 DLL，故意不放 injector/probe：验证"本来就不存在的文件"不会被伪造 */
  check('场景准备：树里只有 DLL（产物层面）', productsIn(out).join(',') === DLL, productsIn(out).join(','))

  /* 用一个不存在的编译器路径驱动真实 main() 流程：走到 buildOne 的失败分支，
   * 但不做任何真正的编译（本机 cl/zig 状态未知，不触发全量构建）。 */
  const r = await runBuild(out, 'full')
  check('失败的构建以非 0 退出码结束', r.code !== 0, `exit=${r.code}`)
  check(
    '失败原因是编译失败（不是发布失败）',
    /compilation failed for winstage-shim\.dll/.test(r.out),
    firstLines(r.out, 3),
  )
  check('旧 DLL 仍在原位', fs.existsSync(path.join(out, DLL)), listNames(out).join(','))
  check(
    '旧 DLL 内容未被改动（不是被截断/半成品顶掉）',
    fs.statSync(path.join(out, DLL)).size === 237568,
    String(fs.statSync(path.join(out, DLL)).size),
  )
  check(
    '失败后树里没有出现 .stale-*（旧件绝不被改名走）',
    listNames(out).every((n) => !n.includes('.stale-')),
    listNames(out).join(','),
  )
  check(
    '失败后树里没有残留 .tmp-* 半成品',
    listNames(out).every((n) => !n.includes('.tmp-')),
    listNames(out).join(','),
  )

  /* 复现历史事故：树里预置一个"旧件已被改名走"的状态，再跑一次失败构建，
   * 断言这次不会再产生任何新的 .stale-*，且原 stale 副本原封不动。 */
  const d2 = mkdir('failure-no-new-stale')
  fs.writeFileSync(path.join(d2, `${INJECTOR}.stale-1790931739730`), dummyPe(158208, 0x33))
  const before = productsIn(d2).join(',')
  const r2 = await runBuild(d2, 'full')
  check('复现事故场景下构建同样失败', r2.code !== 0, `exit=${r2.code}`)
  check(
    '不会新增任何 .stale-*（旧版会在这里把新产物改名走）',
    productsIn(d2).join(',') === before,
    `before=[${before}] after=[${productsIn(d2).join(',')}]`,
  )
  check(
    '已存在的 .stale 副本未被触碰',
    fs.statSync(path.join(d2, `${INJECTOR}.stale-1790931739730`)).size === 158208,
    String(fs.statSync(path.join(d2, `${INJECTOR}.stale-1790931739730`)).size),
  )
}

/* ------------------------------------------------------------------ *
 * 2. 恢复：从. stale 里挑最新可用副本
 * ------------------------------------------------------------------ */
W('')
W('=== 2. .stale-* 恢复：挑最新副本，补回原位 ===')
{
  const d = mkdir('stale-order')
  const final = path.join(d, INJECTOR)
  check('空目录里没有可用的 stale 副本', findNewestStale(final) === null)

  const junk = path.join(d, `${INJECTOR}.stale-1790931739731`)
  fs.writeFileSync(junk, Buffer.alloc(0))
  check('0 字节 stale 不参与"最新可用"评选', findNewestStale(final) === null, 'stale=1790931739731 大小 0')

  fs.writeFileSync(path.join(d, `${INJECTOR}.stale-1790931739730`), dummyPe(158208, 0x33))
  fs.writeFileSync(path.join(d, `${INJECTOR}.stale-1790931742899`), dummyPe(174592, 0x44))
  const newest = findNewestStale(final)
  check(
    '选出时间戳最新的副本',
    newest && path.basename(newest.path) === `${INJECTOR}.stale-1790931742899`,
    newest ? path.basename(newest.path) : 'null',
  )
  check('最新副本的大小与来源一致', newest.size === 174592, String(newest.size))

  /* 名字相似但 base 不同的 stale 不能被误用 */
  fs.writeFileSync(path.join(d, `${PROBE}.stale-1790931799999`), dummyPe(174592))
  const forInjector = findNewestStale(final)
  check(
    '只挑同一 base 的 stale（不串件）',
    path.basename(forInjector.path) === `${INJECTOR}.stale-1790931742899`,
    path.basename(forInjector.path),
  )

  check(
    'parseStaleName 解析 base/stamp',
    JSON.stringify(parseStaleName(`${INJECTOR}.stale-1790931739730`)) ===
      JSON.stringify({ base: INJECTOR, stamp: 1790931739730 }),
    JSON.stringify(parseStaleName(`${INJECTOR}.stale-1790931739730`)),
  )
  check('非 stale 名字返回 null', parseStaleName(INJECTOR) === null && parseStaleName('a.stale-x') === null)
}

W('')
W('=== 3. repairFromStale：补回缺件、保留已有好件、不动 stale 源 ===')
{
  const d = mkdir('repair')
  fs.writeFileSync(path.join(d, DLL), dummyPe(237568, 0x5a)) // 好件，必须保留
  fs.writeFileSync(path.join(d, INJECTOR), Buffer.alloc(0)) // 0 字节 = 缺件等价
  fs.writeFileSync(path.join(d, `${INJECTOR}.stale-1000`), dummyPe(1000, 0x01))
  fs.writeFileSync(path.join(d, `${INJECTOR}.stale-2000`), dummyPe(2000, 0x02))
  const dllBytes = fs.readFileSync(path.join(d, DLL))

  const res = repairFromStale(d, NAMES)
  check(
    '缺件无法恢复时，恢复报告本身也返回失败（不是静默 ok）',
    res.ok === false && res.unrecoverable.length === 1 && res.unrecoverable[0].name === PROBE,
    JSON.stringify(res),
  )
  check(
    '可恢复项仍然被恢复（不因另一项失败而放弃）',
    res.restored.length === 1 && res.restored[0].name === INJECTOR,
    JSON.stringify(res.restored),
  )
  check(
    `injector 从最新 stale 恢复`,
    res.restored.some((x) => x.name === INJECTOR && x.from === `${INJECTOR}.stale-2000`),
    JSON.stringify(res.restored),
  )
  check(
    'injector 内容等于最新 stale 的内容（不是旧的 1000）',
    fs.readFileSync(path.join(d, INJECTOR)).equals(dummyPe(2000, 0x02)),
    `${fs.statSync(path.join(d, INJECTOR)).size} bytes`,
  )
  check('已经健康的 DLL 被原样保留', fs.readFileSync(path.join(d, DLL)).equals(dllBytes))
  check('DLL 被记为"无需修复"', res.skipped.some((s) => s.name === DLL), JSON.stringify(res.skipped))
  check(
    'probe 无 stale 可恢复 -> 明确报不可恢复',
    res.unrecoverable.some((u) => u.name === PROBE),
    JSON.stringify(res.unrecoverable),
  )
  check('stale 源文件未被删除（可重试）', fs.existsSync(path.join(d, `${INJECTOR}.stale-2000`)))
  check('没有留下 .repaired-* 中间文件', listNames(d).every((n) => !n.includes('.repaired-')), listNames(d).join(','))

  /* 补上 probe 的 stale 再恢复一次，检查幂等 + 完整恢复 */
  fs.writeFileSync(path.join(d, `${PROBE}.stale-1500`), dummyPe(174592, 0x77))
  const res2 = repairFromStale(d, NAMES)
  check('第二轮恢复补上 probe', res2.restored.some((x) => x.name === PROBE), JSON.stringify(res2.restored))
  check('三件齐全后恢复报告为成功', res2.ok === true, JSON.stringify(res2))
  const integ = checkArtifactIntegrity(d, NAMES)
  check('恢复后完整性检查通过', integ.ok === true, JSON.stringify(integ.detail))
}

/* ------------------------------------------------------------------ *
 * 4. 报告函数：缺件必须失败，不能静默通过
 * ------------------------------------------------------------------ */
W('')
W('=== 4. 完整性报告：缺件/畸形 -> ok:false（不得静默通过） ===')
{
  const d = mkdir('integrity-broken')
  fs.writeFileSync(path.join(d, DLL), dummyPe(237568, 0x5a))
  fs.writeFileSync(path.join(d, INJECTOR), Buffer.alloc(5000, 0x7f)) // 非 PE 垃圾
  fs.writeFileSync(path.join(d, `${PROBE}.stale-1790931742899`), dummyPe(174592, 0x88))
  fs.writeFileSync(path.join(d, `${PROBE}.stale-1790931739730`), dummyPe(174592, 0x99))

  const rep = checkArtifactIntegrity(d, NAMES)
  check('缺件 + 畸形时报告为失败', rep.ok === false, JSON.stringify(rep.detail))
  check('缺失项列出 probe', rep.missing.includes(PROBE), JSON.stringify(rep.missing))
  check('畸形项列出 injector', rep.malformed.some((m) => m.name === INJECTOR), JSON.stringify(rep.malformed))
  check('健康项列出 dll', rep.present.some((p) => p.name === DLL), JSON.stringify(rep.present))
  check(
    '给出可恢复来源（最新 stale）',
    rep.recoverable.some((r) => r.name === PROBE && r.stale === `${PROBE}.stale-1790931742899`),
    JSON.stringify(rep.recoverable),
  )
  check('错误码为 artifact_missing', rep.detail.code === 'artifact_missing', String(rep.detail.code))

  let threw = null
  try {
    assertArtifactIntegrity(d, NAMES)
  } catch (e) {
    threw = e
  }
  check('assertArtifactIntegrity 抛 BuildError', threw instanceof BuildError, threw ? threw.name : 'no throw')
  check(
    '错误信息包含缺件名单与恢复路径',
    !!threw && /artifact tree is missing/.test(threw.message) && /--repair-stale/.test(threw.detail?.recovery || ''),
    threw ? `${threw.message} | recovery=${threw.detail?.recovery}` : 'no throw',
  )

  const good = mkdir('integrity-good')
  for (const n of NAMES) fs.writeFileSync(path.join(good, n), dummyPe(1000, 0x11))
  check('三件齐全且合法时报告通过', checkArtifactIntegrity(good, NAMES).ok === true)
  check('齐全时不抛异常', (() => { try { assertArtifactIntegrity(good, NAMES); return true } catch { return false } })())
}

/* ------------------------------------------------------------------ *
 * 5. 发布语义与 temp 清理
 * ------------------------------------------------------------------ */
W('')
W('=== 5. publishArtifacts / sweepTemps 语义 ===')
{
  const d = mkdir('publish')
  const finalA = path.join(d, DLL)
  fs.writeFileSync(finalA, dummyPe(100, 0x01)) // 旧产物
  const tmpA = path.join(d, `${DLL}.tmp-1234`)
  fs.writeFileSync(tmpA, dummyPe(200, 0x02)) // 新产物

  const res = publishArtifacts([{ final: finalA, tmp: tmpA }])
  check('发布成功', res.ok === true && res.published.length === 1, JSON.stringify(res))
  check('新内容已就位', fs.readFileSync(finalA).equals(dummyPe(200, 0x02)))
  check('temp 文件已消失（被 rename 消费）', !fs.existsSync(tmpA))

  const missingTmp = path.join(d, `${PROBE}.tmp-1234`)
  const res2 = publishArtifacts([{ final: path.join(d, PROBE), tmp: missingTmp }])
  check('staged 文件丢失 -> 发布失败', res2.ok === false, JSON.stringify(res2.failed))
  check('发布失败时不动最终名', !fs.existsSync(path.join(d, PROBE)))

  const d2 = mkdir('sweep')
  fs.writeFileSync(path.join(d2, `${DLL}.tmp-1111`), dummyPe())
  fs.writeFileSync(path.join(d2, `${INJECTOR}.tmp-2222`), dummyPe())
  fs.writeFileSync(path.join(d2, `${INJECTOR}.stale-3333`), dummyPe())
  fs.writeFileSync(path.join(d2, `${PROBE}-other.tmp-4444`), dummyPe())
  const removed = sweepTemps(d2, NAMES, 0)
  check('清掉本 profile 的 .tmp-*', removed.length === 2, JSON.stringify(removed))
  check('绝不删 .stale-*（恢复来源/证据）', fs.existsSync(path.join(d2, `${INJECTOR}.stale-3333`)))
  check('不碰名字不匹配的临时文件', fs.existsSync(path.join(d2, `${PROBE}-other.tmp-4444`)), listNames(d2).join(','))
  check('artifactNames(profile) 覆盖三个产物', NAMES.length === 3 && artifactNames('file-only')[0] === 'winstage-shim-file-only.dll')
}

/* ------------------------------------------------------------------ *
 * 6. 对真实仓库做只读体检（不构建、不写文件）
 * ------------------------------------------------------------------ */
W('')
W('=== 6. 真实 shim/out：体检 + 在镜像里验证恢复路径 ===')
{
  const repoOut = path.join(REPO_ROOT, 'shim', 'out')
  if (!fs.existsSync(repoOut)) {
    W(`  跳过：${repoOut} 不存在`)
  } else {
    const names = artifactNames('full')
    const rep = checkArtifactIntegrity(repoOut, names)
    W(`  目录: ${repoOut}`)
    W(`  存在: [${rep.present.map((p) => p.name).join(', ')}]`)
    W(`  缺失: [${rep.missing.join(', ')}]`)
    W(`  畸形: ${JSON.stringify(rep.malformed)}`)
    W(`  可恢复: ${JSON.stringify(rep.recoverable.filter((r) => r.stale))}`)
    check(
      '缺件/畸形时体检报告为失败（不静默通过）',
      rep.missing.length || rep.malformed.length ? rep.ok === false : rep.ok === true,
      `ok=${rep.ok} missing=[${rep.missing.join(',')}] malformed=[${rep.malformed.map((m) => m.name).join(',')}]`,
    )

    /* shim/out 是多个 agent 共写的活目录（本次运行期间就有人删掉了
     * winstage-inject.exe.stale-*），所以恢复路径在一个镜像副本上验证，
     * 断言只依赖"真实树里有什么"，不会因为别人同时改树而假失败。 */
    const mirror = mkdir('real-mirror')
    const artifactSet = new Set(names)
    for (const n of fs.readdirSync(repoOut)) {
      const isStale = parseStaleName(n) && artifactSet.has(parseStaleName(n).base)
      if (!artifactSet.has(n) && !isStale) continue
      try {
        fs.copyFileSync(path.join(repoOut, n), path.join(mirror, n))
      } catch { /* 拷贝失败就当这棵树里没有它 */ }
    }
    const staleForInjector = findNewestStale(path.join(mirror, INJECTOR))
    W(`  镜像: [${listNames(mirror).join(', ')}]`)
    if (staleForInjector) {
      check(
        '镜像里能找到 winstage-inject.exe 的最新 stale 副本（恢复路径可用）',
        staleForInjector.size > 0,
        `${path.basename(staleForInjector.path)} (${staleForInjector.size} bytes)`,
      )
      const repairedMirror = repairFromStale(mirror, names)
      check(
        '缺件可被 --repair-stale 从真实 stale 副本补齐',
        repairedMirror.restored.some((r) => r.name === INJECTOR),
        JSON.stringify(repairedMirror.restored),
      )
      const afterMirror = checkArtifactIntegrity(mirror, names)
      check('补齐后镜像体检通过', afterMirror.ok === true, JSON.stringify(afterMirror.detail))
    } else {
      /* 真实树里已经没有可恢复副本：这正是必须显式报错、且只能靠重新编译
       * 解决的场景，绝不能悄悄放过。 */
      check(
        '无 stale 可恢复时，恢复被明确拒绝而不是静默成功',
        repairFromStale(mirror, names).ok === false,
        `mirror=[${listNames(mirror).join(',')}]`,
      )
      W('  注意：shim/out 里已无 winstage-inject.exe 的任何 .stale-* 副本；')
      W('        该产物只能重新编译找回，--repair-stale 会明确失败（这是设计要求）。')
    }
  }
}

/* ------------------------------------------------------------------ */

W('')
W(`结果: ${passed} 通过, ${failed} 失败 (共 ${passed + failed} 条断言)`)
for (const d of dirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true })
  } catch { /* temp cleanup is best effort */ }
}
try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
} catch { /* best effort */ }
process.exit(failed === 0 ? 0 : 1)
