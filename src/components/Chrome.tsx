import { useEffect, useState, type ReactElement } from 'react'
import { useNavigationStore, type Page } from '../stores/navigation'
import { useAppStore } from '../stores/app'
import { useT } from '../i18n'

const ITEMS: { page: Page; key: string; icon: ReactElement }[] = [
  {
    page: 'generate',
    key: 'nav.generate',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    )
  },
  {
    page: 'workflows',
    key: 'nav.workflows',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="6" height="5" rx="1" />
        <rect x="3" y="11" width="6" height="5" rx="1" />
        <rect x="3" y="19" width="6" height="2" rx="1" />
        <path d="M9 5.5h3.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9" />
        <rect x="13.5" y="3" width="7.5" height="16" rx="1" />
      </svg>
    )
  },
  {
    page: 'models',
    key: 'nav.models',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    )
  },
  {
    page: 'settings',
    key: 'nav.settings',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }
]

export function Sidebar() {
  const page = useNavigationStore((s) => s.page)
  const go = useNavigationStore((s) => s.go)
  const t = useT()

  return (
    <nav className="sidebar">
      {ITEMS.map((item) => {
        const label = t(item.key)
        return (
          <button
            key={item.page}
            title={label}
            className={`sidebar__item ${page === item.page ? 'sidebar__item--active' : ''}`}
            onClick={() => go(item.page)}
          >
            <span className="sidebar__icon">{item.icon}</span>
            <span className="sidebar__label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

interface RamSample {
  total: number
  free: number
  percent: number
}

function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export function TitleBar() {
  const showRamIndicator = useAppStore((s) => s.showRamIndicator)
  const [mem, setMem] = useState<RamSample | null>(null)
  const t = useT()

  // Poll every 2s while the indicator is enabled. Guard with a no-op when the
  // sample is unchanged so we never re-render the always-mounted title bar on
  // a tick that changed nothing — that alone avoids a perpetual ~0.5Hz rerender.
  useEffect(() => {
    if (!showRamIndicator) {
      setMem(null)
      return
    }
    let active = true
    const read = () =>
      window.meshforge
        ?.getRam()
        .then((next) => {
          if (!active || !next) return
          setMem((prev) => {
            if (
              prev &&
              prev.percent === next.percent &&
              prev.total === next.total &&
              prev.free === next.free
            ) {
              return prev
            }
            return next
          })
        })
        .catch(() => undefined)
    read()
    const timer = setInterval(read, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [showRamIndicator])

  const pct = mem ? Math.min(100, Math.round(mem.percent)) : 0
  let barColor = 'titlebar__rambar--ok'
  let textColor = 'titlebar__ramtext'
  if (pct >= 90) {
    barColor = 'titlebar__rambar--high'
    textColor = 'titlebar__ramtext--high'
  } else if (pct >= 75) {
    barColor = 'titlebar__rambar--warn'
    textColor = 'titlebar__ramtext--warn'
  }

  return (
    <div className="titlebar">
      <span className="titlebar__app">{t('titlebar.app')}</span>
      {showRamIndicator && mem && (
        <div
          className="titlebar__ram"
          title={t('titlebar.ramTitle', {
            used: fmtGB(mem.total - mem.free),
            available: fmtGB(mem.free),
            total: fmtGB(mem.total)
          })}
        >
          <span className="titlebar__ramlabel">{t('titlebar.ram')}</span>
          <span className="titlebar__rambar">
            <span className={`titlebar__ramfill ${barColor}`} style={{ width: `${pct}%` }} />
          </span>
          <span className={`titlebar__ramvalue ${textColor}`}>
            {fmtGB(mem.total - mem.free)} / {fmtGB(mem.total)} GB
          </span>
        </div>
      )}
      <div className="titlebar__spacer" />
      <button
        className="titlebar__btn"
        title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}
        onClick={() => void window.meshforge?.winMin()}
      >
        —
      </button>
      <button
        className="titlebar__btn"
        title={t('titlebar.maximize')} aria-label={t('titlebar.maximize')}
        onClick={() => void window.meshforge?.winMax()}
      >
        ▢
      </button>
      <button className="titlebar__btn titlebar__btn--close" title={t('titlebar.close')} aria-label={t('titlebar.close')} onClick={() => void window.meshforge?.winClose()}>
        ×
      </button>
    </div>
  )
}
