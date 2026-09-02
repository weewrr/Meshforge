import { useCallback, useEffect, useRef, useState } from 'react'
import { fullUrl, getJob, getWorkflow, listLibrary, processMesh, saveWorkflow, uploadFile } from '../api'
import Viewer3D from '../components/Viewer3D'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useLogsStore } from '../stores/logs'
import { useNavigationStore } from '../stores/navigation'
import { DEFAULT_LIGHT, useSceneStore, type LightSettings } from '../stores/scene'
import { topoSort, useWorkflowRunStore } from '../stores/workflowRun'
import { useWorkflowsStore } from '../stores/workflows'
import type { WFEdge, WFNode, Workflow, WorkflowMeta } from '../types'
import ChatPanel from './generate/ChatPanel'
import {
  LIBRARY_SORT_OPTIONS,
  describeOpenability,
  filterScopeGroups,
  getDefaultCollapsedSectionKeys,
  isOpenable,
  toggleSectionKey,
  type LibraryEntry,
  type LibrarySortMode
} from './generate/assetLibrary'

const MIN_WIDTH = 220
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 320

type OpenPanel =
  | 'import' | 'library' | 'export' | 'smooth' | 'decimate' | 'light' | null

// ─── 工具函数 ───────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** 运行前 preflight：与运行引擎同一套规则，返回第一条问题（无则 null）。 */
function firstPreflightIssue(nodes: WFNode[], edges: WFEdge[]): string | null {
  for (const node of nodes) {
    const label = node.data.label
    const hasIncoming = edges.some((e) => e.target === node.id)
    const params = node.data.params
    if (node.type === 'imageNode' && !params.url) return `${label}: 未选择图片`
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') !== 'current' &&
      !params.url
    ) {
      return `${label}: 未选择网格文件`
    }
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') === 'current' &&
      !useSceneStore.getState().meshUrl
    ) {
      return `${label}: 3D 查看器中没有当前模型`
    }
    if (node.type === 'generatorNode' && !params.generatorId) return `${label}: 未选择生成器`
    if (node.type === 'generatorNode' && !hasIncoming) return `${label}: 需要上游图片连接`
    if (
      (node.type === 'previewNode' || node.type === 'outputNode' || node.type === 'waitNode') &&
      !hasIncoming
    ) {
      return `${label}: 缺少输入连接`
    }
  }
  return null
}

// ─── 工作流下拉 ────────────────────────────────────────────────────────────

