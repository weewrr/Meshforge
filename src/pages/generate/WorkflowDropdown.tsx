import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { WorkflowMeta } from '../../types'

// ─── 工作流下拉 ────────────────────────────────────────────────────────────

export function WorkflowDropdown({ workflows, value, onChange, disabled }: {
  workflows: WorkflowMeta[]
  value: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const selected = workflows.find((w) => w.id === value)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  if (workflows.length === 0) {
    return <div className="gp-dropdown__empty">{t('generate.workflow.noWorkflows')}</div>
  }

  return (
    <div className="gp-dropdown" ref={ref}>
      <button
        className={`gp-dropdown__btn ${open ? 'gp-dropdown__btn--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="gp-dropdown__label">{selected?.name ?? t('generate.workflow.select')}</span>
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`gp-dropdown__chevron ${open ? 'gp-dropdown__chevron--open' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="gp-dropdown__list" role="listbox">
          {workflows.map((wf, i) => (
            <button
              key={wf.id}
              role="option"
              aria-selected={wf.id === value}
              tabIndex={wf.id === value ? 0 : -1}
              className={`gp-dropdown__item ${i > 0 ? 'gp-dropdown__item--sep' : ''} ${wf.id === value ? 'gp-dropdown__item--active' : ''}`}
              onClick={() => { onChange(wf.id); setOpen(false) }}
            >
              <span className="gp-dropdown__item-name">{wf.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
