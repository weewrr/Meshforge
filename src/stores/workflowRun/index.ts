/**
 * 工作流运行态 store 的装配点。
 *
 * 这里只做三件事：初始化运行态字段、把执行引擎（`engine`）挂上来、
 * 对外转出 `types` 与 `topoSort`（外部做静态分析时需要按拓扑序遍历）。
 * 执行逻辑按依赖方向拆在 engine.ts（装配）+ engine-context / executors /
 * runners / preflight（优化文档 7.3）。
 */

import { create } from 'zustand'
import { createEngine } from './engine'
import type { WorkflowRunState } from './types'

export * from './types'
export { topoSort } from './helpers'

export const useWorkflowRunStore = create<WorkflowRunState>((set, get) => ({
  // 以下字段都以「一次运行」为生命周期：run() 开头重置、结束时落定。
  runState: 'idle',
  nodeStates: {},
  nodeProgress: {},
  nodeIter: {},
  activeNodeId: null,
  pausedAt: null,
  currentJobId: null,
  currentWorkflowId: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,

  ...createEngine(set, get)
}))
