// ─── 函数/子图折叠（Collapse to Function）图变换 ──────────────────────────────
// 纯函数：只依赖 types + canvasUtils，供 Canvas / store / 执行引擎复用，避免循环依赖。
import {
  IN_HANDLE,
  OUT_HANDLE,
  SUBGRAPH_INPUT_NODE,
  SUBGRAPH_OUTPUT_NODE,
  SUBGRAPH_REF_PARAM,
  getSubgraphDoc,
  isContainerType,
  isExecNode,
  nodeSpec,
  portColor,
  subgraphInHandle,
  subgraphOutHandle,
  subgraphPinLabel,
  subgraphRefOf,
  type PortType,
  type SubgraphDoc,
  type SubgraphInput,
  type SubgraphOutput,
  type WFEdge,
  type WFNode
} from '../../types'
import { getT } from '../../i18n'
import { boundingBox } from './canvasUtils'

export interface CollapseResult {
  /** 折叠后（含新函数节点）的全部节点。 */
  nodes: WFNode[]
  /** 折叠后（含进出接线）的全部连线。 */
  edges: WFEdge[]
  /** 折叠被拒绝或受限时给出的提示信息。 */
  warnings: string[]
}
export interface ExpandResult {
  /** 展开还原后的全部节点。 */
  nodes: WFNode[]
  /** 展开还原后的全部连线。 */
  edges: WFEdge[]
}

function eid(): string {
  return `e-${crypto.randomUUID()}`
}

/** 折叠的"禁止入选"类型：容器 / 注释 / 流程控制 / 容器与注释框内的子节点 / 函数挂点占位节点。 */
export function isFoldBlocked(node: WFNode): boolean {
  return (
    isContainerType(node.type) ||
    node.type === 'commentNode' ||
    isExecNode(node.type) ||
    // 容器 / 注释框内的节点用"相对父级"的坐标定位，折进函数后会算错位置，先排除
    !!node.parentId ||
    node.type === SUBGRAPH_INPUT_NODE ||
    node.type === SUBGRAPH_OUTPUT_NODE
  )
}

