/**
 * 蓝图节点的通用基元：断点指示、节点外壳（`NodeShell`）、参数写入入口
 * （`useParam`）、原生文件选择按钮、子图编辑器上下文与计算类节点外壳。
 *
 * 各职责节点文件都复用这里的组件/ hook，避免重复处理引脚、运行态高亮、
 * 进度条与"子图内编辑需作用于草稿而非主画布"的分支。
 */

import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  EXEC_IN_HANDLE,
  EXEC_OUT_HANDLE,
  IN_HANDLE,
  ITER_INDEX_HANDLE,
  OUT_HANDLE,
  extensionColor,
  getExtensionById,
  isExecNode,
  nodePorts,
  nodeSpec,
  portColor,
  type PortType
} from '../../../types'
import { useWorkflowsStore } from '../../../stores/workflows'
import { useWorkflowRunStore, type NodeState } from '../../../stores/workflowRun'
import { useLogsStore } from '../../../stores/logs'
import { importImageByPath, importMeshByPath } from '../../../api'
import { useT } from '../../../i18n'

// ─── Breakpoints (调试) ───────────────────────────────────────────────────────

/** 该节点是否打开了断点（运行到它之前会暂停，可单步继续）。 */
function useBreakpoint(id: string): boolean {
  return useWorkflowsStore((s) => !!s.current?.nodes.find((x) => x.id === id)?.data?.params?.breakpoint)
}

/** 断点小红点：带断点的节点在标题栏左上角显示，一眼看出哪里会停。 */
export function BreakpointDot({ id }: { id: string }) {
  const t = useT()
  const on = useBreakpoint(id)
  if (!on) return null
  return <span className="wf-bp-dot" title={t('workflows.nodes.breakpointTitle')} aria-label={t('workflows.nodes.breakpointTitle')} />
}

// ─── Shell ────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<NodeState, string> = {
  pending: '',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'ok',
  failed: 'error',
  skipped: 'skip'
}

/** 通用节点外壳：标题栏（断点/色点/标题/运行状态）、执行与数据引脚、进度条。 */
export function NodeShell({
  id,
  type,
  label,
  children,
  extensionId
}: {
  id: string
  type: string
  label: string
  children?: ReactNode
  extensionId?: string | null
}) {
  const spec = nodeSpec(type)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const progress = useWorkflowRunStore((s) => s.nodeProgress[id] ?? 0)

  // 扩展节点的引脚是动态的：引脚类型取自扩展 schema 而非静态 nodeSpec。
  const ports = type === 'extensionNode' ? nodePorts(type, extensionId) : { inputs: spec.inputs, output: spec.output }
  const hasIn = ports.inputs.length > 0
  const hasOut = ports.output !== 'none'
  // 扩展节点按 category 取色：生视图模型(青绿)与生成建模(绿)区分。
  const nodeColor = type === 'extensionNode' ? extensionColor(getExtensionById(extensionId)) : spec.color
  // Blueprint 风格：引脚按「数据类型」着色（而不是按节点颜色）。
  const inType = ports.inputs[0] ?? 'any'
  const outType = ports.output
  // 流程/控制节点带白色执行引脚，插在顶栏两端（Unreal Blueprint exec 引脚）。
  const exec = isExecNode(type)

  return (
    <div className={`wf-node wf-node--${state}`} style={{ '--node-color': nodeColor } as CSSProperties}>
      {exec && (
        <>
          <Handle id={EXEC_IN_HANDLE} type="target" position={Position.Left} className="wf-handle wf-handle--exec" style={{ top: '8px' }} />
          <Handle id={EXEC_OUT_HANDLE} type="source" position={Position.Right} className="wf-handle wf-handle--exec" style={{ top: '8px' }} />
        </>
      )}
      {hasIn && (
        <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ background: portColor(inType) }} />
      )}
      {hasOut && (
        <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ background: portColor(outType) }} />
      )}
      <div className="wf-node__header">
        <BreakpointDot id={id} />
        <span className="wf-node__dot" style={{ background: nodeColor }} />
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

