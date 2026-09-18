/**
 * 生成页工具栏与浮层小组件。
 *
 * 包括灯光/平滑/减面三个设置弹窗、运行时的进度 HUD、查看器加载失败兜底，
 * 以及顶部工具栏共用的小图标（`ChevronDown`/`Spinner`）与导出格式表。
 * 这些组件被 `GeneratePage` 拼装成生成页的交互层。
 */

import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from './preflight'
import { useT } from '../../i18n'
import { toast } from '../../stores/toasts'
import { DEFAULT_LIGHT, useSceneStore, type LightSettings } from '../../stores/scene'
import { useWorkflowRunStore } from '../../stores/workflowRun'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { WFNode } from '../../types'

// ─── 灯光弹窗 ───────────────────────────────────────────────────────────────

/** 灯光设置弹窗：调节环境光/主光/补光强度，含焦点陷阱与一键复位。 */
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

/** 平滑弹窗：设置网格平滑迭代次数（1~20），确认后执行平滑处理。 */
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

/** 减面弹窗：设置目标面数（≥100），实时显示相对当前网格的减面百分比。 */
export function DecimatePopover({ currentTriangles, decimating, onDecimate, onClose }: {
  currentTriangles: number | null
  decimating: boolean
  onDecimate: (targetFaces: number) => void
  onClose: () => void
}) {
  const t = useT()
  // 默认目标面数：有当前网格时取一半（典型减面幅度），否则兜底为 5000。
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

/** 运行时 HUD：展示当前节点、总进度、耗时与失败错误（含复制/重试），运行外不渲染。 */
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

  // 一次性 toast：失败弹错误提示（带重试），成功弹完成提示。用 ref 记录上一状态，
  // 只在状态发生"进入"时触发一次，避免每次渲染重复弹出。
  const prevState = useRef(runState)
  useEffect(() => {
    const prev = prevState.current
    prevState.current = runState
    if (prev === runState) return
    if (runState === 'failed' && lastError) {
      toast.error(t('generate.hud.failed'), {
        action: { label: t('generate.hud.retry'), onClick: reset },
      })
    } else if (runState === 'succeeded') {
      toast.success(t('generate.hud.succeeded'))
    }
  }, [runState, lastError, t, reset])

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
  // 启动初期（尚无节点完成、也未暂停）：模型加载通常发生在这一阶段，用阶段文案
  // 提示用户"排队/加载中"，而非笼统的"生成中"，减少冷启动时的等待焦虑。
  const booting = runState === 'running' && done === 0 && !activeNodeId

  return (
    <div className="gp-hud">
      <div className="gp-hud__card">
        {active && (
          <>
            <div className="gp-hud__top">
              <div className="gp-hud__label">
                <span className="gp-hud__dot" style={runState === 'paused' ? { background: '#facc15' } : undefined} />
                <span>{runState === 'paused' ? t('generate.hud.waitingInput') : (booting ? t('generate.hud.booting') : (activeLabel ?? t('generate.hud.generating')))}</span>
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

/** 查看器加载失败兜底：网格渲染失败时给出错误、清空与撤销当前网格的操作入口。 */
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

/** 下拉箭头小图标（工具栏/弹窗通用）。 */
export function ChevronDown() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

/** 加载转圈小图标（处理中状态通用）。 */
export function Spinner() {
  return (
    <svg aria-hidden="true" className="gp-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

/** 导出格式列表：每个格式附带其 i18n 描述 key，供导出菜单渲染。 */
export const EXPORT_FORMATS = [
  { fmt: 'glb' as const, descKey: 'generate.export.formatGlb' },
  { fmt: 'obj' as const, descKey: 'generate.export.formatObj' },
  { fmt: 'stl' as const, descKey: 'generate.export.formatStl' },
  { fmt: 'ply' as const, descKey: 'generate.export.formatPly' }
]