function WorkflowDropdown({ workflows, value, onChange, disabled }: {
  workflows: WorkflowMeta[]
  value: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
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
    return <div className="gp-dropdown__empty">No workflows yet</div>
  }

  return (
    <div className="gp-dropdown" ref={ref}>
      <button
        className={`gp-dropdown__btn ${open ? 'gp-dropdown__btn--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <span className="gp-dropdown__label">{selected?.name ?? 'Select a workflow…'}</span>
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`gp-dropdown__chevron ${open ? 'gp-dropdown__chevron--open' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="gp-dropdown__list">
          {workflows.map((wf, i) => (
            <button
              key={wf.id}
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

// ─── 参数行（节点卡片） ─────────────────────────────────────────────────────

type PatchFn = (nodeId: string, patch: Record<string, unknown>) => void

function ImageParamRow({ node, onPatch }: { node: WFNode; onPatch: PatchFn }) {
  const url = String(node.data.params.url ?? '')
  const [busy, setBusy] = useState(false)

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return
    setBusy(true)
    try {
      const { url: uploaded, fileName } = await uploadFile(file)
      onPatch(node.id, { url: uploaded, fileName })
    } finally {
      setBusy(false)
    }
  }

  // Imperative file input — see openMeshPicker() in the page component.
  function pickFromDisk(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => { void pick(input.files?.[0]) }
    input.click()
  }

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span>Image</span>
      </div>
      {url ? (
        <button className="gp-image" onClick={pickFromDisk} disabled={busy}>
          <img src={fullUrl(url)} alt="" />
          <span className="gp-image__change">{busy ? 'Uploading…' : 'Change…'}</span>
        </button>
      ) : (
        <button className="gp-image gp-image--empty" onClick={pickFromDisk} disabled={busy}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>{busy ? 'Uploading…' : 'Browse image…'}</span>
        </button>
      )}
    </div>
  )
}

function TextParamRow({ node, onPatch }: { node: WFNode; onPatch: PatchFn }) {
  const text = String(node.data.params.text ?? '')
  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
          <path d="M17 6.1H3M21 12.1H3M15.1 18H3" />
        </svg>
        <span>Text</span>
      </div>
      <textarea
        className="gp-textarea"
        value={text}
        rows={3}
        placeholder="Enter text…"
        onChange={(e) => onPatch(node.id, { text: e.target.value })}
      />
    </div>
  )
}

function MeshParamRow({ node, onPatch }: { node: WFNode; onPatch: PatchFn }) {
  const url = String(node.data.params.url ?? '')
  const fileName = String(node.data.params.fileName ?? '')
  const [busy, setBusy] = useState(false)

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return
    setBusy(true)
    try {
      const { url: uploaded, fileName: name } = await uploadFile(file)
      onPatch(node.id, { url: uploaded, fileName: name })
    } finally {
      setBusy(false)
    }
  }

  // Imperative file input — see openMeshPicker() in the page component.
  function pickFromDisk(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.glb,.gltf'
    input.onchange = () => { void pick(input.files?.[0]) }
    input.click()
  }

  const source = String(node.data.params.source ?? 'file') === 'current' ? 'current' : 'file'

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <span>Load 3D Mesh</span>
      </div>

      {/* Toggle: use current model */}
      <button
        className={`gp-toggle ${source === 'current' ? 'gp-toggle--on' : ''}`}
        onClick={() => onPatch(node.id, { source: source === 'current' ? 'file' : 'current' })}
      >
        <span className="gp-toggle__knob" />
        <span className="gp-toggle__text">Use current model</span>
      </button>

      {source === 'file' ? (
        <>
          {url ? (
            <button className="gp-file" onClick={pickFromDisk} disabled={busy}>
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="gp-file__name">{fileName}</span>
              <span className="gp-file__change">{busy ? '…' : 'Change…'}</span>
            </button>
          ) : (
            <button className="gp-file gp-file--empty" onClick={pickFromDisk} disabled={busy}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>{busy ? 'Uploading…' : 'Browse mesh…'}</span>
            </button>
          )}
        </>
      ) : (
        <div className="gp-file__hint">Uses the model currently loaded in the 3D viewer</div>
      )}
    </div>
  )
}

function WaitParamRow({ nodeId }: { nodeId: string }) {
  const nodeState = useWorkflowRunStore((s) => s.nodeStates[nodeId])
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const waiting = nodeState === 'waiting'

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
        <span>Wait</span>
      </div>
      {waiting ? (
        <button className="gp-continue" onClick={continueRun}>
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Continue
        </button>
      ) : (
        <p className="gp-hint">Pauses the workflow until you click Continue.</p>
      )}
    </div>
  )
}

function GeneratorParamRow({ node }: { node: WFNode }) {
  const nodeState = useWorkflowRunStore((s) => s.nodeStates[node.id])
  const progress = useWorkflowRunStore((s) => s.nodeProgress[node.id] ?? 0)
  const generatorId = String(node.data.params.generatorId ?? '')

  return (
    <div className="gp-row__body">
      <div className="gp-ext">
        <div className="gp-ext__info">
          <p className="gp-ext__name">{node.data.label}</p>
          <div className="gp-ext__types">
            <span style={{ color: '#38bdf8' }}>image</span>
            <svg aria-hidden="true" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
            <span style={{ color: '#a78bfa' }}>mesh</span>
          </div>
        </div>
        {generatorId && <span className="gp-ext__id">{generatorId}</span>}
      </div>
      {nodeState === 'running' && (
        <div className="gp-gen__progress">
          <div className="gp-gen__bar"><div className="gp-gen__fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="gp-gen__pct">{Math.round(progress * 100)}%</span>
        </div>
      )}
    </div>
  )
}

// ─── 灯光弹窗 ───────────────────────────────────────────────────────────────

function LightPopover({ settings, onChange, onClose }: {
  settings: LightSettings
  onChange: (patch: Partial<LightSettings>) => void
  onClose: () => void
}) {
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
        <p className="gp-pop__title">Lighting</p>
        <button className="gp-pop__reset" onClick={() => onChange(DEFAULT_LIGHT)}>Reset</button>
      </div>
      {row('Ambient', 'ambient', 1.5)}
      {row('Sun', 'main', 4)}
      {row('Fill', 'fill', 2)}
      <button className="gp-pop__close" onClick={onClose}>Close</button>
    </div>
  )
}

// ─── HUD 浮层（进度/耗时/错误） ──────────────────────────────────────────────

