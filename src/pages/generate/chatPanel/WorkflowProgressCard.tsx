/**
 * 聊天面板里的工作流运行进度卡片。
 *
 * 把运行器回放的节点状态（排队 / 运行中 / 完成 / 失败）压成一行进度条 +
 * 当前节点名，让会话流里的批量执行一眼可见。
 */

import { useMemo } from 'react'
import { useWorkflowRunStore } from '../../../stores/workflowRun'

// ─── 工作流进度卡片 ───────────────────────────────────────────────────────────
/**
 * 聊天流里内嵌的工作流执行进度卡片。
 *
 * 它直接订阅运行态 store，所以工作流在画布上跑的同时，聊天里的这张卡片也会
 * 实时推进——两处共用同一份运行状态，不需要额外的消息通道。
 */

/** 展示某个工作流的执行进度：整体百分比 + 已完成节点数。 */
export function WorkflowProgressCard({ name }: { name: string }) {
  const runState = useWorkflowRunStore((s) => s.runState)
  const nodeStates = useWorkflowRunStore((s) => s.nodeStates)
  const nodeProgress = useWorkflowRunStore((s) => s.nodeProgress)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)

  const pct = useMemo(() => {
    const values = Object.values(nodeProgress)
    // 还没有任何节点上报进度时按 0 处理，避免 0/0 得到 NaN。
    if (values.length === 0) return 0
    // 用所有节点进度的算术平均作为整体进度。
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100)
  }, [nodeProgress])

  const done = useMemo(() => Object.values(nodeStates).filter((s) => s === 'succeeded').length, [nodeStates])
  const total = useMemo(() => Object.keys(nodeStates).length, [nodeStates])

  return (
    <div className="gp-chat__wfcard">
      <div className="gp-chat__wfhead">
        <div className="gp-chat__wfname">
          <span className="gp-chat__wfdot" />
          <span>{name}</span>
        </div>
        <span className="gp-chat__wfpct">{pct}%</span>
      </div>
      <div className="gp-chat__wfbar">
        <div className="gp-chat__wffill" style={{ width: `${pct}%` }} />
      </div>
      {/* 节点数为 0 时（例如图里只有注释框）不显示步骤行，避免出现 "0/0"。 */}
      {total > 0 && (
        <p className="gp-chat__wfstep">
          {done}/{total} nodes · {activeNodeId ? 'running…' : runState === 'succeeded' ? 'completed' : runState}
        </p>
      )}
    </div>
  )
}
