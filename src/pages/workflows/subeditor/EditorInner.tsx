/**
 * 子图编辑器的内部实现。
 *
 * 在同一张画布语义下打开子图：本地历史（与主画布隔离的撤销栈）、
 * 子图专属快捷键与右键菜单都在这里；外层的 index.tsx 只负责挂载与关闭。
 *
 * 结构（优化文档 7.3 拆分）：本地撤销栈在 useLocalHistory、图操作在
 * useGraphOps、右键菜单渲染在 NodeContextMenu；本文件保留画布组装与
 * 保存 / 快捷键 / 层级跳转的主体逻辑。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useOnSelectionChange,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import {
  allExtensions,
  extensionColor,
  nodeSpec,
  SUBGRAPH_INPUT_NODE,
  SUBGRAPH_OUTPUT_NODE,
  type WFEdge,
  type WFNode
} from '../../../types'
import { useAppStore } from '../../../stores/app'
import { useWorkflowsStore } from '../../../stores/workflows'
import { boundingBox, createNodeFromPayload, createSubgraphPin, PALETTE_NODES, attachToContainer } from '../canvasUtils'
import { CommentOpsContext, reconcileComments, setCommentCollapsed, type CommentOps } from '../commentUtils'
import {
  expandSubgraph,
  isFoldBlocked,
  normalizeSubgraphInputs,
  normalizeSubgraphOutputs
} from '../subgraphUtils'
import WorkflowEdge from '../WorkflowEdge'
import PinMenu, { pinFromEvent, type PinTarget } from '../PinMenu'
import { nodeTypes, SubgraphOpsContext, SubgraphPatchContext, type SubgraphOps } from '../nodes'
import { setSubEditorOpen } from '../subEditorState'
import { toast } from '../../../stores/toasts'
import { useT } from '../../../i18n'

import { EditorBar } from './EditorBar'
import { docAtPath, labelsAtPath } from './helpers'
import { NodeContextMenu } from './NodeContextMenu'
import { useGraphOps, warnViaLogs } from './useGraphOps'
import { useLocalHistory } from './useLocalHistory'
import type { Props } from './types'

const edgeTypes = { workflowEdge: WorkflowEdge }

/**
 * 子图编辑器内层组件。
 *
 * @param path 从根到当前子图层的 subgraph 节点 id 序列。
 * @param onClose 关闭编辑器回调。
 * @param onDescend 继续下钻一层回调。
 * @param onJump 跳到指定层级回调。
 */
