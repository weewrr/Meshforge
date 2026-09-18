/**
 * 工作流编辑器的顶层 store。
 *
 * 用 zustand 把状态拆成两个 slice：`graph` 负责图结构与编辑，`library` 负责
 * 工作流列表 / 文件夹 / 书签。两个 slice 共享同一份「撤销栈 + 自动保存」能力
 * （即 `SliceDeps`），避免各持一套历史导致撤销语义错乱。
 * 对外的完整动作集合见 `WorkflowsState`。
 */

import { create } from 'zustand'
import { createAutosave } from './autosave'
import { createGraphSlice } from './graph'
import { createHistory } from './history'
import { createLibrarySlice } from './library'
import type { WorkflowsState } from './types'

export type { WorkflowsState } from './types'

export const useWorkflowsStore = create<WorkflowsState>((set, get) => {
  // 共享内部能力：撤销栈 + 自动保存（graph / library 两个 slice 都要用）。
  const autosave = createAutosave(set, get)
  const history = createHistory(set, get, autosave)
  const deps = { history, autosave }

  return {
    workflows: [],
    current: null,
    loaded: false,
    dirty: false,
    canUndo: false,
    canRedo: false,

    // 两个 slice 各自贡献自己那部分动作，展开后合并为一个 store。
    ...createGraphSlice(set, get, deps),
    ...createLibrarySlice(set, get, deps),

    // 撤销/重做必须走共享 history，因此不放进 graph slice。
    undo: history.undo,
    redo: history.redo
  }
})
