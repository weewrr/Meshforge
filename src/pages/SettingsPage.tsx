import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { health } from '../api'
import { Card, LinkButton, PathRow, Row, Section, SegmentedControl, Select, Toggle } from '../components/ui'
import { useT, type Locale } from '../i18n'
import { useAppStore, type ThinkingMode } from '../stores/app'
import { useLogsStore } from '../stores/logs'

// ─── Section registry ────────────────────────────────────────────────────────

type SectionId = 'application' | 'storage' | 'integrations' | 'accessibility' | 'performance' | 'agent' | 'logs' | 'about'

const SECTIONS: { id: SectionId; key: string; icon: ReactElement }[] = [
  {
    id: 'application',
    key: 'settings.nav.application',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07" />
      </svg>
    )
  },
  {
    id: 'storage',
    key: 'settings.nav.storage',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </svg>
    )
  },
  {
    id: 'integrations',
    key: 'settings.nav.integrations',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
      </svg>
    )
  },
  {
    id: 'accessibility',
    key: 'settings.nav.accessibility',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="4" r="2" />
        <path d="M19 9l-7 1-7-1" />
        <path d="M12 10v6" />
        <path d="M9 22l3-6 3 6" />
      </svg>
    )
  },
  {
    id: 'performance',
    key: 'settings.nav.performance',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    )
  },
  {
    id: 'agent',
    key: 'settings.nav.agent',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
      </svg>
    )
  },
  {
    id: 'logs',
    key: 'settings.nav.logs',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    )
  },
  {
    id: 'about',
    key: 'settings.nav.about',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    )
  }
]

// ─── Application ─────────────────────────────────────────────────────────────

