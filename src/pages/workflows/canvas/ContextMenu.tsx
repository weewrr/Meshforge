// Blueprint Context Sensitive Actions：右键节点（或空白画布）弹出的动作菜单。

import type { WFNode } from '../../../types'
import { useT } from '../../../i18n'

export function ContextMenu({
  x,
  y,
  count = 0,
  groupable = 0,
  comment,
  canFold = false,
  isSubgraph = false,
  onAddNode,
  onDuplicate,
  onDelete,
  onGroupComment,
  onToggleCommentCollapse,
  onFold,
  onExpand,
  onToggleBreakpoint
}: {
  x: number
  y: number
  /** 右键目标节点数（含多选） */
  count?: number
  /** 可框选为注释框的节点数 */
  groupable?: number
  /** 右键目标正好是一个注释框时传入，用于显示折叠/展开入口 */
  comment?: WFNode
  canFold?: boolean
  isSubgraph?: boolean
  /** 右键空白画布 → 在落点打开"添加节点"面板 */
  onAddNode?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onGroupComment?: () => void
  onToggleCommentCollapse?: () => void
  onFold?: () => void
  onExpand?: () => void
  onToggleBreakpoint?: () => void
}) {
  const t = useT()

  return (
    <div
      className="wf-node-menu"
      // 把菜单限制在视口内：减去预估宽（200）/高（180），避免贴边被裁。
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 180) }}
    >
      {onAddNode && (
        <button className="wf-node-menu__item" onClick={onAddNode}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('workflows.ctxMenu.paneAddNode')}
        </button>
      )}
      {onDuplicate && (
        <button className="wf-node-menu__item" onClick={onDuplicate}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
          {t('workflows.ctxMenu.nodeDuplicate')}
        </button>
      )}
      {onDelete && (
        <button className="wf-node-menu__item" onClick={onDelete}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
          </svg>
          {t('workflows.ctxMenu.nodeDelete')}
        </button>
      )}
      {groupable > 1 && onGroupComment && (
        <>
          <div className="wf-node-menu__sep" />
          <button className="wf-node-menu__item" onClick={onGroupComment}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
              <path d="M9 12h6M12 9v6" />
            </svg>
            {t('workflows.ctxMenu.nodeGroupComment')}
          </button>
        </>
      )}
      {comment ? (
        <button className="wf-node-menu__item" onClick={onToggleCommentCollapse}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {comment.data?.params?.collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
          </svg>
          {t(comment.data?.params?.collapsed ? 'workflows.ctxMenu.nodeExpandComment' : 'workflows.ctxMenu.nodeCollapseComment')}
        </button>
      ) : null}
      {canFold && onFold && (
        <button className="wf-node-menu__item" onClick={onFold}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="3" />
          </svg>
          {t('workflows.ctxMenu.foldToFunction')}
        </button>
      )}
      {isSubgraph && onExpand && (
        <button className="wf-node-menu__item" onClick={onExpand}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="3" />
            <path d="M16 15l3-3 3 3" />
          </svg>
          {t('workflows.ctxMenu.expandFunction')}
        </button>
      )}
      {count === 1 && onToggleBreakpoint && (
        <>
          <div className="wf-node-menu__sep" />
          <button className="wf-node-menu__item" onClick={onToggleBreakpoint}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="7" />
            </svg>
            {t('workflows.ctxMenu.nodeToggleBreakpoint')}
          </button>
        </>
      )}
    </div>
  )
}