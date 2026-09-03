import type { ReactNode } from 'react'

// ─── Shared settings primitives ─────────────────────────────────────────────
// Port of Modly's @shared/ui building blocks, rendered with local st-* classes.

export function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div>
      <div className="st-section__head">
        <h2 className="st-section__title">{title}</h2>
        <p className="st-section__subtitle">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

export function Card({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <div className="st-card">
      {(title || description) && (
        <div className="st-card__head">
          {title && <p className="st-card__title">{title}</p>}
          {description && <p className="st-card__desc">{description}</p>}
        </div>
      )}
      <div className="st-card__body">{children}</div>
    </div>
  )
}

export function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row__text">
        <p className="st-row__label">{label}</p>
        {description && <p className="st-row__desc">{description}</p>}
      </div>
      <div className="st-row__control">{children}</div>
    </div>
  )
}

export function PathRow({ label, description, value }: {
  label: string
  description?: string
  value: string
}) {
  return (
    <div className="st-path">
      <div className="st-path__top">
        <div>
          <p className="st-row__label">{label}</p>
          {description && <p className="st-row__desc">{description}</p>}
        </div>
      </div>
      <div className="st-path__value">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span>{value}</span>
      </div>
    </div>
  )
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`st-toggle ${value ? 'st-toggle--on' : ''}`}
      aria-pressed={value}
    >
      <span className="st-toggle__knob" />
    </button>
  )
}

export function SegmentedControl<T extends string>({ value, onChange, options, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  ariaLabel?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="st-seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={`st-seg__btn ${o.value === value ? 'st-seg__btn--active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({ value, onChange, options, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  ariaLabel?: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="st-select"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export function LinkButton({ label, href }: { label: string; href?: string }) {
  return (
    <button className="st-linkbtn" onClick={() => href && window.open(href, '_blank')}>
      {label}
      <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </button>
  )
}
