// ─── 引脚右键菜单（删除单条连线）──────────────────────────────────────────────
// Unreal Blueprint 里可以直接在引脚上断开单条连线。React Flow 会把 data-nodeid /
// data-handleid 挂在每个 .react-flow__handle 上，因此两个画布（主画布 / 子图编辑器）
// 都只需在右键事件里解析出引脚，再共用这个菜单即可。
import { useEffect } from 'react'
import type { WFEdge } from '../../types'
import { useT } from '../../i18n'

export interface PinTarget {
  x: number
  y: number
  nodeId: string
  handleId: string | null
  /** 'source'（输出引脚）| 'target'（输入引脚）| null。 */
  handleType: string | null
}

/** 从右键事件的目标元素里解析引脚信息；不是点在引脚上时返回 null。 */
export function pinFromEvent(e: { target: EventTarget | null; clientX: number; clientY: number }): PinTarget | null {
  const el = (e.target as Element | null)?.closest?.('.react-flow__handle') as HTMLElement | null
  if (!el) return null
  const nodeId = el.getAttribute('data-nodeid')
  if (!nodeId) return null
  const type = el.classList.contains('source') ? 'source' : el.classList.contains('target') ? 'target' : null
  return {
    x: e.clientX,
    y: e.clientY,
    nodeId,
    handleId: el.getAttribute('data-handleid'),
    handleType: type
  }
}

/** 命中某个引脚的所有连线（输出端或输入端其中之一匹配即可）。 */
export function edgesAtPin(edges: WFEdge[], nodeId: string, handleId: string | null): WFEdge[] {
  return edges.filter((e) => {
    if (e.source === nodeId && (e.sourceHandle ?? null) === handleId) return true
    if (e.target === nodeId && (e.targetHandle ?? null) === handleId) return true
    return false
  })
}

/** 引脚连线菜单：逐条断开，或一键断开该引脚的全部连线。 */
export default function PinMenu({
  pin,
  edges,
  labelOf,
  onDelete,
  onClose
}: {
  pin: PinTarget
  edges: WFEdge[]
  labelOf: (nodeId: string) => string
  onDelete: (edgeIds: string[]) => void
  onClose: () => void
}) {
  const t = useT()
  const list = edgesAtPin(edges, pin.nodeId, pin.handleId)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = document.querySelector('.wf-pin-menu')
      if (el && el.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="wf-pin-menu"
      // 把菜单限制在视口内：减去预估的宽（250）/高（220），避免贴边时被裁掉。
      style={{ left: Math.min(pin.x, window.innerWidth - 250), top: Math.min(pin.y, window.innerHeight - 220) }}
    >
      <div className="wf-pin-menu__title">{t('workflows.ctxMenu.pinMenuTitle')}</div>
      {list.length === 0 && <div className="wf-pin-menu__empty">{t('workflows.ctxMenu.pinNoEdges')}</div>}
      {list.map((edge) => {
        const outbound = edge.source === pin.nodeId
        const other = outbound ? edge.target : edge.source
        return (
          <button
            key={edge.id}
            className="wf-pin-menu__item"
            title={t('workflows.ctxMenu.pinDeleteEdge')}
            onClick={() => {
              onDelete([edge.id])
              onClose()
            }}
          >
            <span className="wf-pin-menu__dir" aria-hidden="true">
              {outbound ? '→' : '←'}
            </span>
            <span className="wf-pin-menu__label">{labelOf(other)}</span>
            <span className="wf-pin-menu__x" aria-hidden="true">
              ✕
            </span>
          </button>
        )
      })}
      {list.length > 1 && (
        <>
          <div className="wf-pin-menu__sep" />
          <button
            className="wf-pin-menu__item wf-pin-menu__item--danger"
            onClick={() => {
              onDelete(list.map((e) => e.id))
              onClose()
            }}
          >
            {t('workflows.ctxMenu.pinDeleteAll')}
          </button>
        </>
      )}
    </div>
  )
}
