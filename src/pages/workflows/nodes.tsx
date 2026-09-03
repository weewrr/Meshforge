import { useState, type ReactNode } from 'react'
import { Handle, Position, NodeResizer, type NodeProps, type Node } from '@xyflow/react'
import type { ParamSchema, PortType, WFNodeData } from '../../types'
import { IN_HANDLE, OUT_HANDLE, getExtensionById, nodePorts, nodeSpec } from '../../types'
import { useWorkflowsStore } from '../../stores/workflows'
import { useWorkflowRunStore, type NodeState } from '../../stores/workflowRun'
import { useLogsStore } from '../../stores/logs'
import { importImageByPath, importMeshByPath } from '../../api'
import { useT } from '../../i18n'

// ─── Shell ────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<NodeState, string> = {
  pending: '',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'ok',
  failed: 'error',
  skipped: 'skip'
}

function NodeShell({
  id,
  type,
  label,
  children,
  extensionId,
  handleColor
}: {
  id: string
  type: string
  label: string
  children?: ReactNode
  extensionId?: string | null
  handleColor?: string
}) {
  const spec = nodeSpec(type)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const progress = useWorkflowRunStore((s) => s.nodeProgress[id] ?? 0)

  // Dynamic ports for extension nodes (typing comes from the extension schema).
  const ports = type === 'extensionNode' ? nodePorts(type, extensionId) : { inputs: spec.inputs, output: spec.output }
  const hasIn = ports.inputs.length > 0
  const hasOut = ports.output !== 'none'
  const color = handleColor ?? '#4f8cff'

  return (
    <div className={`wf-node wf-node--${state}`}>
      {hasIn && (
        <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ background: color }} />
      )}
      {hasOut && (
        <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ background: color }} />
      )}
      <div className="wf-node__header" style={{ borderTopColor: spec.color }}>
        <span className="wf-node__dot" style={{ background: spec.color }} />
        <span className="wf-node__title">{label}</span>
        {STATUS_LABEL[state] && (
          <span className={`wf-node__status wf-node__status--${state}`}>
            {STATUS_LABEL[state]}
          </span>
        )}
      </div>
      <div className="wf-node__body">{children}</div>
      {state === 'running' && progress > 0 && progress < 1 && (
        <div className="wf-node__progress">
          <div className="wf-node__progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  )
}

const PORT_COLOR: Record<string, string> = {
  image: '#38bdf8',
  text: '#fbbf24',
  mesh: '#a78bfa',
  any: '#71717a'
}

function PortTag({ type }: { type: PortType }) {
  return (
    <span className="wf-ext-tag" style={{ color: PORT_COLOR[type] ?? '#71717a', borderColor: `${PORT_COLOR[type] ?? '#71717a'}44` }}>
      {type}
    </span>
  )
}

// ─── Parameter controls ───────────────────────────────────────────────────────

function useParam(nodeId: string) {
  const updateNodeData = useWorkflowsStore((s) => s.updateNodeData)
  return (key: string, value: unknown) => updateNodeData(nodeId, { [key]: value })
}

function ImageFileButton({
  nodeId,
  label,
  current,
  onUploaded
}: {
  nodeId: string
  label: string
  current?: string
  onUploaded?: (fileName: string) => void
}) {
  const t = useT()
  const setParam = useParam(nodeId)
  const [busy, setBusy] = useState(false)

  // Native-dialog image picker (Modly-aligned) — mirrors MeshFileButton below.
  // Chromium <input type=file> freezes this machine's renderer (see HANDOFF
  // §6), so images are picked in the main process and imported by path.
  async function pickFromDisk(): Promise<void> {
    if (!window.meshforge?.selectImageFile) {
      useLogsStore.getState().warn('[imageNode] native file dialog unavailable (browser-only run)')
      return
    }
    const filePath = await window.meshforge.selectImageFile()
    if (!filePath) return
    setBusy(true)
    try {
      const { url, fileName } = await importImageByPath(filePath)
      setParam('url', url)
      setParam('fileName', fileName)
      onUploaded?.(fileName)
      useLogsStore.getState().log('info', `[imageNode] imported ${fileName}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useLogsStore.getState().error(`[imageNode] import failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wf-upload">
      <button
        className="wf-upload__btn"
        disabled={busy}
        onClick={() => void pickFromDisk()}
      >
        {busy ? t('workflows.nodes.importing') : label}
      </button>
      <span className="wf-upload__name">{current || t('workflows.nodes.noFileSelected')}</span>
    </div>
  )
}

/**
 * Native-dialog mesh picker for Load 3D Mesh nodes (Modly-aligned).
 *
 * Mirrors the Generate-page Import→Mesh flow: the Electron main process opens
 * the file dialog and only returns an absolute path; the backend serves the
 * file (or a trimesh-converted GLB) through /optimize/import-by-path. No
 * Chromium <input type=file> is involved — that freezes the renderer on this
 * machine (see HANDOFF §6).
 */
function MeshFileButton({ nodeId, label, current }: { nodeId: string; label: string; current?: string }) {
  const t = useT()
  const setParam = useParam(nodeId)
  const [busy, setBusy] = useState(false)

  async function pickNative(): Promise<void> {
    if (!window.meshforge?.selectMeshFile) {
      useLogsStore.getState().warn('[meshNode] native file dialog unavailable (browser-only run)')
      return
    }
    const filePath = await window.meshforge.selectMeshFile()
    if (!filePath) return
    setBusy(true)
    try {
      const { url } = await importMeshByPath(filePath)
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      setParam('url', url)
      setParam('fileName', fileName)
      useLogsStore.getState().log('info', `[meshNode] imported ${fileName}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useLogsStore.getState().error(`[meshNode] import failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wf-upload">
      <button className="wf-upload__btn" disabled={busy} onClick={() => void pickNative()}>
        {busy ? t('workflows.nodes.importing') : label}
      </button>
      <span className="wf-upload__name">{current || t('workflows.nodes.noFileSelected')}</span>
    </div>
  )
}

// ─── Node components ──────────────────────────────────────────────────────────

export function ImageNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="imageNode" label={data.label}>
      <ImageFileButton nodeId={id} label={t('workflows.nodes.selectImage')} current={String(data.params.fileName ?? '')} />
    </NodeShell>
  )
}

export function TextNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="textNode" label={data.label}>
      <input
        className="wf-input"
        type="text"
        defaultValue={String(data.params.text ?? '')}
        onChange={(e) => setParam('text', e.target.value)}
      />
    </NodeShell>
  )
}

export function MeshNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="meshNode" label={data.label}>
      <MeshFileButton nodeId={id} label={t('workflows.nodes.selectMeshFile')} current={String(data.params.fileName ?? '')} />
    </NodeShell>
  )
}

