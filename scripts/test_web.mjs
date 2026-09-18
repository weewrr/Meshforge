/**
 * 前端纯函数单元测试（优化文档 5.2）——零新增依赖。
 *
 * 原理：用 vite 自带的 `esbuild`（hoist 到顶层 node_modules）把目标 .ts 模块
 * 在内存里转译成 CommonJS，再用自制 loader 执行——从而让 Node 直接 import
 * 渲染层源码，不必为了测试引入 vitest/jest。
 *
 * 覆盖点：
 * - `src/api/http.ts` 的 fullUrl：绝对地址 / blob: 透传，相对路径拼 API_BASE；
 * - `src/api/http.ts` 的 initApiBase：无桥接环境保持默认端口；
 * - `src/i18n` 的 translate：命中 / 英文回退 / 未命中返回 key / {var} 插值；
 * - `src/stores/app` 的 load() 旧版设置迁移（showMetrics → 四个独立开关）。
 *
 * 运行：`npm run test:web`（已接入 `npm test`）。
 */

import { transformSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const SRC_ROOT = path.resolve(import.meta.dirname, '..', 'src')

// ─── 迷你 CJS loader：内存转译 TS + 解析无扩展名相对导入 ───────────────────────

/** 预置的模块覆盖表（key = 绝对路径），供测试注入桩模块。 */
const overrides = new Map()
const cache = new Map()

/** 解析相对导入到真实 .ts 文件（支持无扩展名与目录 index）。 */
function resolveTs(specifier, importerFile) {
  const base = path.resolve(path.dirname(importerFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

/** 执行一个 TS 模块（CJS 包装），返回其 exports。 */
function loadTs(file) {
  if (cache.has(file)) return cache.get(file).exports
  if (overrides.has(file)) {
    const mod = { exports: overrides.get(file) }
    cache.set(file, mod)
    return mod.exports
  }
  const source = fs.readFileSync(file, 'utf8')
  const js = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022'
  }).code

  const mod = { exports: {} }
  cache.set(file, mod)
  const customRequire = (spec) => {
    const resolved = resolveTs(spec, file)
    if (resolved) return loadTs(resolved)
    return require(spec) // node_modules（react / zustand 等）
  }
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', js)
  fn(mod.exports, customRequire, mod, file, path.dirname(file))
  return mod.exports
}

/** 按相对 src 的路径加载，如 loadSrc('api/http.ts')。 */
function loadSrc(rel) {
  return loadTs(path.join(SRC_ROOT, rel))
}

/** 清空模块缓存后重新加载：让依赖 localStorage 初始内容的模块级代码重跑。 */
function freshLoadSrc(rel) {
  cache.clear()
  return loadSrc(rel)
}

// ─── 测试环境：localStorage / DOM 桩（app store 的 load() 与 applyUi 依赖） ────

const storageMap = new Map()
globalThis.localStorage = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k)
}
const documentElement = { classList: { toggle() {} }, style: {}, dataset: {}, lang: '' }
globalThis.window = {}
globalThis.document = { documentElement }

// ─── 用例 ─────────────────────────────────────────────────────────────────────

const RESULTS = []
async function test(name, fn) {
  try {
    await fn()
    RESULTS.push([name, true, ''])
    console.log(`PASS ${name}`)
  } catch (e) {
    RESULTS.push([name, false, `${e.name}: ${e.message}`])
    console.log(`FAIL ${name}: ${e.name}: ${e.message}`)
  }
}

// 1) fullUrl：绝对地址与 blob: 透传，相对路径拼上 API_BASE。
await test('fullUrl passthrough and base join', () => {
  const http = loadSrc('api/http.ts')
  assert.equal(http.fullUrl('https://example.com/a.glb'), 'https://example.com/a.glb')
  assert.equal(http.fullUrl('http://127.0.0.1:8766/x'), 'http://127.0.0.1:8766/x')
  assert.equal(http.fullUrl('blob:uuid-123'), 'blob:uuid-123')
  assert.equal(http.fullUrl('/workspace/out.glb'), `${http.API_BASE}/workspace/out.glb`)
  assert.equal(http.fullUrl('relative/file.png'), `${http.API_BASE}relative/file.png`)
})

// 2) initApiBase：Node 无 window 桥接 → 静默保持默认端口。
await test('initApiBase keeps default without bridge', async () => {
  const http = loadSrc('api/http.ts')
  await http.initApiBase()
  assert.equal(http.API_BASE, 'http://127.0.0.1:8766')
})