/** 折叠一组选中节点为单个 subgraphNode（单主输出）。 */
export function collapseToSubgraph(
  ids: string[],
  allNodes: WFNode[],
  allEdges: WFEdge[]
): CollapseResult {
  const warnings: string[] = []
  const idSet = new Set(ids)
  const sel = allNodes.filter((n) => idSet.has(n.id))
  const selIds = new Set(sel.map((n) => n.id))
  if (sel.length === 0) return { nodes: allNodes, edges: allEdges, warnings }

  const blocked = sel.some((n) => isFoldBlocked(n))
  if (blocked) {
    return {
      nodes: allNodes,
      edges: allEdges,
      warnings: [getT('workflows.toast.foldBlockedDetail')]
    }
  }

  const inBounds = allEdges.filter((e) => selIds.has(e.target) && !selIds.has(e.source))
  const outBounds = allEdges.filter((e) => selIds.has(e.source) && !selIds.has(e.target))
  const keptEdges = allEdges.filter((e) => !selIds.has(e.source) && !selIds.has(e.target))
  const internalEdges = allEdges.filter((e) => selIds.has(e.source) && selIds.has(e.target))

  // 输入挂点：为每条外部入边生成一个 subgraphInputNode，执行时把外部值写到这里。
  const inputs: SubgraphInput[] = []
  const refNodes: WFNode[] = []
  const refEdges: WFEdge[] = []
  inBounds.forEach((e, i) => {
    const refId = `subin-${crypto.randomUUID()}`
    const srcNode = allNodes.find((n) => n.id === e.source)
    const srcType: PortType = srcNode && srcNode.type ? nodeSpec(srcNode.type).output : 'any'
    const label = srcNode ? String(srcNode.data?.label ?? '') || subgraphPinLabel('in', i) : subgraphPinLabel('in', i)
    refNodes.push({
      id: refId,
      type: SUBGRAPH_INPUT_NODE,
      position: { x: 0, y: i * 40 },
      data: { label, color: portColor(srcType), params: { name: label, type: srcType } },
      initialWidth: 40,
      initialHeight: 28
    })
    inputs.push({
      refId,
      targetId: e.target,
      targetHandle: e.targetHandle ?? null,
      type: srcType,
      label,
      srcId: e.source,
      srcHandle: e.sourceHandle
    })
    refEdges.push({
      id: eid(),
      source: refId,
      sourceHandle: e.sourceHandle ?? OUT_HANDLE,
      target: e.target,
      targetHandle: e.targetHandle ?? null
    })
  })

  // 输出挂点（Exit 节点）：为每条外部出边生成一个 subgraphOutputNode，
  // 子图内部边以它为 target 输送输出；折叠节点按序渲染对应输出引脚。
  const outputs: SubgraphOutput[] = []
  outBounds.forEach((e, i) => {
    const refId = `subout-${crypto.randomUUID()}`
    const srcNode = allNodes.find((n) => n.id === e.source)
    const srcType: PortType = srcNode && srcNode.type ? nodeSpec(srcNode.type).output : 'any'
    const label = subgraphPinLabel('out', i)
    refNodes.push({
      id: refId,
      type: SUBGRAPH_OUTPUT_NODE,
      position: { x: 2000, y: i * 40 },
      data: { label, color: portColor(srcType), params: { name: label, type: srcType } },
      initialWidth: 60,
      initialHeight: 28
    })
    // 子图内部：真正产出的源节点 → Exit 节点。
    refEdges.push({
      id: eid(),
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: refId,
      targetHandle: IN_HANDLE
    })
    outputs.push({ refId, type: srcType, label, toId: e.target, toHandle: e.targetHandle ?? null, index: i })
  })

  const box = boundingBox(sel)
  const fnId = `function-${crypto.randomUUID()}`
  const doc: SubgraphDoc = {
    nodes: [...sel, ...refNodes],
    edges: [...internalEdges, ...refEdges],
    inputs,
    outputs,
    out: outputs[0] ?? null
  }
  const functionNode: WFNode = {
    id: fnId,
    type: 'subgraphNode',
    position: { x: box?.x ?? 0, y: box?.y ?? 0 },
    initialWidth: 200,
    initialHeight: 90,
    data: {
      label: 'Function',
      color: nodeSpec('subgraphNode').color,
      // subgraphRef 指向自身：折叠出来的新函数即主实例，后续可被其它实例共享。
      params: { subgraph: doc, subgraphLabel: 'Function', [SUBGRAPH_REF_PARAM]: fnId }
    }
  }

  const newNodes = [...allNodes.filter((n) => !selIds.has(n.id)), functionNode]
  const newEdges = [
    ...keptEdges,
    ...inBounds.map((e, i) => ({
      id: eid(),
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: fnId,
      targetHandle: subgraphInHandle(i)
    })),
    ...outputs.map((o) => ({
      id: eid(),
      source: fnId,
      sourceHandle: subgraphOutHandle(o.index),
      target: o.toId,
      targetHandle: o.toHandle
    }))
  ]
  return { nodes: newNodes, edges: newEdges, warnings }
}

// ─── 挂点规范化 ──────────────────────────────────────────────────────────────
// 子图编辑器里的挂点节点是可增删/改名的，保存时以挂点节点为唯一事实来源重建
// inputs / outputs 列表，保证折叠节点的引脚数量、名称、类型与子图内部一致。

/** 以现有输入挂点节点(subgraphInputNode)为基准重建 inputs。 */
export function normalizeSubgraphInputs(
  nodes: WFNode[],
  edges: WFEdge[],
  prev: SubgraphInput[]
): SubgraphInput[] {
  const pins = nodes.filter((n) => n.type === SUBGRAPH_INPUT_NODE)
  return pins.map((pin, i) => {
    const prior = prev.find((p) => p.refId === pin.id) ?? prev[i]
    const params = (pin.data?.params ?? {}) as Record<string, unknown>
    const feed = edges.find((e) => e.source === pin.id)
    const declared = params.type as PortType | undefined
    return {
      refId: pin.id,
      targetId: feed?.target ?? prior?.targetId ?? '',
      targetHandle: feed?.targetHandle ?? prior?.targetHandle ?? null,
      type: declared ?? prior?.type ?? 'any',
      label: String(params.name ?? pin.data?.label ?? subgraphPinLabel('in', i)),
      srcId: prior?.srcId ?? '',
      srcHandle: prior?.srcHandle ?? null
    }
  })
}

