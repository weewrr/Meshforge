/**
 * 模型页共享的内联小图标与轻量 UI 片段。
 *
 * 全部为描边风格 SVG，跟随文本颜色（currentColor），供卡片与控制条复用，
 * 避免各处复制同一段路径。
 */

import { useT } from '../../i18n'
import type { ExtNode } from './types'

// ─── Icons ──────────────────────────────────────────────────────────────────

export const CUBE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="ex-icon">
    <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
    <path d="m3 7 9 5 9-5M12 12v10" />
  </svg>
)

export const SPARK_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="ex-icon">
    <path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IMAGE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="ex-icon">
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <circle cx="8.6" cy="8.6" r="1.6" />
    <path d="M21 15l-4.5-4.5L6 21" />
  </svg>
)

export const IMGFILTER_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="ex-icon">
    <circle cx="4" cy="6" r="1.5" /><line x1="4" y1="6" x2="20" y2="6" />
    <circle cx="9" cy="12" r="1.5" /><line x1="9" y1="12" x2="20" y2="12" />
    <circle cx="14" cy="18" r="1.5" /><line x1="14" y1="18" x2="20" y2="18" />
  </svg>
)

export const SHIELD_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ex-icon">
    <path d="M12 3 5 6v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6l-7-3Z" />
    <path d="m9.3 11.5 1.8 1.8 3.6-3.6" />
  </svg>
)

export const DOWNLOAD_ICON = (
  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M7 11l5 5 5-5M5 20h14" />
  </svg>
)

export const CHECK_ICON = (
  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
)

/** 暂停图标。 */
export const PAUSE_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)

export const PLAY_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)

export const X_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ─── Small visual bits ───────────────────────────────────────────────────────

export function TypePill({ type, category }: { type: 'model' | 'process'; category?: string }) {
  const t = useT()
  const view = type === 'model' && category === 'multiview'
  const image = type === 'model' && category === 'image'
  const cls = view ? 'ex-pill--view' : image ? 'ex-pill--image' : type === 'process' ? 'ex-pill--process' : 'ex-pill--model'
  const label = view ? t('models.typeViewModel') : image ? t('models.typeImageModel') : type === 'process' ? t('models.typeProcess') : t('models.typeModel')
  return <span className={`ex-pill ${cls}`}>{label}</span>
}

export function IOBadge({ node }: { node: ExtNode }) {
  return (
    <span className="ex-io">
      <span className="ex-io__slot">{node.input}</span>
      <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h13M13 6l6 6-6 6" />
      </svg>
      <span className="ex-io__slot">{node.output}</span>
    </span>
  )
}

/** 带指示灯的状态徽标（绿 / 琥珀 / 紫）。 */
export function StatusBadge({ tone, children }: { tone: 'green' | 'amber' | 'violet'; children: string }) {
  return (
    <span className={`ex-status ex-status--${tone}`}>
      <span className="ex-status__led" />
      {children}
    </span>
  )
}
