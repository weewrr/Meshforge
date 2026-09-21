/**
 * 工作流节点功能测试 —— 零新增依赖。
 *
 * 目标：在不启动 Electron / 不碰真实后端的前提下，逐个验证**节点的执行语义**
 * 是否正确。覆盖 37 种节点里除「需要真实推理的重型生成器」之外的全部类型，
 * 以及执行引擎（拓扑 / exec 调度 / 循环）与图结构辅助函数。
 *
 * 原理与 `test_web.mjs` 同源：用 vite 自带的 esbuild 把 .ts 在内存里转成 CJS，
 * 再经自制 loader 执行；对 `api` / `scene` / `i18n` 注入桩模块，
 * 使执行完全离线、可断言。
 *
 * 被测点分四层：
 *   A. 纯函数辅助（helpers / types）：truthy、拓扑、循环体推断、参数引脚覆盖…
 *   B. 数据节点（execNode）：文本 / 数值 / 比较 / 布尔 / 类型转换 / 结构体 / 变量…
 *   C. 流程节点（runners）：Branch 分支、Sequence 多出口、事件分发、循环迭代
 *   D. 重型节点（桩验证）：generator / extension 的参数组装与错误分支
 *
 * 运行：`npm run test:nodes`（已接入 `npm test`）。
 */

import { transformSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const SRC_ROOT = path.resolve(import.meta.dirname, '..', 'src')

// ─── 迷你 CJS loader（与 test_web.mjs 同实现）────────────────────────────────

const overrides = new Map()
const cache = new Map()

/** 解析相对导入到真实 .ts 文件（支持无扩展名与目录 index）。 */
function resolveTs(specifier, importerFile) {
  const base = path.resolve(path.dirname(importerFile), specifier)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
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
  const js = transformSync(fs.readFileSync(file, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022'
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
const loadSrc = (rel) => loadTs(srcPath(...rel.split('/')))

// ─── 测试环境桩：api / scene / i18n ───────────────────────────────────────────

/** 记录后端调用，供断言"节点是否按契约提交"。 */
const calls = { submitImage: [], processMesh: [], listDirFiles: [] }

overrides.set(srcPath('api', 'index.ts'), {
  fullUrl: (u) => String(u),
  submitImage: async (...a) => {
    calls.submitImage.push(a)
    return { job_id: 'job-gen-1' }
  },
  processMesh: async (...a) => {
    calls.processMesh.push(a)
    return { job_id: 'job-proc-1' }
  },
  listDirFiles: async (...a) => {
    calls.listDirFiles.push(a)
    return []
  }
})

/** 3D 场景 store 桩：记录 pushMeshUrl 的调用。 */
const scene = { meshUrl: null, pushed: [] }
overrides.set(srcPath('stores', 'scene.ts'), {
  useSceneStore: {
    getState: () => ({
      meshUrl: scene.meshUrl,
      pushMeshUrl: (u) => scene.pushed.push(u)
    })
  }
})

/**
 * i18n 桩：返回 key 本身（测试只关心节点产物，不关心文案）。
 * 带上插值参数，便于断言"日志里到底带了哪个分发器名 / 节点标签"。
 */
overrides.set(srcPath('i18n', 'index.ts'), {
  getT: (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  useT: () => (k) => k,
  translate: (k) => k
})

/**
 * fetch 桩：For Each 的 image/text 模式会把工作区路径当 URL 取回，
 * 这里用内存内容应答，避免测试触网。
 */
const fetched = []
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  const name = decodeURIComponent(String(url).split('/').pop() || 'x')
  if (/\.(txt|md|json|csv)$/i.test(name)) return new Response(`text:${name}`, { status: 200 })
  return new Response(new Blob([`bytes:${name}`]), { status: 200 })
}

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
}

// ─── 加载被测模块 ─────────────────────────────────────────────────────────────

const ex = loadSrc('stores/workflowRun/executors.ts')
const hl = loadSrc('stores/workflowRun/helpers.ts')
const rn = loadSrc('stores/workflowRun/runners.ts')
const runtime = loadSrc('stores/workflowRun/runtime.ts')
const types = loadSrc('types.ts')
// 四视角标签常量住在 workflowRun 子模块的 types.ts（与根 types.ts 是两个文件）。
const MV_TAGS = loadSrc('stores/workflowRun/types.ts').MV_VIEW_TAGS

const { rt } = runtime
const T = types // 常用常量别名

// ─── 图构造与执行辅助 ─────────────────────────────────────────────────────────

/** 造一个节点。params 直接写进 data.params，label 缺省用 id。 */
function N(id, type, params = {}, extra = {}) {
  return {
    id,
    type,
    position: extra.position ?? { x: 0, y: 0 },
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    ...(extra.width ? { width: extra.width, height: extra.height } : {}),
    ...(extra.measured ? { measured: extra.measured } : {}),
    data: { label: extra.label ?? id, params }
  }
}

/** 造一条边。默认走主数据引脚（handle 为空）。 */
function E(source, target, sourceHandle = null, targetHandle = null) {
  return { id: `${source}->${target}`, source, target, sourceHandle, targetHandle }
}

/** 重置模块级运行态（每个用例开始时调用，避免相互污染）。 */
function resetRt() {
  rt.cancelRequested = false
  rt.waitResolve = null
  rt.whileResolve = null
  rt.pauseGateResolve = null
  rt.pauseRequested = false
  rt.stepOnce = false
  rt.bpConsumed = new Set()
  rt.activeJobId = null
  rt.overrideImage = null
  rt.overrideUsed = false
  rt.outputs = new Map()
  rt.outputsByHandle = new Map()
  rt.vars = new Map()
  rt.boundDispatchers = new Map()
  rt.innerGraphRunner = null
  scene.meshUrl = null
  scene.pushed = []
  calls.submitImage = []
  calls.processMesh = []
  calls.listDirFiles = []
  fetched.length = 0
}

/** 与 engine.ts 内实现保持一致的 findUpstream。 */
function findUpstream(nodeId, edges) {
  for (const e of edges) {
    if (e.target !== nodeId) continue
    const out = runtime.readOutput(e.source, e.sourceHandle)
    if (out) return out
  }
  return undefined
}

/**
 * 构造引擎上下文。可用 opts 覆盖任意字段。
 *
 * 关键点：executors.ts 会**解构** ctx 上的方法再调用（`const { setNodeState } = ctx`），
 * 解构后 `this` 丢失。故这些方法必须闭包持状态，绝不能写成依赖 `this` 的对象方法，
 * 否则会以 `Cannot read properties of undefined (reading 'nodeStates')` 崩掉。
 */
function makeCtx(opts = {}) {
  const state = {}
  const log = []
  const nodeStates = new Map()
  const iters = new Map()
  let ctx
  ctx = {
    set: (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    get: () => state,
    logger: {
      info: (m) => log.push(['info', m]),
      warn: (m) => log.push(['warn', m]),
      error: (m) => log.push(['error', m])
    },
    nodeStates,
    iters,
    setNodeState: (id, s) => {
      nodeStates.set(id, s)
    },
    setNodeIter: (id, i, t) => {
      iters.set(id, { index: i, total: t })
    },
    findUpstream,
    pollJob: async () => 'http://127.0.0.1:8766/files/result.glb',
    gate: async () => {},
    execNode: (n, e, d) => ex.execNode(ctx, n, e, d),
    ...opts
  }
  ctx.log = log
  return ctx
}

/**
 * 跑单个节点，返回产物与上下文。
 *
 * 上游输入必须在 `resetRt()` **之后**注入 —— 否则会被重置清空。为消除这种
 * 顺序陷阱，约定把输入写在 `opts` 里：
 *   seed      原始产物对象（`{ srcA: { type:'text', text:'1' } }`）
 *   seedText  文本产物简写（`{ srcA: '1' }` → `{ type:'text', text:'1' }`）
 *   vars      运行期变量表初值
 *   overrideImage 本次运行的覆盖图
 *   sceneMeshUrl  3D 查看器当前模型
 *   ctx       透传给 makeCtx 的字段覆盖
 * 返回值里的 `rt` / `ctx` 供进一步断言。
 */
async function runNode(node, edges = [], opts = {}) {
  resetRt()
  for (const [id, out] of Object.entries(opts.seed ?? {})) rt.outputs.set(id, out)
  for (const [id, text] of Object.entries(opts.seedText ?? {})) rt.outputs.set(id, { type: 'text', text })
  for (const [k, v] of Object.entries(opts.vars ?? {})) rt.vars.set(k, v)
  if ('overrideImage' in opts) rt.overrideImage = opts.overrideImage
  if ('sceneMeshUrl' in opts) scene.meshUrl = opts.sceneMeshUrl
  const ctx = makeCtx(opts.ctx ?? {})
  await ex.execNode(ctx, node, edges)
  return {
    out: runtime.readOutput(node.id, null),
    byHandle: (h) => rt.outputsByHandle.get(`${node.id}::${h}`),
    rt,
    ctx,
    log: ctx.log
  }
}

/** 让出一个事件循环，供挂起类节点（Wait / While manual）先走到挂起点。 */
const tick = () => new Promise((r) => setTimeout(r, 0))

// ─── 用例框架 ─────────────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════════
// A. 纯函数辅助
// ═══════════════════════════════════════════════════════════════════════════════

await test('A1 truthy: 字面量白名单与回退', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'Yes', ' true ']) assert.equal(hl.truthy(v), true, `${v} 应为真`)
  for (const v of ['false', '0', 'no', '', null, undefined]) assert.equal(hl.truthy(v), false, `${v} 应为假`)
  // 非白名单的非空字符串走 JS 真值判断。
  assert.equal(hl.truthy('abc'), true)
  assert.equal(hl.truthy(42), true)
})

await test('A2 isVoidOutput: 四种产物键全空的判定', () => {
  assert.equal(hl.isVoidOutput(undefined), true)
  assert.equal(hl.isVoidOutput({ type: 'text', text: '' }), true, '空文本算空值')
  assert.equal(hl.isVoidOutput({ type: 'array', items: [] }), true, '空数组算空值')
  assert.equal(hl.isVoidOutput({ type: 'text', text: 'x' }), false)
  assert.equal(hl.isVoidOutput({ type: 'image', file: {} }), false)
  assert.equal(hl.isVoidOutput({ type: 'mesh', url: '/a.glb' }), false)
  assert.equal(hl.isVoidOutput({ type: 'array', items: [{}] }), false)
})

await test('A3 topoSort: 依赖顺序与环兜底', () => {
  const nodes = [N('c', 'mathNode'), N('a', 'textNode'), N('b', 'mathNode')]
  const edges = [E('a', 'b'), E('b', 'c')]
  assert.deepEqual(hl.topoSort(nodes, edges), ['a', 'b', 'c'])
  // 悬空边（指向已删节点）被忽略。
  assert.deepEqual(hl.topoSort([N('x', 'textNode')], [E('ghost', 'x')]), ['x'])
  // 成环时剩余节点按声明顺序补到末尾（不漏项）。
  const cyc = hl.topoSort([N('p', 'mathNode'), N('q', 'mathNode')], [E('p', 'q'), E('q', 'p')])
  assert.equal(cyc.length, 2)
  assert.deepEqual([...cyc].sort(), ['p', 'q'])
})

await test('A4 loopSegment: 正向可达且在有界处停止', () => {
  const nodeMap = new Map([
    ['start', N('start', 'whileNode')],
    ['body1', N('body1', 'mathNode')],
    ['body2', N('body2', 'mathNode')],
    ['nested', N('nested', 'whileNode')],
    ['inner', N('inner', 'mathNode')]
  ])
  const edges = [E('start', 'body1'), E('body1', 'body2'), E('body2', 'nested'), E('nested', 'inner')]
  const seg = hl.loopSegment('start', nodeMap, edges).map((n) => n.id)
  assert.deepEqual(seg, ['body1', 'body2'], '嵌套循环自身与其内部都不纳入本层循环体')
})

await test('A5 whileBodyNodes: parentId / 框内中心点 / 注释框内换算', () => {
  const w = N('w', 'whileNode', {}, { position: { x: 0, y: 0 }, measured: { width: 400, height: 300 } })
  const child = N('c', 'mathNode', {}, { parentId: 'w' })
  const inside = N('i', 'mathNode', {}, { position: { x: 50, y: 50 }, measured: { width: 100, height: 60 } })
  const outside = N('o', 'mathNode', {}, { position: { x: 900, y: 900 }, measured: { width: 100, height: 60 } })
  const comment = N('cm', 'commentNode', {}, { position: { x: 20, y: 20 }, measured: { width: 200, height: 150 } })
  // 注释框内的节点坐标是相对的，换算后仍应落在容器框内。
  const inComment = N('ic', 'mathNode', {}, { parentId: 'cm', position: { x: 10, y: 10 }, measured: { width: 80, height: 40 } })
  const body = hl.whileBodyNodes(w, [w, child, inside, outside, comment, inComment]).map((n) => n.id)
  assert.ok(body.includes('c'), '显式 parentId 的节点属于循环体')
  assert.ok(body.includes('i'), '中心点落在容器内属于循环体')
  assert.ok(!body.includes('o'), '容器外的节点不属于循环体')
  assert.ok(body.includes('ic'), '注释框内节点按绝对坐标判定，不应被摘掉')
})

await test('A6 inputIndexForHandle / paramIdFromHandle 引脚解析', () => {
  assert.equal(T.inputIndexForHandle('in'), 0)
  assert.equal(T.inputIndexForHandle('in1'), 1)
  assert.equal(T.inputIndexForHandle('in7'), 7)
  assert.equal(T.inputIndexForHandle(null), 0)
  assert.equal(T.paramIdFromHandle('p:steps'), 'steps')
  assert.equal(T.paramIdFromHandle('in1'), null, '数据引脚不是参数引脚')
})

await test('A7 isExecEdge / isExecNode 判定', () => {
  assert.equal(T.isExecEdge('exec-out', 'exec-in'), true, '两端都是 exec 引脚')
  assert.equal(T.isExecEdge('exec-out', 'in'), true, '任一端为 exec 即算 exec 边')
  assert.equal(T.isExecEdge(null, null), false, '数据边')
  assert.equal(T.isExecNode('branchNode'), true)
  assert.equal(T.isExecNode('variableSetNode'), true)
  assert.equal(T.isExecNode('mathNode'), false)
  assert.equal(T.isLoopStarter('whileNode'), true)
  assert.equal(T.isLoopStarter('forEachNode'), true)
  assert.equal(T.isBranchStarter('waitNode'), true)
})

await test('A8 structFields / packStruct / unpackStruct 往返', () => {
  assert.deepEqual(T.structFields('a,b,c'), ['a', 'b', 'c'])
  assert.deepEqual(T.structFields(''), ['a', 'b', 'c', 'd'], '空值时回退默认四字段')
  const packed = T.packStruct(['x', 'y'], ['1', undefined])
  assert.equal(packed, 'x=1;y=')
  assert.equal(T.unpackStruct(packed, ['x', 'y'], 0), '1')
  assert.equal(T.unpackStruct(packed, ['x', 'y'], 1), '')
  // 裸值序列（无 k=v）按位置取值。
  assert.equal(T.unpackStruct('foo;bar', ['a', 'b'], 1), 'bar')
  assert.equal(T.structOutHandle(0), 'out0')
  assert.equal(T.structOutHandle(2), 'out2')
})

await test('A9 mvViewsFrom: 视角图片引脚优先，数组按顺序回退', () => {
  resetRt()
  const f1 = new File(['a'], 'a.png')
  const f2 = new File(['b'], 'b.png')
  const f3 = new File(['c'], 'c.png')
  // 情形 1：上游是图片节点且自身带四视角（没接视角引脚 → 走回退层）。
  // front 既是主图、也计入 views：后端按 `view_<tag>` 表单字段收图，
  // 主图字段与 front 视角字段必须指向同一张（否则 params.view_front 会缺）。
  const img = hl.mvViewsFrom(N('g', 'generatorNode'), {
    type: 'image', file: f1, views: { back: f2 }
  })
  assert.equal(img.front, f1)
  assert.deepEqual(Object.keys(img.views), ['front', 'back'])
  assert.equal(img.views.front, f1, 'front 也进 views（后端只认 view_<tag> 字段）')
  // 情形 2：上游是数组节点，按 MV_VIEW_TAGS 顺序取同下标项（front←0, left←1 …）。
  const arr = hl.mvViewsFrom(N('g', 'generatorNode'), { type: 'array', items: [f1, f2, f3] })
  assert.equal(arr.front, f1)
  assert.equal(arr.views.left, f2)
  assert.equal(arr.views.right, undefined, '数组短于 4 时缺的视角保持缺省（不重复取图）')
  // 情形 2b（回归守卫）：数组长度 ≥4 且无任何映射时，四个视角必须各不相同 ——
  // 一旦回退层写成"取首项"，四视角会全部退化成同一张图。
  const four = hl.mvViewsFrom(N('g', 'generatorNode'), {
    type: 'array', items: ['front', 'left', 'back', 'right'].map((t) => new File([t], `${t}.png`))
  })
  assert.deepEqual(
    MV_TAGS.map((t) => four.views[t]?.name),
    ['front.png', 'left.png', 'back.png', 'right.png'],
    '四视角按顺序各就各位，不得重复取首图'
  )
  assert.equal(new Set(Object.values(four.views)).size, 4, '四个视角是四个不同文件')

  // 情形 3（本轮新增）：`p:view_<tag>` 图片引脚上的图片优先于回退层，
  // 而且允许完全不接主输入（用户手接 4 张图的正路）。
  const pf = new File(['pf'], 'pin-front.png')
  const pb = new File(['pb'], 'pin-back.png')
  rt.outputs.set('vf', { type: 'image', file: pf })
  rt.outputs.set('vb', { type: 'image', file: pb })
  const pinned = hl.mvViewsFrom(N('g', 'generatorNode'), undefined, [
    E('vf', 'g', null, T.paramHandleFor('view_front')),
    E('vb', 'g', null, T.paramHandleFor('view_back'))
  ])
  assert.ok(pinned, '只接了视角引脚（无主输入）也应解析成功')
  assert.equal(pinned.front, pf, 'front 取自视角引脚')
  assert.equal(pinned.views.back, pb, 'back 取自视角引脚')
  assert.equal(pinned.views.left, undefined, '没接的视角保持缺省')

  // 情形 3b：引脚与回退层同为一个视角时，引脚优先。
  const override = hl.mvViewsFrom(
    N('g', 'generatorNode', {}, {}),
    { type: 'array', items: [f1, f2, f3] },
    [E('vf', 'g', null, T.paramHandleFor('view_front'))]
  )
  assert.equal(override.front, pf, '引脚上的图片覆盖数组里的第 1 张')
  assert.equal(override.views.left, f2, '未接引脚的视角仍由数组补齐')

  // 情形 3c：接到非图片输出（这里是个文本节点的数值）时该视角视为没接，回落数组。
  rt.outputs.set('vt', { type: 'text', text: '1' })
  const txt = hl.mvViewsFrom(
    N('g', 'generatorNode', {}, {}),
    { type: 'array', items: [f1, f2, f3] },
    [E('vt', 'g', null, T.paramHandleFor('view_front'))]
  )
  assert.equal(txt.front, f1, '文本引脚不参与视角取值')

  // 情形 4：无法解析时返回 null。
  assert.equal(hl.mvViewsFrom(N('g', 'generatorNode'), { type: 'array', items: [] }), null)
  assert.equal(hl.mvViewsFrom(N('g', 'generatorNode'), { type: 'image' }), null, '图片节点缺 file')
  assert.equal(hl.mvViewsFrom(N('g', 'generatorNode'), undefined, []), null, '什么都没有 → null')
})

await test('A10 resolveParamPins: 数值协调与内联值回退', () => {
  const ext = {
    id: 'e',
    params: [
      { id: 'steps', type: 'int', default: 20 },
      { id: 'prompt', type: 'string', default: '' }
    ]
  }
  const node = N('e1', 'extensionNode', { steps: 99, prompt: 'inline' })
  resetRt()
  rt.outputs.set('src1', { type: 'text', text: '30' })
  rt.outputs.set('src2', { type: 'text', text: 'hello' })
  rt.outputs.set('src3', { type: 'text', text: 'not-a-number' })
  const edges = [E('src1', 'e1', null, 'p:steps'), E('src2', 'e1', null, 'p:prompt')]
  const r = hl.resolveParamPins(node, edges, ext)
  assert.equal(r.steps, 30, 'int 参数从文本协调为数字')
  assert.equal(r.prompt, 'hello', 'string 参数直接取文本')
  // 文本解析不出数字 → 回退内联值，绝不产生 NaN。
  const r2 = hl.resolveParamPins(node, [E('src3', 'e1', null, 'p:steps')], ext)
  assert.equal(r2.steps, 99)
  // 接了一个"空文本"的引脚（例如上游变量未赋值）→ 同样按未给值处理，回退内联值；
  // 不能因为 Number('') === 0 就把 steps 静默压成 0。
  resetRt()
  rt.outputs.set('src4', { type: 'text', text: '   ' })
  const r3 = hl.resolveParamPins(node, [E('src4', 'e1', null, 'p:steps')], ext)
  assert.equal(r3.steps, 99, '空文本不得被当成 0')
})

await test('A11 nodeExtensionId: 兼容两处存放位置', () => {
  assert.equal(hl.nodeExtensionId(N('a', 'extensionNode', { extensionId: 'mesh-repair' })), 'mesh-repair')
  assert.equal(hl.nodeExtensionId({ id: 'b', data: { extensionId: 'x' } }), 'x')
  assert.equal(hl.nodeExtensionId({ id: 'c', data: {} }), '')
})

// ═══════════════════════════════════════════════════════════════════════════════
// B. 数据节点（execNode）
// ═══════════════════════════════════════════════════════════════════════════════

await test('B1 textNode 输出内联文本，缺省为空串', async () => {
  assert.equal((await runNode(N('t', 'textNode', { text: 'hello' }))).out.text, 'hello')
  assert.equal((await runNode(N('t', 'textNode', {}))).out.text, '')
  assert.equal((await runNode(N('t', 'textNode', { text: 0 }))).out.text, '0', '数值 0 不应丢')
})

await test('B2 variableNode: text 直出 / bool 归一化', async () => {
  assert.equal((await runNode(N('v', 'variableNode', { dtype: 'text', value: 'abc' }))).out.text, 'abc')
  assert.equal((await runNode(N('v', 'variableNode', { dtype: 'bool', value: 'yes' }))).out.text, 'true')
  assert.equal((await runNode(N('v', 'variableNode', { dtype: 'bool', value: 'no' }))).out.text, 'false')
  assert.equal((await runNode(N('v', 'variableNode', { dtype: 'bool', value: '' }))).out.text, 'false')
  assert.equal((await runNode(N('v', 'variableNode', { dtype: 'int', value: '7' }))).out.text, '7')
})

await test('B3 isValidNode: 上游空洞判假', async () => {
  const E_ = [E('src', 'iv')]
  assert.equal((await runNode(N('iv', 'isValidNode'), E_, { seedText: { src: 'x' } })).out.text, 'true')
  assert.equal((await runNode(N('iv', 'isValidNode'), E_, { seedText: { src: '' } })).out.text, 'false', '空输出为假')
  assert.equal((await runNode(N('iv', 'isValidNode'), [])).out.text, 'false', '无上游为假')
})

await test('B4 isEmptyNode: 文本维度判空（trim）', async () => {
  const E_ = [E('s', 'ie')]
  assert.equal((await runNode(N('ie', 'isEmptyNode'), E_, { seedText: { s: '   ' } })).out.text, 'true', '纯空白算空')
  assert.equal((await runNode(N('ie', 'isEmptyNode'), E_, { seedText: { s: 'a' } })).out.text, 'false')
  assert.equal((await runNode(N('ie', 'isEmptyNode'), [])).out.text, 'true')
})

await test('B5 boolNode: and / or / xor 三态', async () => {
  /** 第 i 个输入接到 in / in1 / in2… 引脚上。 */
  const run = async (op, vals) => {
    const seedText = {}
    vals.forEach((v, i) => {
      seedText[`s${i}`] = v
    })
    const edges = vals.map((_, i) => E(`s${i}`, 'b', null, i === 0 ? 'in' : `in${i}`))
    return (await runNode(N('b', 'boolNode', { operator: op }), edges, { seedText })).out.text
  }
  // and：全真且非空
  assert.equal(await run('and', ['true', '1']), 'true')
  assert.equal(await run('and', ['true', 'false']), 'false')
  // or：任一为真
  assert.equal(await run('or', ['false', 'yes']), 'true')
  assert.equal(await run('or', ['false', '0']), 'false')
  // xor：恰好一个为真
  assert.equal(await run('xor', ['true', 'false']), 'true')
  assert.equal(await run('xor', ['true', 'true']), 'false')
  // and 空输入不算真
  assert.equal((await runNode(N('b', 'boolNode', { operator: 'and' }), [])).out.text, 'false')
})

await test('B6 mathNode: 七种算子与除零保护', async () => {
  const EDGES2 = [E('a', 'm', null, 'in'), E('b', 'm', null, 'in1')]
  const calc = async (op, a, b) =>
    (await runNode(N('m', 'mathNode', { operator: op }), EDGES2, { seedText: { a, b } })).out.text
  assert.equal(await calc('+', '2', '3'), '5')
  assert.equal(await calc('-', '10', '4'), '6')
  assert.equal(await calc('*', '3', '4'), '12')
  assert.equal(await calc('/', '9', '3'), '3')
  assert.equal(await calc('/', '9', '0'), '0', '除零返回 0 而非 Infinity')
  assert.equal(await calc('min', '5', '2'), '2')
  assert.equal(await calc('max', '5', '2'), '5')
  const abs = await runNode(N('m', 'mathNode', { operator: 'abs' }), EDGES2, { seedText: { a: '-7', b: '' } })
  assert.equal(abs.out.text, '7')
  // 非数字输入被过滤；无有效输入时按 0 处理。
  assert.equal(await calc('+', 'abc', 'def'), '0')
  // 多于两个输入时 '+' 累加。
  const sum = await runNode(N('m', 'mathNode', { operator: '+' }),
    [E('s0', 'm', null, 'in'), E('s1', 'm', null, 'in1'), E('s2', 'm', null, 'in2')],
    { seedText: { s0: '1', s1: '2', s2: '3' } })
  assert.equal(sum.out.text, '6')
})

await test('B7 compareNode: 数值比较 / 字符串回退 / 空串不当 0', async () => {
  const cmp = async (op, a, b) =>
    (await runNode(N('c', 'compareNode', { operator: op }),
      [E('a', 'c', null, 'in'), E('b', 'c', null, 'in1')], { seedText: { a, b } })).out.text
  assert.equal(await cmp('==', '2', '2'), 'true')
  assert.equal(await cmp('==', '2', '2.0'), 'true', '数值等价')
  assert.equal(await cmp('!=', '2', '3'), 'true')
  assert.equal(await cmp('>', '10', '9'), 'true', '按数值而非字典序')
  assert.equal(await cmp('>=', '9', '9'), 'true')
  assert.equal(await cmp('<', '1', '2'), 'true')
  assert.equal(await cmp('<=', '2', '1'), 'false')
  // 非数字 → 字符串比较
  assert.equal(await cmp('==', 'abc', 'abc'), 'true')
  assert.equal(await cmp('>', 'b', 'a'), 'true')
  // 空串不参与数值比较（否则 '' 会被 Number 成 0）
  assert.equal(await cmp('==', '', '0'), 'false')
  assert.equal(await cmp('==', '', ''), 'true')
})

await test('B8 concatNode: 按引脚顺序拼接与分隔符', async () => {
  const r = await runNode(N('cc', 'concatNode', { separator: '-' }),
    [E('a', 'cc', null, 'in'), E('b', 'cc', null, 'in1')], { seedText: { a: 'foo', b: 'bar' } })
  assert.equal(r.out.text, 'foo-bar')
  // 只有一个输入且落在 in1（in0 悬空）时，仍按"已接线的输入"参与拼接。
  const r2 = await runNode(N('cc', 'concatNode', {}), [E('a', 'cc', null, 'in1')], { seedText: { a: 'foo' } })
  assert.equal(r2.out.text, 'foo', '悬空引脚被跳过，不产生多余分隔符')
  // 无任何输入 → 空串（而不是 undefined）。
  const r3 = await runNode(N('cc', 'concatNode', {}), [])
  assert.equal(r3.out.text, '')
})

await test('B9 gateNode: 仅显式 false 时关闭，缺省开启', async () => {
  const gate = async (params) =>
    (await runNode(N('g', 'gateNode', params), [E('s', 'g')], { seedText: { s: 'data' } })).out
  assert.equal((await gate({})).text, 'data', '未配置时视为开启')
  assert.equal((await gate({ open: 'true' })).text, 'data')
  assert.equal(await gate({ open: 'false' }), undefined, '关闭时无输出')
})

await test('B10 castNode: float / int / bool 转换与失败兜底', async () => {
  const cast = async (to, raw) =>
    (await runNode(N('c', 'castNode', { to }), raw === undefined ? [] : [E('s', 'c')],
      raw === undefined ? {} : { seedText: { s: raw } })).out.text
  assert.equal(await cast('float', '3.14'), '3.14')
  assert.equal(await cast('float', 'abc'), '0', '解析失败给 0')
  assert.equal(await cast('int', '3.9'), '3', '截断为整数')
  assert.equal(await cast('int', 'xyz'), '0')
  assert.equal(await cast('bool', 'yes'), 'true')
  assert.equal(await cast('bool', '0'), 'false')
  assert.equal(await cast('text', 'as-is'), 'as-is', '未识别目标类型时原样透传')
  assert.equal(await cast('float', undefined), '0')
})

await test('B11 clampNode: 区间夹取与上下界归一', async () => {
  const clamp = async (v, lo, hi) =>
    (await runNode(N('cl', 'clampNode'),
      [E('s0', 'cl', null, 'in'), E('s1', 'cl', null, 'in1'), E('s2', 'cl', null, 'in2')],
      { seedText: { s0: v, s1: lo, s2: hi } })).out.text
  assert.equal(await clamp('5', '0', '10'), '5')
  assert.equal(await clamp('-3', '0', '10'), '0')
  assert.equal(await clamp('99', '0', '10'), '10')
  // 上下界传反也能正常工作。
  assert.equal(await clamp('5', '10', '0'), '5')
  assert.equal(await clamp('99', '10', '0'), '10')
  // 缺省兜底为 [0,1]。
  assert.equal(
    (await runNode(N('cl', 'clampNode'), [E('s0', 'cl')], { seedText: { s0: '5' } })).out.text,
    '1'
  )
})

await test('B12 lerpNode: A+(B-A)*Alpha，Alpha 夹到 [0,1]', async () => {
  const lerp = async (a, b, t) =>
    (await runNode(N('l', 'lerpNode'),
      [E('s0', 'l', null, 'in'), E('s1', 'l', null, 'in1'), E('s2', 'l', null, 'in2')],
      { seedText: { s0: a, s1: b, s2: t } })).out.text
  assert.equal(await lerp('0', '10', '0.5'), '5')
  assert.equal(await lerp('0', '10', '0'), '0')
  assert.equal(await lerp('0', '10', '1'), '10')
  assert.equal(await lerp('0', '10', '2'), '10', 'Alpha 上溢被夹到 1（不外插）')
  assert.equal(await lerp('0', '10', '-1'), '0', 'Alpha 下溢被夹到 0')
  // 只接 A 引脚：B/Alpha 缺省（1 / 0）→ 结果等于 A，绝不能是 'NaN'。
  assert.equal(
    (await runNode(N('l', 'lerpNode'), [E('s0', 'l')], { seedText: { s0: '5' } })).out.text,
    '5',
    '缺 B / Alpha 时按缺省参与，不产生 NaN'
  )
})

await test('B13 randomNode: 落在 [min,max] 且截 3 位小数', async () => {
  const edges = [E('a', 'r', null, 'in'), E('b', 'r', null, 'in1')]
  const seedText = { a: '5', b: '6' }
  for (let i = 0; i < 50; i++) {
    const v = Number((await runNode(N('r', 'randomNode'), edges, { seedText })).out.text)
    assert.ok(v >= 5 && v <= 6, `随机值 ${v} 应落在 [5,6]`)
    assert.ok(String(v).split('.')[1]?.length <= 3 || !String(v).includes('.'), '最多 3 位小数')
  }
  // 缺省范围 0..1
  const d = Number((await runNode(N('r', 'randomNode'), [])).out.text)
  assert.ok(d >= 0 && d <= 1)
})

await test('B14 variableSet / variableGet: 跨节点读写与 fallback', async () => {
  resetRt()
  const setNode = N('set', 'variableSetNode', { varName: 'score', default: '0' })
  rt.outputs.set('src', { type: 'text', text: '42' })
  await ex.execNode(makeCtx(), setNode, [E('src', 'set')])
  assert.equal(rt.vars.get('score'), '42', '写入运行期变量表')
  assert.equal(runtime.readOutput('set', null).text, '42', 'Set 原样输出')
  // Get 读回
  const got = await runNode(N('get', 'variableGetNode', { varName: 'score' }), [], { vars: { score: '7' } })
  assert.equal(got.out.text, '7')
  // 未赋值 → fallback
  const fb = await runNode(N('get', 'variableGetNode', { varName: 'nope', fallback: 'FB' }), [])
  assert.equal(fb.out.text, 'FB')
  // 无变量名 → 空串 + 告警
  const noName = await runNode(N('set', 'variableSetNode', { default: 'x' }), [])
  assert.equal(noName.out.text, 'x', '无名字仍输出，只是不写变量表')
  assert.ok(noName.log.some(([lv]) => lv === 'warn'), '应记录告警')
})

await test('B15 makeStruct / breakStruct: 组装与按字段拆解', async () => {
  const mk = await runNode(N('mk', 'makeStructNode', { fields: 'name,age' }),
    [E('s0', 'mk', null, 'in'), E('s1', 'mk', null, 'in1')], { seedText: { s0: 'alice', s1: '30' } })
  assert.equal(mk.out.text, 'name=alice;age=30')
  // 拆解：写到 out0 / out1 两个 handle 上
  const br = await runNode(N('br', 'breakStructNode', { fields: 'name,age' }), [E('src', 'br')],
    { seedText: { src: 'name=alice;age=30' } })
  assert.equal(br.byHandle('out0').text, 'alice')
  assert.equal(br.byHandle('out1').text, '30')
})

await test('B16 rerouteNode: 透传上游数据', async () => {
  const r = await runNode(N('rr', 'rerouteNode'), [E('s', 'rr')], { seed: { s: { type: 'mesh', url: '/m.glb' } } })
  assert.equal(r.out.url, '/m.glb')
  // 无上游时静默无输出（不报错）
  const empty = await runNode(N('rr', 'rerouteNode'), [])
  assert.equal(empty.out, undefined)
})

await test('B17 selectNode: auto 取首个有值输入 / 固定下标', async () => {
  const EDGES = [E('empty', 'sel', null, 'in'), E('good', 'sel', null, 'in1')]
  const SEED = { seedText: { empty: '', good: 'picked' } }
  const sel = async (mode) => runNode(N('sel', 'selectNode', { mode }), EDGES, SEED)
  // auto：跳过空输出
  assert.equal((await sel('auto')).out.text, 'picked', 'auto 模式跳过空洞')
  // 固定下标 1
  assert.equal((await sel('1')).out.text, 'picked')
  // 固定下标 0：显式指定就照办（哪怕选中的是空值），不静默改选别的输入。
  assert.equal((await sel('0')).out.text, '', '固定下标模式忠实透传所选输入')
  // 固定下标越界（没有这条引脚）→ 无输出 + 告警
  const oob = await sel('5')
  assert.equal(oob.out, undefined)
  assert.ok(oob.log.some(([lv]) => lv === 'warn'))
})

await test('B18 commentNode: 纯布局节点无执行语义', async () => {
  const r = await runNode(N('cm', 'commentNode', { text: 'note' }), [])
  assert.equal(r.out, undefined)
  assert.equal(r.ctx.nodeStates.get('cm'), 'succeeded', '仍标记为成功（不阻断流程）')
})

await test('B19 meshNode: file 源与 current 源', async () => {
  const file = await runNode(N('m', 'meshNode', { url: '/workspace/a.glb' }), [])
  assert.equal(file.out.url, '/workspace/a.glb')
  // 缺 url 报错
  await assert.rejects(() => runNode(N('m', 'meshNode', {}), []), /no mesh file configured/)
  // current 源：取 3D 查看器当前模型
  const cur = await runNode(N('m', 'meshNode', { source: 'current' }), [],
    { sceneMeshUrl: 'http://127.0.0.1:8766/files/current.glb' })
  assert.equal(cur.out.url, 'http://127.0.0.1:8766/files/current.glb')
  // current 源但查看器为空 → 报错
  await assert.rejects(() => runNode(N('m', 'meshNode', { source: 'current' }), []), /no current model/)
})

await test('B20 imageNode: override 优先且只用一次', async () => {
  const f = new File(['x'], 'override.png')
  const r = await runNode(N('i', 'imageNode', { url: '/ignored.png' }), [], { overrideImage: f })
  assert.equal(r.out.file, f, '使用本次运行的覆盖图')
  assert.equal(rt.overrideUsed, true, '标记已消费')
  assert.ok(r.log.some(([, m]) => m.includes('using override image')))
})

await test('B21 imageNode: 无图无覆盖 → 明确报错', async () => {
  await assert.rejects(() => runNode(N('i', 'imageNode', {}), []), /no image configured/)
})

await test('B22 arrayNode: 空槽位安全跳过', async () => {
  const r = await runNode(N('a', 'arrayNode', { items: [] }), [])
  assert.deepEqual(r.out.items, [])
  // 含无效项的数组不抛错，只记录告警。
  const r2 = await runNode(N('a', 'arrayNode', { items: [{ id: '1', url: '' }] }), [])
  assert.deepEqual(r2.out.items, [])
})

await test('B23 previewNode: 推入查看器并透传；outputNode: 只推入', async () => {
  const MESH = { seed: { s: { type: 'mesh', url: '/out.glb' } } }
  const pv = await runNode(N('pv', 'previewNode'), [E('s', 'pv')], MESH)
  assert.deepEqual(scene.pushed, ['/out.glb'], '网格推进查看器')
  assert.equal(pv.out.url, '/out.glb', 'Preview 继续透传网格')
  const out = await runNode(N('o', 'outputNode'), [E('s', 'o')], MESH)
  assert.deepEqual(scene.pushed, ['/out.glb'])
  assert.equal(out.out, undefined, 'Add to Scene 是终端节点，不再透传')
  // 缺上游网格 → 报错
  await assert.rejects(() => runNode(N('pv', 'previewNode'), []), /needs an upstream mesh/)
})

await test('B24 waitNode: 挂起 → 继续 / 取消', async () => {
  // 继续：透传上游后恢复
  resetRt()
  rt.outputs.set('s', { type: 'text', text: 'before' })
  const ctx = makeCtx()
  const node = N('w', 'waitNode')
  const p = ex.execNode(ctx, node, [E('s', 'w')])
  await tick()
  assert.equal(ctx.nodeStates.get('w'), 'waiting', '应停在等待态')
  assert.equal(typeof rt.waitResolve, 'function', '已注册恢复回调')
  assert.equal(runtime.readOutput('w', null).text, 'before', '等待期间已透传上游')
  rt.waitResolve('continue')
  await p
  assert.equal(ctx.nodeStates.get('w'), 'succeeded')
  assert.equal(rt.waitResolve, null, '恢复后清空回调')
  // 取消：抛出 Cancelled
  resetRt()
  const ctx2 = makeCtx()
  const p2 = ex.execNode(ctx2, N('w', 'waitNode'), [])
  await tick()
  rt.waitResolve('cancel')
  await assert.rejects(() => p2, (e) => e instanceof hl.Cancelled)
})

await test('B25 eventBind / eventCall: 登记与告警', async () => {
  resetRt()
  const bind = await runNode(N('b1', 'eventBindNode', { dispatcher: 'onDone' }), [])
  assert.deepEqual(rt.boundDispatchers.get('onDone'), ['b1'], 'Bind 登记到分发器')
  assert.equal(bind.out, undefined, 'Bind 无数据输出')
  // 重复登记幂等
  await ex.execNode(makeCtx(), N('b1', 'eventBindNode', { dispatcher: 'onDone' }), [])
  assert.deepEqual(rt.boundDispatchers.get('onDone'), ['b1'])
  // Call：只记日志，本身无输出（分发器表须在 runNode 的重置之后注入，故直接用 execNode）
  resetRt()
  rt.boundDispatchers.set('onDone', ['b1', 'b2'])
  const callCtx = makeCtx()
  await ex.execNode(callCtx, N('c1', 'eventCallNode', { dispatcher: 'onDone' }), [])
  assert.equal(runtime.readOutput('c1', null), undefined)
  assert.ok(callCtx.log.some(([, m]) => m.includes('onDone')))
  // 未命名 → 告警
  const bad = await runNode(N('c2', 'eventCallNode', {}), [])
  assert.ok(bad.log.some(([lv]) => lv === 'warn'))
})

await test('B26 未知节点类型：空操作且不阻断', async () => {
  const r = await runNode(N('u', 'someFutureNode', {}), [])
  assert.equal(r.out, undefined)
  assert.equal(r.ctx.nodeStates.get('u'), 'succeeded', '前向兼容：新节点在旧引擎下不报错')
})

await test('B27 subgraphNode: 入参注入 → 内联执行 → 出参回收', async () => {
  resetRt()
  rt.outputs.set('outer', { type: 'text', text: '5' })
  // 子图文档：一个 Input 挂点 → Math(+1) → 一个 Output 挂点
  const doc = {
    nodes: [
      N('inner_in', 'subgraphInputNode', {}),
      N('inner_math', 'mathNode', { operator: '+' }),
      N('inner_out', 'subgraphOutputNode', {})
    ],
    edges: [E('inner_in', 'inner_math'), E('inner_math', 'inner_out')],
    inputs: [{ refId: 'inner_in', name: 'x' }],
    outputs: [{ refId: 'inner_out', name: 'y' }]
  }
  // 子图内部：inner_in 的值由外部注入，再补一个常量 1 参与相加
  doc.nodes.push(N('one', 'variableNode', { dtype: 'text', value: '1' }))
  doc.edges.push(E('one', 'inner_math', null, 'in1'))

  const node = N('sg', 'subgraphNode', { subgraph: doc })
  const ctx = makeCtx()
  // run() 在真实引擎里会装配 innerGraphRunner；这里用等效实现。
  rt.innerGraphRunner = async (nodes, edges, depth) => {
    for (const id of hl.topoSort(nodes, edges)) {
      const n = nodes.find((x) => x.id === id)
      if (!n || n.type === 'subgraphInputNode' || n.type === 'subgraphOutputNode') continue
      await ex.execNode(ctx, n, edges, depth)
    }
  }
  await ex.execNode(ctx, node, [E('outer', 'sg', null, 'in0')])
  // 注入的 '5' 走 in0 → inner_in，与内部常量 1 相加 → 6，再经 Exit 挂点回收。
  assert.equal(runtime.readOutput('sg', null).text, '6', '外部入参注入后参与计算并回收出参')

  // 空子图 → 告警但不报错
  const empty = await runNode(N('sg', 'subgraphNode', { subgraph: { nodes: [], edges: [] } }), [])
  assert.ok(empty.log.some(([lv]) => lv === 'warn'))
})

// ═══════════════════════════════════════════════════════════════════════════════
// C. 流程节点（runners）
// ═══════════════════════════════════════════════════════════════════════════════

await test('C1 runDataGraphOn: 纯数据图按拓扑顺序执行', async () => {
  resetRt()
  const nodes = [N('t', 'textNode', { text: '5' }), N('m', 'mathNode', { operator: '*' }),
    N('out', 'variableNode', { dtype: 'text', value: '0' })]
  const edges = [E('t', 'm', null, 'in'), E('m', 'out')]
  const ctx = makeCtx()
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  await rn.runDataGraphOn(ctx, nodes, edges, nodeMap, (n, e) => ex.execNode(ctx, n, e, 0))
  // '5' * (无第二输入 → 0) = 0
  assert.equal(runtime.readOutput('m', null).text, '0')
  assert.equal(ctx.nodeStates.get('t'), 'succeeded')
})

await test('C2 runExecGraphOn: Branch 按条件走 True / False 出口', async () => {
  async function branchFlow(cond) {
    resetRt()
    const nodes = [
      N('v', 'variableNode', { dtype: 'bool', value: cond }),
      N('br', 'branchNode'),
      N('ty', 'variableSetNode', { varName: 'path', default: '' }),
      N('tn', 'variableNode', { dtype: 'text', value: 'TRUE' }),
      N('fz', 'variableSetNode', { varName: 'path', default: '' }),
      N('fn', 'variableNode', { dtype: 'text', value: 'FALSE' })
    ]
    const edges = [
      E('v', 'br'),                                     // 条件数据边
      E('br', 'ty', T.EXEC_TRUE_HANDLE, T.EXEC_IN_HANDLE),   // True 出口
      E('tn', 'ty'),                                    // True 分支的值
      E('br', 'fz', T.EXEC_FALSE_HANDLE, T.EXEC_IN_HANDLE),  // False 出口
      E('fn', 'fz')
    ]
    const ctx = makeCtx()
    await rn.runExecGraphOn(ctx, nodes, edges, new Map(nodes.map((n) => [n.id, n])),
      (n, e) => ex.execNode(ctx, n, e, 0))
    return rt.vars.get('path')
  }
  assert.equal(await branchFlow('true'), 'TRUE', '条件为真时只走 True 出口')
  assert.equal(await branchFlow('false'), 'FALSE', '条件为假时只走 False 出口')
})

await test('C3 runExecGraphOn: Branch 节点上的手填条件作为兜底', async () => {
  resetRt()
  // 无数据上游，只有手填 condition
  const nodes = [N('br', 'branchNode', { condition: 'yes' }), N('s', 'variableSetNode', { varName: 'p', default: '' }),
    N('c', 'variableNode', { dtype: 'text', value: 'HAND' })]
  const edges = [E('br', 's', T.EXEC_TRUE_HANDLE, T.EXEC_IN_HANDLE), E('c', 's')]
  const ctx = makeCtx()
  await rn.runExecGraphOn(ctx, nodes, edges, new Map(nodes.map((n) => [n.id, n])),
    (n, e) => ex.execNode(ctx, n, e, 0))
  assert.equal(rt.vars.get('p'), 'HAND')
})

await test('C4 runExecGraphOn: Sequence 多出口按序触发，出口数夹在 1..16', async () => {
  resetRt()
  const nodes = [N('sq', 'sequenceNode', { outputs: 3 }),
    N('a', 'variableSetNode', { varName: 'k1', default: 'a' }),
    N('b', 'variableSetNode', { varName: 'k2', default: 'b' }),
    N('c', 'variableSetNode', { varName: 'k3', default: 'c' })]
  const edges = [
    E('sq', 'a', 'exec-0', T.EXEC_IN_HANDLE),
    E('sq', 'b', 'exec-1', T.EXEC_IN_HANDLE),
    E('sq', 'c', 'exec-2', T.EXEC_IN_HANDLE)
  ]
  const ctx = makeCtx()
  await rn.runExecGraphOn(ctx, nodes, edges, new Map(nodes.map((n) => [n.id, n])),
    (n, e) => ex.execNode(ctx, n, e, 0))
  assert.deepEqual([...rt.vars.keys()].sort(), ['k1', 'k2', 'k3'], '三个出口都被执行')
  // 非法出口数被夹住
  resetRt()
  const nodes2 = [N('sq', 'sequenceNode', { outputs: 999 }), N('a', 'variableSetNode', { varName: 'only', default: 'x' })]
  const ctx2 = makeCtx()
  await rn.runExecGraphOn(ctx2, nodes2, [E('sq', 'a', 'exec-15', T.EXEC_IN_HANDLE)],
    new Map(nodes2.map((n) => [n.id, n])), (n, e) => ex.execNode(ctx2, n, e, 0))
  assert.equal(rt.vars.get('only'), 'x', '第 16 个出口（下标 15）仍可达')
})

await test('C5 runExecGraphOn: 事件分发 Call 触发 Bind 的下游链路', async () => {
  resetRt()
  const nodes = [
    N('bind', 'eventBindNode', { dispatcher: 'done' }),
    N('call', 'eventCallNode', { dispatcher: 'done' }),
    N('afterBind', 'variableSetNode', { varName: 'fired', default: 'yes' })
  ]
  const edges = [
    E('bind', 'afterBind', T.EXEC_OUT_HANDLE, T.EXEC_IN_HANDLE),
    // Call 自身无 exec 出边：它要触发的正是 Bind 挂的那条链路
    E('call', 'afterBind', T.EXEC_OUT_HANDLE, T.EXEC_IN_HANDLE)
  ]
  const ctx = makeCtx()
  await rn.runExecGraphOn(ctx, nodes, edges, new Map(nodes.map((n) => [n.id, n])),
    (n, e) => ex.execNode(ctx, n, e, 0))
  assert.equal(rt.vars.get('fired'), 'yes', 'Bind 的下游被 Call 拉起')
})

await test('C6 runExecGraphOn: 未覆盖的数据节点由拓扑兜底执行', async () => {
  resetRt()
  // 完全没有 exec 节点的纯数据子图
  const nodes = [N('t', 'textNode', { text: '3' }), N('c', 'castNode', { to: 'int' })]
  const ctx = makeCtx()
  await rn.runExecGraphOn(ctx, nodes, [E('t', 'c')], new Map(nodes.map((n) => [n.id, n])),
    (n, e) => ex.execNode(ctx, n, e, 0))
  assert.equal(runtime.readOutput('c', null).text, '3')
})

/**
 * 循环测试的公共脚手架：循环体节点必须真正挂在循环节点的 exec 出边上，
 * 否则 `loopSegment` 推断出的循环体集合为空、循环体一次都不会跑
 * （这本身是正确行为，但会让"迭代次数"类断言测不到东西）。
 */
function loopFixture(loopParams, bodyParams = { varName: 'k', default: '' }) {
  const { __type = 'forEachNode', ...params } = loopParams
  const loop = N('lp', __type, params)
  const body = N('bd', 'variableSetNode', bodyParams)
  const nodes = [loop, body]
  const edges = [E('lp', 'bd', T.EXEC_OUT_HANDLE, T.EXEC_IN_HANDLE)]
  return { loop, body, nodes, edges, map: new Map(nodes.map((n) => [n.id, n])) }
}

await test('C7 runLoopOn: For Each 按字面量列表迭代并输出 Index', async () => {
  resetRt()
  const { loop, nodes, edges, map } = loopFixture({ mode: 'image', items: 'a.png, b.png ,c.png', dir: '' })
  const ctx = makeCtx()
  const seen = []
  let lastBody = null
  await rn.runLoopOn(ctx, loop, nodes, edges, map, async (sid, sn) => {
    seen.push(runtime.readOutput('lp', T.ITER_INDEX_HANDLE).text)
    lastBody = sn.id
    await ex.execNode(ctx, sn, edges, 0)
  })
  assert.deepEqual(seen, ['0', '1', '2'], '三次迭代，Index 依次 0/1/2')
  assert.deepEqual(ctx.iters.get('lp'), { index: 3, total: 3 })
  assert.equal(lastBody, 'bd', '每轮执行的是挂在 exec 出边上的循环体节点')
  // image 模式：每轮把当前项拉成 File 作为循环节点产物，供循环体内下游读取。
  const cur = runtime.readOutput('lp', null)
  assert.equal(cur.type, 'image')
  assert.equal(cur.file.name, 'c.png', '末轮产物是列表最后一项')
  assert.deepEqual(
    fetched.map((u) => u.split('/').pop()),
    ['a.png', 'b.png', 'c.png'],
    '按列表顺序逐项取回，且已剔除项间空白'
  )
})

await test('C8 runLoopOn: For Each 空列表也至少跑一轮', async () => {
  resetRt()
  const { loop, nodes, edges, map } = loopFixture({ mode: 'image', items: '', dir: '' })
  const ctx = makeCtx()
  let rounds = 0
  await rn.runLoopOn(ctx, loop, nodes, edges, map, async () => {
    rounds++
  })
  assert.equal(rounds, 1, '空列表保底执行一轮，保证"无输入"路径也被覆盖')
  assert.equal(ctx.iters.get('lp').total, 1)
  assert.equal(runtime.readOutput('lp', null), undefined, '空列表时循环节点不产出数据')
})

await test('C9 runLoopOn: While auto 模式按 iterations 次数执行', async () => {
  resetRt()
  const { loop, nodes, edges, map } = loopFixture({ __type: 'whileNode', iterations: 4 })
  const ctx = makeCtx()
  let rounds = 0
  // manual 收尾会挂起：auto 跑完后仍需 continue 才能结束，故用微任务提交指令。
  const body = rn.runLoopOn(ctx, loop, nodes, edges, map, async () => {
    rounds++
  })
  // 等 auto 迭代跑完进入 manual 收尾挂起
  for (let i = 0; i < 50 && !rt.whileResolve; i++) await tick()
  assert.equal(rounds, 4, 'auto 迭代 4 次')
  assert.equal(ctx.nodeStates.get('lp'), 'waiting', 'auto 跑完进入手动收尾挂起')
  assert.equal(runtime.readOutput('lp', T.ITER_INDEX_HANDLE).text, '3', '末轮 Index = 3')
  rt.whileResolve('continue')
  await body
  assert.equal(rounds, 4, 'continue 不再追加迭代')
})

await test('C10 runLoopOn: While manual 模式挂起，retry 重跑循环体', async () => {
  resetRt()
  const { loop, nodes, edges, map } = loopFixture({ __type: 'whileNode', iterations: 0 }) // 0 → manual
  const ctx = makeCtx()
  let rounds = 0
  const body = rn.runLoopOn(ctx, loop, nodes, edges, map, async () => {
    rounds++
  })
  for (let i = 0; i < 50 && !rt.whileResolve; i++) await tick()
  assert.ok(rt.whileResolve, 'manual 模式应挂起等待指令')
  assert.equal(ctx.nodeStates.get('lp'), 'waiting')
  assert.equal(rounds, 0, '未下指令前不执行循环体')
  assert.equal(ctx.get().runState, 'paused', '运行态切到 paused，UI 才能给出 Continue/Retry')
  rt.whileResolve('retry')
  // 重跑一次后又回到挂起态等下一步指令（'running' 只在重跑那一瞬，无法稳定观测）。
  for (let i = 0; i < 50 && !(rounds === 1 && rt.whileResolve); i++) await tick()
  assert.equal(rounds, 1, 'retry 重跑一次循环体')
  assert.equal(ctx.get().runState, 'paused', '重跑后再次挂起')
  assert.equal(ctx.nodeStates.get('lp'), 'waiting')
  rt.whileResolve('continue')
  await body
  assert.equal(rounds, 1)
})

await test('C11 取消标志：循环体每轮检查 cancelRequested', async () => {
  resetRt()
  const { loop, nodes, edges, map } = loopFixture({ mode: 'image', items: 'a.png,b.png,c.png,d.png,e.png', dir: '' })
  const ctx = makeCtx()
  let rounds = 0
  await assert.rejects(
    () => rn.runLoopOn(ctx, loop, nodes, edges, map, async () => {
      rounds++
      if (rounds === 2) rt.cancelRequested = true
    }),
    (e) => e instanceof hl.Cancelled
  )
  assert.equal(rounds, 2, '第二轮置位后第三轮入口即中断')
})

// ═══════════════════════════════════════════════════════════════════════════════
// D. 重型节点：用桩验证参数组装与错误分支（不做真实推理）
// ═══════════════════════════════════════════════════════════════════════════════

await test('D1 generatorNode: 缺 generatorId / 缺上游 → 明确报错', async () => {
  await assert.rejects(() => runNode(N('g', 'generatorNode', {}), []), /no generator selected/)
  await assert.rejects(
    () => runNode(N('g', 'generatorNode', { generatorId: 'x' }), []),
    /needs an upstream image/
  )
})

await test('D2 generatorNode: 正确提交图片与参数并回填结果 URL', async () => {
  resetRt()
  const f = new File(['img'], 'in.png')
  rt.outputs.set('img', { type: 'image', file: f })
  const node = N('g', 'generatorNode', { generatorId: 'hunyuan3d-2-mini', steps: 25 })
  const ctx = makeCtx()
  await ex.execNode(ctx, node, [E('img', 'g')])
  assert.equal(calls.submitImage.length, 1, '提交一次后端任务')
  const [image, genId, params, views] = calls.submitImage[0]
  assert.equal(image, f, '传的是上游 File')
  assert.equal(genId, 'hunyuan3d-2-mini')
  assert.equal(params.steps, 25, '节点参数一并提交')
  assert.deepEqual(views, {}, '非 MV 生成器不带 views')
  assert.equal(runtime.readOutput('g', null).url, 'http://127.0.0.1:8766/files/result.glb', '结果 URL 写回产物')
  assert.equal(rt.activeJobId, null, '轮询结束后清空 activeJobId')
})

await test('D3 generatorNode(MV): 从数组上游组装四视角', async () => {
  resetRt()
  const fs4 = ['front', 'left', 'back', 'right'].map((n) => new File([n], `${n}.png`))
  rt.outputs.set('arr', { type: 'array', items: fs4 })
  const node = N('g', 'generatorNode', { generatorId: 'hunyuan3d-2-mv' })
  const ctx = makeCtx()
  await ex.execNode(ctx, node, [E('arr', 'g')])
  const [img, genId, , views] = calls.submitImage[0]
  assert.equal(genId, 'hunyuan3d-2-mv')
  assert.deepEqual(Object.keys(views).sort(), ['back', 'front', 'left', 'right'], '四个视角齐备')
  // 主图必须是 front，其余视角各取数组中的对应项（回归守卫：不得全为首图）。
  assert.equal(img.name, 'front.png', '主图 = front 视角')
  assert.deepEqual(
    MV_TAGS.map((t) => views[t].name),
    ['front.png', 'left.png', 'back.png', 'right.png'],
    '四视角按顺序一一对应'
  )
})

await test('D3b generatorNode(MV): 四个视角引脚各接一张图片', async () => {
  resetRt()
  const names = ['front', 'left', 'back', 'right']
  names.forEach((n, i) => rt.outputs.set(`v${i}`, { type: 'image', file: new File([n], `${n}.png`) }))
  const node = N('g', 'generatorNode', { generatorId: 'hunyuan3d-2-mv' })
  const edges = names.map((n, i) => E(`v${i}`, 'g', null, T.paramHandleFor(`view_${n}`)))
  await ex.execNode(makeCtx(), node, edges)
  const [img, genId, , views] = calls.submitImage[0]
  assert.equal(genId, 'hunyuan3d-2-mv')
  assert.equal(img.name, 'front.png', '主图 = 视角引脚上的 front')
  assert.deepEqual(
    MV_TAGS.map((t) => views[t].name),
    names.map((n) => `${n}.png`),
    '四视角逐引脚一一对应（图片接得进、也送得出去）'
  )
})

await test('D3c generatorNode(MV): 视角引脚覆盖数组回退', async () => {
  resetRt()
  const arrFiles = ['f', 'l', 'b', 'r'].map((n) => new File([n], `arr-${n}.png`))
  rt.outputs.set('arr', { type: 'array', items: arrFiles })
  rt.outputs.set('vback', { type: 'image', file: new File(['x'], 'pin-back.png') })
  const node = N('g', 'generatorNode', { generatorId: 'hunyuan3d-2-mv' })
  const edges = [E('arr', 'g'), E('vback', 'g', null, T.paramHandleFor('view_back'))]
  await ex.execNode(makeCtx(), node, edges)
  const [img, , , views] = calls.submitImage[0]
  assert.equal(img.name, 'arr-f.png', 'front 仍来自数组第 1 张')
  assert.equal(views.back.name, 'pin-back.png', 'back 用引脚上的图片')
  assert.equal(views.left.name, 'arr-l.png', '其它视角继续按数组顺序补齐')
})

await test('D4 generatorNode(MV): 上游无法提供视角 → 报错', async () => {
  await assert.rejects(
    () => runNode(N('g', 'generatorNode', { generatorId: 'hunyuan3d-2-mv' }), [E('arr', 'g')],
      { seed: { arr: { type: 'array', items: [] } } }),
    (e) => e instanceof Error
  )
})

await test('D5 extensionNode: 未知扩展 → 明确报错', async () => {
  await assert.rejects(
    () => runNode(N('e', 'extensionNode', { extensionId: 'nope' }), []),
    /unknown extension/
  )
})

await test('D6 节点状态机：成功路径置 succeeded 并推进进度', async () => {
  const r = await runNode(N('t', 'textNode', { text: 'x' }), [])
  assert.equal(r.ctx.nodeStates.get('t'), 'succeeded')
  assert.equal(r.ctx.get().nodeProgress.t, 1, '进度推进到 1')
  assert.equal(r.ctx.get().activeNodeId, null, '执行完毕后清除活跃节点')
})

await test('D7 失败路径：抛出异常且不标记 succeeded', async () => {
  resetRt()
  const ctx = makeCtx()
  await assert.rejects(() => ex.execNode(ctx, N('m', 'meshNode', {}), []))
  assert.equal(ctx.nodeStates.get('m'), 'running', '失败时停在 running，由引擎改写为 failed')
})

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

const failed = RESULTS.filter(([, ok]) => !ok)
console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} passed`)
process.exit(failed.length ? 1 : 0)