export function EditorInner({ path, onClose, onDescend, onJump }: Props) {
  const t = useT()
  const theme = useAppStore((s) => s.theme)
  const current = useWorkflowsStore((s) => s.current)
  const replaceSubgraphGraph = useWorkflowsStore((s) => s.replaceSubgraphGraph)
  const renameSubgraphAt = useWorkflowsStore((s) => s.renameSubgraphAt)
  const { screenToFlowPosition, fitView } = useReactFlow()
  // 子图编辑器内 Alt 重连（UE 语义：新线替代指到同一输入口的旧线）。
  const connectAltRef = useRef(false)
  const canvasBg = theme === 'light' ? '#e9eef5' : '#0a0e18'
  const gridMinor = theme === 'light' ? 'rgba(30, 90, 150, 0.14)' : 'rgba(96, 165, 250, 0.1)'
  const gridMajor = theme === 'light' ? 'rgba(23, 90, 140, 0.26)' : 'rgba(125, 211, 252, 0.16)'
  const minimapMask = theme === 'light' ? 'rgba(46, 63, 92, 0.32)' : 'rgba(9, 13, 21, 0.75)'
  // 网格随缩放分级（与主画布同一套阈值：缩得越小格越粗）。
  const zoom = useStore((s) => s.transform[2])
  const gridMinorGap = zoom < 0.35 ? 80 : zoom < 0.7 ? 40 : zoom < 1.4 ? 20 : 10
  const gridMajorGap = gridMinorGap * 5

  const doc = useMemo(() => (current ? docAtPath(current.nodes, path) : null), [current, path])
  const crumbs = useMemo(() => (current ? labelsAtPath(current.nodes, path) : []), [current, path])

  // 本地编辑副本 + 本地撤销栈（拆出的 hook）。
  const history = useLocalHistory(doc?.nodes ?? [], doc?.edges ?? [])
  const { nodes, edges, setNodes, setEdges, histSizes, snapshot, undoLocal, redoLocal, reset } = history

  useEffect(() => {
    reset(doc?.nodes ?? [], doc?.edges ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, current?.id])

  // 编辑器打开期间主画布让出 Delete / Space 等全局键。
  useEffect(() => {
    setSubEditorOpen(true)
    return () => setSubEditorOpen(false)
  }, [])

  const subgraphPatch = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n))
    )
  }, [setNodes])

  // ─── 选择态（右键菜单 / 方向键微调都基于它）────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  useOnSelectionChange({
    onChange: useCallback((sel) => setSelectedIds(sel.nodes.map((n) => n.id)), [])
  })

  // ─── 图操作（复制 / 删除 / 编组 / 折叠）─────────────────────────────────────
  const ops2 = useGraphOps({
    nodes,
    edges,
    setNodes,
    setEdges,
    snapshot,
    clearSelection: () => setSelectedIds([]),
    onWarn: warnViaLogs
  })

  // ─── 子图内图操作（供嵌套 SubgraphNode 的"展开"按钮等复用）──────────────────
  const ops = useMemo<SubgraphOps>(
    () => ({
      expand: (nodeId) => {
        snapshot()
        const r = expandSubgraph(nodeId, nodes, edges)
        setNodes(r.nodes)
        setEdges(r.edges)
      },
      duplicate: (ids) => ops2.duplicateNodes(ids),
      removeNodes: (ids) => ops2.removeNodes(ids)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, snapshot, ops2]
  )

  // ─── 添加节点 / 挂点 ────────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const addItems = useMemo(() => {
    const base = PALETTE_NODES.map((n) => ({
      payload: n.payload,
      label: t(n.labelKey),
      color: nodeSpec(n.payload.slice('builtin:'.length)).color
    }))
    const exts = allExtensions().map((e) => ({
      payload: `extension:${e.id}`,
      label: e.display_name,
      color: extensionColor(e)
    }))
    const q = addQuery.trim().toLowerCase()
    const all = [...base, ...exts]
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addQuery, current])

  function canvasCenter(): { x: number; y: number } {
    const rect = document.querySelector('.wf-subeditor__canvas')?.getBoundingClientRect()
    return rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 }
  }

  function addAt(payload: string): void {
    const n = createNodeFromPayload(payload, canvasCenter())
    if (n) {
      snapshot()
      setNodes((ns) => [...ns, n])
    }
    setAddOpen(false)
    setAddQuery('')
  }

  const inputPins = nodes.filter((n) => n.type === SUBGRAPH_INPUT_NODE)
  const outputPins = nodes.filter((n) => n.type === SUBGRAPH_OUTPUT_NODE)

  /** 新增一个输入挂点（函数多一个入参）。 */
  function addInputPin(): void {
    snapshot()
    const pin = createSubgraphPin('in', inputPins.length, { x: 40, y: 40 + inputPins.length * 44 })
    setNodes((ns) => [...ns, pin])
    toast.success(t('workflows.toast.pinAdded'), { duration: 1500 })
  }

  /** 新增一个输出挂点（函数多一个出参）。 */
  function addOutputPin(): void {
    const box = boundingBox(nodes)
    snapshot()
    const pin = createSubgraphPin('out', outputPins.length, {
      x: box ? box.x + box.w + 120 : 520,
      y: 40 + outputPins.length * 44
    })
    setNodes((ns) => [...ns, pin])
    toast.success(t('workflows.toast.pinAdded'), { duration: 1500 })
  }

  function handleNodeDoubleClick(_e: unknown, node: WFNode): void {
    if (node.type === 'subgraphNode') onDescend(node.id)
  }

  // ─── 保存（规范化挂点 → 落盘 → 同步到全部实例）──────────────────────────────
  function save(): void {
    const prevIns = doc?.inputs ?? []
    const prevOuts = doc?.outputs ?? (doc?.out ? [doc.out] : [])
    // 挂点顺序即索引：保存前按当前排列重排一次，保证 handle 下标与显示顺序一致。
    const ordered = [
      ...nodes.filter((n) => n.id.startsWith('subin-') || n.id.startsWith('subout-')),
      ...nodes.filter((n) => !(n.id.startsWith('subin-') || n.id.startsWith('subout-')))
    ]
    replaceSubgraphGraph(
      path,
      ordered,
      edges,
      normalizeSubgraphOutputs(nodes, edges, prevOuts),
      normalizeSubgraphInputs(nodes, edges, prevIns)
    )
  }

  function saveAndClose(): void {
    save()
    onClose()
  }

  const onNodesChange = useCallback(
    (cs: NodeChange<WFNode>[]) => {
      // 结构性变更（删除/新增）前入栈一步；纯位置变化由 onNodeDragStart 负责。
      if (cs.some((c) => c.type === 'remove' || c.type === 'add')) snapshot()
      setNodes((ns) => applyNodeChanges(cs, ns))
      // 注释框缩放结束（React Flow 在松手时补一发 resizing:false）→ 重算框内节点归属。
      if (cs.some((c) => c.type === 'dimensions' && c.resizing === false)) {
        setNodes((ns) => reconcileComments(ns))
      }
    },
    [snapshot, setNodes]
  )
  const onEdgesChange = useCallback(
    (cs: EdgeChange<WFEdge>[]) => {
      if (cs.some((c) => c.type === 'remove' || c.type === 'add')) snapshot()
      setEdges((es) => applyEdgeChanges(cs, es))
    },
    [snapshot, setEdges]
  )

  const flowNodes = useMemo(() => nodes, [nodes])
  const flowEdges = useMemo(() => edges.map((e) => ({ ...e, type: e.type ?? 'workflowEdge' })), [edges])

  // 注释框操作作用于本地草稿（与主画布写 store 的版本行为一致）。
  const commentOps = useMemo<CommentOps>(
    () => ({ toggleCollapse: (id, collapsed) => setNodes((ns) => setCommentCollapsed(ns, id, collapsed)) }),
    [setNodes]
  )

  // 拖拽落点决定归属：While 容器 / 注释框都按"中心点落在谁里面"重算一次。
  function handleNodeDragStop(_e: unknown, dragged: WFNode): void {
    setNodes((ns) => reconcileComments(attachToContainer(ns, dragged)))
  }

  // ─── 键盘：Esc 关闭 / Ctrl+Z 本地撤销 / 方向键微调选中节点 ───────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redoLocal()
        else undoLocal()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redoLocal()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        saveAndClose()
        return
      }
      // UE 蓝图快捷键（针对子图内选中）：F = 帧选中；C = 收进注释框。
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        const groupable = nodes.filter((n) => selectedIds.includes(n.id) && !isFoldBlocked(n))
        fitView({ nodes: groupable.length > 0 ? groupable : nodes, padding: 0.3, duration: 250 })
        return
      }
      if (e.key === 'c' || e.key === 'C') {
        if (selectedIds.length === 0) return
        e.preventDefault()
        ops2.groupAsComment(selectedIds, t('workflows.palette.commentLabel'))
        return
      }
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }
      const d = dirs[e.key]
      if (!d || selectedIds.length === 0) return
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      setNodes((ns) =>
        ns.map((n) =>
          selectedIds.includes(n.id)
            ? { ...n, position: { x: n.position.x + d[0] * step, y: n.position.y + d[1] * step } }
            : n
        )
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, nodes, edges, path, undoLocal, redoLocal, fitView, ops2])

  // ─── 右键菜单 ──────────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null)
  // 拖拽连线中：高亮可连接引脚（与主画布同一套 CSS）。
  const [connecting, setConnecting] = useState(false)
  // 引脚右键菜单（断开单条连线）。
  const [pinMenu, setPinMenu] = useState<PinTarget | null>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent): void => {
      const el = document.querySelector('.wf-node-menu')
      if (el && el.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  function handleNodeContextMenu(e: ReactMouseEvent, node: WFNode): void {
    e.preventDefault()
    const ids = selectedIds.includes(node.id) ? selectedIds : [node.id]
    setCtxMenu({ x: e.clientX, y: e.clientY, ids })
  }

  /** 引脚的右键在捕获阶段先被拦下（不再触发节点右键菜单）。 */
  function handlePinContextMenu(e: ReactMouseEvent): void {
    const pin = pinFromEvent(e)
    if (!pin) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu(null)
    setPinMenu(pin)
  }

  /** 连线另一端的节点名（引脚菜单里用来标识是哪条线）。 */
  function nodeLabelOf(id: string): string {
    return String(nodes.find((n) => n.id === id)?.data.label ?? id)
  }

  /** 断点开关：直接改本地草稿的 params.breakpoint，保存后随函数体一起写回。 */
  function toggleBreakpoint(id: string): void {
    const cur = nodes.find((n) => n.id === id)
    if (!cur) return
    snapshot()
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, params: { ...n.data.params, breakpoint: !n.data.params.breakpoint } } }
          : n
      )
    )
    setCtxMenu(null)
  }

  const ctxFoldable = !!ctxMenu && ctxMenu.ids.length >= 2 && !nodes.filter((n) => ctxMenu.ids.includes(n.id)).some(isFoldBlocked)
  const ctxSingle = ctxMenu && ctxMenu.ids.length === 1 ? nodes.find((n) => n.id === ctxMenu.ids[0]) : undefined
  const ctxComment = ctxSingle?.type === 'commentNode' ? ctxSingle : undefined

  /** 跳到路径的某一层；跳转前先落盘当前草稿，避免丢失改动。 */
  function jumpTo(level: number): void {
    if (level >= path.length) return
    save()
    if (level === 0) onClose()
    else if (onJump) onJump(path.slice(0, level))
  }

  return (
    <div className="wf-subeditor">
      <EditorBar
        saveAndClose={saveAndClose}
        histSizes={histSizes}
        undoLocal={undoLocal}
        redoLocal={redoLocal}
        current={current}
        crumbs={crumbs}
        path={path}
        renameSubgraphAt={renameSubgraphAt}
        jumpTo={jumpTo}
        inputPins={inputPins}
        outputPins={outputPins}
        addInputPin={addInputPin}
        addOutputPin={addOutputPin}
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        addQuery={addQuery}
        setAddQuery={setAddQuery}
        addItems={addItems}
        addAt={addAt}
      />

      <SubgraphPatchContext.Provider value={subgraphPatch}>
        <SubgraphOpsContext.Provider value={ops}>
          <CommentOpsContext.Provider value={commentOps}>
          <div
            className="wf-subeditor__canvas"
            data-connecting={connecting ? '1' : undefined}
            onContextMenuCapture={handlePinContextMenu}
          >
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              // UE 蓝图式：Alt + 左键点击连线 → 打断该连线（作用于本地草稿，先入栈可撤销）。
              onEdgeClick={(e, edge) => {
                if (e.altKey) {
                  snapshot()
                  setEdges((es) => es.filter((x) => x.id !== edge.id))
                }
              }}
              onNodeDragStart={() => snapshot()}
              onNodeDragStop={handleNodeDragStop}
              onConnectStart={(e) => {
                setConnecting(true)
                // onConnect 拿不到原始事件，只能在按下瞬间捕捉 Alt。
                connectAltRef.current = e instanceof MouseEvent && e.altKey
              }}
              onConnectEnd={() => setConnecting(false)}
              onConnect={(c: Connection) => {
                // UE 蓝图语义：按住 Alt 连到已占用的输入口 → 新线替代旧线。
                if (connectAltRef.current && c.target) {
                  setEdges((es) => es.filter((x) => !(x.target === c.target && x.targetHandle === c.targetHandle)))
                }
                connectAltRef.current = false
                snapshot()
                setEdges((es) => [...es, { id: `e-${crypto.randomUUID()}`, ...c, animated: false }])
              }}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeContextMenu={handleNodeContextMenu}
              defaultEdgeOptions={{ type: 'workflowEdge' }}
              // UE 蓝图式交互：左键拖空白=框选，中键/空格+拖拽=平移画布（空格平移为 ReactFlow 内置）。
              selectionOnDrag
              panOnDrag={[1]}
              selectionKeyCode="Shift"
              deleteKeyCode="Delete"
              multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
              fitView
              minZoom={0.2}
            >
              <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={gridMinorGap} lineWidth={1} color={gridMinor} />
              <Background id="grid-major" variant={BackgroundVariant.Lines} gap={gridMajorGap} lineWidth={1} color={gridMajor} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => nodeSpec(n.type ?? '').color} maskColor={minimapMask} style={{ backgroundColor: canvasBg }} />
            </ReactFlow>

            {/* 引脚右键：断开该引脚上的单条连线。 */}
            {pinMenu && (
              <PinMenu
                pin={pinMenu}
                edges={edges}
                labelOf={nodeLabelOf}
                onDelete={(ids) => {
                  snapshot()
                  const idSet = new Set(ids)
                  setEdges((es) => es.filter((e) => !idSet.has(e.id)))
                }}
                onClose={() => setPinMenu(null)}
              />
            )}

            {/* 子图内的节点右键菜单（与主画布一致的操作集） */}
            {ctxMenu && (
              <NodeContextMenu
                x={ctxMenu.x}
                y={ctxMenu.y}
                ids={ctxMenu.ids}
                ctxFoldable={ctxFoldable}
                ctxSingle={ctxSingle}
                ctxComment={ctxComment}
                onDuplicate={() => { ops.duplicate(ctxMenu.ids); setCtxMenu(null) }}
                onRemove={() => { ops.removeNodes(ctxMenu.ids); setCtxMenu(null) }}
                onGroupComment={() => { ops2.groupAsComment(ctxMenu.ids, t('workflows.palette.commentLabel')); setCtxMenu(null) }}
                onFold={() => { ops2.foldSelection(ctxMenu.ids); setCtxMenu(null) }}
                onToggleCommentCollapse={() => {
                  commentOps.toggleCollapse(ctxComment!.id, !ctxComment!.data?.params?.collapsed)
                  setCtxMenu(null)
                }}
                onExpandSubgraph={() => { ops.expand(ctxSingle!.id); setCtxMenu(null) }}
                onToggleBreakpoint={() => toggleBreakpoint(ctxMenu.ids[0])}
                onClose={() => setCtxMenu(null)}
              />
            )}
          </div>
        </CommentOpsContext.Provider>
        </SubgraphOpsContext.Provider>
      </SubgraphPatchContext.Provider>

      <div className="wf-subeditor__hint">{t('workflows.subeditor.hint')}</div>
    </div>
  )
}