// 3) i18n：注入可控的双语字典，验证回退与插值逻辑。
await test('translate: zh hit / en fallback / missing key / interpolation', () => {
  // 覆盖真实字典（resolveTs 的结果路径）：只测回退逻辑本身。
  overrides.set(path.join(SRC_ROOT, 'i18n', 'en.ts'), { en: { hello: 'Hello {name}!', onlyEn: 'EN only' } })
  overrides.set(path.join(SRC_ROOT, 'i18n', 'zh.ts'), { zh: { hello: '你好 {name}！' } })
  const i18n = loadSrc('i18n/index.ts')
  assert.equal(i18n.translate('zh', 'hello', { name: '世界' }), '你好 世界！')
  assert.equal(i18n.translate('en', 'hello', { name: 'World' }), 'Hello World!')
  // zh 缺失 → 回退英文。
  assert.equal(i18n.translate('zh', 'onlyEn'), 'EN only')
  // 两边都缺 → 返回 key 本身（界面不空白，缺配一眼可见）。
  assert.equal(i18n.translate('zh', 'no.such.key'), 'no.such.key')
  // 未提供的占位符原样保留。
  assert.equal(i18n.translate('en', 'hello'), 'Hello {name}!')
})

// 4) app store 旧版设置迁移：单一 showMetrics 开关 → 四个独立开关，敏感字段清除。
await test('app store migrates legacy showMetrics and strips secrets', () => {
  storageMap.set(
    'meshforge.settings',
    JSON.stringify({ showMetrics: false, hfToken: 'legacy-secret', theme: 'light' })
  )
  const { useAppStore } = freshLoadSrc('stores/app.ts')
  const s = useAppStore.getState()
  assert.equal(s.showCpu, false)
  assert.equal(s.showRam, false)
  assert.equal(s.showVram, false)
  assert.equal(s.showGpu, false)
  assert.equal(s.hfToken, '', '明文凭据不得从 localStorage 恢复（回退默认空串）')
  // 未覆盖字段仍取默认值。
  assert.ok(typeof s.locale === 'string')
})

// 5) 迁移后 patch 正常写回（不把旧字段带回 localStorage）。
await test('app store patch persists without legacy fields', () => {
  storageMap.set('meshforge.settings', JSON.stringify({ showMetrics: true }))
  const { useAppStore } = freshLoadSrc('stores/app.ts')
  assert.equal(useAppStore.getState().showCpu, true)
  useAppStore.getState().patch({ showGpu: false })
  const saved = JSON.parse(storageMap.get('meshforge.settings'))
  assert.equal(saved.showGpu, false)
  assert.ok(!('showMetrics' in saved), '旧字段不得被写回')
})

// 6) staleAssets：旧版磁盘路径 / 临时转换目录判为过期，uploads 持久产物放行。
await test('staleAssets distinguishes legacy paths from persistent uploads', () => {
  const m = loadSrc('pages/generate/staleAssets.ts')
  const upload = `/optimize/serve-file?path=${encodeURIComponent('C:/d/workspace/uploads/' + 'a'.repeat(32) + '.glb')}`
  const legacy = `/optimize/serve-file?path=${encodeURIComponent('D:/github/model.glb')}`
  const tempDir = `/optimize/serve-file?path=${encodeURIComponent('C:/Temp/meshforge_import_xyz/mesh.glb')}`
  assert.equal(m.isStaleServeFileUrl(upload), false, 'uploads 内持久产物有效')
  assert.equal(m.isStaleServeFileUrl(legacy), true, 'workspace 外旧路径已失效')
  assert.equal(m.isStaleServeFileUrl(tempDir), true, '临时转换目录已失效')
  assert.equal(m.isStaleServeFileUrl('/files/job/out.glb'), false, '非 serve-file 引用不扫描')
  assert.equal(m.isStaleServeFileUrl(undefined), false)
  // 节点扫描：返回去重后的 label 列表。
  const labels = m.findStaleAssetRefs([
    { data: { label: 'mesh', params: { url: legacy } } },
    { data: { label: 'mesh', params: { url: tempDir } } },
    { data: { label: 'ok', params: { url: upload } } }
  ])
  assert.deepEqual(labels, ['mesh'])
})

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

const failed = RESULTS.filter(([, ok]) => !ok)
console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} passed`)
process.exit(failed.length ? 1 : 0)
