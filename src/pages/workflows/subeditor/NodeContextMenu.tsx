/**
 * 子图编辑器的节点右键菜单。
 *
 * 从 EditorInner 抽出的展示组件：菜单项随选中内容动态出现
 * （多选 → 编组；可折叠 → 函数化；注释框 → 折叠/展开；子函数 → 展开；单选 → 断点）。
 */

import { useT } from '../../../i18n'
import type { WFNode } from '../../../types'

interface NodeContextMenuProps {
  x: number
  y: number
  ids: string[]
  ctxFoldable: boolean
  ctxSingle: WFNode | undefined
  ctxComment: WFNode | undefined
  onDuplicate: () => void
  onRemove: () => void
  onGroupComment: () => void
  onFold: () => void
  onToggleCommentCollapse: () => void
  onExpandSubgraph: () => void
  onToggleBreakpoint: () => void
  onClose: () => void
}

export function NodeContextMenu(props: NodeContextMenuProps) {
  const {
    x, y, ids, ctxFoldable, ctxSingle, ctxComment,
    onDuplicate, onRemove, onGroupComment, onFold,
    onToggleCommentCollapse, onExpandSubgraph, onToggleBreakpoint
  } = props
  const t = useT()

  return (
    <div
      className="wf-node-menu"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 200) }}
    >
      <button className="wf-node-menu__item" onClick={onDuplicate}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        {t('workflows.ctxMenu.nodeDuplicate')}
      </button>
      <button className="wf-node-menu__item" onClick={onRemove}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </svg>
        {t('workflows.ctxMenu.nodeDelete')}
      </button>
      {ids.length > 1 && (
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
      {ctxFoldable && (
        <button className="wf-node-menu__item" onClick={onFold}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="3" />
          </svg>
          {t('workflows.ctxMenu.foldToFunction')}
        </button>
      )}
      {ctxComment && (
        <button className="wf-node-menu__item" onClick={onToggleCommentCollapse}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {ctxComment.data?.params?.collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
          </svg>
          {t(ctxComment.data?.params?.collapsed ? 'workflows.ctxMenu.nodeExpandComment' : 'workflows.ctxMenu.nodeCollapseComment')}
        </button>
      )}
      {ctxSingle?.type === 'subgraphNode' && (
        <button className="wf-node-menu__item" onClick={onExpandSubgraph}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="3" />
            <path d="M16 15l3-3 3 3" />
          </svg>
          {t('workflows.ctxMenu.expandFunction')}
        </button>
      )}
      {ids.length === 1 && (
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
