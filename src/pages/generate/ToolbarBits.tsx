import { useEffect, useState } from 'react'
import { formatElapsed } from './preflight'
import { useT } from '../../i18n'
import { DEFAULT_LIGHT, useSceneStore, type LightSettings } from '../../stores/scene'
import { useWorkflowRunStore } from '../../stores/workflowRun'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { WFNode } from '../../types'

// ─── 灯光弹窗 ───────────────────────────────────────────────────────────────

export function LightPopover({ settings, onChange, onClose }: {
  settings: LightSettings
  onChange: (patch: Partial<LightSettings>) => void
  onClose: () => void
}) {
  const t = useT()
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  function row(label: string, key: keyof LightSettings, max: number) {
    const value = settings[key]
    return (
      <div className="gp-light__row" key={key}>
        <div className="gp-light__labelrow">
          <span>{label}</span>
          <span className="gp-light__value">{value.toFixed(2)}</span>
        </div>
        <input
          type="range"
          aria-label={label}
          min={0}
          max={max}
          step={0.05}
          value={value}
          onChange={(e) => onChange({ [key]: parseFloat(e.target.value) } as Partial<LightSettings>)}
        />
      </div>
    )
  }

  return (
    <div ref={trapRef} className="gp-pop">
      <div className="gp-pop__head">
        <p className="gp-pop__title">{t('generate.light.title')}</p>
        <button className="gp-pop__reset" onClick={() => onChange(DEFAULT_LIGHT)}>{t('generate.light.reset')}</button>
      </div>
      {row(t('generate.light.ambient'), 'ambient', 1.5)}
      {row(t('generate.light.sun'), 'main', 4)}
      {row(t('generate.light.fill'), 'fill', 2)}
      <button className="gp-pop__close" onClick={onClose}>{t('generate.common.close')}</button>
    </div>
  )
}

// ─── Smooth / Decimate 弹窗 ─────────────────────────────────────────────────

export function SmoothPopover({ smoothing, onSmooth, onClose }: {
  smoothing: boolean
  onSmooth: (iterations: number) => void
  onClose: () => void
}) {
  const t = useT()
  const [inputValue, setInputValue] = useState('3')
  const parsed = parseInt(inputValue, 10)
  const valid = !isNaN(parsed) && parsed >= 1 && parsed <= 20

  return (
    <div className="gp-pop gp-pop--left">
      <p className="gp-pop__title">{t('generate.smooth.popupTitle')}</p>
      <div className="gp-pop__field">
        <label className="gp-pop__fieldlabel" htmlFor="gp-smooth-iterations">{t('generate.smooth.iterationsLabel')}</label>
        <input id="gp-smooth-iterations" type="number" min={1} max={20} step={1} value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
        <p className="gp-pop__fieldhint">{t('generate.smooth.iterationsHint')}</p>
      </div>
      <div className="gp-pop__actions">
        <button className="gp-pop__cancel" onClick={onClose}>{t('generate.common.cancel')}</button>
        <button className="gp-pop__apply" disabled={smoothing || !valid} onClick={() => valid && onSmooth(parsed)}>
          {smoothing ? t('generate.common.processing') : t('generate.common.apply')}
        </button>
      </div>
    </div>
  )
}

export function DecimatePopover({ currentTriangles, decimating, onDecimate, onClose }: {
  currentTriangles: number | null
  decimating: boolean
  onDecimate: (targetFaces: number) => void
  onClose: () => void
}) {
  const t = useT()
  const defaultTarget = currentTriangles ? Math.round(currentTriangles * 0.5) : 5000
  const [inputValue, setInputValue] = useState(String(defaultTarget))
  const parsed = parseInt(inputValue, 10)
  const validTarget = !isNaN(parsed) && parsed >= 100 ? parsed : null
  const reduction =
    currentTriangles && validTarget
      ? Math.round((1 - Math.min(validTarget, currentTriangles) / currentTriangles) * 100)
      : null

  return (
    <div className="gp-pop gp-pop--left">
      <p className="gp-pop__title">{t('generate.decimate.popupTitle')}</p>
      {currentTriangles && (
        <p className="gp-pop__fieldhint">{t('generate.decimate.currentTri', { current: currentTriangles.toLocaleString() })}</p>
      )}
      <div className="gp-pop__field">
        <label className="gp-pop__fieldlabel" htmlFor="gp-decimate-faces">{t('generate.decimate.targetFaces')}</label>
        <input id="gp-decimate-faces" type="number" min={100} step={500} value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
        {reduction !== null && (
          <p className="gp-pop__fieldhint">{t('generate.decimate.reduction')} <span className="gp-pop__accent">{reduction}%</span></p>
        )}
      </div>
      <div className="gp-pop__actions">
        <button className="gp-pop__cancel" onClick={onClose}>{t('generate.common.cancel')}</button>
        <button className="gp-pop__apply" disabled={decimating || !validTarget} onClick={() => validTarget && onDecimate(validTarget)}>
          {decimating ? t('generate.common.processing') : t('generate.common.apply')}
        </button>
      </div>
    </div>
  )
}