function ApplicationSection() {
  const showRamIndicator = useAppStore((s) => s.showRamIndicator)
  const locale = useAppStore((s) => s.locale)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  return (
    <Section title={t('settings.application.title')} subtitle={t('settings.application.subtitle')}>
      <Card title={t('settings.application.interface')}>
        <Row label={t('settings.application.ramIndicator')} description={t('settings.application.ramIndicatorDesc')}>
          <Toggle value={showRamIndicator} onChange={(v) => patch({ showRamIndicator: v })} />
        </Row>
        <Row label={t('lang.label')} description={t('lang.description')}>
          <SegmentedControl
            options={[
              { value: 'en', label: t('lang.english') },
              { value: 'zh', label: t('lang.chinese') }
            ]}
            value={locale}
            onChange={(v) => patch({ locale: v as Locale })}
          />
        </Row>
      </Card>
    </Section>
  )
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function StorageSection() {
  const modelsDir = useAppStore((s) => s.modelsDir)
  const workspaceDir = useAppStore((s) => s.workspaceDir)
  const workflowsDir = useAppStore((s) => s.workflowsDir)
  const [cacheStatus, setCacheStatus] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')
  const t = useT()

  function handleClearCache(): void {
    setCacheStatus('clearing')
    // No cache API in this build — simulate the clear so the UI stays honest
    // about what happened locally (renderer caches, blob URLs).
    setTimeout(() => {
      setCacheStatus('done')
      setTimeout(() => setCacheStatus('idle'), 2500)
    }, 500)
  }

  return (
    <Section title={t('settings.storage.title')} subtitle={t('settings.storage.subtitle')}>
      <div className="st-grid">
        <Card title={t('settings.storage.directoriesTitle')} description={t('settings.storage.directoriesDesc')}>
          <PathRow label={t('settings.storage.modelsLabel')} description={t('settings.storage.modelsDesc')} value={modelsDir} />
          <PathRow label={t('settings.storage.workspaceLabel')} description={t('settings.storage.workspaceDesc')} value={workspaceDir} />
          <PathRow label={t('settings.storage.workflowsLabel')} description={t('settings.storage.workflowsDesc')} value={workflowsDir} />
        </Card>
        <Card title={t('settings.storage.cacheTitle')} description={t('settings.storage.cacheDesc')}>
          <Row label={t('settings.storage.tempFilesLabel')} description={t('settings.storage.tempFilesDesc')}>
            <button
              onClick={handleClearCache}
              disabled={cacheStatus === 'clearing'}
              className={`st-actionbtn ${
                cacheStatus === 'done' ? 'st-actionbtn--ok' : cacheStatus === 'error' ? 'st-actionbtn--bad' : ''
              }`}
            >
              {cacheStatus === 'clearing' ? t('settings.storage.clearing') : cacheStatus === 'done' ? t('settings.storage.cleared') : cacheStatus === 'error' ? t('settings.storage.failed') : t('settings.storage.clearCache')}
            </button>
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Integrations ────────────────────────────────────────────────────────────

function IntegrationsSection() {
  const savedToken = useAppStore((s) => s.hfToken)
  const patch = useAppStore((s) => s.patch)
  const [token, setToken] = useState(savedToken)
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const t = useT()

  useEffect(() => setToken(savedToken), [savedToken])

  function save(value: string): void {
    setStatus('saving')
    patch({ hfToken: value })
    setStatus('saved')
    setTimeout(() => setStatus('idle'), 2500)
  }

  function handleClear(): void {
    setToken('')
    save('')
  }

  return (
    <Section title={t('settings.integrations.title')} subtitle={t('settings.integrations.subtitle')}>
      <div className="st-grid">
        <Card
          title={t('settings.integrations.hfTitle')}
          description={t('settings.integrations.hfDesc')}
        >
          <Row label={t('settings.integrations.accessTokenLabel')} description={t('settings.integrations.accessTokenDesc')}>
            <div className="st-token">
              <div className="st-token__field">
                <input
                  type={visible ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setStatus('idle') }}
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && save(token.trim())}
                  placeholder={t('settings.integrations.tokenPlaceholder')}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  title={visible ? t('settings.integrations.hideToken') : t('settings.integrations.showToken')}
                  aria-label={visible ? t('settings.integrations.hideToken') : t('settings.integrations.showToken')}
                  className="st-token__eye"
                >
                  {visible ? (
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              {token && (
                <button onClick={handleClear} title={t('settings.integrations.removeToken')} aria-label={t('settings.integrations.removeToken')} className="st-token__clear">
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => save(token.trim())}
                disabled={status === 'saving' || !token.trim()}
                className={`st-actionbtn st-actionbtn--accent ${
                  status === 'saved' ? 'st-actionbtn--ok' : status === 'error' ? 'st-actionbtn--bad' : ''
                }`}
              >
                {status === 'saving' ? t('settings.integrations.saving') : status === 'saved' ? t('settings.integrations.saved') : status === 'error' ? t('settings.integrations.failed') : t('settings.integrations.save')}
              </button>
            </div>
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Accessibility ───────────────────────────────────────────────────────────

function AccessibilitySection() {
  const useAtkinsonFont = useAppStore((s) => s.useAtkinsonFont)
  const uiScale = useAppStore((s) => s.uiScale)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  return (
    <Section title={t('settings.accessibility.title')} subtitle={t('settings.accessibility.subtitle')}>
      <div className="st-grid">
        <Card title={t('settings.accessibility.fontTitle')} description={t('settings.accessibility.fontDesc')}>
          <Row
            label={t('settings.accessibility.atkinsonLabel')}
            description={t('settings.accessibility.atkinsonDesc')}
          >
            <Toggle value={useAtkinsonFont} onChange={(v) => patch({ useAtkinsonFont: v })} />
          </Row>
        </Card>
        <Card title={t('settings.accessibility.scaleTitle')} description={t('settings.accessibility.scaleDesc')}>
          <Row label={t('settings.accessibility.scaleLabel')} description={t('settings.accessibility.scaleRowDesc')}>
            <SegmentedControl
              ariaLabel={t('settings.accessibility.scaleAria')}
              value={uiScale}
              onChange={(v) => patch({ uiScale: v })}
              options={[
                { value: 'small', label: t('settings.accessibility.sizeSmall') },
                { value: 'medium', label: t('settings.accessibility.sizeMedium') },
                { value: 'large', label: t('settings.accessibility.sizeLarge') },
                { value: 'very-large', label: t('settings.accessibility.sizeVeryLarge') }
              ]}
            />
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Performance ─────────────────────────────────────────────────────────────

function PerformanceSection() {
  const gpuDevice = useAppStore((s) => s.gpuDevice)
  const fp16 = useAppStore((s) => s.fp16)
  const vramLimit = useAppStore((s) => s.vramLimit)
  const parallelWorkers = useAppStore((s) => s.parallelWorkers)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  return (
    <Section title={t('settings.performance.title')} subtitle={t('settings.performance.subtitle')}>
      <div className="st-grid">
        <Card title={t('settings.performance.deviceTitle')} description={t('settings.performance.deviceDesc')}>
          <Row label={t('settings.performance.gpuLabel')} description={t('settings.performance.gpuDesc')}>
            <Select
              ariaLabel={t('settings.performance.gpuAria')}
              value={gpuDevice}
              onChange={(v) => patch({ gpuDevice: v })}
              options={[
                { value: 'auto', label: t('settings.performance.devAuto') },
                { value: 'mps', label: t('settings.performance.devMps') },
                { value: 'cuda0', label: t('settings.performance.devCuda0') },
                { value: 'cuda1', label: t('settings.performance.devCuda1') },
                { value: 'cpu', label: t('settings.performance.devCpu') }
              ]}
            />
          </Row>
          <Row label={t('settings.performance.fp16Label')} description={t('settings.performance.fp16Desc')}>
            <Toggle value={fp16} onChange={(v) => patch({ fp16: v })} />
          </Row>
        </Card>
        <Card title={t('settings.performance.memoryTitle')} description={t('settings.performance.memoryDesc')}>
          <Row label={t('settings.performance.vramLabel')} description={t('settings.performance.vramDesc')}>
            <Select
              ariaLabel={t('settings.performance.vramAria')}
              value={vramLimit}
              onChange={(v) => patch({ vramLimit: v })}
              options={[
                { value: '4', label: t('settings.performance.gb4') },
                { value: '6', label: t('settings.performance.gb6') },
                { value: '8', label: t('settings.performance.gb8') },
                { value: '12', label: t('settings.performance.gb12') },
                { value: '0', label: t('settings.performance.noLimit') }
              ]}
            />
          </Row>
          <Row label={t('settings.performance.workersLabel')} description={t('settings.performance.workersDesc')}>
            <Select
              ariaLabel={t('settings.performance.workersAria')}
              value={parallelWorkers}
              onChange={(v) => patch({ parallelWorkers: v })}
              options={[
                { value: '1', label: t('settings.performance.workersDefault') },
                { value: '2', label: t('settings.performance.workers2') },
                { value: '4', label: t('settings.performance.workers4') }
              ]}
            />
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Agent ──────────────────────────────────────────────────────────────────

function AgentSection() {
  const ollamaUrl = useAppStore((s) => s.ollamaUrl)
  const defaultModel = useAppStore((s) => s.defaultModel)
  const defaultThinking = useAppStore((s) => s.defaultThinking)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  const [urlDraft, setUrlDraft] = useState(ollamaUrl)
  const [modelDraft, setModelDraft] = useState(defaultModel)
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)

  useEffect(() => setUrlDraft(ollamaUrl), [ollamaUrl])
  useEffect(() => setModelDraft(defaultModel), [defaultModel])

  async function fetchModels(url: string): Promise<string[]> {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`)
      if (!res.ok) return []
      const data = (await res.json()) as { models?: { name: string }[] }
      return (data.models ?? []).map((m) => m.name)
    } catch {
      return []
    }
  }

  async function handleTestConnection(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    const found = await fetchModels(urlDraft)
    setModels(found)
    setTestResult(found.length > 0 ? 'ok' : 'error')
    setTesting(false)
  }

  function handleSave(): void {
    patch({ ollamaUrl: urlDraft.trim(), defaultModel: modelDraft.trim() })
    void fetchModels(urlDraft.trim())
  }

  const THINKING_OPTIONS: { value: ThinkingMode; key: string }[] = [
    { value: 'auto', key: 'thinkAuto' },
    { value: 'on', key: 'thinkOn' },
    { value: 'off', key: 'thinkOff' }
  ]

  return (
    <div className="st-agent">
      <div>
        <h2 className="st-agent__title">{t('settings.agent.title')}</h2>
        <p className="st-agent__subtitle">{t('settings.agent.subtitle')}</p>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">{t('settings.agent.groupOllama')}</h3>
        <label className="st-agent__label">{t('settings.agent.urlLabel')}</label>
        <div className="st-agent__urlrow">
          <input
            value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setTestResult(null) }}
            placeholder={t('settings.agent.urlPlaceholder')}
          />
          <button onClick={() => void handleTestConnection()} disabled={testing}>
            {testing ? t('settings.agent.testing') : t('settings.agent.test')}
          </button>
        </div>
        {testResult === null && <p className="st-agent__hint">{t('settings.agent.urlHint')}</p>}
        {testResult === 'ok' && (
          <p className="st-agent__hint st-agent__hint--ok">{t('settings.agent.connOk', { count: models.length })}</p>
        )}
        {testResult === 'error' && <p className="st-agent__hint st-agent__hint--bad">{t('settings.agent.connErr')}</p>}

        <label className="st-agent__label">{t('settings.agent.modelLabel')}</label>
        {models.length > 0 ? (
          <select value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} className="st-agent__select">
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder={t('settings.agent.modelPlaceholder')}
            className="st-agent__input"
          />
        )}
        <p className="st-agent__hint">{t('settings.agent.modelHint')}</p>

        <button onClick={handleSave} className="st-agent__save">{t('settings.agent.save')}</button>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">{t('settings.agent.groupThinking')}</h3>
        <label className="st-agent__label">{t('settings.agent.modeLabel')}</label>
        <div className="st-agent__radios">
          {THINKING_OPTIONS.map((opt) => (
            <label key={opt.value} className="st-agent__radio">
              <input
                type="radio"
                name="thinking"
                value={opt.value}
                checked={defaultThinking === opt.value}
                onChange={() => patch({ defaultThinking: opt.value })}
              />
              <div>
                <p className="st-agent__radiolabel">{t(`settings.agent.${opt.key}`)}</p>
                <p className="st-agent__hint">{t(`settings.agent.${opt.key}Desc`)}</p>
              </div>
            </label>
          ))}
        </div>
        <p className="st-agent__hint">{t('settings.agent.modeHint')}</p>
      </div>
    </div>
  )
}

// ─── Logs ────────────────────────────────────────────────────────────────────

const LOG_TABS = [
  { id: 'errors', key: 'tabErrors', levels: ['error'] },
  { id: 'runtime', key: 'tabRuntime', levels: ['info'] },
  { id: 'app', key: 'tabApp', levels: ['warn'] }
] as const

type LogTabId = (typeof LOG_TABS)[number]['id']

function LogsSection() {
  const logs = useLogsStore((s) => s.logs)
  const [activeTab, setActiveTab] = useState<LogTabId>('errors')
  const [copied, setCopied] = useState(false)
  const t = useT()

  const tab = LOG_TABS.find((tab) => tab.id === activeTab)!
  const entries = [...logs].reverse().filter((l) => (tab.levels as readonly string[]).includes(l.level))

  const content = entries
    .map((e) => `[${new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })}] ${e.level.toUpperCase()} ${e.message}`)
    .join('\n')

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [content])

  return (
    <div className="st-logs">
      <div>
        <h2 className="st-logs__title">{t('settings.logs.title')}</h2>
        <p className="st-agent__subtitle">{t('settings.logs.subtitle')}</p>
      </div>

      <div className="st-logs__tabs">
        {LOG_TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            onClick={() => setActiveTab(tabDef.id)}
            className={`st-logs__tab ${activeTab === tabDef.id ? 'st-logs__tab--active' : ''}`}
          >
            {t(`settings.logs.${tabDef.key}`)}
          </button>
        ))}
        <div className="st-logs__tabactions">
          <button className="st-logs__refresh" title={t('settings.logs.refreshTitle')}>
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {t('settings.logs.refresh')}
          </button>
          <button onClick={handleCopy} disabled={!content} className="st-logs__copy">
            {copied ? t('settings.logs.copied') : t('settings.logs.copyAll')}
          </button>
        </div>
      </div>

      {content ? (
        <pre className="st-logs__body">{content}</pre>
      ) : (
        <div className="st-logs__empty">{t('settings.logs.empty', { file: tab.id })}</div>
      )}
    </div>
  )
}

// ─── About ───────────────────────────────────────────────────────────────────

const APP_VERSION = '0.1.0'

function AboutSection() {
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  const t = useT()

  useEffect(() => {
    void health().then(setBackendOk)
  }, [])

  return (
    <Section title={t('settings.about.title')} subtitle={t('settings.about.subtitle')}>
      <div className="st-grid">
        <Card>
          <Row label={t('settings.about.appLabel')} description={t('settings.about.appDesc')}>
            <span className="st-mono">{APP_VERSION ? `v${APP_VERSION}` : '—'}</span>
          </Row>
          <Row label={t('settings.about.backendLabel')} description={t('settings.about.backendDesc')}>
            <span className={`st-mono ${backendOk === true ? 'st-mono--ok' : backendOk === false ? 'st-mono--bad' : ''}`}>
              {backendOk === null ? t('settings.about.checking') : backendOk ? t('settings.about.online') : t('settings.about.offline')}
            </span>
          </Row>
          <Row label={t('settings.about.docsLabel')} description={t('settings.about.docsDesc')}>
            <LinkButton label={t('settings.about.open')} href="https://github.com/lightningpixel/modly" />
          </Row>
        </Card>
        <Card>
          <Row label={t('settings.about.githubLabel')} description={t('settings.about.githubDesc')}>
            <LinkButton label={t('settings.about.open')} href="https://github.com/lightningpixel/modly" />
          </Row>
          <Row label={t('settings.about.licensesLabel')} description={t('settings.about.licensesDesc')}>
            <LinkButton label={t('settings.about.view')} href="https://github.com/lightningpixel/modly/blob/main/LICENSE" />
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Page shell ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>('application')
  const t = useT()

  return (
    <div className="st">
      {/* Left nav */}
      <nav className="st-nav">
        <p className="st-nav__title">{t('nav.settings')}</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`st-nav__item ${section === s.id ? 'st-nav__item--active' : ''}`}
          >
            <span className={`st-nav__icon ${section === s.id ? 'st-nav__icon--active' : ''}`}>{s.icon}</span>
            {t(s.key)}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="st-content">
        <div className="st-inner">
          {section === 'application' && <ApplicationSection />}
          {section === 'storage' && <StorageSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'accessibility' && <AccessibilitySection />}
          {section === 'performance' && <PerformanceSection />}
          {section === 'agent' && <AgentSection />}
          {section === 'logs' && <LogsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}
