/**
 * 子图画布的图操作：复制 / 删除（含注释框内成员释放）/ 注释框编组 / 折叠为子函数。
 *
 * 从 EditorInner 抽出的纯逻辑 hook；所有操作都先 snapshot 入撤销栈再改草稿。
 */

import { useCallback } from 'react'
import { useLogsStore } from '../../../stores/logs'
import { boundingBox } from '../canvasUtils'
import { reconcileComments } from '../commentUtils'
import { collapseToSubgraph, isFoldBlocked } from '../subgraphUtils'
import type { WFEdge, WFNode } from '../../../types'

interface GraphOpsDeps {
  nodes: WFNode[]
  edges: WFEdge[]
  setNodes: (updater: (ns: WFNode[]) => WFNode[]) => void
  setEdges: (updater: (es: WFEdge[]) => WFEdge[]) => void
  snapshot: () => void
  clearSelection: () => void
  /** 折叠操作前的状态快照（与 snapshot 相同语义）。 */
  onWarn: (msg: string) => void
}

export function useGraphOps(deps: GraphOpsDeps) {
  const { nodes, edges, setNodes, setEdges, snapshot, clearSelection, onWarn } = deps

  const duplicateNodes = useCallback(
    (ids: string[]): void => {
      const idSet = new Set(ids)
      const picked = nodes.filter((n) => idSet.has(n.id))
      if (picked.length === 0) return
      snapshot()
      const rename = new Map<string, string>()
      const cloneOf = (id: string): string => {
        let next = rename.get(id)
        if (!next) {
          next = crypto.randomUUID()
          rename.set(id, next)
        }
        return next
      }
      const clones = picked.map((n) => ({
        ...structuredClone(n),
        id: cloneOf(n.id),
        position: { x: n.position.x + 30, y: n.position.y + 30 },
        ...(n.parentId && idSet.has(n.parentId) ? { parentId: cloneOf(n.parentId) } : {})
      }))
      const clonedEdges = edges
        .filter((e) => idSet.has(e.source) && idSet.has(e.target))
        .map((e) => ({
          ...structuredClone(e),
          id: `e-${crypto.randomUUID()}`,
          source: cloneOf(e.source),
          target: cloneOf(e.target)
        }))
      setNodes((ns) => [...ns, ...clones])
      setEdges((es) => [...es, ...clonedEdges])
    },
    [nodes, edges, snapshot, setNodes, setEdges]
  )

  const removeNodes = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return
      snapshot()
      const idSet = new Set(ids)
      // 删除注释框 / While 容器时，框内节点"释放"为顶层节点（保留），但被显式选中的照删。
      const doomedComments = nodes.filter((n) => idSet.has(n.id) && (n.type === 'commentNode' || n.type === 'whileNode'))
      const rescuedIds = new Set(
        doomedComments.length === 0
          ? []
          : nodes.filter((n) => n.parentId && idSet.has(n.parentId) && !idSet.has(n.id)).map((n) => n.id)
      )
      const groupById = new Map(nodes.map((n) => [n.id, n]))
      setNodes((ns) =>
        ns
          .filter((n) => !idSet.has(n.id))
          .map((n) => {
            if (!rescuedIds.has(n.id)) return n
            const g = groupById.get(n.parentId!)
            const { parentId: _p, extent: _e, ...rest } = n
            return {
              ...rest,
              hidden: false,
              position: { x: (g?.position.x ?? 0) + n.position.x, y: (g?.position.y ?? 0) + n.position.y }
            }
          })
      )
      // 被保留的成员节点连线不动，只断开真正被删除的节点。
      setEdges((es) => es.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)))
      clearSelection()
    },
    [nodes, snapshot, setNodes, setEdges, clearSelection]
  )

  /** 把选中的节点框进一个注释框（与主画布一致），并把框内节点收编为其成员。 */
  const groupAsComment = useCallback(
    (ids: string[], commentLabel: string): void => {
      const groupable = nodes.filter((n) => ids.includes(n.id) && !isFoldBlocked(n))
      const box = boundingBox(groupable)
      if (!box) return
      snapshot()
      const color = '#38bdf8'
      setNodes((ns) =>
        reconcileComments([
          {
            id: crypto.randomUUID(),
            type: 'commentNode',
            position: { x: box.x, y: box.y },
            zIndex: -1,
            style: { width: box.w, height: box.h },
            initialWidth: box.w,
            initialHeight: box.h,
            data: { label: commentLabel, color, params: { text: '', color } }
          },
          ...ns
        ])
      )
    },
    [nodes, snapshot, setNodes]
  )

  /** 子图内部再折叠为子函数（嵌套函数）。 */
  const foldSelection = useCallback(
    (ids: string[]): void => {
      const { nodes: nNode, edges: nEdge, warnings } = collapseToSubgraph(ids, nodes, edges)
      for (const w of warnings) onWarn(`[fold] ${w}`)
      if (nNode === nodes && nEdge === edges) return
      snapshot()
      setNodes(() => nNode)
      setEdges(() => nEdge)
      clearSelection()
    },
    [nodes, edges, snapshot, setNodes, setEdges, clearSelection, onWarn]
  )

  return { duplicateNodes, removeNodes, groupAsComment, foldSelection }
}

// 默认 warn 通道：折叠警告统一进全局日志 store（与原实现一致）。
export const warnViaLogs = (msg: string): void => {
  useLogsStore.getState().warn(msg)
}
