/**
 * 子图编辑器的路径导航辅助。
 *
 * 子图编辑器按 `path`（从根 subgraphNode 到当前层的 id 序列）定位要展示哪一层子图，
 * 这里的两个纯函数负责"沿 path 取当前层文档"与"生成面包屑名称"。
 */

import { getSubgraphDoc, type SubgraphDoc, type WFNode } from '../../../types'

/** 沿 path（含根 subgraphNode id）下钻，取当前层子图文档。当前层=path 末元素对应的 doc。 */
export function docAtPath(nodes: WFNode[], path: string[]): SubgraphDoc | null {
  const root = nodes.find((n) => n.id === path[0])
  if (!root) return null
  let doc = getSubgraphDoc({ data: { params: (root.data?.params ?? {}) as Record<string, unknown> } })
  if (!doc) return null
  for (let i = 1; i < path.length; i++) {
    const inner = doc.nodes.find((n) => n.id === path[i])
    if (!inner) return null
    doc = getSubgraphDoc({ data: { params: (inner.data?.params ?? {}) as Record<string, unknown> } })
    if (!doc) return null
  }
  return doc
}

/** 面包屑名字：path 每层的 subgraphNode 显示名。 */
export function labelsAtPath(nodes: WFNode[], path: string[]): string[] {
  const out: string[] = []
  let list = nodes
  for (const id of path) {
    const n = list.find((x) => x.id === id)
    if (!n) break
    out.push(String(n.data?.params?.subgraphLabel ?? n.data?.label ?? 'Function'))
    const doc = getSubgraphDoc({ data: { params: (n.data?.params ?? {}) as Record<string, unknown> } })
    if (!doc) break
    list = doc.nodes
  }
  return out
}
