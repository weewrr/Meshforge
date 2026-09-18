/**
 * 蓝图注释节点的几何与吸附工具。
 *
 * 注释块与普通节点共用一套节点存储，但有自己的位置 reconcile 规则：
 * 这里集中处理"注释是否可并入 / 覆盖到哪些节点 / 绝对坐标如何反推"。
 */

import { createContext } from 'react'
import { isContainerType, type WFNode } from '../../types'
import { nodeSize, orderParentsFirst } from './canvasUtils'

/**
 * 注释框（Unreal Blueprint Comment Box）语义工具。
 *
 * UE 的注释框不是"画在节点下面的一个框"，而是一个**容器**：框内的节点属于它，
 * 拖动 / 删除 / 折叠时作为一个整体处理。这里用 React Flow 原生的 parentId 关系
 * 表达归属（子节点存"相对坐标"），这样：
 *  - 拖注释框时框内节点由 React Flow 自动跟随（不需要手工平移）
 *  - 折叠时把成员 `hidden` 掉，连边一并消失
 *  - 删除注释框时成员被"释放"为顶层节点，而不是被一起删掉
 *
 * 刻意**不加 `extent: 'parent'`**：UE 里可以把节点从注释框里拖出去，加了 extent
 * 就拖不动了。归属完全由几何位置在拖拽结束时重算（`reconcileComments`）。
 */

export const COMMENT_TYPE = 'commentNode'

/** 折叠态注释框的高度（流程坐标）：只够放一条标题栏。 */
export const COMMENT_COLLAPSED_H = 34

/** 能落进注释框的节点：注释框自己不嵌套，While 容器保持独立归属。 */
export function canJoinComment(n: WFNode): boolean {
  return n.type !== COMMENT_TYPE && !isContainerType(n.type)
}

/** 节点在流程坐标下的绝对位置（父节点为注释框时把相对坐标还原为绝对坐标）。 */
export function absPos(n: WFNode, byId: Map<string, WFNode>, depth = 0): { x: number; y: number } {
  if (!n.parentId || depth > 8) return { x: n.position.x, y: n.position.y }
  const p = byId.get(n.parentId)
  if (!p) return { x: n.position.x, y: n.position.y }
  const base = absPos(p, byId, depth + 1)
  return { x: base.x + n.position.x, y: base.y + n.position.y }
}

/** 注释框在流程坐标下的矩形（用绝对位置，兼容注释框被放进 While 容器的情况）。 */
export function commentRect(c: WFNode, byId: Map<string, WFNode>): { x: number; y: number; w: number; h: number } {
  const s = nodeSize(c)
  const p = absPos(c, byId)
  return { x: p.x, y: p.y, w: s.w, h: s.h }
}

function inside(r: { x: number; y: number; w: number; h: number }, cx: number, cy: number): boolean {
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
}

/**
 * 依据几何位置重算注释框归属（在拖拽 / 缩放结束时调用）：
 *  - 中心点落在某注释框内 → 收编为成员（parentId + 相对坐标）
 *  - 原本是成员、现在中心点已在框外 → 释放回顶层（绝对坐标）
 *  - 折叠态注释框不参与判定：成员处于隐藏态，保持原归属不动
 *  - While 容器的子节点不参与收编（否则会把容器成员"抢"走，破坏循环体归属）
 *
 * 无变化时原样返回入参（引用相等），调用方据此跳过无谓的 store 写入与入栈。
 */
export function reconcileComments(nodes: WFNode[]): WFNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hosts = nodes.filter((n) => n.type === COMMENT_TYPE && !n.data?.params?.collapsed)
  let changed = false

  const next = nodes.map((n) => {
    if (!canJoinComment(n)) return n
    // 属于 While 容器等其他父级的节点不参与注释框归属
    if (n.parentId && byId.get(n.parentId)?.type !== COMMENT_TYPE) return n

    const s = nodeSize(n)
    const abs = absPos(n, byId)
    const cx = abs.x + s.w / 2
    const cy = abs.y + s.h / 2

    // 取数组里最靠后的容纳者，与画布层级（后写的在上）一致
    let host: WFNode | undefined
    for (const c of hosts) {
      if (c.id === n.id) continue
      if (inside(commentRect(c, byId), cx, cy)) host = c
    }

    if (host?.id === n.parentId) return n

    changed = true
    if (!host) {
      const { parentId: _p, extent: _e, ...rest } = n
      return { ...rest, position: { x: abs.x, y: abs.y } }
    }
    const hostAbs = absPos(host, byId)
    return {
      ...n,
      parentId: host.id,
      position: { x: abs.x - hostAbs.x, y: abs.y - hostAbs.y }
    }
  })

  return changed ? orderParentsFirst(next) : nodes
}

/**
 * 折叠 / 展开注释框：折叠后成员隐藏（相连的边由 React Flow 一并隐藏），
 * 注释框自身收缩成一条标题栏；展开时还原尺寸与可见性。
 * 折叠前的高度记在 `params._h` 里，展开时原样恢复（宽度不变，故只需记高度）。
 */
export function setCommentCollapsed(nodes: WFNode[], commentId: string, collapsed: boolean): WFNode[] {
  const c = nodes.find((n) => n.id === commentId)
  if (!c) return nodes
  const cur = nodeSize(c)
  const restoreH = Number(c.data?.params?._h ?? 0) || cur.h

  return nodes.map((n) => {
    if (n.id === commentId) {
      const params: Record<string, unknown> = { ...n.data?.params, collapsed }
      if (collapsed) params._h = cur.h
      else delete params._h
      return {
        ...n,
        style: { ...n.style, width: cur.w, height: collapsed ? COMMENT_COLLAPSED_H : restoreH },
        data: { ...n.data, params }
      }
    }
    if (n.parentId === commentId) {
      return collapsed ? { ...n, hidden: true, selected: false } : { ...n, hidden: false }
    }
    return n
  })
}

/** 注释框操作，由画布注入（主画布写 store，子图编辑器写本地草稿）。 */
export type CommentOps = {
  /** 折叠 / 展开指定注释框（同时切换其成员的可见性）。 */
  toggleCollapse: (id: string, collapsed: boolean) => void
}

/** 把注释框操作（折叠 / 展开）从画布注入到子组件，避免层层透传 props。 */
export const CommentOpsContext = createContext<CommentOps | null>(null)
