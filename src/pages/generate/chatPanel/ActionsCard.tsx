/**
 * 聊天面板里的"智能体动作"卡片。
 *
 * 智能体每发起一次工具调用（生成 / 处理 / 导入），就在会话流里插一张卡片，
 * 展示动作名与进行状态，让长流程的中间步骤可见、可预期。
 */

import { useState } from 'react'
import type { AgentAction } from '../../../api'

// ─── 动作卡片 ─────────────────────────────────────────────────────────────────
/**
 * 汇总一轮对话里 LLM 实际执行过的工具动作。
 *
 * 收起时只显示条数；展开后逐条列出。若其中有改动过网格的动作，
 * 还会给出一个 Undo 按钮，把网格回滚到本轮执行之前。
 */

/** 工具名 → 展示文案。未登记的工具会退化为"把下划线换成空格"。 */
export const TOOL_LABELS: Record<string, string> = {
  decimate_mesh: 'Decimated mesh',
  smooth_mesh: 'Smoothed mesh',
  list_models: 'Listed models',
  unload_models: 'Unloaded models',
  get_mesh_info: 'Inspected mesh',
  get_generation_status: 'Checked generation',
  list_workflows: 'Listed workflows',
  run_workflow: 'Ran workflow',
  create_workflow: 'Created workflow'
}

/** 动作汇总卡片。`onUndo` 缺省时不显示撤销按钮。 */
export function ActionsCard({ actions, onUndo }: { actions: AgentAction[]; onUndo?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  // 只有真正改动过网格的动作才可撤销——查询类动作没有可回滚的副作用。
  const meshActions = actions.filter((a) => a.payload?.type === 'mesh_update')
  const canUndo = meshActions.length > 0 && !!onUndo

  return (
    <div className="gp-chat__actions">
      <div className="gp-chat__actionshead">
        <span className="gp-chat__actionslabel">
          {actions.length} action{actions.length > 1 ? 's' : ''} performed
        </span>
        <div className="gp-chat__actionstools">
          {canUndo && (
            <button className="gp-chat__actionsundo" onClick={onUndo} title="Undo">
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 2.28-5.93" />
              </svg>
              Undo
            </button>
          )}
          <button className="gp-chat__actionscaret" onClick={() => setExpanded((v) => !v)} title="Expand">
            <svg aria-hidden="true"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={expanded ? 'gp-chat__caret--open' : ''}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>
      {expanded && (
        <div className="gp-chat__actionsbody">
          {actions.map((a, i) => (
            // 用下标作 key：动作列表是一次性渲染的只读快照，没有重排场景。
            <div key={i} className="gp-chat__actionrow">
              <span className="gp-chat__actionname">{TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, ' ')}</span>
              {a.payload?.type === 'mesh_update' && a.payload.face_count && (
                <span className="gp-chat__actionfaces">{String(a.payload.face_count)} faces</span>
              )}
              {a.payload?.type === 'run_workflow' && (
                <span className="gp-chat__actionwf">{a.payload.workflow_name}</span>
              )}
              {a.payload?.type === 'create_workflow' && a.payload.workflow && (
                <span className="gp-chat__actionwf">{a.payload.workflow.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