function GenerationHUD({ nodes }: { nodes: WFNode[] }) {
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
                <span className="gp-hud__dot" style={runState === 'paused' ? { background: '#fbbf24' } : undefined} />
                <span>{runState === 'paused' ? 'Waiting for input' : (activeLabel ?? 'Generating 3D mesh…')}</span>
              </div>
              <span className="gp-hud__time">{formatElapsed(elapsed)}</span>
            </div>
            <div className="gp-hud__bar">
              <div className="gp-hud__fill" style={{ width: `${overall}%` }} />
            </div>
            <div className="gp-hud__sub">
              <span>{runState === 'paused' ? 'Click Continue on the Wait node' : `${done}/${nodes.length} nodes`}</span>
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
              <span>Generation failed</span>
            </div>
            <pre className="gp-hud__errortext">{lastError}</pre>
            <div className="gp-hud__actions">
              <button className="gp-hud__retry" onClick={reset}>Try again</button>
              {lastError && (
                <button
                  className="gp-hud__copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastError)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── 顶部工具栏小组件 ───────────────────────────────────────────────────────

function ChevronDown() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg aria-hidden="true" className="gp-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

const EXPORT_FORMATS = [
  { fmt: 'glb' as const, desc: 'Binary glTF' },
  { fmt: 'obj' as const, desc: 'Wavefront' },
  { fmt: 'stl' as const, desc: '3D Print' },
  { fmt: 'ply' as const, desc: 'Polygon File' }
]

// ─── 主页面 ────────────────────────────────────────────────────────────────

export default function GeneratePage() {
  const go = useNavigationStore((s) => s.go)
  const workflows = useWorkflowsStore((s) => s.workflows)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const loadList = useWorkflowsStore((s) => s.loadList)
  const selectInStore = useWorkflowsStore((s) => s.select)

  const meshUrl = useSceneStore((s) => s.meshUrl)
  const pushMeshUrl = useSceneStore((s) => s.pushMeshUrl)
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const redoMesh = useSceneStore((s) => s.redoMesh)
  const canUndoMesh = useSceneStore((s) => s.historyIndex > 0)
  const canRedoMesh = useSceneStore((s) => s.historyIndex < s.meshHistory.length - 1)
  const meshStats = useSceneStore((s) => s.meshStats)
  const meshSelected = useSceneStore((s) => s.meshSelected)
  const gizmoMode = useSceneStore((s) => s.gizmoMode)
  const setGizmoMode = useSceneStore((s) => s.setGizmoMode)
  const light = useSceneStore((s) => s.lightSettings)
  const setLight = useSceneStore((s) => s.setLight)

  const runState = useWorkflowRunStore((s) => s.runState)
  const run = useWorkflowRunStore((s) => s.run)
  const cancel = useWorkflowRunStore((s) => s.cancel)

  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const [selectedId, setSelectedId] = useState('')
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [nodes, setNodes] = useState<WFNode[]>([])
  const [edges, setEdges] = useState<WFEdge[]>([])
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [mode, setMode] = useState<'basic' | 'chat'>('basic')
  const [unloadStatus, setUnloadStatus] = useState<'idle' | 'done'>('idle')
  const [importing, setImporting] = useState(false)
  const [decimating, setDecimating] = useState(false)
  const [smoothing, setSmoothing] = useState(false)
  const [exporting, setExporting] = useState<'glb' | 'obj' | 'stl' | 'ply' | null>(null)
  const dragging = useRef(false)

  // Library（workspace 资产库）状态
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([])
  const [librarySelectedId, setLibrarySelectedId] = useState<string | null>(null)
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [librarySearch, setLibrarySearch] = useState('')
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>('type')
  const [libraryCollapsed, setLibraryCollapsed] = useState<string[]>(() => getDefaultCollapsedSectionKeys())

  const busy = runState === 'running' || runState === 'paused'
  const hasModel = !!meshUrl

  useEffect(() => {
    if (!loaded) void loadList()
  }, [loaded, loadList])

  // 默认选中：优先取编辑器当前打开的工作流，否则取列表第一个
  useEffect(() => {
    if (!selectedId && workflows.length > 0) {
      setSelectedId(useWorkflowsStore.getState().current?.id ?? workflows[0].id)
    }
  }, [workflows, selectedId])

  useEffect(() => {
    if (!selectedId) return
    getWorkflow(selectedId)
      .then((wf) => {
        setWorkflow(wf)
        setNodes(wf.nodes)
        setEdges(wf.edges)
      })
      .catch(() => setWorkflow(null))
  }, [selectedId])

  // Library：打开面板时懒加载（首次），Refresh 强制刷新
  async function loadLibrary(force = false): Promise<void> {
    if (libraryLoading) return
    if (libraryLoaded && !force) return
    setLibraryLoading(true)
    setLibraryError(null)
    try {
      const entries = await listLibrary()
      setLibraryEntries(entries)
      setLibrarySelectedId((cur) =>
        cur && entries.some((e) => e.id === cur) ? cur : entries.find(isOpenable)?.id ?? entries[0]?.id ?? null
      )
      setLibraryLoaded(true)
    } catch (err) {
      setLibraryLoaded(false)
      setLibraryError(String(err instanceof Error ? err.message : err))
    } finally {
      setLibraryLoading(false)
    }
  }

  useEffect(() => {
    if (openPanel !== 'library' || libraryLoaded || libraryLoading) return
    void loadLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel, libraryLoaded, libraryLoading])

  /** 打开选中的库资产：直接加载到 3D 查看器并计入撤销历史。 */
  function handleOpenLibraryAsset(entry: LibraryEntry | null): void {
    if (!entry || !isOpenable(entry)) return
    pushMeshUrl(fullUrl(entry.url))
    useLogsStore.getState().info(`library open: ${entry.workspacePath}`)
    setOpenPanel(null)
  }

  const patchNode = useCallback<PatchFn>((nodeId, patch) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
          : n
      )
    )
  }, [])

  // 参数修改后 500ms 防抖保存（首次挂载跳过）
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return }
    if (!workflow || !selectedId) return
    const t = setTimeout(() => {
      void saveWorkflow({
        ...workflow,
        nodes,
        edges,
        updatedAt: new Date().toISOString()
      }).catch(() => undefined)
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅对可编辑状态防抖
  }, [nodes, edges])

  // 网格历史快捷键 Ctrl+Z / Ctrl+Y
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 'z') { e.preventDefault(); undoMesh() }
      if (e.key === 'y') { e.preventDefault(); redoMesh() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoMesh, redoMesh])

  // Gizmo 快捷键：W 移动 / R 旋转 / S 缩放 / Esc 退出
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const el = document.activeElement as HTMLElement | null
      if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return
      if (e.key === 'Escape') { setGizmoMode(null); return }
      if (!hasModel || !meshSelected) return
      const k = e.key.toLowerCase()
      if (k === 'w') setGizmoMode(gizmoMode === 'translate' ? null : 'translate')
      else if (k === 'r') setGizmoMode(gizmoMode === 'rotate' ? null : 'rotate')
      else if (k === 's') setGizmoMode(gizmoMode === 'scale' ? null : 'scale')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasModel, meshSelected, gizmoMode, setGizmoMode])

  // 参数行按拓扑序展示（只展示带参数的节点类型）
  const paramNodes = workflow
    ? topoSort(nodes, edges)
        .map((id) => nodes.find((n) => n.id === id)!)
        .filter((n) =>
          n.type === 'imageNode' || n.type === 'textNode' || n.type === 'meshNode' ||
          n.type === 'waitNode' || n.type === 'generatorNode'
        )
    : []

  const preflightIssue = workflow ? firstPreflightIssue(nodes, edges) : null

  function handleGenerate(): void {
    if (!workflow || preflightIssue) return
    const wf = { ...workflow, nodes, edges, updatedAt: new Date().toISOString() }
    void saveWorkflow(wf).catch(() => undefined)
    void run(wf)
  }

  function handleUnloadAll(): void {
    useSceneStore.setState({
      meshUrl: null,
      meshSelected: false,
      meshStats: null,
      gizmoMode: null,
      meshHistory: [],
      historyIndex: -1
    })
    setUnloadStatus('done')
    setTimeout(() => setUnloadStatus('idle'), 2000)
  }

  async function handleExport(format: 'glb' | 'obj' | 'stl' | 'ply'): Promise<void> {
    if (!meshUrl) return
    if (format === 'glb') {
      // GLB is the viewer's native format — download the loaded file directly.
      const a = document.createElement('a')
      a.href = meshUrl
      a.download = `meshforge-${Date.now()}.glb`
      a.click()
      return
    }
    // obj / stl / ply → mesh-exporter job (trimesh backend, /process/mesh)
    if (exporting) return
    setExporting(format)
    try {
      const { job_id } = await processMesh(meshUrl, 'mesh-exporter', { format })
      let status = await getJob(job_id)
      for (let i = 0; i < 60 && (status.state === 'pending' || status.state === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 500))
        status = await getJob(job_id)
      }
      if (status.state !== 'succeeded' || !status.result_url) {
        useLogsStore.getState().error(`export .${format}: ${status.error || status.state}`)
        return
      }
      const a = document.createElement('a')
      a.href = fullUrl(status.result_url)
      a.download = `meshforge-${Date.now()}.${format}`
      a.click()
      useLogsStore.getState().info(`export .${format}: saved`)
    } catch (e) {
      useLogsStore.getState().error(`export .${format}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(null)
    }
  }

  async function handleImportMesh(file: File | undefined): Promise<void> {
    if (!file) return
    setImporting(true)
    try {
      pushMeshUrl(URL.createObjectURL(file))
      setOpenPanel(null)
    } finally {
      setImporting(false)
    }
  }

  // Imperative file input: committing a hidden <input type="file"> through React
  // freezes the renderer on some Electron/Chromium builds. Create the element
  // only when the user actually picks a file instead.
  function openMeshPicker(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.glb,.gltf'
    input.onchange = () => { void handleImportMesh(input.files?.[0]) }
    input.click()
  }

  function handleDecimate(targetFaces: number): void {
    setDecimating(true)
    setTimeout(() => {
      setDecimating(false)
      useLogsStore.getState().error(`decimate to ${targetFaces} faces: backend endpoint not available yet`)
    }, 500)
  }

  function handleSmooth(iterations: number): void {
    setSmoothing(true)
    setTimeout(() => {
      setSmoothing(false)
      useLogsStore.getState().error(`smooth (${iterations} iterations): backend endpoint not available yet`)
    }, 500)
  }

  // 左面板拖宽
  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      setPanelWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + ev.movementX)))
    }
    const onUp = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  function openEditor(): void {
    if (selectedId) void selectInStore(selectedId)
    go('workflows')
  }

  return (
    <div className="gp">
      {/* 左侧工作流面板 */}
      <aside className="gp-panel" style={{ width: panelWidth }}>
        {/* 模式切换：basic / chat */}
        <div className="gp-mode">
          <div className="gp-mode__box">
            {(['basic', 'chat'] as const).map((m) => (
              <button
                key={m}
                className={`gp-mode__btn ${mode === m ? 'gp-mode__btn--active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {mode === 'chat' ? (
          <ChatPanel />
        ) : (
          <>
            <div className="gp-panel__header">
              <h2 className="gp-panel__title">Workflow</h2>
              <div className="gp-panel__selectrow">
                <WorkflowDropdown
                  workflows={workflows}
                  value={selectedId}
                  onChange={setSelectedId}
                  disabled={busy}
                />
                {selectedId && (
                  <button className="gp-edit" title="Edit workflow" aria-label="Edit workflow" onClick={openEditor}>
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* 参数行列表 */}
            <div className="gp-params">
              {paramNodes.map((node) => (
                <div key={node.id} className="gp-row">
                  {node.type === 'imageNode' && <ImageParamRow node={node} onPatch={patchNode} />}
                  {node.type === 'textNode' && <TextParamRow node={node} onPatch={patchNode} />}
                  {node.type === 'meshNode' && <MeshParamRow node={node} onPatch={patchNode} />}
                  {node.type === 'waitNode' && <WaitParamRow nodeId={node.id} />}
                  {node.type === 'generatorNode' && <GeneratorParamRow node={node} />}
                </div>
              ))}
              {workflow && paramNodes.length === 0 && (
                <div className="gp-params__empty">
                  <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                  <p>工作流中没有可配置的节点。</p>
                  <button className="gp-params__link" onClick={openEditor}>
                    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    Open workflow editor
                  </button>
                </div>
              )}
              {!workflow && (
                <div className="gp-params__empty">
                  <p>No workflows yet.<br />Create one in the Workflows tab.</p>
                </div>
              )}
            </div>

            {/* 底部：preflight 警告 + 运行按钮 */}
            <div className="gp-panel__footer">
              {preflightIssue && !busy && (
                <div className="gp-warn">
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span>{preflightIssue}</span>
                </div>
              )}
              {busy ? (
                <button className="gp-generate gp-generate--stop" onClick={() => void cancel()}>Stop</button>
              ) : (
                <button
                  className="gp-generate"
                  disabled={!workflow || nodes.length === 0 || !!preflightIssue}
                  onClick={handleGenerate}
                >
                  Generate 3D Model
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      {/* 拖宽手柄 */}
      <div className="gp-resizer" onMouseDown={onResizeDown} />

      {/* 右侧：工具栏 + 3D 查看器 */}
      <div className="gp-main">
        {/* 顶部工具栏 */}
        <div className="gp-toolbar">
          {/* Free memory */}
          <button className="gp-toolbtn" onClick={handleUnloadAll} disabled={busy} title="Free model from memory">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
            {unloadStatus === 'done' ? 'Freed' : 'Free memory'}
          </button>

          <div className="gp-toolbar__sep" />

          {/* Undo / Redo */}
          <button className="gp-toolbtn gp-toolbtn--icon" onClick={undoMesh} disabled={!canUndoMesh} title="Undo (Ctrl+Z)" aria-label="Undo (Ctrl+Z)">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 7v6h6" />
              <path d="M3 13a9 9 0 1 0 2.28-5.93" />
            </svg>
          </button>
          <button className="gp-toolbtn gp-toolbtn--icon" onClick={redoMesh} disabled={!canRedoMesh} title="Redo (Ctrl+Y)" aria-label="Redo (Ctrl+Y)">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 7v6h-6" />
              <path d="M21 13a9 9 0 1 1-2.28-5.93" />
            </svg>
          </button>

          <div className="gp-toolbar__sep" />

          {/* Import */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn ${openPanel === 'import' ? 'gp-toolbtn--active' : ''}`}
              onClick={() => setOpenPanel((p) => (p === 'import' ? null : 'import'))}
              disabled={importing}
            >
              {importing ? <Spinner /> : (
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
              {importing ? 'Importing…' : 'Import'}
              {!importing && <ChevronDown />}
            </button>
            {openPanel === 'import' && (
              <div className="gp-menu">
                <button onClick={openMeshPicker}>
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  <span>
                    <span className="gp-menu__title">Mesh</span>
                    <span className="gp-menu__desc">.glb .gltf</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Library */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn ${openPanel === 'library' ? 'gp-toolbtn--active' : ''}`}
              onClick={() => setOpenPanel((p) => (p === 'library' ? null : 'library'))}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" />
              </svg>
              Library
            </button>
            {openPanel === 'library' && (() => {
              const scopeGroups = filterScopeGroups(libraryEntries, librarySearch, librarySort)
              const visibleIds = new Set(
                scopeGroups.flatMap((g) => g.entryGroups.flatMap((cg) => cg.entries.map((e) => e.id)))
              )
              const selectedEntry =
                librarySelectedId && visibleIds.has(librarySelectedId)
                  ? libraryEntries.find((e) => e.id === librarySelectedId) ?? null
                  : null
              const openDisabled = !selectedEntry || !isOpenable(selectedEntry) || libraryLoading
              const selectedMessage = selectedEntry
                ? describeOpenability(selectedEntry)
                : scopeGroups.length === 0 && librarySearch.trim()
                  ? `No workspace assets match "${librarySearch.trim()}".`
                  : 'Select an asset to open it in Generate.'
              return (
                <div className="gp-menu gp-menu--wide gp-lib">
                  <div className="gp-menu__head">
                    <p className="gp-menu__label">Workspace library</p>
                    <p className="gp-menu__text">Select a workspace asset and open the supported source in Generate.</p>
                  </div>
                  <button
                    className="gp-lib__refresh"
                    onClick={() => void loadLibrary(true)}
                    disabled={libraryLoading}
                  >
                    Refresh assets
                  </button>
                  <div className="gp-lib__bar">
                    <input
                      className="gp-lib__search"
                      type="search"
                      value={librarySearch}
                      onChange={(e) => setLibrarySearch(e.target.value)}
                      placeholder="Search by name, path, scope, or capability"
                    />
                    <select
                      className="gp-lib__sort"
                      value={librarySort}
                      onChange={(e) => setLibrarySort(e.target.value as LibrarySortMode)}
                    >
                      {LIBRARY_SORT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  {libraryLoading ? (
                    <p className="gp-menu__empty">Loading workspace assets…</p>
                  ) : scopeGroups.length === 0 ? (
                    <p className="gp-menu__empty">
                      {librarySearch.trim()
                        ? `No workspace assets match "${librarySearch.trim()}".`
                        : 'No workspace assets are indexed yet.'}
                    </p>
                  ) : (
                    <div className="gp-lib__list">
                      {scopeGroups.map((scopeGroup) => {
                        const scopeExpanded = !libraryCollapsed.includes(scopeGroup.sectionKey)
                        return (
                          <div key={scopeGroup.sectionKey} className="gp-lib__scope">
                            <button
                              className="gp-lib__section"
                              aria-expanded={scopeExpanded}
                              onClick={() => setLibraryCollapsed((keys) => toggleSectionKey(keys, scopeGroup.sectionKey))}
                            >
                              <span className="gp-lib__section-name">{scopeGroup.sourceScopeLabel}</span>
                              <span className="gp-lib__section-toggle">{scopeExpanded ? 'Hide' : 'Show'}</span>
                            </button>
                            {scopeExpanded && scopeGroup.entryGroups.map((group) => {
                              const capExpanded = !libraryCollapsed.includes(group.sectionKey)
                              return (
                                <div key={group.sectionKey} className="gp-lib__cap">
                                  <button
                                    className="gp-lib__section gp-lib__section--cap"
                                    aria-expanded={capExpanded}
                                    onClick={() => setLibraryCollapsed((keys) => toggleSectionKey(keys, group.sectionKey))}
                                  >
                                    <span className="gp-lib__section-name">{group.capabilityLabel}</span>
                                    <span className="gp-lib__section-toggle">{capExpanded ? 'Hide' : 'Show'}</span>
                                  </button>
                                  {capExpanded && group.entries.map((entry) => {
                                    const selected = entry.id === librarySelectedId
                                    return (
                                      <button
                                        key={entry.id}
                                        className={`gp-lib__item ${selected ? 'gp-lib__item--selected' : ''}`}
                                        aria-pressed={selected}
                                        onClick={() => setLibrarySelectedId(entry.id)}
                                      >
                                        <span className="gp-lib__item-name">{entry.displayName}</span>
                                        <span className="gp-lib__item-cap">{entry.capability}</span>
                                        <span className="gp-lib__item-path">{entry.workspacePath}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="gp-menu__hint">
                    {selectedMessage}
                    {libraryError && <span className="gp-lib__error">{libraryError}</span>}
                  </div>
                  <button
                    className="gp-menu__primary"
                    disabled={openDisabled}
                    onClick={() => handleOpenLibraryAsset(selectedEntry)}
                  >
                    Open selected asset
                  </button>
                </div>
              )
            })()}
          </div>

          {hasModel && (
            <>
              <div className="gp-toolbar__sep" />

              {/* Export */}
              <div className="gp-relative">
                <button
                  className={`gp-toolbtn ${openPanel === 'export' || exporting ? 'gp-toolbtn--active' : ''}`}
                  onClick={() => setOpenPanel((p) => (p === 'export' ? null : 'export'))}
                  disabled={exporting !== null}
                >
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 5 17 10" />
                    <line x1="12" y1="5" x2="12" y2="15" />
                  </svg>
                  {exporting ? `Exporting .${exporting}…` : 'Export'}
                  <ChevronDown />
                </button>
                {openPanel === 'export' && (
                  <div className="gp-menu">
                    {EXPORT_FORMATS.map(({ fmt, desc }) => (
                      <button
                        key={fmt}
                        disabled={exporting !== null}
                        onClick={() => { void handleExport(fmt); setOpenPanel(null) }}
                      >
                        <span className="gp-menu__fmt">.{fmt}</span>
                        <span className="gp-menu__desc">{exporting === fmt ? 'Exporting…' : desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Smooth */}
              <div className="gp-relative">
                <button
                  className={`gp-toolbtn ${openPanel === 'smooth' || smoothing ? 'gp-toolbtn--active' : ''}`}
                  onClick={() => setOpenPanel((p) => (p === 'smooth' ? null : 'smooth'))}
                  disabled={smoothing}
                >
                  {smoothing ? <Spinner /> : (
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                  {smoothing ? 'Processing…' : 'Smooth'}
                </button>
                {openPanel === 'smooth' && (
                  <SmoothPopover smoothing={smoothing} onSmooth={handleSmooth} onClose={() => setOpenPanel(null)} />
                )}
              </div>

              {/* Decimate */}
              <div className="gp-relative">
                <button
                  className={`gp-toolbtn ${openPanel === 'decimate' || decimating ? 'gp-toolbtn--active' : ''}`}
                  onClick={() => setOpenPanel((p) => (p === 'decimate' ? null : 'decimate'))}
                  disabled={decimating}
                >
                  {decimating ? <Spinner /> : (
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <polygon points="12 2 22 20 2 20" />
                      <line x1="12" y1="9" x2="8" y2="17" />
                      <line x1="12" y1="9" x2="16" y2="17" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                    </svg>
                  )}
                  {decimating ? 'Processing…' : 'Decimate'}
                </button>
                {openPanel === 'decimate' && (
                  <DecimatePopover
                    currentTriangles={meshStats?.triangles ?? null}
                    decimating={decimating}
                    onDecimate={handleDecimate}
                    onClose={() => setOpenPanel(null)}
                  />
                )}
              </div>
            </>
          )}

          <div className="gp-spacer" />

          {/* Light — 始终靠右 */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn gp-toolbtn--icon ${openPanel === 'light' ? 'gp-toolbtn--active' : ''}`}
              title="Lighting"
              aria-label="Lighting"
              onClick={() => setOpenPanel((p) => (p === 'light' ? null : 'light'))}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" />
                <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
                <line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" />
                <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
              </svg>
            </button>
            {openPanel === 'light' && (
              <LightPopover
                settings={light}
                onChange={(patch) => setLight(patch)}
                onClose={() => setOpenPanel(null)}
              />
            )}
          </div>
        </div>

        {/* 变换工具条（模型选中后出现） */}
        <div className="gp-tools">
          {hasModel && meshSelected && (
            <>
              <button
                className={`gp-tools__btn ${gizmoMode === 'translate' ? 'gp-tools__btn--active' : ''}`}
                title="Move (W)"
                aria-label="Move (W)"
                onClick={() => setGizmoMode(gizmoMode === 'translate' ? null : 'translate')}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" />
                  <polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" />
                  <line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
                </svg>
              </button>
              <button
                className={`gp-tools__btn ${gizmoMode === 'rotate' ? 'gp-tools__btn--active' : ''}`}
                title="Rotate (R)"
                aria-label="Rotate (R)"
                onClick={() => setGizmoMode(gizmoMode === 'rotate' ? null : 'rotate')}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 2v6h-6" />
                  <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
                </svg>
              </button>
              <button
                className={`gp-tools__btn ${gizmoMode === 'scale' ? 'gp-tools__btn--active' : ''}`}
                title="Scale (S)"
                aria-label="Scale (S)"
                onClick={() => setGizmoMode(gizmoMode === 'scale' ? null : 'scale')}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="gp-viewer">
          {meshUrl ? (
            <Viewer3D url={meshUrl} light={light} />
          ) : (
            <div className="gp-viewer__empty">
              <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>Generate a model to preview it here</span>
            </div>
          )}
          <GenerationHUD nodes={nodes} />
        </div>
      </div>
    </div>
  )
}

// ─── Smooth / Decimate 弹窗 ─────────────────────────────────────────────────

function SmoothPopover({ smoothing, onSmooth, onClose }: {
  smoothing: boolean
  onSmooth: (iterations: number) => void
  onClose: () => void
}) {
  const [inputValue, setInputValue] = useState('3')
  const parsed = parseInt(inputValue, 10)
  const valid = !isNaN(parsed) && parsed >= 1 && parsed <= 20

  return (
    <div className="gp-pop gp-pop--left">
      <p className="gp-pop__title">Smooth mesh</p>
      <div className="gp-pop__field">
        <label className="gp-pop__fieldlabel">Iterations (1–20)</label>
        <input type="number" min={1} max={20} step={1} value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
        <p className="gp-pop__fieldhint">More iterations = smoother, but loses detail</p>
      </div>
      <div className="gp-pop__actions">
        <button className="gp-pop__cancel" onClick={onClose}>Cancel</button>
        <button className="gp-pop__apply" disabled={smoothing || !valid} onClick={() => valid && onSmooth(parsed)}>
          {smoothing ? 'Processing…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

function DecimatePopover({ currentTriangles, decimating, onDecimate, onClose }: {
  currentTriangles: number | null
  decimating: boolean
  onDecimate: (targetFaces: number) => void
  onClose: () => void
}) {
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
      <p className="gp-pop__title">Decimate mesh</p>
      {currentTriangles && (
        <p className="gp-pop__fieldhint">Current: {currentTriangles.toLocaleString()} tri</p>
      )}
      <div className="gp-pop__field">
        <label className="gp-pop__fieldlabel">Target faces</label>
        <input type="number" min={100} step={500} value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
        {reduction !== null && (
          <p className="gp-pop__fieldhint">Reduction: <span className="gp-pop__accent">{reduction}%</span></p>
        )}
      </div>
      <div className="gp-pop__actions">
        <button className="gp-pop__cancel" onClick={onClose}>Cancel</button>
        <button className="gp-pop__apply" disabled={decimating || !validTarget} onClick={() => validTarget && onDecimate(validTarget)}>
          {decimating ? 'Processing…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}
