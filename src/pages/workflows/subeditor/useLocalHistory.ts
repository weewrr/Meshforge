/**
 * 子图编辑器的本地草稿撤销栈。
 *
 * 编辑器基于"本地副本 + 保存写回"，所以历史也维护在本地：结构变更、连线、
 * 拖动起点、增删挂点各入栈一步，Ctrl+Z / Ctrl+Shift+Z 在草稿内逐笔回退。
 * 从 EditorInner 抽出的纯逻辑 hook；返回的 setter 用于回放历史快照。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WFEdge, WFNode } from '../../../types'

/** 单步历史快照：nodes/edges 引用对（浅比较即可判断"同一状态"）。 */
interface Snap {
  nodes: WFNode[]
  edges: WFEdge[]
}

/** 历史栈深度上限：超过即丢最旧的一步，避免长会话内存无限增长。 */
const MAX_HISTORY = 80

export function useLocalHistory(
  initialNodes: WFNode[],
  initialEdges: WFEdge[]
) {
  const [nodes, setNodes] = useState<WFNode[]>(initialNodes)
  const [edges, setEdges] = useState<WFEdge[]>(initialEdges)
  const undoStack = useRef<Snap[]>([])
  const redoStack = useRef<Snap[]>([])
  const liveRef = useRef<Snap>({ nodes: [], edges: [] })
  const lastSnapRef = useRef<Snap | null>(null)
  /** [undo 深度, redo 深度]——入栈/出栈后刷新，用来驱动工具栏按钮的可用态。 */
  const [histSizes, setHistSizes] = useState<[number, number]>([0, 0])

  const bumpHist = useCallback((): void => {
    setHistSizes([undoStack.current.length, redoStack.current.length])
  }, [])

  /** 变更前快照；同一帧内重复调用（如删除同时触发 nodes/edges 两个 change）只记一次。 */
  const snapshot = useCallback(() => {
    const cur = liveRef.current
    const last = lastSnapRef.current
    if (last && last.nodes === cur.nodes && last.edges === cur.edges) return
    lastSnapRef.current = cur
    undoStack.current.push(cur)
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift()
    redoStack.current = []
    bumpHist()
  }, [bumpHist])

  const undoLocal = useCallback(() => {
    const snap = undoStack.current.pop()
    if (!snap) return
    redoStack.current.push(liveRef.current)
    lastSnapRef.current = null
    setNodes(snap.nodes)
    setEdges(snap.edges)
    bumpHist()
  }, [bumpHist])

  const redoLocal = useCallback(() => {
    const snap = redoStack.current.pop()
    if (!snap) return
    undoStack.current.push(liveRef.current)
    lastSnapRef.current = null
    setNodes(snap.nodes)
    setEdges(snap.edges)
    bumpHist()
  }, [bumpHist])

  /** 切换层级时调用：重置本地草稿与撤销栈（历史只对当前这一层有意义）。 */
  const reset = useCallback((ns: WFNode[], es: WFEdge[]): void => {
    setNodes(ns)
    setEdges(es)
    undoStack.current = []
    redoStack.current = []
    lastSnapRef.current = null
    setHistSizes([0, 0])
  }, [])

  // liveRef 始终指向"最近一次渲染的草稿"，snapshot() 才能拿到正确的变更前状态。
  useEffect(() => {
    liveRef.current = { nodes, edges }
  }, [nodes, edges])

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    histSizes,
    snapshot,
    undoLocal,
    redoLocal,
    reset,
    liveRef
  }
}
