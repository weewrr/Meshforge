import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelModelDownload,
  installExtension,
  installExtensionFromDir,
  installExtensionStatus,
  listExtensions,
  listModelStatus,
  pauseModelDownload,
  reloadExtensionsApi,
  startModelDownload,
  uninstallExtension,
  type InstallProgress,
  type ModelDownloadInfo
} from '../api'
import type { WorkflowExtension } from '../types'
import { useLogsStore } from '../stores/logs'
import { useAppStore } from '../stores/app'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { getT, useT } from '../i18n'
import { SegmentedControl } from '../components/ui'

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExtNode {
  id: string
  name: string
  input: string
  output: string
}

interface Ext {
  type: 'model' | 'process'
  id: string
  name: string
  version?: string
  description?: string
  author?: string
  trusted: boolean
  nodes: ExtNode[]
  loaded: boolean
  /** HF repo to download weights from (manifest model extensions). */
  hfRepo?: string
  hfSkipPrefixes?: string[]
  hfIncludePrefixes?: string[]
}

type FilterId = 'all' | 'process' | 'model' | 'official'
type SortId = 'name' | 'type'
type SourceId = 'github' | 'huggingface' | 'modelscope'

const SOURCES: { id: SourceId; tkey: string }[] = [
  { id: 'github', tkey: 'models.sourceGithub' },
  { id: 'huggingface', tkey: 'models.sourceHuggingFace' },
  { id: 'modelscope', tkey: 'models.sourceModelScope' }
]

const FILTERS: { id: FilterId; tkey: string }[] = [
  { id: 'all', tkey: 'models.filterAll' },
  { id: 'process', tkey: 'models.filterProcess' },
  { id: 'model', tkey: 'models.filterModel' },
  { id: 'official', tkey: 'models.filterOfficial' }
]

const SORTS: { id: SortId; tkey: string }[] = [
  { id: 'name', tkey: 'models.sortName' },
  { id: 'type', tkey: 'models.sortType' }
]

// Built-in extensions are "official" / trusted; manifest-installed ones are not.
const BUILTIN_IDS = new Set([
  'mock-relief', 'hunyuan3d-2-mini',
  'mesh-repair', 'mesh-smoother', 'mesh-remesher', 'mesh-optimizer', 'mesh-exporter'
])

function toExt(e: WorkflowExtension): Ext {
  const isModel = e.kind === 'model'
  return {
    type: e.kind,
    id: e.id,
    name: e.display_name,
    version: BUILTIN_IDS.has(e.id) ? '1.0.0' : undefined,
    description: isModel
      ? getT('models.descGenerator')
      : getT('models.descProcessTool'),
    author: 'meshforge',
    trusted: BUILTIN_IDS.has(e.id),
    nodes: [{ id: e.id, name: e.display_name, input: e.input, output: e.output }],
    loaded: true,
    hfRepo: e.hfRepo,
    hfSkipPrefixes: e.hfSkipPrefixes,
    hfIncludePrefixes: e.hfIncludePrefixes
  }
}

// ─── Small visual bits ───────────────────────────────────────────────────────

function TypePill({ type }: { type: 'model' | 'process' }) {
  const t = useT()
  return (
    <span className={`ex-pill ${type === 'process' ? 'ex-pill--process' : 'ex-pill--model'}`}>
      {type === 'process' ? t('models.typeProcess') : t('models.typeModel')}
    </span>
  )
}

function IOBadge({ node }: { node: ExtNode }) {
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

function StatusBadge({ tone, children }: { tone: 'green' | 'amber' | 'violet'; children: string }) {
  return (
    <span className={`ex-status ex-status--${tone}`}>
      <span className="ex-status__led" />
      {children}
    </span>
  )
}

const CUBE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="ex-icon">
    <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
    <path d="m3 7 9 5 9-5M12 12v10" />
  </svg>
)

