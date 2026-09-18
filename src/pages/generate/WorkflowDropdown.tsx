/**
 * 生成页顶部的工作流选择下拉。
 *
 * 列出全部已保存工作流供"按工作流生成"使用；点击外部自动收起，
 * 选中后仅记录 id，由父组件负责读取与切换。
 */

import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { WorkflowMeta } from '../../types'

// ─── 工作流下拉 ────────────────────────────────────────────────────────────
/**
 * 生成页顶部的工作流选择器。
 *
 * 手写而非用原生 `<select>`：需要自定义外观（每项之间带分隔线、自定义箭头），
 * 同时仍要保证 listbox / option 的 ARIA 语义与键盘可达性。
 */

/** 工作流选择下拉。`disabled` 用于运行中禁止切换工作流。 */
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
    // 点击面板外部即关闭：监听 document 上的 mousedown，比铺一层遮罩更轻，
    // 也不会引入额外的 z-index 层级。
    function onDocClick(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    // 收起时卸载监听；open 变化时重新绑定。
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // 一个工作流都没有时不渲染下拉，直接给一句空态文案。
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
              // 选中项才进入 tab 顺序，键盘用户一次 Tab 即可回到当前选项。
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
