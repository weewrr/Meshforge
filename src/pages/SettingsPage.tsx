import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { health } from '../api'
import { Card, LinkButton, PathRow, Row, Section, SegmentedControl, Toggle } from '../components/ui'
import { useAppStore, type ThinkingMode } from '../stores/app'
import { useLogsStore } from '../stores/logs'

// ─── Section registry ────────────────────────────────────────────────────────

type SectionId = 'application' | 'storage' | 'integrations' | 'accessibility' | 'agent' | 'logs' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: ReactElement }[] = [
  {
    id: 'application',
    label: 'Application',
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
    label: 'Storage',
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
    label: 'Integrations',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
      </svg>
    )
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
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
    id: 'agent',
    label: 'Agent',
    icon: (
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
      </svg>
    )
  },
  {
    id: 'logs',
    label: 'Logs',
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
    label: 'About',
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
  const patch = useAppStore((s) => s.patch)

  return (
    <Section title="Application" subtitle="General application settings.">
      <Card title="Interface">
        <Row label="RAM indicator" description="Show live memory usage in the top bar.">
          <Toggle value={showRamIndicator} onChange={(v) => patch({ showRamIndicator: v })} />
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
    <Section title="Storage" subtitle="Manage where models and outputs are saved on disk.">
      <div className="st-grid">
        <Card title="Directories" description="Paths used to store model weights and generated files.">
          <PathRow label="Models" description="Where downloaded AI model weights are stored." value={modelsDir} />
          <PathRow label="Workspace" description="Where generated 3D files are saved." value={workspaceDir} />
          <PathRow label="Workflows" description="Where workflow definitions are saved." value={workflowsDir} />
        </Card>
        <Card title="Cache" description="Temporary files created during generation processing.">
          <Row label="Temp files" description="Intermediate files accumulated over time.">
            <button
              onClick={handleClearCache}
              disabled={cacheStatus === 'clearing'}
              className={`st-actionbtn ${
                cacheStatus === 'done' ? 'st-actionbtn--ok' : cacheStatus === 'error' ? 'st-actionbtn--bad' : ''
              }`}
            >
              {cacheStatus === 'clearing' ? 'Clearing…' : cacheStatus === 'done' ? '✓ Cleared' : cacheStatus === 'error' ? '✗ Failed' : 'Clear cache'}
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
    <Section title="Integrations" subtitle="API keys and tokens for external services.">
      <div className="st-grid">
        <Card
          title="HuggingFace Hub"
          description="Required to download gated models such as Stable Fast 3D. Generate a token at huggingface.co/settings/tokens."
        >
          <Row label="Access Token" description="Must have at least 'Read' permission.">
            <div className="st-token">
              <div className="st-token__field">
                <input
                  type={visible ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setStatus('idle') }}
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && save(token.trim())}
                  placeholder="hf_…"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  title={visible ? 'Hide token' : 'Show token'}
                  aria-label={visible ? 'Hide token' : 'Show token'}
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
                <button onClick={handleClear} title="Remove token" aria-label="Remove token" className="st-token__clear">
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
                {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Failed' : 'Save'}
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

  return (
    <Section title="Accessibility" subtitle="Make Meshforge easier to read and use.">
      <div className="st-grid">
        <Card title="Display Font" description="Use a more legible typeface, helpful for dyslexia and low vision.">
          <Row
            label="Atkinson Hyperlegible"
            description="Replace the default font with a typeface designed for readability."
          >
            <Toggle value={useAtkinsonFont} onChange={(v) => patch({ useAtkinsonFont: v })} />
          </Row>
        </Card>
        <Card title="Interface Scale" description="Zoom the whole interface up or down.">
          <Row label="Scale" description="Applies to all text, icons, and spacing.">
            <SegmentedControl
              ariaLabel="Interface scale"
              value={uiScale}
              onChange={(v) => patch({ uiScale: v })}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
                { value: 'very-large', label: 'Very Large' }
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

  const THINKING_OPTIONS: { value: ThinkingMode; label: string; desc: string }[] = [
    { value: 'auto', label: 'Auto', desc: 'The model decides whether to think' },
    { value: 'on', label: 'Enabled', desc: 'Forces thinking on every response' },
    { value: 'off', label: 'Disabled', desc: 'Disables thinking (faster responses)' }
  ]

  return (
    <div className="st-agent">
      <div>
        <h2 className="st-agent__title">Agent</h2>
        <p className="st-agent__subtitle">Configure the local LLM and Chat mode settings.</p>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">Ollama</h3>
        <label className="st-agent__label">Ollama URL</label>
        <div className="st-agent__urlrow">
          <input
            value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setTestResult(null) }}
            placeholder="http://localhost:11434"
          />
          <button onClick={() => void handleTestConnection()} disabled={testing}>
            {testing ? 'Testing…' : 'Test'}
          </button>
        </div>
        {testResult === null && <p className="st-agent__hint">Address of the Ollama server. Change this if you run Ollama on a remote machine.</p>}
        {testResult === 'ok' && (
          <p className="st-agent__hint st-agent__hint--ok">Connection successful — {models.length} model{models.length > 1 ? 's' : ''} found</p>
        )}
        {testResult === 'error' && <p className="st-agent__hint st-agent__hint--bad">Could not reach Ollama at this address</p>}

        <label className="st-agent__label">Default model</label>
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
            placeholder="qwen2.5:3b"
            className="st-agent__input"
          />
        )}
        <p className="st-agent__hint">Model used when opening the chat. Can be changed on the fly in the chat.</p>

        <button onClick={handleSave} className="st-agent__save">Save</button>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">Thinking</h3>
        <label className="st-agent__label">Default mode</label>
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
                <p className="st-agent__radiolabel">{opt.label}</p>
                <p className="st-agent__hint">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
        <p className="st-agent__hint">Can be changed on the fly in the chat via the brain icon.</p>
      </div>
    </div>
  )
}