export function GeneratorNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="generatorNode" label={data.label}>
      <input
        className="wf-input"
        type="text"
        defaultValue={String(data.params.generatorId ?? '')}
        onChange={(e) => setParam('generatorId', e.target.value)}
      />
    </NodeShell>
  )
}

export function PreviewNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="previewNode" label={data.label}>
      <span className="wf-hint">{t('workflows.nodes.previewHint')}</span>
    </NodeShell>
  )
}

export function OutputNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="outputNode" label={data.label}>
      <span className="wf-hint">{t('workflows.nodes.outputHint')}</span>
    </NodeShell>
  )
}

export function WaitNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const paused = useWorkflowRunStore((s) => s.runState === 'paused' && s.nodeStates[id] === 'waiting')
  const continueRun = useWorkflowRunStore((s) => s.continueRun)

  return (
    <NodeShell id={id} type="waitNode" label={data.label}>
      {paused ? (
        <button className="wf-wait-btn nodrag" onClick={continueRun}>
          ▶ {t('workflows.nodes.continue')}
        </button>
      ) : (
        <span className="wf-hint">{t('workflows.nodes.waitHint')}</span>
      )}
    </NodeShell>
  )
}

// While container — a resizable dashed frame that wraps the loop-body nodes
// (Modly parity). Drop nodes inside it to define the body; the runner repeats
// the contained nodes each iteration. Child nodes render on top of the frame
// via React Flow's parentId mechanism.
export function WhileNode({ id, data, selected }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const running = state === 'running'
  const runState = useWorkflowRunStore((s) => s.runState)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const continueWhile = useWorkflowRunStore((s) => s.continueWhile)
  const retryWhile = useWorkflowRunStore((s) => s.retryWhile)
  const isPaused = runState === 'paused' && activeNodeId === id
  const spec = nodeSpec('whileNode')

  return (
    <div className={`wf-while ${running ? 'wf-while--running' : ''} ${isPaused ? 'wf-while--paused' : ''} ${selected ? 'wf-while--selected' : ''}`}>
      <NodeResizer
        minWidth={280}
        minHeight={160}
        lineStyle={{ borderColor: 'transparent' }}
        handleStyle={{ background: spec.color, border: 'none', width: 10, height: 10, borderRadius: 3 }}
        isVisible={selected}
      />
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" />
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" />

      <div className="wf-while__header">
        <span className="wf-while__glyph">↻</span>
        <span className="wf-while__title">{data.label}</span>
        <label className="wf-while__loop">
          <span>{t('workflows.nodes.loop')}</span>
          <input
            className="wf-while__num"
            // Not type="number" — painting number inputs inside the canvas
            // natively crashes this machine's renderer (see ParamControl).
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            defaultValue={Number(data.params.iterations ?? 0)}
            disabled={runState === 'running' || runState === 'paused'}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const raw = e.target.value
              if (raw !== '' && raw !== '-' && !/^-?\d*$/.test(raw)) return
              const n = parseInt(raw, 10)
              if (!isNaN(n)) setParam('iterations', Math.max(0, n))
            }}
          />
          <span>×</span>
        </label>
        <div className="wf-while__header-spacer" />
        {isPaused && (
          <div className="wf-while__actions">
            <button className="wf-while__btn wf-while__btn--continue" onClick={continueWhile}>
              ▶ {t('workflows.nodes.continue')}
            </button>
            <button className="wf-while__btn" onClick={retryWhile}>
              ↻ {t('workflows.nodes.retry')}
            </button>
          </div>
        )}
      </div>

      <div className="wf-while__body">
        <span className="wf-while__hint">{isPaused ? t('workflows.nodes.whilePaused') : t('workflows.nodes.whileBodyHint')}</span>
      </div>
    </div>
  )
}