/** 端口类型标签（扩展节点 I/O 概览用）。 */
export function PortTag({ type }: { type: PortType }) {
  const c = portColor(type)
  return (
    <span className="wf-ext-tag" style={{ color: c, borderColor: `${c}44` }}>
      {type}
    </span>
  )
}

// ─── Parameter controls ───────────────────────────────────────────────────────

/** 子图编辑器参数补丁上下文：存在时（子图内），useParam 改为更新编辑器的本地
 *   nodes state，使参数编辑只作用于被编辑的子图文档，而不冒犯主画布。 */
export const SubgraphPatchContext = createContext<((nodeId: string, patch: Record<string, unknown>) => void) | null>(null)

/** 子图编辑器图操作上下文：在编辑器内时，展开/复制/删除等结构性操作应作用于
 *  草稿副本（本地 nodes/edges），而不是主画布。 */
export interface SubgraphOps {
  expand: (nodeId: string) => void
  duplicate: (ids: string[]) => void
  removeNodes: (ids: string[]) => void
}
/** 子图编辑器图操作上下文：编辑器内展开/复制/删除应作用于草稿副本，而不是主画布。 */
export const SubgraphOpsContext = createContext<SubgraphOps | null>(null)

/** 统一的参数写入入口：优先走子图补丁上下文，否则写主画布 store。 */
export function useParam(nodeId: string) {
  const updateNodeData = useWorkflowsStore((s) => s.updateNodeData)
  const subgraphPatch = useContext(SubgraphPatchContext)
  if (subgraphPatch) return (key: string, value: unknown) => subgraphPatch(nodeId, { [key]: value })
  return (key: string, value: unknown) => updateNodeData(nodeId, { [key]: value })
}

export function ImageFileButton({
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

  // 原生文件选择图片（Modly 对齐），与下方 MeshFileButton 对称。
  // 本机 Chromium 的 <input type=file> 会让渲染进程冻结（见 HANDOFF §6），
  // 因此图片改由主进程选择、再按路径导入。
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
 * 「加载 3D 网格」节点的原生文件选择按钮（Modly 对齐）。
 *
 * 与生成页的「导入 → 网格」流程一致：由 Electron 主进程弹出文件框、只回传
 * 绝对路径，后端经 `/optimize/import-by-path` 提供文件（或 trimesh 转换后的 GLB）。
 * 全程不涉及 Chromium 的 `<input type=file>`——在本机会令渲染进程冻结（见 HANDOFF §6）。
 */
export function MeshFileButton({ nodeId, label, current }: { nodeId: string; label: string; current?: string }) {
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

/** 迭代下标输出：把 ForEach / While 当前的迭代序号（0 起）接到数值/文本节点上。 */
export function IterIndexHandle() {
  return (
    <>
      <Handle
        id={ITER_INDEX_HANDLE}
        type="source"
        position={Position.Right}
        className="wf-handle"
        style={{ top: '86%', background: portColor('text') }}
      />
      <span className="wf-pin-label wf-pin-label--out" style={{ top: '86%' }}>
        Index
      </span>
    </>
  )
}

/** 通用多输入「运算/计算」节点外壳：N 个左侧数据引脚 + 单个 text 输出。 */
export function ComputeShell({
  id,
  nodeType,
  label,
  count,
  children
}: {
  id: string
  nodeType: string
  label: string
  count: number
  children?: ReactNode
}) {
  const spec = nodeSpec(nodeType)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  return (
    <div className={`wf-compute wf-node--${state}`} style={{ '--node-color': spec.color } as CSSProperties}>
      {Array.from({ length: count }, (_, i) => {
        const top = ((i + 1) / (count + 1)) * 100
        return (
          <Handle
            key={i}
            id={i === 0 ? IN_HANDLE : `in${i}`}
            type="target"
            position={Position.Left}
            className="wf-handle"
            style={{ top: `${top}%`, background: portColor('text') }}
          />
        )
      })}
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ top: '50%', background: portColor('text') }} />
      <div className="wf-node__header">
        <BreakpointDot id={id} />
        <span className="wf-node__dot" style={{ background: spec.color }} />
        <span className="wf-node__title">{label}</span>
      </div>
      <div className="wf-node__body">{children}</div>
    </div>
  )
}
