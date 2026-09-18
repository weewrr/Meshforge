// ─── 工作流运行器：公开类型与常量 ─────────────────────────────────────────────
/**
 * 工作流运行器的公开契约。
 *
 * 运行态相关的对外类型全部收在这里：整体状态机 `RunState`、单个节点的状态与
 * 产物结构、以及暂停/单步等调试动作的签名。把契约与引擎（`engine.ts`）分开，
 * 是为了让 UI 只依赖这份声明、不触碰执行细节。
 */

import type { Workflow } from '../../types'

/** 一次运行的整体状态机：idle → running ⇄ paused → succeeded / failed / cancelled。 */
export type RunState = 'idle' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

/** 四视角生成器（Hunyuan3D 2 MV）的生成器 id。该生成器需要把 4 个视角图
 *  （front/left/back/right）组装成 views 传给 submitImage。 */
export const HUNYUAN_MV_GENERATOR = 'hunyuan3d-2-mv'

/** 四视角图的 tag 顺序（与后端 /generate/from-image 的 multipart 字段一一对应）。 */
export const MV_VIEW_TAGS = ['front', 'left', 'back', 'right'] as const
/** 单个视角的 tag 字面量联合类型。 */
export type MvViewTag = (typeof MV_VIEW_TAGS)[number]

/** 单个节点在一次运行中的状态。
 *  `waiting` 专指因 Wait 节点或断点而挂起，与 `running` 区分开以便 UI 显示不同的提示。 */
export type NodeState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'

/** 节点执行产物。下游节点按 handle 读取它，见 `runtime.ts` 的 outputs 表。 */
export interface NodeOutput {
  type: 'image' | 'text' | 'mesh' | 'array'
  file?: File
  url?: string
  text?: string
  /** 数组节点：按序解析好的图片文件（可喂给 MV 生成器的四视角槽）。 */
  items?: File[]
  /** 四视角生成器专用：front/left/back/right 视角图（可为空的部分视图）。 */
  views?: Partial<Record<MvViewTag, File>>
}

/** 递归执行子图时的最大嵌套层数（自引用函数会无限下钻，这里做硬截断）。 */
export const MAX_GRAPH_DEPTH = 8

/** 运行态 store 的形状：运行数据 + 控制动作。 */
export interface WorkflowRunState {
  runState: RunState
  /** 节点 id → 状态。 */
  nodeStates: Record<string, NodeState>
  /** 节点 id → 0~1 的进度（生成器节点用后端回报的百分比）。 */
  nodeProgress: Record<string, number>
  /** 循环节点的迭代进度（节点上显示 "3/8"，并驱动 Index 输出）。 */
  nodeIter: Record<string, { index: number; total: number }>
  /** 当前正在执行的节点（用于画布高亮）。 */
  activeNodeId: string | null
  /** 因断点/单步/手动暂停而停在哪个节点上（null = 未因调试暂停）。 */
  pausedAt: string | null
  /** 当前后端任务 id，取消时需要它调 `/jobs/{id}/cancel`。 */
  currentJobId: string | null
  /** 本次运行对应的工作流 id（运行中用户可能切走，故单独记录）。 */
  currentWorkflowId: string | null
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  run: (workflow: Workflow, override?: File | null) => Promise<void>
  cancel: () => Promise<void>
  continueRun: () => void
  /** 请求在当前节点跑完后暂停（下一次节点边界生效）。 */
  pause: () => void
  /** 暂停状态下单步：执行一个节点后再次暂停。 */
  stepOver: () => void
  continueWhile: () => void
  retryWhile: () => void
  reset: () => void
}
