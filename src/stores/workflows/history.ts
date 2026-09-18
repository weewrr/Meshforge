/**
 * 撤销 / 重做栈（按当前工作流、有容量上限）。
 *
 * 历史只属于"当前打开的工作流"——切换工作流时由调用方 `clear()`，
 * 因此无需把快照按工作流 id 分开存放。
 *
 * `past` / `future` 用闭包变量而非 store 字段：它们本身不参与渲染，
 * 真正需要驱动 UI 的只有派生出来的 `canUndo` / `canRedo` 两个布尔值。
 */

// ─── 撤销 / 重做历史（按当前工作流，有上限） ──────────────────────────────────

import type { Autosave } from './autosave'
import type { Get, Set, Snapshot } from './types'

/** 撤销栈容量上限；超出后从最旧的一端丢弃，避免长时间编辑把内存吃满。 */
const HISTORY_MAX = 50

/** 创建撤销栈实例。闭包内持有 past/future，返回操作它的四个方法。 */
export function createHistory(set: Set, get: Get, autosave: Autosave) {
  const past: Snapshot[] = []
  const future: Snapshot[] = []

  /** 清空历史（切换 / 新建工作流时调用）。 */
  function clear(): void {
    past.length = 0
    future.length = 0
    set({ canUndo: false, canRedo: false })
  }

  /** 记录改动前的图快照。
   *  结构性编辑之前调用；节点拖拽只在"开始时"记一次——拖动过程会持续产生
   *  位置变更，逐帧快照会把历史撑爆。 */
  function push(): void {
    const cur = get().current
    if (!cur) return
    past.push({ nodes: cur.nodes, edges: cur.edges })
    // 超限时丢最旧的一条。
    if (past.length > HISTORY_MAX) past.shift()
    // 出现新改动，原有的"未来"分支作废。
    future.length = 0
    set({ canUndo: true, canRedo: false })
  }

  /** 撤销：当前图压入 future，再恢复 past 的栈顶。 */
  function undo(): void {
    const cur = get().current
    const snap = past.pop()
    if (!cur || !snap) return
    future.push({ nodes: cur.nodes, edges: cur.edges })
    set({
      current: { ...cur, nodes: snap.nodes, edges: snap.edges },
      canUndo: past.length > 0,
      canRedo: true,
      dirty: true
    })
    // 撤销后内存里的图与后端已不一致，标脏并安排一次保存。
    autosave.schedule()
  }

  /** 重做：与 `undo` 对称，只是两个栈的角色互换。 */
  function redo(): void {
    const cur = get().current
    const snap = future.pop()
    if (!cur || !snap) return
    past.push({ nodes: cur.nodes, edges: cur.edges })
    set({
      current: { ...cur, nodes: snap.nodes, edges: snap.edges },
      canUndo: true,
      canRedo: future.length > 0,
      dirty: true
    })
    autosave.schedule()
  }

  return { clear, push, undo, redo }
}

/** 撤销能力的类型，供其它 slice 声明依赖。 */
export type History = ReturnType<typeof createHistory>