export function ForEachNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const runState = useWorkflowRunStore((s) => s.runState)
  const locked = runState === 'running' || runState === 'paused'
  return (
    <NodeShell id={id} type="forEachNode" label={data.label}>
      <label className="wf-field">
        <span>{t('workflows.nodes.iterModeLabel')}</span>
        <select
          className="wf-input nodrag"
          defaultValue={String(data.params.mode ?? 'image')}
          disabled={locked}
          onChange={(e) => setParam('mode', e.target.value)}
        >
          <option value="image">{t('workflows.nodes.iterImage')}</option>
          <option value="text">{t('workflows.nodes.iterText')}</option>
        </select>
      </label>
      <label className="wf-field">
        <span>{t('workflows.nodes.workspaceDirLabel')}</span>
        <input
          className="wf-input"
          type="text"
          defaultValue={String(data.params.dir ?? '')}
          placeholder={t('workflows.nodes.workspaceDirPlaceholder')}
          disabled={locked}
          onChange={(e) => setParam('dir', e.target.value)}
        />
      </label>
      <label className="wf-field">
        <span>{t('workflows.nodes.itemsLabel')}</span>
        <input
          className="wf-input"
          type="text"
          defaultValue={String(data.params.items ?? '')}
          disabled={locked}
          placeholder={t('workflows.nodes.itemsPlaceholder')}
          onChange={(e) => setParam('items', e.target.value)}
        />
      </label>
    </NodeShell>
  )
}

