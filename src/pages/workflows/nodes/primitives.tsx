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
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
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
import { fullUrl, importImageByPath, importMeshByPath } from '../../../api'
import { useT } from '../../../i18n'
import { requestPinAdd } from '../pinAdd'

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

// ─── 连线状态（折叠时只保留"有连接"的引脚）──────────────────────────────────

/**
 * 该节点上**真正接了线**的 handle，target / source 分开记。
 *
 * 画布的 `edges` 是受控的（由 store 传入 `<ReactFlow>`），React Flow 会把它同步进
 * 自己的内部 store，所以这里读 store 就能拿到与画布一致的连线集合；
 * 子图编辑器有自己的 store，会自动读到草稿那份，不必区分两套来源。
 *
 * 历史工作流里 `targetHandle` 可能是 null（早期连主引脚时不写 handle），
 * 这种一律按主数据引脚计，免得折叠后"有连接的主引脚"被当成没连接藏起来。
 *
 * @param id 节点 id
 * @returns `targets` = 有入边的 target handle 集合；`sources` = 有出边的 source handle 集合
 */
export function useConnectedHandles(id: string): { targets: Set<string>; sources: Set<string> } {
  const edges = useStore((s) => s.edges)
  return useMemo(() => {
    const targets = new Set<string>()
    const sources = new Set<string>()
    for (const e of edges) {
      if (e.target === id) targets.add(e.targetHandle ?? IN_HANDLE)
      if (e.source === id) sources.add(e.sourceHandle ?? OUT_HANDLE)
    }
    return { targets, sources }
  }, [edges, id])
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

/** 通用节点外壳：标题栏（折叠/断点/色点/标题/运行状态）、执行与数据引脚、进度条。
 *
 *  可折叠（UE 蓝图式"收起来"）：传了 `onToggleCollapse` 就在标题栏右端出现一个朝上的
 *  小箭头，点一下把节点体收上去。折叠态下**只保留有连线的引脚** —— 空引脚折叠后既没有
 *  内容可看、也没有线可连，留着只会让相邻节点误以为这里还有接口。 */
export function NodeShell({
  id,
  type,
  label,
  children,
  extensionId,
  collapsed = false,
  onToggleCollapse
}: {
  id: string
  type: string
  label: string
  children?: ReactNode
  extensionId?: string | null
  /** 是否处于折叠态（由持有折叠状态的节点组件传入）。 */
  collapsed?: boolean
  /** 点击标题栏箭头时的回调；不给就不显示箭头（该节点不可折叠）。 */
  onToggleCollapse?: () => void
}) {
  const t = useT()
  const spec = nodeSpec(type)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const progress = useWorkflowRunStore((s) => s.nodeProgress[id] ?? 0)
  // 引脚是否"有连接"与节点体是否显示是同一份判据，故在壳里统一算。
  const conn = useConnectedHandles(id)

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

  // 折叠态：主引脚只在真有连线时保留。
  const showIn = hasIn && (!collapsed || conn.targets.has(IN_HANDLE))
  const showOut = hasOut && (!collapsed || conn.sources.has(OUT_HANDLE))
  const showExecIn = exec && (!collapsed || conn.targets.has(EXEC_IN_HANDLE))
  const showExecOut = exec && (!collapsed || conn.sources.has(EXEC_OUT_HANDLE))

  return (
    <div
      className={`wf-node wf-node--${state}${collapsed ? ' wf-node--collapsed' : ''}`}
      style={{ '--node-color': nodeColor } as CSSProperties}
    >
      {showExecIn && (
        <Handle id={EXEC_IN_HANDLE} type="target" position={Position.Left} className="wf-handle wf-handle--exec" style={{ top: '8px' }} />
      )}
      {showExecOut && (
        <Handle id={EXEC_OUT_HANDLE} type="source" position={Position.Right} className="wf-handle wf-handle--exec" style={{ top: '8px' }} />
      )}
      {showIn && (
        <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ background: portColor(inType) }} />
      )}
      {showOut && (
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
        {onToggleCollapse && (
          // 朝上的箭头 = 折起来；折叠后由 CSS 转 180° 朝下（= 展开）。
          <button
            type="button"
            className="wf-node__fold nodrag"
            title={t(collapsed ? 'workflows.nodes.expandNode' : 'workflows.nodes.collapseNode')}
            aria-label={t(collapsed ? 'workflows.nodes.expandNode' : 'workflows.nodes.collapseNode')}
            aria-expanded={!collapsed}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              // 不让节点拖拽 / 双击进子图接管这次点击。
              e.stopPropagation()
              onToggleCollapse()
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && hasIn && (
        <AddPinBtn nodeId={id} handleType="target" handleId={IN_HANDLE} style={{ left: -16, top: 'calc(50% - 24px)' }} />
      )}
      {!collapsed && hasOut && (
        <AddPinBtn nodeId={id} handleType="source" handleId={OUT_HANDLE} style={{ right: -16, top: 'calc(50% - 24px)' }} />
      )}
      <div className="wf-node__body">{children}</div>
      {state === 'running' && progress > 0 && progress < 1 && (
        <div className="wf-node__progress">
          <div className="wf-node__progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  )
}

/** 数据引脚的「+」快加节点按钮（UE 蓝图式快速插入）。点击后在引脚旁打开
 *  节点面板并自动接线。子图编辑器内不渲染——它的节点面板走 EditorBar。 */
function AddPinBtn({
  nodeId,
  handleType,
  handleId,
  style
}: {
  nodeId: string
  handleType: 'source' | 'target'
  handleId: string | null
  style: CSSProperties
}) {
  const inSubeditor = useContext(SubgraphPatchContext) !== null
  if (inSubeditor) return null
  return (
    <button
      className="wf-addpin"
      style={style}
      title="Add node"
      aria-label="Add node"
      onClick={(e) => {
        // 不让节点拖拽 / 节点双击接管这次点击。
        e.stopPropagation()
        requestPinAdd({ nodeId, handleType, handleId, clientX: e.clientX, clientY: e.clientY })
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
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
  url,
  onUploaded
}: {
  nodeId: string
  label: string
  current?: string
  /** 已导入图片的相对 URL（`data.params.url`）；有值时渲染缩略图与清除入口。 */
  url?: string
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
      const { url: nextUrl, fileName } = await importImageByPath(filePath)
      setParam('url', nextUrl)
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

  /** 撤销已选图片：url 与 fileName 一并置空，节点回到「未选择」状态。 */
  function clearImage(): void {
    setParam('url', '')
    setParam('fileName', '')
    onUploaded?.('')
    useLogsStore.getState().log('info', '[imageNode] cleared')
  }

  return (
    <div className="wf-upload">
      {url ? (
        <div className="wf-upload__preview">
          <img src={fullUrl(url)} alt={current || ''} />
          <button
            className="wf-upload__clear nodrag"
            onClick={clearImage}
            title={t('workflows.nodes.clearImage')}
            aria-label={t('workflows.nodes.clearImage')}
          >
            ✕
          </button>
        </div>
      ) : null}
      <button
        className="wf-upload__btn"
        disabled={busy}
        onClick={() => void pickFromDisk()}
      >
        {busy ? t('workflows.nodes.importing') : url ? t('workflows.nodes.replaceImage') : label}
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
