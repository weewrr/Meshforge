/**
 * 扩展卸载确认模态框。
 *
 * 用焦点圈定 hook 保证键盘可达；确认后调卸载接口，失败原因就地展示在框内，
 * 而不是静默关闭。
 */

import { useEffect, type Ref } from 'react'
import { useT } from '../../i18n'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { Ext } from './types'

// ─── Uninstall confirm modal ─────────────────────────────────────────────────

export function UninstallModal({ ext, busy, error, onCancel, onConfirm }: {
  ext: Ext
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (ext: Ext) => void
}) {
  const t = useT()
  const trapRef = useFocusTrap(true, onCancel)

  useEffect(() => {
    // Esc 关闭（处理中时不响应，避免误触打断卸载）。
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [busy, onCancel])

  return (
    <div className="ex-modal" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="ex-modal__overlay" />
      <div ref={trapRef as Ref<HTMLDivElement>} role="dialog" aria-modal="true" aria-label={t('models.uninstallAria', { name: ext.name })} className="ex-modal__card">
        <div className="ex-modal__head">
          <div className="ex-modal__icon">
            <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
          </div>
          <div>
            <h2 className="ex-modal__title">{t('models.uninstallTitle', { name: ext.name })}</h2>
            <p className="ex-modal__sub">{t('models.uninstallDesc')}</p>
          </div>
        </div>

        {error && (
          <div className="ex-modal__error">
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p>{error}</p>
          </div>
        )}

        <div className="ex-modal__actions">
          <button className="ex-modal__cancel" onClick={onCancel} disabled={busy}>{t('models.cancel')}</button>
          <button className="ex-modal__confirm" onClick={() => onConfirm(ext)} disabled={busy}>
            {busy ? <span className="ex-spinner" /> : t('models.uninstall')}
          </button>
        </div>
      </div>
    </div>
  )
}