// ─── Extension node (schema-driven, Modly parity) ────────────────────────────

function ParamControl({
  param,
  value,
  onChange
}: {
  param: ParamSchema
  value: string | number
  onChange: (v: string | number) => void
}) {
  if (param.type === 'select') {
    return (
      <select
        className="wf-input nodrag"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {param.options?.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label ?? String(o.value)}
          </option>
        ))}
      </select>
    )
  }
  if (param.type === 'int' || param.type === 'float') {
    // Chromium on this machine natively crashes when <input type="number"> is
    // painted inside the React Flow canvas (verified: any node with a number
    // input kills the renderer, exit 0xC0000005 / 0x7003). Modly parity: use a
    // text input + inputMode + regex gate and parse on change instead.
    const isFloat = param.type === 'float'
    return (
      <input
        className="wf-input wf-input--num nodrag"
        type="text"
        inputMode={isFloat ? 'decimal' : 'numeric'}
        autoComplete="off"
        spellCheck={false}
        min={param.min}
        max={param.max}
        defaultValue={value}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const raw = isFloat ? e.target.value.replace(',', '.') : e.target.value
          // Allow transient states while typing ('', '-', '1.', '-1' …).
          if (raw !== '' && raw !== '-' && !(isFloat ? /^-?\d*\.?\d*$/.test(raw) : /^-?\d*$/.test(raw))) return
          const n = isFloat ? parseFloat(raw) : parseInt(raw, 10)
          if (!isNaN(n)) onChange(n)
        }}
      />
    )
  }
  return (
    <input
      className="wf-input nodrag"
      type="text"
      defaultValue={value as string}
      placeholder={param.tooltip ?? ''}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function ExtensionNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const ext = getExtensionById(String(data.extensionId ?? ''))
  const label = ext?.display_name ?? t('workflows.nodes.extension')
  const inputType = (ext?.input ?? 'any') as PortType
  const outputType = (ext?.output ?? 'mesh') as PortType
  const hasParams = (ext?.params.length ?? 0) > 0

  const isVisible = (param: ParamSchema): boolean => {
    if (!param.show_if) return true
    return Object.entries(param.show_if).every(([key, expected]) => {
      const current = (data.params[key] as string | number | undefined) ?? ext?.params.find((p) => p.id === key)?.default
      return Array.isArray(expected)
        ? current != null && expected.includes(current)
        : current === expected
    })
  }

  return (
    <NodeShell id={id} type="extensionNode" label={label} extensionId={data.extensionId as string} handleColor={PORT_COLOR[inputType] ?? '#4f8cff'}>
      <div className="wf-ext-io">
        <PortTag type={inputType} />
        {ext?.output !== 'none' && (
          <>
            <span className="wf-ext-arrow">→</span>
            <PortTag type={outputType} />
          </>
        )}
      </div>
      {hasParams && (
        <div className="wf-ext-params">
          {ext!.params.filter(isVisible).map((param) => {
            const val = (data.params[param.id] ?? param.default) as string | number
            return (
              <label key={param.id} className="wf-field">
                <span>{param.label}</span>
                <ParamControl param={param} value={val} onChange={(v) => setParam(param.id, v)} />
              </label>
            )
          })}
        </div>
      )}
    </NodeShell>
  )
}

export const nodeTypes = {
  imageNode: ImageNode,
  textNode: TextNode,
  meshNode: MeshNode,
  generatorNode: GeneratorNode,
  previewNode: PreviewNode,
  outputNode: OutputNode,
  waitNode: WaitNode,
  whileNode: WhileNode,
  forEachNode: ForEachNode,
  extensionNode: ExtensionNode
}
