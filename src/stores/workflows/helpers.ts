/**
 * 工作流 store 的通用小工具。
 *
 * 只有两件事：生成 ID / 时间戳这类纯函数，以及"函数实例同步"这一条业务规则。
 */

import { getSubgraphDoc, subgraphRefOf, type WFNode } from '../../types'

/** 生成节点 / 连线 / 工作流的唯一 ID。
 *  用 `crypto.randomUUID` 而非自增计数器：重载后的多个渲染上下文、以及从外部
 *  导入的工作流之间不会撞号，无需中心化的发号服务。 */
export function newId(): string {
  return crypto.randomUUID()
}

/** 统一的"最后修改时间"表示：ISO 8601 字符串，可直接落盘与展示。 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 把 source 节点的子图文档与函数名同步到共享同一 subgraphRef 的其它实例上，
 *  实现「一个函数被多处引用，改一处全局生效」。 */
export function syncFunctionInstances(nodes: WFNode[], sourceId: string): WFNode[] {
  const src = nodes.find((n) => n.id === sourceId)
  if (!src || src.type !== 'subgraphNode') return nodes
  const ref = subgraphRefOf(src)
  const doc = getSubgraphDoc({ data: { params: (src.data?.params ?? {}) as Record<string, unknown> } })
  if (!doc) return nodes
  const label = typeof src.data?.params?.subgraphLabel === 'string' ? String(src.data.params.subgraphLabel) : ''
  let changed = false
  const next = nodes.map((n) => {
    if (n.id === sourceId || n.type !== 'subgraphNode') return n
    if (subgraphRefOf(n) !== ref) return n
    changed = true
    // 深拷贝函数体：各实例的 subgraph 必须是彼此独立的对象，
    // 否则后续在编辑器里改一个实例会就地污染其余实例。
    const params: Record<string, unknown> = { ...n.data.params, subgraph: structuredClone(doc) }
    // 函数名与函数体同源：重命名一个实例即同步到全部实例。
    if (label) params.subgraphLabel = label
    return { ...n, data: { ...n.data, params } }
  })
  // 没有任何实例需要改动时返回原数组引用，让 zustand 的浅比较能跳过重渲染。
  return changed ? next : nodes
}
