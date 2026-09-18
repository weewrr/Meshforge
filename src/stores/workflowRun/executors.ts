/**
 * 工作流运行器：节点执行器。
 *
 * 从 engine.ts 原样迁出的 `execNode`：按 `node.type` 分派到对应语义，
 * 把结果写进 `rt.outputs`。所有 store/闭包依赖经 `EngineCtx` 注入，
 * 子图递归通过 `ctx.execNode` 回到同一入口。
 */

import { fullUrl, processMesh, submitImage } from '../../api'
import {
  DISPATCHER_PARAM,
  OUT_HANDLE,
  STRUCT_FIELDS_PARAM,
  SUBGRAPH_INPUT_NODE,
  SUBGRAPH_OUTPUT_NODE,
  VAR_NAME_PARAM,
  getExtensionById,
  getSubgraphDoc,
  inputIndexForHandle,
  packStruct,
  structFields,
  structOutHandle,
  unpackStruct,
  type WFEdge,
  type WFNode
} from '../../types'
import { useSceneStore } from '../scene'
import type { EngineCtx } from './engine-context'
import { Cancelled, isVoidOutput, mvViewsFrom, nodeExtensionId, resolveParamPins, textInputs, topoSort, truthy, urlToFile } from './helpers'
import { readOutput, rt, storeOutput } from './runtime'
import { HUNYUAN_MV_GENERATOR, MAX_GRAPH_DEPTH, MV_VIEW_TAGS, type MvViewTag, type NodeOutput } from './types'

/**
 * 执行单个节点。
 *
 * @param ctx 引擎上下文（store 读写 / 轮询 / 闸门等闭包依赖）
 * @param node 目标节点
 * @param edges 所属（子）图的全部边（用于找上游 / 解析参数引脚）
 * @param depth 子图嵌套深度，超过 `MAX_GRAPH_DEPTH` 时停止下钻
 */