/** 以现有 Exit(subgraphOutputNode) 节点为基准重建 outputs。 */
export function normalizeSubgraphOutputs(
  nodes: WFNode[],
  edges: WFEdge[],
  prev: SubgraphOutput[]
): SubgraphOutput[] {
  const pins = nodes.filter((n) => n.type === SUBGRAPH_OUTPUT_NODE)
  return pins.map((pin, i) => {
    const prior = prev.find((p) => p.refId === pin.id) ?? prev[i]
    const params = (pin.data?.params ?? {}) as Record<string, unknown>
    const feed = edges.find((e) => e.target === pin.id)
    const src = feed ? nodes.find((n) => n.id === feed.source) : undefined
    const declared = params.type as PortType | undefined
    const type: PortType = declared ?? (src && src.type ? nodeSpec(src.type).output : 'any')
    return {
      refId: pin.id,
      type,
      label: String(params.name ?? pin.data?.label ?? subgraphPinLabel('out', i)),
      toId: prior?.toId ?? '',
      toHandle: prior?.toHandle ?? null,
      index: i
    }
  })
}

/** 把一个 subgraphNode 展开回多个节点（反转折叠）。 */
export function expandSubgraph(nodeId: string, allNodes: WFNode[], allEdges: WFEdge[]): ExpandResult {
  const fn = allNodes.find((n) => n.id === nodeId)
  if (!fn) return { nodes: allNodes, edges: allEdges }
  const doc = fn.data?.params?.subgraph as SubgraphDoc | undefined
  if (!doc) return { nodes: allNodes, edges: allEdges }

  // 其余节点 + 子图内节点（去掉输入/输出挂点占位）。
  const inner = doc.nodes.filter((n) => n.type !== SUBGRAPH_INPUT_NODE && n.type !== SUBGRAPH_OUTPUT_NODE)
  const rest = allNodes.filter((n) => n.id !== nodeId)
  // 去掉本节点相关的边（含我们创建的 in/out 接线），再按 doc 反向还原原始连接。
  const unrelated = allEdges.filter((e) => e.source !== nodeId && e.target !== nodeId)
  // 输出还原：Exit 节点在子图内的 feed 边（target=exit.refId）记录真正的源。
  const outputsToRestore: WFEdge[] = doc.outputs.flatMap((o) => {
    const feed = doc.edges.find((e) => e.target === o.refId)
    if (!feed) return []
    return [
      {
        id: eid(),
        source: feed.source,
        sourceHandle: feed.sourceHandle,
        target: o.toId,
        targetHandle: o.toHandle
      }
    ]
  })
  const restored: WFEdge[] = [
    ...doc.inputs.map((inp) => ({
      id: eid(),
      source: inp.srcId,
      sourceHandle: inp.srcHandle ?? OUT_HANDLE,
      target: inp.targetId,
      targetHandle: inp.targetHandle
    })),
    ...outputsToRestore
  ]
  // 实例共享同一函数体时，挂点记录的 srcId/toId 可能属于别处的实例上下文；
  // 展开时只还原两端都存在于当前图的连线，避免产生悬空边。
  const present = new Set([...rest, ...inner].map((n) => n.id))
  return {
    nodes: [...rest, ...inner],
    edges: [...unrelated, ...restored.filter((e) => present.has(e.source) && present.has(e.target))]
  }
}

// ─── 函数库（My Blueprint 风格）────────────────────────────────────────────────

export interface FunctionEntry {
  /** 共享引用键（主实例节点 id）。 */
  id: string
  /** 从根到该函数的路径（含自身 id），用于打开子图编辑器。 */
  path: string[]
  label: string
  inputs: number
  outputs: number
  /** 工作流中引用该函数的所有实例节点 id。 */
  instances: string[]
}

/** 递归遍历工作流（含子图内部），汇总全部函数定义与其实例。 */
export function collectFunctions(nodes: WFNode[]): FunctionEntry[] {
  const byRef = new Map<string, FunctionEntry>()
  const walk = (list: WFNode[], prefix: string[]): void => {
    for (const n of list) {
      if (n.type !== 'subgraphNode') continue
      const params = (n.data?.params ?? {}) as Record<string, unknown>
      const doc = getSubgraphDoc({ data: { params } })
      const path = [...prefix, n.id]
      const ref = subgraphRefOf(n)
      const label = String(params.subgraphLabel ?? n.data?.label ?? 'Function')
      const existing = byRef.get(ref)
      if (existing) {
        existing.instances.push(n.id)
      } else {
        byRef.set(ref, {
          id: ref,
          path,
          label,
          inputs: doc?.inputs.length ?? 0,
          outputs: doc?.outputs.length ?? 0,
          instances: [n.id]
        })
      }
      if (doc) walk(doc.nodes, path)
    }
  }
  walk(nodes, [])
  return [...byRef.values()]
}