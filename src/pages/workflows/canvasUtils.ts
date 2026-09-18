/**
 * 画布几何与拓扑工具。
 *
 * 可达性检测（防环）、容器节点的命中与吸附、节点尺寸与包围盒计算、
 * "父容器优先"的拓扑排序等。全部为纯函数，方便单测与在拖拽热路径里复用。
 */

import { extensionColor, getExtensionById, isContainerType, nodeSpec, portColor, SUBGRAPH_INPUT_NODE, SUBGRAPH_OUTPUT_NODE, type PortType, type WFEdge, type WFNode } from '../../types'
import { useWorkflowsStore } from '../../stores/workflows'

/** 沿给定连线从 `from` 能否到达 `to`（环检测）？ */
export function reaches(
  from: string,
  to: string,
  edges: WFEdge[]
): boolean {
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    for (const e of edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target)
        stack.push(e.target)
      }
    }
  }
  return false
}

/** 最上层「分组节点」（While 容器 / 注释框）中，屏幕矩形包含给定 client 点的那个。
 *  用 DOM 元素做命中测试，因此在任何缩放 / 平移状态下都准确。 */
export function containerAtScreen(clientX: number, clientY: number): WFNode | undefined {
  const nds = useWorkflowsStore.getState().current?.nodes ?? []
  for (let i = nds.length - 1; i >= 0; i--) {
    const n = nds[i]
    if (!isContainerType(n.type) && n.type !== 'commentNode') continue
    const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${n.id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return n
  }
  return undefined
}

export function nodeSize(n: WFNode): { w: number; h: number } {
  return {
    w: n.measured?.width ?? n.width ?? (typeof n.style?.width === 'number' ? n.style.width : 200),
    h: n.measured?.height ?? n.height ?? (typeof n.style?.height === 'number' ? n.style.height : 80)
  }
}

/** 一组节点的并集包围盒（流程坐标，用于把选中节点"框进"一个 Comment 注释框）。 */
export function boundingBox(nodes: WFNode[]): { x: number; y: number; w: number; h: number } | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const s = nodeSize(n)
    const w = Math.max(s.w, 60)
    const h = Math.max(s.h, 40)
    minX = Math.min(minX, n.position.x)
    minY = Math.min(minY, n.position.y)
    maxX = Math.max(maxX, n.position.x + w)
    maxY = Math.max(maxY, n.position.y + h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * React Flow 要求父节点在数组里位于其子节点之前，否则子节点会错一帧定位。
 * 这里做一次稳定的"父先于子"拓扑排序（其余相对顺序保持不变）。
 */
export function orderParentsFirst(nodes: WFNode[]): WFNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: WFNode[] = []
  const seen = new Set<string>()
  const push = (n: WFNode): void => {
    if (seen.has(n.id)) return
    if (n.parentId) {
      const p = byId.get(n.parentId)
      if (p) push(p)
    }
    seen.add(n.id)
    out.push(n)
  }
  for (const n of nodes) push(n)
  return out
}

/**
 * 依据拖拽落点把节点挂到 / 摘下 While 容器（Modly 容器语义）：中心点落在容器矩形内
 * 即成为其子节点。子节点保留 parentId + 相对坐标，但**不加 `extent`**，所以还能拖出去。
 * 返回新数组；无变化时引用相等，调用方据此跳过写入。
 */
export function attachToContainer(nodes: WFNode[], dragged: WFNode): WFNode[] {
  if (isContainerType(dragged.type)) return nodes
  // 注释框的成员交给 reconcileComments 处理（它懂注释框那条相对坐标链）；
  // 否则在没有 While 容器的图里，这里会把注释框成员误判成"拖出容器"而提前释放。
  const currentParent = dragged.parentId ? nodes.find((n) => n.id === dragged.parentId) : undefined
  if (currentParent && !isContainerType(currentParent.type)) return nodes
  const containers = nodes.filter((n) => isContainerType(n.type))
  if (containers.length === 0 && !dragged.parentId) return nodes

  const absX = (currentParent?.position.x ?? 0) + dragged.position.x
  const absY = (currentParent?.position.y ?? 0) + dragged.position.y
  const { w, h } = nodeSize(dragged)
  const cx = absX + w / 2
  const cy = absY + h / 2

  // 取数组里最靠后的容纳者，与 reconcileComments（注释框归属）以及画布层级
  // （"后写的在上层"）保持一致；容器重叠时不会出现两套判定各选一个的局面。
  let container: WFNode | undefined
  for (const g of containers) {
    const gw = g.measured?.width ?? g.width ?? (typeof g.style?.width === 'number' ? g.style.width : 0)
    const gh = g.measured?.height ?? g.height ?? (typeof g.style?.height === 'number' ? g.style.height : 0)
    if (cx >= g.position.x && cx <= g.position.x + gw && cy >= g.position.y && cy <= g.position.y + gh) {
      container = g
    }
  }

  if ((container?.id ?? undefined) === dragged.parentId) return nodes

  const next = nodes.map((n) => {
    if (n.id !== dragged.id) return n
    if (container) {
      return {
        ...n,
        parentId: container.id,
        position: { x: absX - container.position.x, y: absY - container.position.y }
      }
    }
    const { parentId: _p, extent: _ext, ...rest } = n
    return { ...rest, position: { x: absX, y: absY } }
  })
  return orderParentsFirst(next)
}

export const PALETTE_NODES: { payload: string; labelKey: string; hintKey: string }[] = [
  { payload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', hintKey: 'workflows.palette.imageHint' },
  { payload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', hintKey: 'workflows.palette.textHint' },
  { payload: 'builtin:arrayNode', labelKey: 'workflows.palette.arrayLabel', hintKey: 'workflows.palette.arrayHint' },
  { payload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', hintKey: 'workflows.palette.meshHint' },
  { payload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', hintKey: 'workflows.palette.generateHint' },
  { payload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', hintKey: 'workflows.palette.previewHint' },
  { payload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', hintKey: 'workflows.palette.outputHint' },
  { payload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', hintKey: 'workflows.palette.waitHint' },
  { payload: 'builtin:branchNode', labelKey: 'workflows.palette.branchLabel', hintKey: 'workflows.palette.branchHint' },
  { payload: 'builtin:sequenceNode', labelKey: 'workflows.palette.sequenceLabel', hintKey: 'workflows.palette.sequenceHint' },
  { payload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', hintKey: 'workflows.palette.whileHint' },
  { payload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', hintKey: 'workflows.palette.forEachHint' },
  { payload: 'builtin:commentNode', labelKey: 'workflows.palette.commentLabel', hintKey: 'workflows.palette.commentHint' },
  { payload: 'builtin:rerouteNode', labelKey: 'workflows.palette.rerouteLabel', hintKey: 'workflows.palette.rerouteHint' },
  { payload: 'builtin:selectNode', labelKey: 'workflows.palette.selectLabel', hintKey: 'workflows.palette.selectHint' },
  { payload: 'builtin:variableNode', labelKey: 'workflows.palette.variableLabel', hintKey: 'workflows.palette.variableHint' },
  { payload: 'builtin:isValidNode', labelKey: 'workflows.palette.isValidLabel', hintKey: 'workflows.palette.isValidHint' },
  { payload: 'builtin:isEmptyNode', labelKey: 'workflows.palette.isEmptyLabel', hintKey: 'workflows.palette.isEmptyHint' },
  { payload: 'builtin:boolNode', labelKey: 'workflows.palette.boolLabel', hintKey: 'workflows.palette.boolHint' },
  { payload: 'builtin:mathNode', labelKey: 'workflows.palette.mathLabel', hintKey: 'workflows.palette.mathHint' },
  { payload: 'builtin:compareNode', labelKey: 'workflows.palette.compareLabel', hintKey: 'workflows.palette.compareHint' },
  { payload: 'builtin:concatNode', labelKey: 'workflows.palette.concatLabel', hintKey: 'workflows.palette.concatHint' },
  { payload: 'builtin:castNode', labelKey: 'workflows.palette.castLabel', hintKey: 'workflows.palette.castHint' },
  { payload: 'builtin:clampNode', labelKey: 'workflows.palette.clampLabel', hintKey: 'workflows.palette.clampHint' },
  { payload: 'builtin:lerpNode', labelKey: 'workflows.palette.lerpLabel', hintKey: 'workflows.palette.lerpHint' },
  { payload: 'builtin:randomNode', labelKey: 'workflows.palette.randomLabel', hintKey: 'workflows.palette.randomHint' },
  { payload: 'builtin:gateNode', labelKey: 'workflows.palette.gateLabel', hintKey: 'workflows.palette.gateHint' },
  { payload: 'builtin:variableGetNode', labelKey: 'workflows.palette.varGetLabel', hintKey: 'workflows.palette.varGetHint' },
  { payload: 'builtin:variableSetNode', labelKey: 'workflows.palette.varSetLabel', hintKey: 'workflows.palette.varSetHint' },
  { payload: 'builtin:eventBindNode', labelKey: 'workflows.palette.eventBindLabel', hintKey: 'workflows.palette.eventBindHint' },
  { payload: 'builtin:eventCallNode', labelKey: 'workflows.palette.eventCallLabel', hintKey: 'workflows.palette.eventCallHint' },
  { payload: 'builtin:makeStructNode', labelKey: 'workflows.palette.makeStructLabel', hintKey: 'workflows.palette.makeStructHint' },
  { payload: 'builtin:breakStructNode', labelKey: 'workflows.palette.breakStructLabel', hintKey: 'workflows.palette.breakStructHint' }
]

/** 在子图编辑器里创建一个输入/输出挂点节点（可增删、改名、改端口类型）。 */
export function createSubgraphPin(
  kind: 'in' | 'out',
  index: number,
  position: { x: number; y: number },
  label?: string,
  type: PortType = 'any'
): WFNode {
  const suffix = kind === 'in' ? 'subin-' : 'subout-'
  const name = label ?? `${kind}${index}`
  return {
    id: `${suffix}${crypto.randomUUID()}`,
    type: kind === 'in' ? SUBGRAPH_INPUT_NODE : SUBGRAPH_OUTPUT_NODE,
    position,
    data: {
      label: name,
      color: portColor(type),
      params: { name, type, index }
    },
    initialWidth: kind === 'in' ? 60 : 70,
    initialHeight: 28
  }
}

/** 从调色板载荷字符串实例化 WFNode（builtin:* / generator:* / extension:*）。 */
export function createNodeFromPayload(payload: string, position: { x: number; y: number }): WFNode | null {
  const id = crypto.randomUUID()
  if (payload.startsWith('builtin:')) {
    const type = payload.slice('builtin:'.length)
    const spec = nodeSpec(type)
    if (!spec) return null
    const defaults: Record<string, Record<string, unknown>> = {
      imageNode: { url: '', fileName: '' },
      textNode: { text: 'A 3D model' },
      meshNode: { url: '', fileName: '' },
      arrayNode: { items: [] },
      generatorNode: { generatorId: 'hunyuan3d-2-mini' },
      outputNode: {},
      previewNode: {},
      waitNode: {},
      whileNode: { iterations: 2 },
      forEachNode: { items: 'view 1, view 2' },
      branchNode: { condition: true },
      sequenceNode: { outputs: 2 },
      commentNode: { text: '', color: '#38bdf8' },
      rerouteNode: {},
      selectNode: { mode: 'auto' },
      variableNode: { value: '', dtype: 'text' },
      isValidNode: {},
      isEmptyNode: {},
      boolNode: { operator: 'and' },
      mathNode: { operator: '+' },
      compareNode: { operator: '==' },
      concatNode: { separator: '' },
      castNode: { to: 'float' },
      clampNode: {},
      lerpNode: {},
      randomNode: {},
      gateNode: { open: true },
      variableGetNode: { varName: '', fallback: '' },
      variableSetNode: { varName: '', default: '' },
      eventCallNode: { dispatcher: '' },
      eventBindNode: { dispatcher: '' },
      makeStructNode: { fields: 'a, b, c, d' },
      breakStructNode: { fields: 'a, b, c, d' }
    }
    // 蓝图层级/规格：注释框铺底大框、Reroute 为小圆点、Select 标准框。
    const sizes: Record<string, { s?: { w: number; h: number }; z?: number }> = {
      whileNode: { s: { w: 340, h: 220 } },
      commentNode: { s: { w: 300, h: 160 }, z: -1 },
      rerouteNode: { s: { w: 30, h: 30 } }
    }
    const sz = sizes[type]
    return {
      id,
      type,
      position,
      zIndex: sz?.z,
      // React Flow 仅在知道尺寸后才渲染节点外壳（及其 handle），故用 initialWidth/Height
      // 撑住首帧，等 ResizeObserver 测量完成再覆盖（initial* 之后会被改写）。
      ...(sz?.s
        ? { style: { width: sz.s.w, height: sz.s.h }, initialWidth: sz.s.w, initialHeight: sz.s.h }
        : { initialWidth: 200, initialHeight: 80 }),
      data: { label: spec.label, color: spec.color, params: { ...defaults[type] } }
    }
  }
  if (payload.startsWith('generator:')) {
    const generatorId = payload.slice('generator:'.length)
    const spec = nodeSpec('generatorNode')
    return {
      id,
      type: 'generatorNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: `Generate (${generatorId})`,
        color: spec.color,
        params: { generatorId }
      }
    }
  }
  if (payload.startsWith('extension:')) {
    const extensionId = payload.slice('extension:'.length)
    const ext = getExtensionById(extensionId)
    return {
      id,
      type: 'extensionNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: ext?.display_name ?? 'Extension',
        color: extensionColor(ext),
        extensionId,
        params: {
          extensionId,
          ...Object.fromEntries((ext?.params ?? []).map((p) => [p.id, p.default]))
        }
      }
    }
  }
  return null
}