const SPARK_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="ex-icon">
    <path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18" />
  </svg>
)

const SHIELD_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ex-icon">
    <path d="M12 3 5 6v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6l-7-3Z" />
    <path d="m9.3 11.5 1.8 1.8 3.6-3.6" />
  </svg>
)

const DOWNLOAD_ICON = (
  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M7 11l5 5 5-5M5 20h14" />
  </svg>
)

const CHECK_ICON = (
  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
)

const PAUSE_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)

const PLAY_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)

const X_ICON = (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

// ─── Per-extension weight download control ──────────────────────────────────
// Shown for model extensions that declare an HF repo. Mirrors Modly's
// NodeInstallControl: Install → progress bar + pause/cancel → Installed.

function NodeInstallControl({
  dl,
  installed,
  disabled,
  onInstall,
  onPause,
  onResume,
  onCancel
}: {
  dl: ModelDownloadInfo | undefined
  installed: boolean
  disabled?: boolean
  onInstall: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const t = useT()
  if (installed) {
    return (
      <span className="ex-dl ex-dl--installed">
        {CHECK_ICON}
        {t('models.installed')}
        {/* <span className="ex-dl__size">{sizeLabel}</span> */}
      </span>
    )
  }

  if (dl) {
    const paused = dl.paused ?? false
    const pct = Math.max(0, Math.min(100, dl.percent ?? 0))
    return (
      <span className="ex-dl">
        <span className="ex-dl__progress">
          <span className="ex-dl__bar">
            <span
              className={`ex-dl__fill ${paused ? 'ex-dl__fill--paused' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className={`ex-dl__pct ${paused ? 'ex-dl__pct--paused' : ''}`}>
            {paused ? t('models.paused') : `${pct}%`}
          </span>
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); paused ? onResume() : onPause() }}
          title={paused ? t('models.resumeDownload') : t('models.pauseDownload')}
          aria-label={paused ? t('models.resumeDownload') : t('models.pauseDownload')}
          className="ex-dl__btn"
        >
          {paused ? PLAY_ICON : PAUSE_ICON}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel() }}
          title={t('models.cancelDownload')}
          aria-label={t('models.cancelDownload')}
          className="ex-dl__btn ex-dl__btn--danger"
        >
          {X_ICON}
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onInstall() }}
      disabled={disabled}
      className="ex-dl__install"
    >
      {DOWNLOAD_ICON}
      {t('models.install')}
    </button>
  )
}

// ─── Extension card ─────────────────────────────────────────────────────────

function ExtensionCard({ ext, dl, installed, disabled, onOpen, onUninstall, onInstall, onPause, onResume, onCancel }: {
  ext: Ext
  dl: ModelDownloadInfo | undefined
  installed: boolean
  disabled?: boolean
  onOpen: (ext: Ext) => void
  onUninstall: (ext: Ext) => void
  onInstall: (ext: Ext) => void
  onPause: (ext: Ext) => void
  onResume: (ext: Ext) => void
  onCancel: (ext: Ext) => void
}) {
  const t = useT()
  const isModel = ext.type === 'model'

  const status = ext.loaded
    ? { tone: 'green' as const, text: isModel ? t('models.statusAllNodesReady') : t('models.statusReady') }
    : { tone: 'amber' as const, text: t('models.statusNotLoaded') }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(ext)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(ext) } }}
      aria-label={t('models.openDetails', { name: ext.name })}
      className="ex-card"
    >
      <div className="ex-card__head">
        <div className={`ex-card__icon ${isModel ? 'ex-card__icon--model' : ''}`}>
          {isModel ? SPARK_ICON : CUBE_ICON}
        </div>
        <div className="ex-card__titlewrap">
          <div className="ex-card__titlerow">
            <span className="ex-card__name">{ext.name}</span>
            <TypePill type={ext.type} />
          </div>
          <div className="ex-card__meta">
            {ext.version && <span className="ex-card__version">v{ext.version}</span>}
            {ext.version && ext.author && <span className="ex-card__sep">·</span>}
            {ext.author && <span>{ext.author}</span>}
            {ext.trusted && (
              <>
                <span className="ex-card__sep">·</span>
                <span className="ex-card__official">
                  {SHIELD_ICON}
                  {t('models.official')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="ex-card__desc">{ext.description?.trim() || '—'}</p>

      {ext.nodes.length > 0 && (
        <div className="ex-card__nodes">
          {ext.nodes.map((node) => (
            <div key={node.id} className="ex-card__node">
              <div className="ex-card__nodetext">
                <span className="ex-card__nodename">{node.name}</span>
                <IOBadge node={node} />
              </div>
              {ext.hfRepo && (
                <div className="ex-card__nodefoot">
                  <NodeInstallControl
                    dl={dl}
                    installed={installed}
                    disabled={disabled}
                    onInstall={() => onInstall(ext)}
                    onPause={() => onPause(ext)}
                    onResume={() => onResume(ext)}
                    onCancel={() => onCancel(ext)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="ex-card__foot">
        <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
      </div>
    </div>
  )
}

// ─── Detail drawer ──────────────────────────────────────────────────────────

function ExtensionDrawer({ ext, dl, installed, disabled, onClose, onUninstall, onInstall, onPause, onResume, onCancel }: {
  ext: Ext
  dl: ModelDownloadInfo | undefined
  installed: boolean
  disabled?: boolean
  onClose: () => void
  onUninstall: (ext: Ext) => void
  onInstall: (ext: Ext) => void
  onPause: (ext: Ext) => void
  onResume: (ext: Ext) => void
  onCancel: (ext: Ext) => void
}) {
  const t = useT()
  const isModel = ext.type === 'model'
  const trapRef = useFocusTrap(true, onClose)

  return (
    <>
      <div className="ex-drawer__overlay" onClick={onClose} />
      <aside ref={trapRef} role="dialog" aria-modal="true" aria-label={ext.name} className="ex-drawer">
        <div className="ex-drawer__head">
          <button onClick={onClose} title={t('models.close')} aria-label={t('models.close')} className="ex-drawer__close">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
          <div className="ex-drawer__titlewrap">
            <div className={`ex-drawer__icon ${isModel ? 'ex-card__icon--model' : ''}`}>
              {isModel ? SPARK_ICON : CUBE_ICON}
            </div>
            <div>
              <h3 className="ex-drawer__name">{ext.name}</h3>
              <div className="ex-drawer__metarow">
                <TypePill type={ext.type} />
                {ext.version && <span className="ex-card__version">v{ext.version}</span>}
                {ext.author && <span className="ex-drawer__author">{t('models.byAuthor', { author: ext.author })}</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="ex-drawer__body">
          <p className="ex-drawer__desc">{ext.description?.trim() || '—'}</p>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.identifier')}</p>
            <code className="ex-drawer__code">{ext.id}</code>
          </div>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.status')}</p>
            <StatusBadge tone={ext.loaded ? 'green' : 'amber'}>
              {ext.loaded ? t('models.loadedOnServer') : t('models.registeredNotLoaded')}
            </StatusBadge>
          </div>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.nodes')}</p>
            <div className="ex-drawer__nodes">
              {ext.nodes.map((node) => (
                <div key={node.id} className="ex-card__node">
                  <div className="ex-card__nodetext">
                    <span className="ex-card__nodename">{node.name}</span>
                    <IOBadge node={node} />
                  </div>
                  {ext.hfRepo && (
                    <div className="ex-card__nodefoot">
                      <NodeInstallControl
                        dl={dl}
                        installed={installed}
                        disabled={disabled}
                        onInstall={() => onInstall(ext)}
                        onPause={() => onPause(ext)}
                        onResume={() => onResume(ext)}
                        onCancel={() => onCancel(ext)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="ex-drawer__danger">
            <button className="ex-drawer__uninstall" onClick={() => onUninstall(ext)}>
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
              {t('models.uninstall')}
                </button>
          </div>
        </div>
      </aside>
    </>
  )
}

// ─── Install progress banner ──────────────────────────────────────────────────

function InstallProgressBar({ progress }: { progress: InstallProgress }) {
  const t = useT()
  const { step, percent, message } = progress
  return (
    <div className="ex-install">
      <div className="ex-install__row">
        <span className="ex-install__label">
          {step === 'downloading' && t('models.downloading', { pct: percent ?? 0 })}
          {step === 'extracting' && t('models.extracting')}
          {step === 'validating' && t('models.validating')}
          {step === 'setting_up' && (message || t('models.settingUp'))}
          {step === 'done' && t('models.installedDone')}
          {step === 'error' && t('models.installFailed')}
        </span>
        {step === 'setting_up' && <span className="ex-install__hint">{t('models.mayTakeAFewMinutes')}</span>}
      </div>
      <div className={`ex-install__bar ${step === 'setting_up' ? 'ex-install__bar--indet' : ''}`}>
        <div
          className="ex-install__fill"
          style={{ width: step === 'downloading' ? `${percent ?? 0}%` : step === 'extracting' || step === 'validating' ? '50%' : '100%' }}
        />
      </div>
      {step === 'error' && message && <p className="ex-install__err">{message}</p>}
    </div>
  )
}

// ─── Uninstall confirm modal ─────────────────────────────────────────────────

function UninstallModal({ ext, busy, error, onCancel, onConfirm }: {
  ext: Ext
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (ext: Ext) => void
}) {
  const t = useT()
  const trapRef = useFocusTrap(true, onCancel)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [busy, onCancel])

  return (
    <div className="ex-modal" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="ex-modal__overlay" />
      <div ref={trapRef as React.Ref<HTMLDivElement>} role="dialog" aria-modal="true" aria-label={t('models.uninstallAria', { name: ext.name })} className="ex-modal__card">
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const t = useT()
  const [extensions, setExtensions] = useState<Ext[]>([])
  const [loading, setLoading] = useState(true)

  // Search / filter / sort / drawer
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [sort, setSort] = useState<SortId>('name')
  const [sortOpen, setSortOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sortRef = useRef<HTMLDivElement>(null)

  // Install state (source selector / URL)
  const [source, setSource] = useState<SourceId>('github')
  const [showGHForm, setShowGHForm] = useState(false)
  const [ghUrl, setGhUrl] = useState('')
  const [ghErr, setGhErr] = useState<string | null>(null)
  const [ghOk, setGhOk] = useState(false)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const installPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Uninstall state
  const [uninstallTarget, setUninstallTarget] = useState<Ext | null>(null)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)

  // Model weight downloads (HF-backed model extensions)
  const hfToken = useAppStore((s) => s.hfToken)
  const [modelStatus, setModelStatus] = useState<Record<string, { downloaded: boolean; sizeBytes: number }>>({})
  const [downloading, setDownloading] = useState<Record<string, ModelDownloadInfo>>({})

  const log = useLogsStore((s) => s.log)

  const isInstalling = installProgress !== null &&
    installProgress.step !== 'done' &&
    installProgress.step !== 'error'

  // ── Poll install progress while an install is running ────────────────────
  useEffect(() => {
    if (!isInstalling) {
      if (installPollRef.current) {
        clearInterval(installPollRef.current)
        installPollRef.current = null
      }
      return
    }
    installPollRef.current = setInterval(async () => {
      const progress = await installExtensionStatus().catch(() => null)
      if (progress) setInstallProgress(progress)
      if (progress && (progress.step === 'done' || progress.step === 'error')) {
        if (progress.step === 'done') setGhOk(true)
        if (progress.step === 'error') setGhErr(progress.message ?? getT('models.installFailed'))
        setTimeout(() => { setGhOk(false); setShowGHForm(false); setGhUrl('') }, 1600)
        await refresh()
      }
    }, 500)
    return () => {
      if (installPollRef.current) { clearInterval(installPollRef.current); installPollRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInstalling])

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const extensions = await listExtensions()
      setExtensions(extensions.map(toExt))
    } catch {
      setExtensions([])
    } finally {
      setLoading(false)
    }
    void refreshModelStatus()
  }

  async function refreshModelStatus(): Promise<void> {
    const list = await listModelStatus()
    setModelStatus(
      Object.fromEntries(list.map((m) => [m.extId, { downloaded: m.downloaded, sizeBytes: m.sizeBytes }]))
    )
  }

  useEffect(() => { void refresh() }, [])

  // "/" focuses the search field
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Close the sort dropdown on outside click
  useEffect(() => {
    if (!sortOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortOpen])

  // ── GitHub extension install ────────────────────────────────────────────

  async function handleGHInstall(): Promise<void> {
    const url = ghUrl.trim()
    if (!url) { setGhErr(getT('models.errGhUrlRequired')); return }
    const expects: Record<SourceId, { host: (box: string) => boolean; err: string }> = {
      github: { host: (u: string) => u.includes('github.com'), err: getT('models.errNotGitHub') },
      huggingface: { host: (u: string) => u.includes('huggingface.co') || u.includes('hf.co'), err: getT('models.errNotHuggingFace') },
      modelscope: { host: (u: string) => u.includes('modelscope.cn'), err: getT('models.errNotModelScope') }
    }
    if (!expects[source].host(url)) { setGhErr(expects[source].err); return }
    setGhErr(null)
    setGhOk(false)
    try {
      const result = await installExtension(url)
      if (!result.ok) { setGhErr(result.message); return }
      log('info', getT('models.logInstall', { msg: result.message }))
      setInstallProgress({ step: 'downloading', percent: 0 })
    } catch (e) {
      setGhErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Local folder install (native directory dialog) ───────────────────────

  async function handleLocalInstall(): Promise<void> {
    // The old webkitdirectory <input type=file> froze/crashed this machine's
    // renderer (same root cause as the mesh/image pickers). Now the main
    // process opens a native folder dialog and the backend copies the tree.
    const picker = window.meshforge?.selectFolder
    if (!picker) {
      setGhErr(getT('models.errNativePicker'))
      return
    }
    const folder = await picker()
    if (!folder) return
    setGhErr(null)
    try {
      const result = await installExtensionFromDir(folder)
      if (!result.ok) { setGhErr(result.message); return }
      log('info', getT('models.logInstallLocal', { msg: result.message }))
      setGhOk(true)
      setTimeout(() => setGhOk(false), 1600)
      await refresh()
    } catch (e) {
      setGhErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Reload (re-scan server extensions dir) ──────────────────────────────

  async function handleReload(): Promise<void> {
    setLoading(true)
    const result = await reloadExtensionsApi()
    if (!result.ok) log('warn', getT('models.logReload', { msg: result.message }))
    await refresh()
  }

  // ── Model weight download (start / pause / resume / cancel) ────────────

  async function handleDownload(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    const id = ext.id
    setDownloading((prev) => ({ ...prev, [id]: { percent: 0, status: 'Starting…' } }))
    try {
      const last = await startModelDownload({
        id,
        repoId: ext.hfRepo,
        skipPrefixes: ext.hfSkipPrefixes,
        includePrefixes: ext.hfIncludePrefixes,
        token: hfToken || undefined,
        onEvent: (e) => setDownloading((prev) => ({ ...prev, [id]: e }))
      })
      if (last.cancelled) {
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
      } else if (last.error) {
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
        log('error', getT('models.logDownloadFailed', { err: last.error }))
      } else if (!last.paused) {
        // done
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
        log('info', getT('models.logDownloaded', { name: ext.name }))
      }
      // paused → keep the entry so the UI shows "Paused"; resume re-enters here.
      await refreshModelStatus()
    } catch (e) {
      setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
      log('error', getT('models.logDownloadError', { err: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function handlePause(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    await pauseModelDownload(ext.id).catch(() => undefined)
    setDownloading((prev) => {
      const cur = prev[ext.id]
      return cur ? { ...prev, [ext.id]: { ...cur, paused: true } } : prev
    })
  }

  function handleResume(ext: Ext): void {
    // .part files are kept server-side; a fresh stream resumes via Range.
    void handleDownload(ext)
  }

  async function handleCancel(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    await cancelModelDownload(ext.id).catch(() => undefined)
    setDownloading((prev) => { const next = { ...prev }; delete next[ext.id]; return next })
    await refreshModelStatus()
  }

  // ── Uninstall ───────────────────────────────────────────────────────────

  function openUninstallModal(ext: Ext): void {
    setUninstallError(null)
    setUninstallTarget(ext)
    setSelectedId((id) => (id === ext.id ? null : id))
  }

  async function handleUninstallConfirm(ext: Ext): Promise<void> {
    setUninstallBusy(true)
    setUninstallError(null)
    try {
      const result = await uninstallExtension(ext.id)
      if (!result.ok) {
        setUninstallError(result.message)
        return
      }
      log('info', getT('models.logUninstall', { msg: result.message }))
      setUninstallTarget(null)
      await refresh()
    } catch (e) {
      setUninstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setUninstallBusy(false)
    }
  }

  // ── Derived lists ────────────────────────────────────────────────────────

  const counts = useMemo(() => ({
    all: extensions.length,
    process: extensions.filter((e) => e.type === 'process').length,
    model: extensions.filter((e) => e.type === 'model').length,
    official: extensions.filter((e) => e.trusted).length
  }), [extensions])

  const filteredExtensions = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = extensions.filter((e) => {
      if (q) {
        const haystack = `${e.name} ${e.description ?? ''} ${e.author ?? ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (filter === 'process') return e.type === 'process'
      if (filter === 'model') return e.type === 'model'
      if (filter === 'official') return e.trusted
      return true
    })
    const sorters: Record<SortId, (a: Ext, b: Ext) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
    }
    return [...list].sort(sorters[sort])
  }, [extensions, search, filter, sort])

  const processList = filteredExtensions.filter((e) => e.type === 'process')
  const modelList = filteredExtensions.filter((e) => e.type === 'model')
  const grouped = filter === 'all' || filter === 'official'

  const selectedExt = selectedId ? extensions.find((e) => e.id === selectedId) ?? null : null

  const sourcePlaceholder: Record<SourceId, string> = {
    github: t('models.ghUrlPlaceholder'),
    huggingface: t('models.hfUrlPlaceholder'),
    modelscope: t('models.msUrlPlaceholder')
  }
  const sourceAria: Record<SourceId, string> = {
    github: t('models.ghUrlAria'),
    huggingface: t('models.hfUrlAria'),
    modelscope: t('models.msUrlAria')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ex">
      {/* Page head */}
      <div className="ex-head">
        <div>
          <h1 className="ex-head__title">{t('models.title')}</h1>
          <p className="ex-head__subtitle">
            {t('models.subtitle', { all: counts.all, process: counts.process, model: counts.model })}
          </p>
        </div>
        <div className="ex-head__actions">
          <button
            onClick={handleLocalInstall}
            disabled={isInstalling}
            title={t('models.linkFolderTitle')}
            className="ex-head__btn"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
            {t('models.linkFolder')}
          </button>
          <button
            onClick={() => { setShowGHForm((v) => !v); setGhErr(null); setGhOk(false) }}
            className="ex-head__btn"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            {showGHForm ? t('models.cancel') : t('models.installFromGitHub')}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="ex-toolbar">
        <label className="ex-search">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            aria-label={t('models.searchAria')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('models.searchPlaceholder')}
          />
          {search ? (
            <button onClick={() => setSearch('')} aria-label={t('models.clearSearch')} className="ex-search__clear">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : (
            <kbd className="ex-search__kbd">/</kbd>
          )}
        </label>

        <div className="ex-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={`ex-filters__btn ${filter === f.id ? 'ex-filters__btn--active' : ''}`}
            >
              {t(f.tkey)}
              <span className={`ex-filters__count ${filter === f.id ? 'ex-filters__count--active' : ''}`}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        <div className="ex-sort" ref={sortRef}>
          <button onClick={() => setSortOpen((o) => !o)} aria-haspopup="true" aria-expanded={sortOpen} aria-label={t('models.sortAria')} className="ex-sort__btn">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 5v14M7 19l-3-3M7 5l3 3M17 19V5M17 5l-3 3M17 19l3-3" />
            </svg>
            {t(SORTS.find((s) => s.id === sort)!.tkey)}
          </button>
          {sortOpen && (
            <div className="ex-sort__menu">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setSort(s.id); setSortOpen(false) }}
                  className={`ex-sort__option ${sort === s.id ? 'ex-sort__option--active' : ''}`}
                >
                  {t(s.tkey)}
                  {sort === s.id && (
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 12 4.5 4.5L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => void handleReload()}
          disabled={loading}
          title={t('models.reloadTitle')}
          aria-label={t('models.reloadAria')}
          className="ex-reload"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={loading ? 'ex-spin' : ''}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* Install from GitHub / HuggingFace / ModelScope */}
      {showGHForm && (
        <div className="ex-ghform">
          <div className="ex-ghform__box">
            <div className="ex-ghform__source">
              <span className="ex-ghform__sourcelabel">{t('models.installFromSource')}</span>
              <SegmentedControl
                value={source}
                onChange={(s) => { setSource(s); setGhErr(null); setGhOk(false) }}
                ariaLabel={t('models.installFromSource')}
                options={SOURCES.map((s) => ({ value: s.id, label: t(s.tkey) }))}
              />
            </div>
            <div className="ex-ghform__row">
              <input
                type="text"
                aria-label={sourceAria[source]}
                value={ghUrl}
                onChange={(e) => { setGhUrl(e.target.value); setGhErr(null); setGhOk(false) }}
                onKeyDown={(e) => e.key === 'Enter' && !isInstalling && void handleGHInstall()}
                placeholder={sourcePlaceholder[source]}
                autoFocus
                disabled={isInstalling}
              />
              <button
                onClick={() => void handleGHInstall()}
                disabled={!ghUrl.trim() || isInstalling}
                className="ex-ghform__submit"
              >
                {isInstalling ? (
                  <span className="ex-spinner" />
                ) : (
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                )}
                {isInstalling ? t('models.installing') : t('models.install')}
              </button>
            </div>

            {isInstalling && installProgress && <InstallProgressBar progress={installProgress} />}

            {ghOk && (
              <div className="ex-ghform__ok">
                <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <p>{t('models.installSucceeded')}</p>
              </div>
            )}

            {ghErr && (
              <div className="ex-ghform__err">
                <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p>{ghErr}</p>
              </div>
            )}

            <p className="ex-ghform__hint">
              {t('models.ghHintBefore')} <span className="mono">manifest.json</span> {t('models.ghHintAnd')} <span className="mono">generator.py</span> {t('models.ghHintAfter')}
            </p>
          </div>
        </div>
      )}

      {/* Extensions list */}
      <div className="ex-list">
        {extensions.length === 0 && !loading ? (
          <div className="ex-empty">
            <div className="ex-empty__icon">{CUBE_ICON}</div>
            <div className="ex-empty__text">
              <p className="ex-empty__title">{t('models.emptyTitle')}</p>
              <p className="ex-empty__sub">{t('models.emptySub')}</p>
            </div>
          </div>
        ) : loading ? (
          <div className="ex-loading">
            <span className="ex-spinner ex-spinner--lg" />
          </div>
        ) : filteredExtensions.length === 0 ? (
          <div className="ex-noresult">
            <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <p>{t('models.noMatch', { search })}</p>
          </div>
        ) : grouped ? (
          <>
            {processList.length > 0 && (
              <section className="ex-group">
                <div className="ex-group__head">
                  <span className="ex-group__icon ex-group__icon--process">{CUBE_ICON}</span>
                  <h2 className="ex-group__title">{t('models.groupProcessors')}</h2>
                  <span className="ex-group__count">{processList.length}</span>
                  <span className="ex-group__line" />
                </div>
                <div className="ex-grid">
                  {processList.map((ext) => (
                    <ExtensionCard
                      key={ext.id}
                      ext={ext}
                      dl={downloading[ext.id]}
                      installed={!!modelStatus[ext.id]?.downloaded}
                      disabled={isInstalling}
                      onOpen={(e) => setSelectedId(e.id)}
                      onUninstall={openUninstallModal}
                      onInstall={(e) => void handleDownload(e)}
                      onPause={(e) => void handlePause(e)}
                      onResume={(e) => handleResume(e)}
                      onCancel={(e) => void handleCancel(e)}
                    />
                  ))}
                </div>
              </section>
            )}
            {modelList.length > 0 && (
              <section className={`ex-group ${processList.length > 0 ? 'ex-group--spaced' : ''}`}>
                <div className="ex-group__head">
                  <span className="ex-group__icon ex-group__icon--model">{SPARK_ICON}</span>
                  <h2 className="ex-group__title">{t('models.groupModels')}</h2>
                  <span className="ex-group__count">{modelList.length}</span>
                  <span className="ex-group__line" />
                </div>
                <div className="ex-grid">
                  {modelList.map((ext) => (
                    <ExtensionCard
                      key={ext.id}
                      ext={ext}
                      dl={downloading[ext.id]}
                      installed={!!modelStatus[ext.id]?.downloaded}
                      disabled={isInstalling}
                      onOpen={(e) => setSelectedId(e.id)}
                      onUninstall={openUninstallModal}
                      onInstall={(e) => void handleDownload(e)}
                      onPause={(e) => void handlePause(e)}
                      onResume={(e) => handleResume(e)}
                      onCancel={(e) => void handleCancel(e)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="ex-grid">
            {filteredExtensions.map((ext) => (
              <ExtensionCard
                key={ext.id}
                ext={ext}
                dl={downloading[ext.id]}
                installed={!!modelStatus[ext.id]?.downloaded}
                disabled={isInstalling}
                onOpen={(e) => setSelectedId(e.id)}
                onUninstall={openUninstallModal}
                onInstall={(e) => void handleDownload(e)}
                onPause={(e) => void handlePause(e)}
                onResume={(e) => handleResume(e)}
                onCancel={(e) => void handleCancel(e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {selectedExt && (
        <ExtensionDrawer
          ext={selectedExt}
          dl={downloading[selectedExt.id]}
          installed={!!modelStatus[selectedExt.id]?.downloaded}
          disabled={isInstalling}
          onClose={() => setSelectedId(null)}
          onUninstall={openUninstallModal}
          onInstall={(e) => void handleDownload(e)}
          onPause={(e) => void handlePause(e)}
          onResume={(e) => handleResume(e)}
          onCancel={(e) => void handleCancel(e)}
        />
      )}

      {/* Confirm uninstall */}
      {uninstallTarget && (
        <UninstallModal
          ext={uninstallTarget}
          busy={uninstallBusy}
          error={uninstallError}
          onCancel={() => setUninstallTarget(null)}
          onConfirm={(ext) => void handleUninstallConfirm(ext)}
        />
      )}
    </div>
  )
}