// ─── HUD 浮层（进度/耗时/错误） ──────────────────────────────────────────────

export function GenerationHUD({ nodes }: { nodes: WFNode[] }) {
  const t = useT()
  const runState = useWorkflowRunStore((s) => s.runState)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const nodeStates = useWorkflowRunStore((s) => s.nodeStates)
  const lastError = useWorkflowRunStore((s) => s.lastError)
  const startedAt = useWorkflowRunStore((s) => s.startedAt)
  const reset = useWorkflowRunStore((s) => s.reset)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)

  const active = runState === 'running' || runState === 'paused'
  const visible = active || runState === 'failed'

  useEffect(() => {
    if (active && startedAt) {
      const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
      return () => clearInterval(id)
    }
    setElapsed(0)
  }, [active, startedAt])

  if (!visible) return null

  const activeLabel = nodes.find((n) => n.id === activeNodeId)?.data.label
  const done = nodes.filter((n) => nodeStates[n.id] === 'succeeded').length
  const overall = nodes.length > 0 ? Math.round((done / nodes.length) * 100) : 0

  return (
    <div className="gp-hud">
      <div className="gp-hud__card">
        {active && (
          <>
            <div className="gp-hud__top">
              <div className="gp-hud__label">
                <span className="gp-hud__dot" style={runState === 'paused' ? { background: '#facc15' } : undefined} />
                <span>{runState === 'paused' ? t('generate.hud.waitingInput') : (activeLabel ?? t('generate.hud.generating'))}</span>
              </div>
              <span className="gp-hud__time">{formatElapsed(elapsed)}</span>
            </div>
            <div className="gp-hud__bar">
              <div className="gp-hud__fill" style={{ width: `${overall}%` }} />
            </div>
            <div className="gp-hud__sub">
              <span>{runState === 'paused' ? t('generate.hud.pausedHint') : t('generate.hud.nodesDone', { done, total: nodes.length })}</span>
              <span className="gp-hud__pct">{overall}%</span>
            </div>
          </>
        )}
        {runState === 'failed' && (
          <>
            <div className="gp-hud__errorhead">
              <span className="gp-hud__erroricon">
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </span>
              <span>{t('generate.hud.failed')}</span>
            </div>
            <pre className="gp-hud__errortext">{lastError}</pre>
            <div className="gp-hud__actions">
              <button className="gp-hud__retry" onClick={reset}>{t('generate.hud.retry')}</button>
              {lastError && (
                <button
                  className="gp-hud__copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastError)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? t('generate.hud.copied') : t('generate.hud.copy')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Viewer 加载失败兜底 ────────────────────────────────────────────────────

export function ViewerLoadError({ error }: { error: Error }) {
  const t = useT()
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const setMesh = useSceneStore((s) => s.setMesh)
  const canUndo = useSceneStore((s) => s.historyIndex > 0)
  return (
    <div className="gp-viewer__empty eb-viewer">
      <svg className="eb-app__icon" aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        <line x1="12" y1="12" x2="12" y2="16" />
      </svg>
      <span className="eb-viewer__title">{t('generate.viewer.failedToLoad')}</span>
      <span className="eb-viewer__msg">
        {t('generate.viewer.errorMsg', { msg: error.message || String(error) })}
      </span>
      <div className="eb-viewer__actions">
        <button className="eb-btn" onClick={() => setMesh(null)}>{t('generate.viewer.clearModel')}</button>
        {canUndo && (
          <button className="eb-btn eb-btn--primary" onClick={undoMesh}>{t('generate.viewer.undo')}</button>
        )}
      </div>
    </div>
  )
}

// 顶部工具栏小组件

export function ChevronDown() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export function Spinner() {
  return (
    <svg aria-hidden="true" className="gp-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

export const EXPORT_FORMATS = [
  { fmt: 'glb' as const, descKey: 'generate.export.formatGlb' },
  { fmt: 'obj' as const, descKey: 'generate.export.formatObj' },
  { fmt: 'stl' as const, descKey: 'generate.export.formatStl' },
  { fmt: 'ply' as const, descKey: 'generate.export.formatPly' }
]
