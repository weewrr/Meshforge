/**
 * 工作流 store 的公开契约。
 *
 * 这里集中三样东西：对外的动作全集 `WorkflowsState`、各 slice 之间共享的
 * 内部能力 `SliceDeps`（撤销栈 + 自动保存），以及撤销栈的元素类型 `Snapshot`。
 * 各 slice 实现只依赖本文件，彼此不直接引用，从而避免循环依赖。
 */

import type { StoreApi } from 'zustand'
import type { EdgeChange, NodeChange, Connection } from '@xyflow/react'
import type {
  SubgraphInput,
  SubgraphOutput,
  WFEdge,
  WFNode,
  Workflow,
  WorkflowMeta
} from '../../types'

/** 撤销栈里的一个快照。只存图结构——工作流名、更新时间等不属于"图编辑"。 */
export interface Snapshot {
  nodes: WFNode[]
  edges: WFEdge[]
}

/** 工作流 store 的形状：数据字段 + 动作。 */
export interface WorkflowsState {
  /** 工作流列表，由后端按最近修改排序。 */
  workflows: WorkflowMeta[]
  /** 当前打开的工作流；`null` 表示尚未选中。 */
  current: Workflow | null
  /** 列表是否已完成首次加载（用于区分"加载中"与"确实为空"）。 */
  loaded: boolean
  /** 是否有未保存的改动，驱动自动保存与关闭前提示。 */
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  loadList: () => Promise<void>
  select: (id: string) => Promise<void>
  create: () => Promise<void>
  rename: (name: string) => void
  applyNodeChanges: (changes: NodeChange<WFNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<WFEdge>[]) => void
  connect: (connection: Connection) => void
  addNode: (node: WFNode) => void
  updateNodeData: (nodeId: string, params: Record<string, unknown>) => void
  /** 更新 nodes[].data 顶层字段（用于改写 subgraphNode.data.params.subgraph 整体）。 */
  updateNodeDataAt: (nodeId: string, patch: Record<string, unknown>) => void
  /** 就地更新 subgraphNode 子图文档内某个内部节点（递归嵌套）。 */
  updateSubgraphNodeData: (functionId: string, innerId: string, patch: Record<string, unknown>) => void
  /** 用新的 nodes/edges 替换路径 path（含根 subgraphNode id）末端层子图的结构。
   *  outputs / inputs 由子图编辑器按挂点节点规范化后传入；省略时保留原值。 */
  replaceSubgraphGraph: (
    path: string[],
    nodes: WFNode[],
    edges: WFEdge[],
    outputs?: SubgraphOutput[],
    inputs?: SubgraphInput[]
  ) => void
  /** 重命名函数（subgraphLabel），并同步到共享同一函数体的全部实例。 */
  renameSubgraph: (nodeId: string, label: string) => void
  /** 按路径重命名函数（path = 从根到当前层的 subgraphNode id 序列）。 */
  renameSubgraphAt: (path: string[], label: string) => void
  /** 以某个已有函数为主本，新建一个共享同一函数体的实例（多实例复用）。 */
  instantiateFunction: (masterId: string, position?: { x: number; y: number }) => void
  /** 整体替换节点列表；`history:false` 表示静默替换（删除流程内部使用，不额外记一步撤销）。 */
  replaceNodes: (nodes: WFNode[], opts?: { history?: boolean }) => void
  /** 在同一步撤销里原子地替换节点与连线（用于子图的折叠/展开）。 */
  replaceGraph: (nodes: WFNode[], edges: WFEdge[], opts?: { history?: boolean }) => void
  /** 在改动开始前给当前图拍快照（例如节点拖拽开始时）。 */
  pushHistory: () => void
  /** 标记图为"有改动"并安排一次自动保存（拖拽/方向键微调结束时调用）。 */
  markDirty: () => void
  /** 复制一组节点，以及它们之间的连线，全部换新 id。 */
  duplicateNodes: (ids: string[]) => void
  undo: () => void
  redo: () => void
  duplicate: (id: string) => Promise<void>
  moveToFolder: (id: string, folder?: string) => Promise<void>
  toggleBookmark: (id: string) => Promise<void>
  reorderTab: (dragId: string, targetId: string) => void
  importWorkflow: (wf: Workflow) => Promise<void>
  save: () => Promise<void>
  remove: (id: string) => Promise<void>
}

/** zustand 的 setState，收窄为当前 store 的形状后供 slice 使用。 */
export type Set = StoreApi<WorkflowsState>['setState']
/** zustand 的 getState，同上。 */
export type Get = StoreApi<WorkflowsState>['getState']

/** 各 slice 之间共享的内部能力（撤销栈 + 自动保存）。 */
export interface SliceDeps {
  history: { push: () => void; clear: () => void; undo: () => void; redo: () => void }
  autosave: { touch: () => void; schedule: () => void }
}
