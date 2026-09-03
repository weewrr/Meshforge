import { useEffect, useState } from 'react'
import ErrorBoundary, { type ErrorBoundaryFallbackProps } from './components/ErrorBoundary'
import { Sidebar, TitleBar } from './components/Chrome'
import GeneratePage from './pages/GeneratePage'
import ModelsPage from './pages/ModelsPage'
import SettingsPage from './pages/SettingsPage'
import WorkflowsPage from './pages/WorkflowsPage'
import { useT } from './i18n'
import { useLogsStore } from './stores/logs'
import { useNavigationStore } from './stores/navigation'

function AppCrash({ error, reset }: ErrorBoundaryFallbackProps) {
  const t = useT()
  return (
    <div className="eb-app">
      <svg className="eb-app__icon" aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <p className="eb-app__title">{t('app.crashTitle')}</p>
      <p className="eb-app__msg">{error.message || String(error)}</p>
      <div className="eb-app__actions">
        <button className="eb-btn eb-btn--primary" onClick={() => window.location.reload()}>{t('app.reload')}</button>
        <button className="eb-btn" onClick={reset}>{t('app.retry')}</button>
      </div>
    </div>
  )
}

export default function App() {
  const page = useNavigationStore((s) => s.page)
  const [crash, setCrash] = useState<{ reason: string; at: number } | null>(null)
  const t = useT()

  // Crash recovery banner: the main process auto-reloads the renderer after a
  // render-process-gone / unresponsive event and stashes the reason. We ask
  // once on mount (one-shot, cleared by the main process) and surface it so a
  // reload never looks like a silent "jumped back to home". Navigation and the
  // open workflow tab are restored from localStorage elsewhere, so the banner
  // doubles as a hint that the restore just happened.
  useEffect(() => {
    let cancelled = false
    void window.meshforge
      ?.getLastCrash()
      .then((last) => {
        if (cancelled || !last) return
        // Stale guard: if the window was closed before the auto-reload and
        // relaunched later, ignore an old crash record.
        if (Date.now() - last.at > 60_000) return
        setCrash(last)
        useLogsStore.getState().error(`[crash-recovery] ${last.reason}`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      {crash && (
        <div role="status" className="eb-banner">
          <svg className="eb-banner__icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="eb-banner__msg">
            {t('app.banner')}
            <span style={{ opacity: 0.75 }}> ({crash.reason})</span>
          </span>
          <button
            onClick={() => setCrash(null)}
            className="eb-banner__dismiss"
            aria-label={t('app.dismiss')}
          >
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <div className="app__body">
        <Sidebar />
        <div className="app__content">
          <ErrorBoundary label="App" fallback={(props) => <AppCrash {...props} />}>
            {page === 'workflows' && <WorkflowsPage />}
            {page === 'generate' && <GeneratePage />}
            {page === 'models' && <ModelsPage />}
            {page === 'settings' && <SettingsPage />}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