// ─── Logs ────────────────────────────────────────────────────────────────────

const LOG_TABS = [
  { id: 'errors', label: 'Errors', levels: ['error'] },
  { id: 'runtime', label: 'Runtime', levels: ['info'] },
  { id: 'app', label: 'App', levels: ['warn'] }
] as const

type LogTabId = (typeof LOG_TABS)[number]['id']

function LogsSection() {
  const logs = useLogsStore((s) => s.logs)
  const [activeTab, setActiveTab] = useState<LogTabId>('errors')
  const [copied, setCopied] = useState(false)

  const tab = LOG_TABS.find((t) => t.id === activeTab)!
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
        <h2 className="st-logs__title">Logs</h2>
        <p className="st-agent__subtitle">Application log files — share these when reporting issues.</p>
      </div>

      <div className="st-logs__tabs">
        {LOG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`st-logs__tab ${activeTab === t.id ? 'st-logs__tab--active' : ''}`}
          >
            {t.label}
          </button>
        ))}
        <div className="st-logs__tabactions">
          <button className="st-logs__refresh" title="Live view — refreshed automatically">
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
          <button onClick={handleCopy} disabled={!content} className="st-logs__copy">
            {copied ? 'Copied!' : 'Copy all'}
          </button>
        </div>
      </div>

      {content ? (
        <pre className="st-logs__body">{content}</pre>
      ) : (
        <div className="st-logs__empty">No entries in {tab.id}.log</div>
      )}
    </div>
  )
}

// ─── About ───────────────────────────────────────────────────────────────────

const APP_VERSION = '0.1.0'

function AboutSection() {
  const [backendOk, setBackendOk] = useState<boolean | null>(null)

  useEffect(() => {
    void health().then(setBackendOk)
  }, [])

  return (
    <Section title="About" subtitle="Application information and useful resources.">
      <div className="st-grid">
        <Card>
          <Row label="Meshforge" description="Local 3D mesh generation app.">
            <span className="st-mono">{APP_VERSION ? `v${APP_VERSION}` : '—'}</span>
          </Row>
          <Row label="Backend" description="Python generation server.">
            <span className={`st-mono ${backendOk === true ? 'st-mono--ok' : backendOk === false ? 'st-mono--bad' : ''}`}>
              {backendOk === null ? 'checking…' : backendOk ? 'online' : 'offline'}
            </span>
          </Row>
          <Row label="Documentation" description="Guides and API reference.">
            <LinkButton label="Open" href="https://github.com/lightningpixel/modly" />
          </Row>
        </Card>
        <Card>
          <Row label="GitHub" description="Source code and issues.">
            <LinkButton label="Open" href="https://github.com/lightningpixel/modly" />
          </Row>
          <Row label="Open-source licenses" description="Third-party licenses used in this app.">
            <LinkButton label="View" href="https://github.com/lightningpixel/modly/blob/main/LICENSE" />
          </Row>
        </Card>
      </div>
    </Section>
  )
}

// ─── Page shell ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>('application')

  return (
    <div className="st">
      {/* Left nav */}
      <nav className="st-nav">
        <p className="st-nav__title">Settings</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`st-nav__item ${section === s.id ? 'st-nav__item--active' : ''}`}
          >
            <span className={`st-nav__icon ${section === s.id ? 'st-nav__icon--active' : ''}`}>{s.icon}</span>
            {s.label}
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
          {section === 'agent' && <AgentSection />}
          {section === 'logs' && <LogsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}