export async function execNode(ctx: EngineCtx, node: WFNode, edges: WFEdge[], depth = 0): Promise<void> {
  const { set, get, logger, setNodeState, findUpstream, pollJob, gate } = ctx
  const label = node.data.label
  await gate(node)
  setNodeState(node.id, 'running')
  set({ activeNodeId: node.id })
  const params = node.data.params

  switch (node.type) {
    case 'imageNode': {
      // 图片来源优先级：本次运行传入的覆盖图（只生效一次）> 节点上配置的 URL。
      let file: File | null = null
      if (rt.overrideImage && !rt.overrideUsed) {
        file = rt.overrideImage
        rt.overrideUsed = true
        logger.info(`${label}: using override image`)
      } else {
        const url = String(params.url ?? '')
        if (!url) throw new Error(`${label}: no image configured`)
        file = await urlToFile(url, String(params.fileName ?? 'input.png'))
      }
      // 四视角：若 params 里存了 view_front/left/back/right 的 url（由 ImageParamRow
      // 在 MV 模式写入），则一并转成 File，供下游 MV 生成器组装 views 上传。
      const views: NodeOutput['views'] = {}
      for (const tag of MV_VIEW_TAGS) {
        const vurl = String(params[`view_${tag}`] ?? '')
        if (!vurl) continue
        try {
          views[tag] = await urlToFile(vurl, String(params[`view_${tag}_name`] ?? `view_${tag}.png`))
        } catch {
          // 单个视角加载失败时跳过该视角，避免阻塞整次生成
          logger.warn(`${label}: failed to load view '${tag}'`)
        }
      }
      rt.outputs.set(node.id, {
        type: 'image',
        file,
        // 只有真的凑到视角时才带上 views 字段，保持旧节点输出的形状不变。
        ...(Object.keys(views).length ? { views } : {})
      })
      break
    }

    case 'textNode': {
      rt.outputs.set(node.id, { type: 'text', text: String(params.text ?? '') })
      break
    }

    case 'arrayNode': {
      // 数组节点：把多张图片槽逐个转成 File；单项失败只记警告，不影响其余项。
      const items = (Array.isArray(params.items) ? params.items : []) as Array<{
        id: string
        url: string
        fileName: string
      }>
      const files: File[] = []
      for (const it of items) {
        if (!it || !it.url) continue
        try {
          files.push(await urlToFile(it.url, it.fileName || 'input.png'))
        } catch (e) {
          logger.warn(`${label}: failed to load array item ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      rt.outputs.set(node.id, { type: 'array', items: files })
      break
    }

    case 'meshNode': {
      // source='current' 表示取 3D 查看器里当前展示的模型，而不是磁盘上的文件。
      if (String(params.source ?? 'file') === 'current') {
        const current = useSceneStore.getState().meshUrl
        if (!current) throw new Error(`${label}: no current model in the 3D viewer`)
        logger.info(`${label}: using current model from viewer`)
        rt.outputs.set(node.id, { type: 'mesh', url: current })
        break
      }
      const url = String(params.url ?? '')
      if (!url) throw new Error(`${label}: no mesh file configured`)
      rt.outputs.set(node.id, { type: 'mesh', url })
      break
    }

    case 'generatorNode': {
      const generatorId = String(params.generatorId ?? '')
      if (!generatorId) throw new Error(`${label}: no generator selected`)
      const upstream = findUpstream(node.id, edges)
      if (!upstream) throw new Error(`${label}: needs an upstream image`)
      // 多视角（MV）生成器的输入形状与普通单图不同，需单独组装 views。
      const isMV = generatorId === HUNYUAN_MV_GENERATOR
      let image: File
      let views: Partial<Record<MvViewTag, File>> = {}
      if (isMV) {
        const mv = mvViewsFrom(node, upstream)
        if (!mv) throw new Error(`${label}: MV 需要上游为 多视角图片节点 或 数组节点`)
        image = mv.front
        views = mv.views
      } else {
        if (upstream.type !== 'image' || !upstream.file) throw new Error(`${label}: needs an upstream image`)
        image = upstream.file
      }
      logger.info(`${label}: submitting to '${generatorId}'`)
      const { job_id } = await submitImage(image, generatorId, params, views)
      // activeJobId 供 cancel() 用来撤销后端任务；轮询结束后立即清空。
      rt.activeJobId = job_id
      const resultUrl = await pollJob(job_id, node.id, label)
      rt.activeJobId = null
      set({ currentJobId: null })
      rt.outputs.set(node.id, { type: 'mesh', url: resultUrl })
      break
    }

    case 'extensionNode': {
      const extensionId = nodeExtensionId(node)
      const ext = getExtensionById(extensionId)
      if (!ext) throw new Error(`${label}: unknown extension '${extensionId}'`)
      // 参数引脚覆盖：接到 `p:<paramId>` 引脚上的文本值优先生效，缺省用内联值。
      const extParams = resolveParamPins(node, edges, ext)
      if (ext.kind === 'process') {
        // 网格处理工具（mesh → mesh / none）。
        const upstream = findUpstream(node.id, edges)
        if (!upstream || upstream.type !== 'mesh' || !upstream.url) {
          throw new Error(`${label}: needs an upstream mesh`)
        }
        logger.info(`${label}: processing mesh`)
        const { job_id } = await processMesh(upstream.url, ext.id, extParams)
        rt.activeJobId = job_id
        const resultUrl = await pollJob(job_id, node.id, label)
        rt.activeJobId = null
        set({ currentJobId: null })
        // output='none' 的纯副作用工具（如仅导出）不产出下游可用的网格。
        if (ext.output !== 'none') {
          rt.outputs.set(node.id, { type: 'mesh', url: resultUrl })
        }
        break
      }
      // 模型生成器（image → mesh），管线与 generatorNode 完全一致。
      const upstream = findUpstream(node.id, edges)
      if (!upstream) throw new Error(`${label}: needs an upstream image`)
      logger.info(`${label}: submitting to '${ext.id}'`)
      const isMV = ext.id === HUNYUAN_MV_GENERATOR
      let image: File
      let views: Partial<Record<MvViewTag, File>> = {}
      if (isMV) {
        const mv = mvViewsFrom(node, upstream)
        if (!mv) throw new Error(`${label}: MV 需要上游为 多视角图片节点 或 数组节点`)
        image = mv.front
        views = mv.views
      } else {
        if (upstream.type !== 'image' || !upstream.file) throw new Error(`${label}: needs an upstream image`)
        image = upstream.file
      }
      const { job_id } = await submitImage(image, ext.id, extParams, views)
      rt.activeJobId = job_id
      const resultUrl = await pollJob(job_id, node.id, label)
      rt.activeJobId = null
      set({ currentJobId: null })
      rt.outputs.set(node.id, { type: 'mesh', url: resultUrl })
      break
    }

    case 'previewNode':
    case 'outputNode': {
      // 终端节点：把上游网格推进 3D 查看器（预览节点还会把数据继续透传）。
      const upstream = findUpstream(node.id, edges)
      if (!upstream || upstream.type !== 'mesh' || !upstream.url) {
        throw new Error(`${label}: needs an upstream mesh`)
      }
      useSceneStore.getState().pushMeshUrl(fullUrl(upstream.url))
      logger.info(`${label}: mesh pushed to viewer`)
      if (node.type === 'previewNode') rt.outputs.set(node.id, upstream)
      break
    }

    case 'waitNode': {
      // 人工闸门：透传上游后挂起，等用户点「继续」或「取消」。
      const upstream = findUpstream(node.id, edges)
      if (upstream) rt.outputs.set(node.id, upstream)
      setNodeState(node.id, 'waiting')
      set({ runState: 'paused', activeNodeId: node.id })
      logger.info(`${label}: paused — waiting for user to continue`)
      const action = await new Promise<'continue' | 'cancel'>((resolve) => {
        rt.waitResolve = resolve
      })
      rt.waitResolve = null
      if (action === 'cancel') throw new Cancelled()
      set({ runState: 'running' })
      break
    }

    case 'rerouteNode': {
      // 跳线点：把上游输出直接透传，让下游只关心拓扑连线。
      const up = findUpstream(node.id, edges)
      if (up) rt.outputs.set(node.id, up)
      break
    }

    case 'selectNode': {
      // Select 多输入一输出：按 mode 选定一个输入，透传其输出。
      // mode 为 'auto' 时取第一条已有输出的上游；否则按 handle 下标取固定输入。
      const incoming = edges
        .filter((e) => e.target === node.id)
        .map((e) => ({
          idx: inputIndexForHandle(e.targetHandle),
          out: rt.outputs.get(e.source) as NodeOutput | undefined
        }))
      let chosen: NodeOutput | undefined
      const mode = String(params.mode ?? 'auto')
      if (mode === 'auto') {
        // 跳过空输出（例如条件不成立时的占位值），避免把"真空"当成有效数据。
        chosen = incoming.filter((x) => !!x.out && !isVoidOutput(x.out))[0]?.out
      } else {
        const idx = parseInt(mode, 10)
        chosen = incoming.find((x) => x.idx === idx)?.out
      }
      if (chosen) rt.outputs.set(node.id, chosen)
      else logger.warn(`${label}: Select 没有可用输入，本次无输出`)
      break
    }

    case 'commentNode': {
      // 注释框仅布局用，无执行语义。
      break
    }

    case 'variableNode': {
      // 变量/常量：把内联值作为文本输出（供任意文本/参数引脚使用）。
      const dtype = String(params.dtype ?? 'text')
      let text = String(params.value ?? '')
      // bool 类型统一归一化成小写 'true'/'false'，方便下游 Compare/Bool 节点按字面量判断。
      if (dtype === 'bool') text = truthy(params.value) ? 'true' : 'false'
      rt.outputs.set(node.id, { type: 'text', text })
      break
    }

    case 'isValidNode': {
      // 判空：上游存在有效数据 → 'true'。
      const up = findUpstream(node.id, edges)
      rt.outputs.set(node.id, { type: 'text', text: (up && !isVoidOutput(up)) ? 'true' : 'false' })
      break
    }

    case 'isEmptyNode': {
      // 判空（文本维度）：上游不存在、或文本 trim 后为空 → 'true'。
      const up = findUpstream(node.id, edges)
      const empty = !up || !up.text || String(up.text).trim() === ''
      rt.outputs.set(node.id, { type: 'text', text: empty ? 'true' : 'false' })
      break
    }

    case 'boolNode': {
      // 布尔运算：xor 要求恰好一个输入为真；and 要求输入非空且全真（空输入不算真）。
      const ins = textInputs(node.id, edges)
      const op = String(params.operator ?? 'and')
      let result = false
      if (op === 'or') result = ins.some((v) => truthy(v))
      else if (op === 'xor') result = ins.filter((v) => truthy(v)).length === 1
      else result = ins.length > 0 && ins.every((v) => truthy(v)) // and
      rt.outputs.set(node.id, { type: 'text', text: result ? 'true' : 'false' })
      break
    }

    case 'mathNode': {
      // 数学运算：非数字输入先被过滤掉；除数为 0 时返回 0 而非 Infinity。
      const nums = textInputs(node.id, edges).map(Number).filter((n) => !isNaN(n))
      const op = String(params.operator ?? '+')
      let result = 0
      if (op === '-') result = (nums[0] ?? 0) - (nums[1] ?? 0)
      else if (op === '*') result = (nums[0] ?? 0) * (nums[1] ?? 0)
      else if (op === '/') result = nums[1] ? (nums[0] ?? 0) / nums[1] : 0
      else if (op === 'min') result = Math.min(...nums)
      else if (op === 'max') result = Math.max(...nums)
      else if (op === 'abs') result = Math.abs(nums[0] ?? 0)
      else result = nums.reduce((a, b) => a + b, 0) // +
      rt.outputs.set(node.id, { type: 'text', text: String(result) })
      break
    }

    case 'compareNode': {
      // 比较：两侧都能解析成数字时按数值比较，否则退化为字符串比较。
      const [a, b] = textInputs(node.id, edges)
      const op = String(params.operator ?? '==')
      const na = Number(a)
      const nb = Number(b)
      // 空串会被 Number() 转成 0，因此显式排除，避免 '' 被当成 0 参与数值比较。
      const bothNum = !isNaN(na) && !isNaN(nb) && a !== '' && b !== ''
      let result = false
      const x = bothNum ? na : a
      const y = bothNum ? nb : b
      switch (op) {
        case '!=': result = x !== y; break
        case '>': result = x > y; break
        case '>=': result = x >= y; break
        case '<': result = x < y; break
        case '<=': result = x <= y; break
        default: result = x === y
      }
      rt.outputs.set(node.id, { type: 'text', text: result ? 'true' : 'false' })
      break
    }

    case 'concatNode': {
      // 拼接：按输入引脚顺序用 separator 连接成一段文本。
      const sep = String(params.separator ?? '')
      const parts = textInputs(node.id, edges).filter((s) => s !== undefined)
      rt.outputs.set(node.id, { type: 'text', text: parts.join(sep) })
      break
    }

    case 'gateNode': {
      // 数据门：open 为真时透传上游数据，否则无输出。
      // 只有显式写了 'false' 才关闭，缺省（未配置）视为开启。
      if (String(params.open ?? 'true') !== 'false') {
        const up = findUpstream(node.id, edges)
        if (up) rt.outputs.set(node.id, up)
      }
      break
    }

    case 'variableGetNode': {
      // 变量读取：取运行期变量表；未赋值时回退到 fallback（缺省空串）。
      const name = String(params[VAR_NAME_PARAM] ?? '').trim()
      const value = name ? rt.vars.get(name) : undefined
      rt.outputs.set(node.id, { type: 'text', text: value ?? String(params.fallback ?? '') })
      break
    }

    case 'variableSetNode': {
      // 变量写入：优先取数据输入（上游连线）的值，缺省用 default；写完后原样输出。
      const name = String(params[VAR_NAME_PARAM] ?? '').trim()
      const up = findUpstream(node.id, edges)
      const text = String(up?.text ?? params.default ?? '')
      if (name) rt.vars.set(name, text)
      else logger.warn(`${label}: 未设置变量名，本次写入被忽略`)
      rt.outputs.set(node.id, { type: 'text', text })
      break
    }

    case 'eventBindNode': {
      // 绑定声明：Bind 节点是"声明式"的（等价于 UE 的 Bind Event），运行开始时
      // 已由 run() 统一登记；这里只在被数据图显式执行时兜底补登记一次。
      const name = String(params[DISPATCHER_PARAM] ?? '').trim()
      if (!name) {
        logger.warn(`${label}: 未设置事件名，绑定被忽略`)
        break
      }
      const list = rt.boundDispatchers.get(name) ?? []
      if (!list.includes(node.id)) list.push(node.id)
      rt.boundDispatchers.set(name, list)
      break
    }

    case 'eventCallNode': {
      // 调用：真正的下游触发在 exec 调度里（按 boundDispatchers 展开绑定链路）。
      // 这里只做日志与告警，本身不产生输出。
      const name = String(params[DISPATCHER_PARAM] ?? '').trim()
      const n = name ? (rt.boundDispatchers.get(name)?.length ?? 0) : 0
      if (!name) logger.warn(`${label}: 未设置事件名`)
      else logger.info(`${label}: 调用事件 '${name}'（已绑定 ${n} 处）`)
      break
    }

    case 'makeStructNode': {
      // 组装结构体：把各路输入按字段顺序编成 `字段=值;…` 文本。
      const fields = structFields(params[STRUCT_FIELDS_PARAM])
      const values = textInputs(node.id, edges)
      rt.outputs.set(node.id, { type: 'text', text: packStruct(fields, fields.map((_, i) => values[i])) })
      break
    }

    case 'breakStructNode': {
      // 拆解结构体：按字段名逐个取出，写到各自的输出引脚（out0 / out1 …）。
      const fields = structFields(params[STRUCT_FIELDS_PARAM])
      const raw = String(findUpstream(node.id, edges)?.text ?? '')
      fields.forEach((_f, i) => {
        storeOutput(node.id, structOutHandle(i), { type: 'text', text: unpackStruct(raw, fields, i) })
      })
      break
    }

    case 'castNode': {
      // 类型转换：按目标类型重新解释上游文本（UE 的 Conv_* 节点）。
      // 解析失败统一给 '0'，保证下游数字节点拿到可用值。
      const raw = String(findUpstream(node.id, edges)?.text ?? '')
      const to = String(params.to ?? 'float')
      let text = raw
      if (to === 'float') {
        const n = Number(raw)
        text = Number.isNaN(n) ? '0' : String(n)
      } else if (to === 'int') {
        const n = parseInt(raw, 10)
        text = Number.isNaN(n) ? '0' : String(n)
      } else if (to === 'bool') {
        text = truthy(raw) ? 'true' : 'false'
      }
      rt.outputs.set(node.id, { type: 'text', text })
      break
    }

    case 'clampNode': {
      // 钳制：value 落在 [min, max] 区间内（输入不足时按 0/1 兜底）。
      // 上下界传入顺序不保证大小，因此先做 min/max 归一。
      const [v, lo, hi] = textInputs(node.id, edges).map((s) => Number(s))
      const value = Number.isNaN(v) ? 0 : v
      const a = Number.isNaN(lo) ? 0 : lo
      const b = Number.isNaN(hi) ? 1 : hi
      const min = Math.min(a, b)
      const max = Math.max(a, b)
      rt.outputs.set(node.id, { type: 'text', text: String(Math.min(Math.max(value, min), max)) })
      break
    }

    case 'lerpNode': {
      // 线性插值：A + (B - A) * Alpha。Alpha 会被夹到 [0,1]，避免外插。
      const [a, b, t] = textInputs(node.id, edges).map((s) => Number(s))
      const from = Number.isNaN(a) ? 0 : a
      const to = Number.isNaN(b) ? 1 : b
      const alpha = Number.isNaN(t) ? 0 : Math.min(Math.max(t, 0), 1)
      rt.outputs.set(node.id, { type: 'text', text: String(from + (to - from) * alpha) })
      break
    }

    case 'randomNode': {
      // 随机数：在 [min, max] 内取一个值（缺省 0..1）。
      // 结果截到 3 位小数：避免浮点尾巴污染下游文本比较/拼接。
      const [lo, hi] = textInputs(node.id, edges).map((s) => Number(s))
      const a = Number.isNaN(lo) ? 0 : lo
      const b = Number.isNaN(hi) ? 1 : hi
      const min = Math.min(a, b)
      const max = Math.max(a, b)
      const value = min + Math.random() * (max - min)
      rt.outputs.set(node.id, { type: 'text', text: String(Math.round(value * 1000) / 1000) })
      break
    }

    case 'subgraphNode': {
      // 函数/子图折叠：把外部输入读到子图输入挂点 → 内联执行子图内部 → 逐个读取
      // 输出挂点（Exit 节点）的输入值，按对应 handle 写回本节点。
      // 内部有 exec 边时走 exec 调度（Branch/Sequence/Set/事件在函数体内同样生效），
      // 否则保持纯数据 DAG 拓扑执行。
      const doc = getSubgraphDoc({ data: { params: params as Record<string, unknown> } })
      if (!doc || doc.nodes.length === 0) {
        logger.warn(`${label}: 子图为空`)
        break
      }
      // 1) 入参注入：把 `in0/in1/...` 引脚上的值写到子图内对应的输入挂点 refId 上。
      for (const e of edges) {
        if (e.target !== node.id) continue
        const m = /^in(\d+)$/.exec(String(e.targetHandle ?? ''))
        if (!m) continue
        const inp = doc.inputs[parseInt(m[1], 10)]
        if (!inp) continue
        const up = readOutput(e.source, e.sourceHandle)
        if (up) rt.outputs.set(inp.refId, up)
      }
      // 递归保护：图论上允许自嵌套，超过深度上限直接停止下钻，防止栈溢出/死循环。
      if (depth >= MAX_GRAPH_DEPTH) {
        logger.warn(`${label}: 子图嵌套超过 ${MAX_GRAPH_DEPTH} 层，已停止下钻`)
        break
      }
      // 2) 内联执行函数体：优先走 run() 注入的 innerGraphRunner（支持 exec 语义）。
      if (rt.innerGraphRunner) {
        await rt.innerGraphRunner(doc.nodes, doc.edges, depth + 1)
      } else {
        // 兜底（理论上不会走到）：旧的纯数据路径。
        const innerMap = new Map(doc.nodes.map((n) => [n.id, n]))
        for (const innerId of topoSort(doc.nodes, doc.edges)) {
          const inner = innerMap.get(innerId)
          if (!inner) continue
          if (inner.type === SUBGRAPH_INPUT_NODE || inner.type === SUBGRAPH_OUTPUT_NODE) continue
          await ctx.execNode(inner, doc.edges, depth + 1)
        }
      }
      // 3) 出参回收：读 Exit 挂点的入边来源值，写回本节点对应 handle。
      //    兼容单输出（doc.out）与多输出（doc.outputs）两种历史结构。
      const outDefs = doc.outputs.length > 0 ? doc.outputs : doc.out ? [doc.out] : []
      outDefs.forEach((o, i) => {
        const feed = doc.edges.find((e) => e.target === o.refId)
        if (!feed) return
        const val = readOutput(feed.source, feed.sourceHandle)
        if (!val) return
        // 第 0 个输出沿用 OUT_HANDLE，其余用 out1/out2…，与节点定义的 handle 名对齐。
        storeOutput(node.id, i === 0 ? OUT_HANDLE : `out${i}`, val)
      })
      break
    }

    default:
      // 未知节点类型：当作空操作，保证前向兼容（新节点旧引擎也能跑完）。
      break
  }

  setNodeState(node.id, 'succeeded')
  set((s) => ({ nodeProgress: { ...s.nodeProgress, [node.id]: 1 } }))
  // 只有当自己仍是当前活跃节点时才清空，避免把后续节点的 activeNodeId 误抹掉。
  set({ activeNodeId: get().activeNodeId === node.id ? null : get().activeNodeId })
}
