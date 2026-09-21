/**
 * 工作流节点 UI 渲染测试（SSR）—— 零新增依赖。
 *
 * 目标：补上 `test_nodes.mjs`（执行语义）与 `test_web.mjs`（纯逻辑）之外的空
 * 白——**节点控件的可见输出**。用 esbuild 把 `.tsx` 在内存里转成 CJS，经自制
 * loader 执行，再用 `react-dom/server` 把节点组件渲染成 HTML 字符串来断言结构。
 *
 * 本次覆盖的回归（用户反馈）：
 *   1. imageNode 选了图之后**只显示文件名**，没有把图片回显出来；
 *   2. 选了图之后**没有清空途径**，只能重新选一张覆盖旧的；
 *   3. 生视图模型的节点上「显存」变成一个改了没用的文本输入框；
 *      采样步数 / 随机种子也不该摆输入框（默认值够用，改值走引脚）。
 *
 * 运行：`npm run test:ui`（已接入 `npm test`）。
 */

import { transformSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const SRC_ROOT = path.resolve(import.meta.dirname, '..', 'src')

// ─── 迷你 CJS loader（与 test_nodes.mjs 同源，额外支持 .tsx）──────────────────

const overrides = new Map()
const cache = new Map()

/** 解析相对导入到真实文件（支持无扩展名、.ts/.tsx 与目录 index）。 */
function resolveTs(specifier, importerFile) {
  const base = path.resolve(path.dirname(importerFile), specifier)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

/** 执行一个 TS/TSX 模块（CJS 包装），返回其 exports。 */
function loadTs(file) {
  if (cache.has(file)) return cache.get(file).exports
  if (overrides.has(file)) {
    const mod = { exports: overrides.get(file) }
    cache.set(file, mod)
    return mod.exports
  }
  const isTsx = file.endsWith('.tsx')
  const js = transformSync(fs.readFileSync(file, 'utf8'), {
    loader: isTsx ? 'tsx' : 'ts',
    format: 'cjs',
    target: 'es2022',
    // 源码用现代 JSX，不显式 import React——交给 automatic runtime 注入。
    jsx: 'automatic'
  }).code
  const mod = { exports: {} }
  cache.set(file, mod)
  const customRequire = (spec) => {
    const resolved = resolveTs(spec, file)
    if (resolved) return loadTs(resolved)
    return require(spec)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports, customRequire, mod, file, path.dirname(file)
  )
  return mod.exports
}

const srcPath = (...segs) => path.join(SRC_ROOT, ...segs)

// ─── 桩 ───────────────────────────────────────────────────────────────────────

/**
 * i18n 桩：返回 key 本身，并把插值变量拼在方括号里（如 `k[a=1]`）。
 * 这样断言既能看用了哪个键，也能看模板变量有没有真的传进去。
 */
const stubT = (key, vars) =>
  vars ? `${key}[${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}]` : key

overrides.set(srcPath('i18n', 'index.ts'), {
  getT: stubT,
  useT: () => stubT,
  translate: stubT
})

/** api 桩：只关心 fullUrl（缩略图 src 的基址拼接）；导入走内存返回值。 */
overrides.set(srcPath('api', 'index.ts'), {
  fullUrl: (u) => `https://test.local${u}`,
  importImageByPath: async () => ({ url: '/files/picked.png', fileName: 'picked.png' }),
  importMeshByPath: async () => ({ url: '/files/picked.glb' })
})

// ─── 渲染工具 ─────────────────────────────────────────────────────────────────

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const { ImageFileButton } = loadTs(srcPath('pages', 'workflows', 'nodes', 'primitives.tsx'))

/** 渲染 ImageFileButton，返回 HTML 字符串。 */
const render = (props) => renderToStaticMarkup(React.createElement(ImageFileButton, props))

const SELECT_IMAGE = 'workflows.nodes.selectImage'

// ─── 用例 ─────────────────────────────────────────────────────────────────────

const results = []
function check(name, fn) {
  try {
    fn()
    results.push([name, true])
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push([name, false])
    console.log(`FAIL ${name}: ${err.message}`)
    console.log(`::error::${name}: ${err.message}`)
  }
}

check('未选图：不渲染缩略图 / 清除按钮，文案为「选择图片」', () => {
  const html = render({ nodeId: 'n1', label: SELECT_IMAGE, current: '', url: '' })
  assert.ok(!html.includes('<img'), `不该出现 <img>：${html}`)
  assert.ok(!html.includes('wf-upload__clear'), '不该出现清除按钮')
  assert.ok(html.includes('workflows.nodes.noFileSelected'), '应显示「未选择文件」')
  assert.ok(html.includes(SELECT_IMAGE), '按钮文案应为 selectImage')
})

check('已选图：回显缩略图（src 经 fullUrl 拼基址）', () => {
  const html = render({ nodeId: 'n1', label: SELECT_IMAGE, current: 'cat.png', url: '/files/cat.png' })
  assert.ok(html.includes('<img'), `应渲染缩略图：${html}`)
  assert.ok(
    html.includes('https://test.local/files/cat.png'),
    '缩略图 src 应经 fullUrl 拼接基址'
  )
})

check('已选图：给出清除入口，文案切到「更换图片」', () => {
  const html = render({ nodeId: 'n1', label: SELECT_IMAGE, current: 'cat.png', url: '/files/cat.png' })
  assert.ok(html.includes('wf-upload__clear'), '应有清除按钮')
  assert.ok(html.includes('workflows.nodes.clearImage'), '清除按钮应带 clearImage 标签')
  assert.ok(html.includes('workflows.nodes.replaceImage'), '按钮文案应切到 replaceImage')
  assert.ok(!html.includes(SELECT_IMAGE), '已选图后不应再显示「选择图片」')
})

check('已选图：文件名仍然显示在缩略图下方', () => {
  const html = render({ nodeId: 'n1', label: SELECT_IMAGE, current: 'cat.png', url: '/files/cat.png' })
  assert.ok(html.includes('cat.png'), '应保留文件名展示')
  assert.ok(!html.includes('workflows.nodes.noFileSelected'), '不该再显示「未选择文件」')
})

check('清除按钮带 nodrag，且缩略图 alt 有兜底', () => {
  const html = render({ nodeId: 'n1', label: SELECT_IMAGE, current: 'cat.png', url: '/files/cat.png' })
  assert.ok(/class="wf-upload__clear nodrag"/.test(html), `清除按钮应带 nodrag：${html}`)
  assert.ok(/<img[^>]*alt="cat\.png"/.test(html), `img 的 alt 应为文件名：${html}`)
})

// ─── 扩展节点参数区（生视图模型：无意义输入框回归）──────────────────────────
//
// 用户反馈：生视图模型的 3 个节点上，「显存」渲染成一个改了没用的文本输入框；
// 采样步数 / 随机种子也不该摆输入框——默认值够用，要改从引脚喂变量。
//
// 根因有两处，这里分别锁住：
//   a. 后端 `type: 'label'` 的说明型参数掉进了默认文本输入分支 → 渲染假输入框；
//   b. 参数没有"只要引脚、不要输入框"的表达方式 → 每个参数都必然带一个框。

const { setExtensionsCache } = loadTs(srcPath('types.ts'))
const { ExtensionNode } = loadTs(srcPath('pages', 'workflows', 'nodes', 'extension.tsx'))
const { ReactFlowProvider } = require('@xyflow/react')

/** 造一个扩展节点并渲染成 HTML。Handle 依赖 React Flow 的 store，故需 Provider 包裹。
 *
 *  `initialEdges` 用来给 store 播种连线：`ReactFlowProvider` 是 `useState(() => createStore({...}))`
 *  同步建库的，所以 SSR（无 useEffect）下 `useStore((s) => s.edges)` 也能读到 ——
 *  折叠态「只留已连接引脚」这条行为因此可以真渲染验证，而不必靠读源码猜。 */
function renderExtension(params, dataParams = {}, initialEdges = []) {
  setExtensionsCache([
    { id: 'ext-test', display_name: '测试模型', kind: 'model', input: 'image', output: 'image', category: 'multiview', params }
  ])
  const data = { label: '测试模型', color: '#2dd4bf', extensionId: 'ext-test', params: dataParams }
  return renderToStaticMarkup(
    React.createElement(
      ReactFlowProvider,
      { initialEdges },
      React.createElement(ExtensionNode, { id: 'e1', type: 'extensionNode', data, selected: false, isConnectable: true })
    )
  )
}

check('生视图参数：pin_only 的步数/种子不渲染输入框，只给默认值提示', () => {
  const html = renderExtension([
    { id: 'steps', label: '采样步数', type: 'int', default: 30, pin_only: true },
    { id: 'seed', label: '随机种子', type: 'int', default: -1, pin_only: true }
  ])
  assert.ok(!html.includes('<input'), `不该出现任何输入框：${html}`)
  assert.ok(html.includes('wf-field--pinonly'), '应走仅引脚渲染分支')
  assert.ok(html.includes('workflows.nodes.pinOnlyHintNumber'), '应提示可接入数值变量')
  assert.ok(html.includes('采样步数') && html.includes('随机种子'), '两个参数标签都应保留')
  assert.ok(html.includes('value=30') && html.includes('value=-1'), `默认值应展示出来：${html}`)
})

check('生视图参数：pin_only 参数仍然保留可连线的参数引脚', () => {
  const html = renderExtension([{ id: 'steps', label: '采样步数', type: 'int', default: 30, pin_only: true }])
  assert.ok(html.includes('p:steps'), `参数引脚 p:steps 不该丢：${html}`)
  assert.ok(html.includes('wf-handle--param'), '引脚应带参数引脚样式')
})

check('说明型参数（type=label）渲染为静态文案，不是输入框', () => {
  const html = renderExtension([
    { id: 'vram_note', label: '显存', type: 'label', default: '需 ≥10GB 显存' }
  ])
  assert.ok(!html.includes('<input'), `说明型参数不该生成输入框：${html}`)
  assert.ok(html.includes('wf-param__note'), '应走说明型渲染分支')
  assert.ok(html.includes('需 ≥10GB 显存'), '文案本身要显示出来')
  assert.ok(!html.includes('p:vram_note'), '说明型参数不该产生参数引脚')
})

check('普通数值参数不受影响：依旧渲染输入框（防一刀切回归）', () => {
  const html = renderExtension([{ id: 'octree', label: '八叉树分辨率', type: 'int', default: 256 }])
  assert.ok(html.includes('<input'), `普通参数应仍有输入框：${html}`)
  assert.ok(!html.includes('wf-field--pinonly'), '普通参数不该走仅引脚分支')
})

check('生视图模型实际 schema：显存行彻底消失，步数/种子无输入框', () => {
  const html = renderExtension([
    { id: 'steps', label: '采样步数', type: 'int', default: 30, pin_only: true },
    { id: 'seed', label: '随机种子', type: 'int', default: -1, pin_only: true }
  ], { vram_note: '生视图模型建议 6GB(RTX4050) 用低档参数' })
  assert.ok(!html.includes('显存'), `节点上不该再出现「显存」：${html}`)
  assert.ok(!html.includes('<input'), '不该出现输入框')
})

// ─── 图片参数（type=image）：四视角"手接图片"的端口契约 ──────────────────────
//
// 用户反馈：「MV 节点那 4 个映射输入框去掉，当前问题 4 个都不能手动接入 image」。
// 根因是那 4 个位置是 int 参数，而参数引脚的端口类型恒为 text，图片连线会被
// `validConnection` 直接拒绝。改成 `type: 'image'` 后：不摆输入框、引脚是 image 端口。

check('图片参数（type=image）：不渲染输入框，只留一个可接图片的参数引脚', () => {
  const html = renderExtension([{ id: 'view_front', label: 'Front 视角', type: 'image', default: '' }])
  assert.ok(!html.includes('<input'), `图片参数不该出现输入框：${html}`)
  assert.ok(html.includes('wf-field--pinonly'), '应走仅引脚渲染分支')
  assert.ok(html.includes('p:view_front'), '参数引脚 p:view_front 不该丢')
  assert.ok(html.includes('workflows.nodes.pinOnlyHintImage'), '应提示「接一张图片」')
  assert.ok(html.includes('Front 视角'), '视角名要留在节点上（只接图，不填值）')
  // 引脚必须着成图片色（#38bdf8）而不是文本色（#fb7185），否则用户看不出这里能接图。
  // 注意只取该引脚的标签来断言：节点的主输入引脚本来就是 image 色，全局 grep 会假通过。
  const tag = html.slice(html.indexOf('data-handleid="p:view_front"')).split('>')[0]
  assert.ok(tag.includes('wf-handle--param'), `视角引脚标签异常：${tag}`)
  assert.ok(tag.includes('background:#38bdf8'), `视角引脚应为图片色（图片接得进来）：${tag}`)
  assert.ok(!tag.includes('#fb7185'), `视角引脚不该是文本色：${tag}`)
})

const { paramPortType, targetInputType } = loadTs(srcPath('types.ts'))

check('端口类型：图片参数的引脚是 image，其余参数仍是 text', () => {
  setExtensionsCache([
    {
      id: 'ext-test', display_name: '测试模型', kind: 'model', input: 'image', output: 'mesh',
      category: 'mesh',
      params: [
        { id: 'view_front', label: 'Front 视角', type: 'image', default: '' },
        { id: 'steps', label: '采样步数', type: 'int', default: 20 }
      ]
    }
  ])
  const node = { type: 'extensionNode', data: { extensionId: 'ext-test' } }
  assert.equal(paramPortType(node, 'p:view_front'), 'image', '图片参数 → image 端口')
  assert.equal(paramPortType(node, 'p:steps'), 'text', '数字参数 → text 端口（与改前一致）')
  assert.equal(paramPortType(node, 'in'), 'text', '非参数引脚不参与本函数判定')
  assert.equal(paramPortType(undefined, 'p:view_front'), 'text', '没有 schema 时退化为 text')
  assert.equal(targetInputType(node, 'p:view_front'), 'image', '连线着色读的也是同一个判定')
  assert.equal(targetInputType(node, 'in'), 'image', '主输入仍是扩展声明的 image')
})

check('连线校验：图片输出可接入视角引脚，文本输出被拒', () => {
  const { makeIsValidConnection } = loadTs(srcPath('pages', 'workflows', 'canvas', 'validConnection.ts'))
  const target = { id: 'mv', type: 'extensionNode', data: { label: 'MV', extensionId: 'ext-test', params: {} } }
  const imgNode = { id: 'i1', type: 'imageNode', data: { label: 'img', params: {} } }
  const txtNode = { id: 't1', type: 'textNode', data: { label: 'txt', params: {} } }
  const valid = makeIsValidConnection([target, imgNode, txtNode], [])
  assert.equal(
    valid({ source: 'i1', target: 'mv', sourceHandle: null, targetHandle: 'p:view_front' }),
    true,
    '图片节点应能接进视角引脚（这一条以前是 false，就是用户说的"接不上图片"）'
  )
  assert.equal(
    valid({ source: 't1', target: 'mv', sourceHandle: null, targetHandle: 'p:view_front' }),
    false,
    '文本节点不该接进视角引脚'
  )
  assert.equal(
    valid({ source: 't1', target: 'mv', sourceHandle: null, targetHandle: 'p:steps' }),
    true,
    '文本节点仍能接数字参数引脚（引脚喂变量这条老路不能断）'
  )
})

// ─── 节点折叠（UE 蓝图式"收起来"）：只留已连接的引脚 ─────────────────────────
//
// 用户反馈：「生成器的节点太高了，添加一个向上折叠的，没有被连接的引脚隐藏起来，
// 有连接就不需要隐藏，参考虚幻引擎的蓝图系统」。
//
// 契约（三条，分别锁住）：
//   1. 标题栏右端有一个朝上的折叠开关，展开/折叠互斥；
//   2. 折叠后只保留**有连线**的参数引脚与主引脚，空引脚一律不渲染；
//   3. 折叠态不摆输入框（都折起来了，控件没有意义）。

// 四个视角参数 + 一条"接进第 1 个视角引脚"的边，用来区分"有连接/没连接"。
const VIEW_PARAMS = [
  { id: 'view_front', label: 'Front 视角', type: 'image', default: '' },
  { id: 'view_left', label: 'Left 视角', type: 'image', default: '' },
  { id: 'view_back', label: 'Back 视角', type: 'image', default: '' },
  { id: 'view_right', label: 'Right 视角', type: 'image', default: '' }
]
/** 造若干条指向本节点 e1 的入边（`null` handle = 主数据引脚）。 */
const edgesInto = (...handles) =>
  handles.map((h, i) => ({ id: `edge-${i}`, source: 'upstream', target: 'e1', targetHandle: h }))

check('折叠开关：展开态给「折叠」提示，折叠态给「展开」提示并带折叠类', () => {
  const open = renderExtension(VIEW_PARAMS)
  assert.ok(open.includes('wf-node__fold'), '标题栏应渲染折叠开关')
  assert.ok(open.includes('workflows.nodes.collapseNode'), `展开态提示应为"折叠节点"：${open}`)
  assert.ok(!open.includes('workflows.nodes.expandNode'), '展开态不该出现"展开节点"提示')
  assert.ok(!open.includes('wf-node--collapsed'), '展开态不该带折叠类')
  assert.ok(open.includes('wf-ext-params'), '展开态应是完整参数区')

  const folded = renderExtension(VIEW_PARAMS, { collapsed: true })
  assert.ok(folded.includes('wf-node__fold'), '折叠态仍要留着开关（否则展不开）')
  assert.ok(folded.includes('workflows.nodes.expandNode'), `折叠态提示应为"展开节点"：${folded}`)
  assert.ok(folded.includes('wf-node--collapsed'), '折叠态应带折叠类')
  assert.ok(!folded.includes('aria-expanded="true"'), '折叠态 aria-expanded 应为 false')
})

check('折叠：没接线的视角引脚藏起来，接了线的那一个留着', () => {
  const html = renderExtension(VIEW_PARAMS, { collapsed: true }, edgesInto('p:view_front'))
  assert.ok(html.includes('wf-node--collapsed'), '应处于折叠态')
  assert.ok(html.includes('wf-ext-params--folded'), '应走折叠参数区')
  assert.ok(html.includes('p:view_front'), '已连接的视角引脚要留下来')
  assert.ok(html.includes('Front 视角'), '留下的那一行仍显示参数名')
  for (const gone of ['p:view_left', 'p:view_back', 'p:view_right']) {
    assert.ok(!html.includes(gone), `未连接的 ${gone} 不该渲染：${html}`)
  }
  for (const gone of ['Left 视角', 'Back 视角', 'Right 视角']) {
    assert.ok(!html.includes(gone), `藏起来的参数名 ${gone} 也不该出现`)
  }
  assert.ok(!html.includes('<input'), '折叠态不该有输入框')
  assert.ok(!html.includes('wf-ext-io'), '折叠态连 I/O 概览行也一起收起来')
})

check('折叠：一个引脚都没接时节点体整个消失（只剩标题栏）', () => {
  const html = renderExtension(VIEW_PARAMS, { collapsed: true })
  assert.ok(html.includes('wf-node--collapsed'), '应处于折叠态')
  assert.ok(!html.includes('wf-ext-params'), '不该渲染空的折叠参数区')
  assert.ok(!html.includes('p:view_'), '不该留下任何参数引脚')
  assert.ok(!html.includes('视角'), '参数名一个都不该出现')
  assert.ok(!html.includes('wf-ext-io'), 'I/O 概览行也该收起')
  // 空节点体由 CSS `.wf-node--collapsed .wf-node__body:empty { display: none }` 收掉。
  assert.ok(/class="wf-node__body"><\/div>/.test(html), `节点体应为空：${html}`)
})

check('折叠：主输入引脚同样是"有连接才留"', () => {
  const wired = renderExtension(VIEW_PARAMS, { collapsed: true }, edgesInto(null))
  assert.ok(wired.includes('data-handleid="in"'), `有连线的主输入引脚要留下：${wired}`)
  const unwired = renderExtension(VIEW_PARAMS, { collapsed: true })
  assert.ok(!unwired.includes('data-handleid="in"'), '没连线的主输入引脚要藏起来')
})

check('折叠：展开态不受影响（四个视角引脚都在）', () => {
  const html = renderExtension(VIEW_PARAMS, {}, edgesInto('p:view_front'))
  for (const id of ['p:view_front', 'p:view_left', 'p:view_back', 'p:view_right']) {
    assert.ok(html.includes(id), `展开态下 ${id} 必须在：${html}`)
  }
  assert.ok(!html.includes('wf-ext-params--folded'), '展开态不该走折叠分支')
})

check('折叠开关已接线：读写的都是 params.collapsed（随工作流持久化）', () => {
  // 点击语义在 SSR 里测不到（没有 DOM/事件），退而在源码层面锁住接线：
  // 读的是 data.params.collapsed，写的是同一个键 —— 与断点 params.breakpoint 同构。
  const src = fs.readFileSync(srcPath('pages', 'workflows', 'nodes', 'extension.tsx'), 'utf8')
  assert.ok(
    src.includes("data.params?.collapsed === true"),
    '折叠态应从 data.params.collapsed 读取'
  )
  assert.ok(
    /onToggleCollapse=\{\(\) => setParam\('collapsed', !collapsed\)\}/.test(src),
    '点击箭头应把 collapsed 取反写回 params'
  )
})

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
