/**
 * 工作流画布主组件（React Flow 封装）。
 *
 * 编排节点渲染、连线合法性、选择 / 框选、右键菜单、调色板拖入、键盘快捷键
 * 与容器折叠等交互。坐标换算遵循 React Flow 的约定：屏幕坐标须经
 * `flowInstance.screenToFlowPosition` 转换，切勿直接用 clientX/Y 比对节点位置。
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useOnSelectionChange,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import {
  IN_HANDLE,
  OUT_HANDLE,
  allExtensions,
  extensionColor,
  isContainerType,
  nodePorts,
  nodeSpec,
  portCompatible,
  type WFEdge,
  type WFNode
} from '../../../types'
import { useAppStore } from '../../../stores/app'
import { useLogsStore } from '../../../stores/logs'
import { toast } from '../../../stores/toasts'
import { useWorkflowsStore } from '../../../stores/workflows'
import { uploadFile } from '../../../api'
import { getT, useT } from '../../../i18n'
import WorkflowEdge from '../WorkflowEdge'
import PinMenu, { pinFromEvent, type PinTarget } from '../PinMenu'
import { nodeTypes } from '../nodes'
import { createNodeFromPayload, containerAtScreen, boundingBox, attachToContainer, PALETTE_NODES } from '../canvasUtils'
import { collapseToSubgraph, expandSubgraph } from '../subgraphUtils'
import { CommentOpsContext, reconcileComments, setCommentCollapsed, type CommentOps } from '../commentUtils'
import { useSubEditorOpen } from '../subEditorState'
import { ConnMenu } from './ConnMenu'
import { NodePalette, type PaletteItem, type PaletteRow } from './NodePalette'
import { ContextMenu } from './ContextMenu'
import { makeIsValidConnection } from './validConnection'

const edgeTypes = { workflowEdge: WorkflowEdge }

/**
 * Canvas 外壳：只负责把"注释框操作"注入节点树。
 * CommentNode 是主画布与子图编辑器共用的组件，两者的图状态分别落在 store 与本地草稿里，
 * 所以折叠/展开这类"要同时改注释框与其成员"的动作通过 context 下传，节点组件本身不碰 store。
 */
function Canvas({ onOpenSubgraph }: { onOpenSubgraph?: (id: string) => void }) {
  const replaceNodes = useWorkflowsStore((s) => s.replaceNodes)
  const commentOps = useMemo<CommentOps>(
    () => ({
      toggleCollapse: (id, collapsed) => {
        const nds = useWorkflowsStore.getState().current?.nodes
        if (!nds) return
        replaceNodes(setCommentCollapsed(nds, id, collapsed))
      }
    }),
    [replaceNodes]
  )
  return (
    <CommentOpsContext.Provider value={commentOps}>
      <CanvasInner onOpenSubgraph={onOpenSubgraph} />
    </CommentOpsContext.Provider>
  )
}

function CanvasInner({ onOpenSubgraph }: { onOpenSubgraph?: (id: string) => void }) {
  const { screenToFlowPosition } = useReactFlow()
  const t = useT()
  const commentOps = useContext(CommentOpsContext)
  const theme = useAppStore((s) => s.theme)
  const canvasBg = theme === 'light' ? '#e9eef5' : '#0a0e18'
  // 蓝图图纸：细小网格 + 强调的主网格，随画布一起平移与缩放，
  // 如同真正的绘图纸。
  const gridMinor = theme === 'light' ? 'rgba(30, 90, 150, 0.14)' : 'rgba(96, 165, 250, 0.1)'
  const gridMajor = theme === 'light' ? 'rgba(23, 90, 140, 0.26)' : 'rgba(125, 211, 252, 0.16)'
  const minimapMask = theme === 'light' ? 'rgba(46, 63, 92, 0.32)' : 'rgba(9, 13, 21, 0.75)'
  const current = useWorkflowsStore((s) => s.current)
  // 画布缩放：驱动网格密度分级（只关心 zoom，平移不会触发重渲染）。
  const zoom = useStore((s) => s.transform[2])
  // Blueprint 网格分级：缩得越小格越粗（否则糊成一片），放大后才露出更细的格。
  const gridMinorGap = zoom < 0.35 ? 80 : zoom < 0.7 ? 40 : zoom < 1.4 ? 20 : 10
  const gridMajorGap = gridMinorGap * 5
  const applyNodeChanges = useWorkflowsStore((s) => s.applyNodeChanges)
  const applyEdgeChanges = useWorkflowsStore((s) => s.applyEdgeChanges)
  const connect = useWorkflowsStore((s) => s.connect)
  const addNode = useWorkflowsStore((s) => s.addNode)
  const replaceNodes = useWorkflowsStore((s) => s.replaceNodes)
  const replaceGraph = useWorkflowsStore((s) => s.replaceGraph)
  const duplicateNodes = useWorkflowsStore((s) => s.duplicateNodes)

  const canvasRef = useRef<HTMLDivElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  // 拖线建连（与 Modly 对齐）：从 handle 拖到空白画布，会在落点弹出
  // 一个精简节点列表，只列端口兼容的节点；选中即在原地创建节点
  // 并自动接上连线。
  const pendingConnectionRef = useRef<{ nodeId: string; handleType: string | null; handleId: string | null } | null>(null)
  const connectionCompletedRef = useRef(false)
  const [pendingDropPos, setPendingDropPos] = useState<{ x: number; y: number } | null>(null)
  const [connIndex, setConnIndex] = useState(0)
  // Space 调色板的当前行（↑↓ 导航，与 Modly NodePalette 对齐）。
  const [paletteIndex, setPaletteIndex] = useState(0)
  // 从桌面拖入外部图片：显示放置提示，松手时自动搭出一套可运行骨架
  // （Image 节点 + 首个模型扩展 + 连线）。
  const [fileDragging, setFileDragging] = useState(false)
  // 蓝图式注释分组：记录选中的节点 id，以便提供"包进注释框"动作。
  // "group as comment" action that boxes the selection into a named Comment node.
  // useOnSelectionChange 与渲染身份保持解耦——若改用 onSelectionChange
  // prop，每次重渲染都会重新触发（edges 每次渲染都是新数组），
  // 会引发无限的 setState 循环。
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  useOnSelectionChange({
    onChange: useCallback((sel) => {
      setSelectedIds(sel.nodes.map((n) => n.id))
    }, [])
  })
  // 蓝图"上下文相关动作"：右键节点 → 针对该选择的动作；
  // 右键空白画布 → 针对整图的动作。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [ctxTarget, setCtxTarget] = useState<'node' | 'pane'>('pane')
  const [ctxNodeIdState, setCtxNodeIdState] = useState<string | null>(null)
  // 拖拽连线中：给画布挂 data-connecting，CSS 借此高亮所有"可连接引脚"（悬停预览）。
  const [connecting, setConnecting] = useState(false)
  // 引脚右键菜单（断开单条连线）。
  const [pinMenu, setPinMenu] = useState<PinTarget | null>(null)
  // 子图编辑器打开时主画布让出键盘（否则 Delete 会同时命中两层画布）。
  const subEditorOpen = useSubEditorOpen()
  // 方向键微调连按时只在第一次入栈，避免每个像素都产生一条撤销记录。
  const nudgingRef = useRef(false)

  function closePalette(): void {
    pendingConnectionRef.current = null
    setPendingDropPos(null)
    setPaletteOpen(false)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (subEditorOpen) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        if (e.key === 'Escape') (target as HTMLInputElement).blur()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        setPaletteQuery('')
        setPaletteIndex(0)
        setPaletteOpen((v) => !v)
      } else if (e.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subEditorOpen])

  // 方向键微调选中节点（Shift = 10px/次），与 Blueprint 的键盘微移一致。
  useEffect(() => {
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (subEditorOpen) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      const d = dirs[e.key]
      if (!d || selectedIds.length === 0) return
      const cur = useWorkflowsStore.getState().current
      if (!cur) return
      e.preventDefault()
      if (!nudgingRef.current) {
        useWorkflowsStore.getState().pushHistory()
        nudgingRef.current = true
      }
      const step = e.shiftKey ? 10 : 1
      const ids = new Set(selectedIds)
      const changes = cur.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => ({
          id: n.id,
          type: 'position' as const,
          position: { x: n.position.x + d[0] * step, y: n.position.y + d[1] * step }
        }))
      if (changes.length > 0) applyNodeChanges(changes)
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (!dirs[e.key]) return
      // 微调结束：节点可能被推入 / 推出了注释框，重算一次归属（静默，不入栈）。
      if (nudgingRef.current) {
        const nds = useWorkflowsStore.getState().current?.nodes
        if (nds) {
          const next = reconcileComments(nds)
          if (next !== nds) replaceNodes(next, { history: false })
        }
        // 与拖拽同理：位置变更不逐帧标记脏，微调结束补一次自动保存。
        useWorkflowsStore.getState().markDirty()
      }
      nudgingRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [selectedIds, subEditorOpen, applyNodeChanges, replaceNodes])

  // 从拖线打开时，调色板只列出端口与待连连线兼容的节点
  // （与 Modly 对齐）。扩展节点以 schema 驱动的端口参与过滤，
  // 过滤逻辑与内置节点走同一条路径。
  const pendingConn = pendingConnectionRef.current
  // 编程/逻辑节点归入独立分组（UE 感：基础 IO / 逻辑 / 生成 / 处理）。
  const logicTypes = new Set([
    'variableNode', 'variableGetNode', 'variableSetNode',
    'eventCallNode', 'eventBindNode',
    'isValidNode', 'isEmptyNode', 'boolNode', 'mathNode',
    'compareNode', 'concatNode', 'castNode', 'clampNode', 'lerpNode', 'randomNode',
    'makeStructNode', 'breakStructNode',
    'gateNode', 'waitNode', 'branchNode',
    'sequenceNode', 'whileNode', 'forEachNode', 'rerouteNode', 'selectNode'
  ])
  const paletteItems: PaletteItem[] = [
    ...PALETTE_NODES.map((n) => {
      const type = n.payload.slice('builtin:'.length)
      return {
        payload: n.payload,
        label: t(n.labelKey),
        hint: t(n.hintKey),
        group: logicTypes.has(type) ? 'logic' : 'basic',
        ports: nodePorts(type)
      }
    }),
    ...allExtensions().map((e) => ({
      payload: `extension:${e.id}`,
      label: e.display_name,
      hint: t(e.kind === 'model' ? 'workflows.palette.kindGenerate' : 'workflows.palette.kindTools'),
      group: e.kind === 'process' ? 'process' : e.category === 'multiview' ? 'multiview' : e.category === 'image' ? 'image' : 'mesh',
      ports: { inputs: e.input === 'none' ? [] : [e.input], output: e.output }
    }))
  ].filter((n) => {
    const q = paletteQuery.trim().toLowerCase()
    if (q && !n.label.toLowerCase().includes(q) && !n.hint.includes(q)) return false
    if (!pendingConn) return true
    const cur = useWorkflowsStore.getState().current
    if (!cur) return true
    const sourceNode = cur.nodes.find((x) => x.id === pendingConn.nodeId)
    if (!sourceNode) return true
    if (pendingConn.handleType === 'source') {
      // 新节点作为待连连线的目标端。
      const out = nodePorts(sourceNode.type, sourceNode.data?.extensionId).output
      const targetIn = n.ports.inputs[0]
      return targetIn !== undefined && portCompatible(out, targetIn)
    }
    // 新节点作为待连连线的源端。
    const out = n.ports.output
    const targetIn = nodePorts(sourceNode.type, sourceNode.data?.extensionId).inputs[0]
    if (out === 'none' || targetIn === undefined) return false
    if (!portCompatible(out, targetIn)) return false
    // 单输入规则：目标 handle 必须空闲。
    const handleId = pendingConn.handleId ?? undefined
    return !cur.edges.some((e) => e.target === sourceNode.id && e.targetHandle === handleId)
  })

  // Space 调色板的分组标题 + 分类配色。仅当以普通方式打开调色板
  // （无搜索、非拖线）时才显示标题；条目的选择顺序与 `paletteItems`
  // 完全一致，保证键盘导航不受影响。
  const groupLabelFor: Record<string, string> = {
    basic: t('workflows.panel.groupBasic'),
    logic: t('workflows.panel.groupLogic'),
    mesh: t('workflows.panel.groupGenerators'),
    multiview: t('workflows.panel.groupMultiview'),
    image: t('workflows.panel.groupImageModels'),
    process: t('workflows.panel.groupMeshTools')
  }
  const showGroupHeaders = paletteQuery.trim() === '' && !pendingConn
  const paletteRows: PaletteRow[] = []
  {
    let last: string | undefined
    let sel = 0
    for (const it of paletteItems) {
      if (showGroupHeaders && it.group !== last) {
        paletteRows.push({ key: `grp-${it.group}`, group: it.group, selIdx: -1 })
        last = it.group
      }
      paletteRows.push({ key: it.payload, item: it, selIdx: sel++ })
    }
  }
  const paletteDotColor = (payload: string): string =>
    payload.startsWith('extension:')
      ? extensionColor(allExtensions().find((e) => e.id === payload.slice('extension:'.length)))
      : nodeSpec(payload.slice('builtin:'.length)).color

  // 调色板键盘导航。拖线列表：↑↓ 在兼容节点间移动、Enter 选中。
  // Space 调色板：同样的按键，但有自己的当前行状态，由其 onKeyDown
  // (Modly NodePalette parity). When the Space search box is focused its own
  // 驱动导航（window 处理器会跳过它，避免双重触发）。
  useEffect(() => {
    if (!paletteOpen) return
    const onKey = (e: KeyboardEvent): void => {
      const count = paletteItems.length
      const inSearch = !!(e.target as HTMLElement).classList?.contains('wf-palette__search')
      // Space 调色板的搜索框聚焦时独占按键（其 onKeyDown
      // 负责 ↑↓/Enter/Escape）——此处跳过以免双重触发。
      if (!pendingConn && inSearch) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (count === 0) return
        const step = (i: number): number => (e.key === 'ArrowDown' ? Math.min(i + 1, count - 1) : Math.max(i - 1, 0))
        if (pendingConn) {
          e.preventDefault()
          setConnIndex(step)
        } else {
          e.preventDefault()
          setPaletteIndex(step)
        }
        return
      }
      if (e.key === 'Enter') {
        const item = paletteItems[pendingConn ? connIndex : paletteIndex]
        if (item) {
          e.preventDefault()
          addAtCenter(item.payload)
        }
        return
      }
      if (e.key === 'Escape') closePalette()
    }
    const onDown = (e: MouseEvent): void => {
      if (!pendingConn) return
      const el = document.querySelector('.wf-conn-menu')
      if (el && el.contains(e.target as Node)) return
      closePalette()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, pendingConn, connIndex, paletteIndex, paletteItems])

  function addAtCenter(payload: string): void {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const dropScreen = pendingDropPos ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    const position = screenToFlowPosition(dropScreen)
    const node = spawnNode(payload, position, dropScreen.x, dropScreen.y)
    // 若调色板由拖线打开，则自动接线。
    const pending = pendingConnectionRef.current
    if (pending && node) {
      if (pending.handleType === 'source') {
        connect({ source: pending.nodeId, sourceHandle: OUT_HANDLE, target: node.id, targetHandle: IN_HANDLE })
      } else if (pending.handleType === 'target') {
        connect({ source: node.id, sourceHandle: OUT_HANDLE, target: pending.nodeId, targetHandle: pending.handleId ?? IN_HANDLE })
      }
    }
    closePalette()
  }

  /** 创建节点；若落在 While 容器内则自动挂到该容器下。 */
  function spawnNode(
    payload: string,
    position: { x: number; y: number },
    clientX?: number,
    clientY?: number
  ): WFNode | null {
    const node = createNodeFromPayload(payload, position)
    if (!node) return null
    // 容器 / 注释框落到别的分组里没有意义（注释框不嵌套），只对普通节点做挂载。
    if (node.type !== 'commentNode' && !isContainerType(node.type) && clientX !== undefined && clientY !== undefined) {
      const parent = containerAtScreen(clientX, clientY)
      if (parent) {
        node.parentId = parent.id
        node.position = { x: position.x - parent.position.x, y: position.y - parent.position.y }
      }
    }
    addNode(node)
    return node
  }

  // 把外部图片文件拖到画布上 → 自动创建一条可即跑的图片 → 模型骨架。
  // 优先取第一个已安装的 model 类扩展；若一个都没有，
  // 则回退到旧的 `generatorNode`（mock 浮雕）。
  const handleFileDrop = useCallback(
    (file: File, clientX: number, clientY: number) => {
      if (!file.type.startsWith('image/')) {
        useLogsStore.getState().log('warn', `Ignoring non-image file: ${file.name}`)
        return
      }

      const position = screenToFlowPosition({ x: clientX, y: clientY })
      const parent = containerAtScreen(clientX, clientY)
      const imagePos = parent
        ? { x: position.x - parent.position.x, y: position.y - parent.position.y }
        : position
      const MODEL_OFFSET_X = 260
      const modelPos = parent
        ? { x: imagePos.x + MODEL_OFFSET_X, y: imagePos.y }
        : { x: position.x + MODEL_OFFSET_X, y: position.y }

      useLogsStore.getState().log('info', `Uploading image ${file.name}…`)

      void uploadFile(file)
        .then(({ url, fileName }) => {
          // 1. Image node at the drop point.
          const imageId = crypto.randomUUID()
          addNode({
            id: imageId,
            type: 'imageNode',
            position: imagePos,
            ...(parent ? { parentId: parent.id } : {}),
            data: {
              label: fileName,
              color: nodeSpec('imageNode').color,
              params: { url, fileName }
            }
          })

          // 2. Model node — prefer the first installed model extension.
          const firstModel = allExtensions().find((e) => e.kind === 'model')
          let modelId: string
          let modelLabel: string
          if (firstModel) {
            modelId = crypto.randomUUID()
            addNode({
              id: modelId,
              type: 'extensionNode',
              position: modelPos,
              ...(parent ? { parentId: parent.id } : {}),
              data: {
                label: firstModel.display_name,
                color: nodeSpec('extensionNode').color,
                params: {},
                extensionId: firstModel.id
              }
            })
            modelLabel = firstModel.display_name
          } else {
            const fallback = createNodeFromPayload('builtin:generatorNode', modelPos)
            if (!fallback) {
              useLogsStore.getState().log('error', 'No model extension found, and generatorNode creation failed')
              return
            }
            if (parent) {
              fallback.parentId = parent.id
            }
            addNode(fallback)
            modelId = fallback.id
            modelLabel = String(fallback.data.label ?? 'Generate Mesh')
          }

          // 3. Wire Image.out → Model.in.
          connect({
            source: imageId,
            sourceHandle: OUT_HANDLE,
            target: modelId,
            targetHandle: IN_HANDLE
          })

          useLogsStore.getState().log('info', `Created workflow: Image → ${modelLabel}`)
        })
        .catch((err: unknown) => {
          useLogsStore.getState().log(
            'error',
            `Upload failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    },
    [screenToFlowPosition, addNode, connect]
  )

  // 注释框的"带上框内节点"不再手工平移：框内节点在拖拽落点时被收编为注释框的子节点
  // （parentId + 相对坐标），之后由 React Flow 原生跟随父节点移动，缩放/平移都不会掉队。
  function handleNodeDragStart(): void {
    useWorkflowsStore.getState().pushHistory()
  }

  // 拖拽落点决定归属：
  //  - While 容器：中心点落在容器内则成为其子节点（Modly 容器语义）
  //  - 注释框：中心点落在框内则收编，被拖出框外则释放回顶层（Unreal Comment 语义）
  function handleNodeDragStop(_e: unknown, dragged: WFNode): void {
    const cur = useWorkflowsStore.getState().current
    if (!cur) return
    // onNodeDragStart 已经入过栈，这里静默写入避免一次拖拽产生两条撤销记录。
    const next = reconcileComments(attachToContainer(cur.nodes, dragged))
    if (next !== cur.nodes) replaceNodes(next, { history: false })
    // 位置变更不再逐帧标记脏（见 store.applyNodeChanges），拖拽结束统一补一次自动保存。
    useWorkflowsStore.getState().markDirty()
  }

  // 注释框被删除时，框内节点"释放"为顶层节点（保留），不跟着一起消失；
  // 但显式选中一起删的节点照删（显式选择优先）。
  function handleBeforeDelete({ nodes: doomed, edges: doomedEdges }: { nodes: WFNode[]; edges: WFEdge[] }): Promise<{
    nodes: WFNode[]
    edges: WFEdge[]
  }> {
    const groups = doomed.filter((n) => isContainerType(n.type) || n.type === 'commentNode')
    if (groups.length === 0) return Promise.resolve({ nodes: doomed, edges: doomedEdges })
    const groupIds = new Set(groups.map((c) => c.id))
    const groupById = new Map(groups.map((c) => [c.id, c]))
    const doomedIds = new Set(doomed.map((n) => n.id))

    const cur = useWorkflowsStore.getState().current
    const rescued =
      cur?.nodes.filter((n) => n.parentId && groupIds.has(n.parentId) && !doomedIds.has(n.id)) ?? []
    const rescuedIds = new Set(rescued.map((n) => n.id))
    if (rescued.length > 0 && cur) {
      const next = cur.nodes.map((n) => {
        if (!(n.parentId && groupIds.has(n.parentId))) return n
        const group = groupById.get(n.parentId)!
        const { parentId: _p, extent: _ext, ...rest } = n
        return {
          ...rest,
          hidden: false,
          position: { x: group.position.x + n.position.x, y: group.position.y + n.position.y }
        }
      })
      replaceNodes(next, { history: false })
    }

    const deletedNodes = doomed.filter((n) => !rescuedIds.has(n.id))
    const deletedIds = new Set(deletedNodes.map((n) => n.id))
    const edges = doomedEdges.filter((e) => deletedIds.has(e.source) || deletedIds.has(e.target))
    return Promise.resolve({ nodes: deletedNodes, edges })
  }

  // 连线拖拽 → 调色板（Modly 对等交互）。正常落到另一个引脚则无事发生；落到空白画布
  // 才弹出兼容节点清单。
  function handleConnectStart(_e: unknown, params: { nodeId: string | null; handleType: string | null; handleId: string | null }): void {
    pendingConnectionRef.current = {
      nodeId: params.nodeId ?? '',
      handleType: params.handleType,
      handleId: params.handleId ?? null
    }
    connectionCompletedRef.current = false
    setConnecting(true)
  }

  function handleConnectEnd(e: MouseEvent | TouchEvent): void {
    setConnecting(false)
    if (connectionCompletedRef.current || !pendingConnectionRef.current?.nodeId) {
      pendingConnectionRef.current = null
      return
    }
    const target = e.target as Element
    // 落在真实 handle 或普通节点上 → 不弹调色板。While 容器的
    // 空腔视为空白画布（它本身是一个巨型节点）。
    const nodeEl = target.closest('.react-flow__node')
    const onContainer = !!nodeEl?.classList.contains('react-flow__node-whileNode')
    if (target.closest('.react-flow__handle') || (nodeEl && !onContainer)) {
      pendingConnectionRef.current = null
      return
    }
    const clientX = 'clientX' in e ? e.clientX : (e as TouchEvent).changedTouches[0].clientX
    const clientY = 'clientY' in e ? e.clientY : (e as TouchEvent).changedTouches[0].clientY
    setPendingDropPos({ x: clientX, y: clientY })
    setConnIndex(0)
    setPaletteQuery('')
    setPaletteOpen(true)
  }

  // 可成组的选中节点：排除注释框与 While 容器（它们是结构 / 锚点类型，不该被框起来）。
  const groupableNodes = (current?.nodes ?? []).filter(
    (n) => selectedIds.includes(n.id) && n.type !== 'commentNode' && !isContainerType(n.type)
  )

  // 蓝图"注释框"：按所选节点的联合包围盒新建一个命名注释框，
  // 再把框内节点收为它的子节点，让整组作为一体移动 / 折叠 / 删除，
  // 避免拖动时"框走了、节点没走"的错位。
  function groupAsComment(): void {
    const box = boundingBox(groupableNodes)
    if (!box) return
    const color = '#38bdf8'
    addNode({
      id: crypto.randomUUID(),
      type: 'commentNode',
      position: { x: box.x, y: box.y },
      zIndex: -1,
      style: { width: box.w, height: box.h },
      initialWidth: box.w,
      initialHeight: box.h,
      data: {
        label: t('workflows.palette.commentLabel'),
        color,
        params: { text: '', color }
      }
    })
    // addNode 是同步的：紧接着读回节点表做一次归属收编（静默，不额外入栈）。
    const withComment = useWorkflowsStore.getState().current?.nodes
    if (!withComment) return
    const adopted = reconcileComments(withComment)
    if (adopted !== withComment) replaceNodes(adopted, { history: false })
  }

  // 注释框缩放结束时重算归属（NodeResizer 只改尺寸，不会触发拖拽回调）：
  // React Flow 在拖拽中发 `resizing: true` 的 dimension 变更，松手时补一发 `resizing: false`，
  // 以此作为"缩放结束"的信号。
  function handleNodesChange(changes: NodeChange<WFNode>[]): void {
    applyNodeChanges(changes)
    if (!changes.some((c) => c.type === 'dimensions' && c.resizing === false)) return
    const nds = useWorkflowsStore.getState().current?.nodes
    if (!nds) return
    const next = reconcileComments(nds)
    if (next !== nds) replaceNodes(next, { history: false })
  }

  const nodes = current?.nodes ?? []
  // 用 useMemo，避免每次渲染都给 React Flow 一个新的边数组——那会
  // 搅动其内部订阅，也是此前选中态 setState 死循环的诱因之一。
  const edges = useMemo(() => (current?.edges ?? []).map((e) => ({ ...e, type: e.type ?? 'workflowEdge' })), [current?.edges])

  // 右键菜单：节点级动作以被右键的节点为目标；若该节点已在
  // 当前多选集合中，则回退为对整个多选集合生效。
  const ctxNodeId = ctxTarget === 'node' ? (ctxNodeIdState ?? '') : ''
  const ctxNodeIds =
    ctxTarget === 'node'
      ? ctxNodeId && selectedIds.includes(ctxNodeId)
        ? selectedIds
        : ctxNodeId
          ? [ctxNodeId]
          : selectedIds
      : []

  // 右键目标正好是一个注释框时，菜单里额外给一个折叠 / 展开入口。
  const ctxComment =
    ctxNodeIds.length === 1
      ? (current?.nodes ?? []).find((n) => n.id === ctxNodeIds[0] && n.type === 'commentNode')
      : undefined

  useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent): void => {
      const el = document.querySelector('.wf-node-menu, .wf-pane-menu')
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
    setCtxNodeIdState(node.id)
    setCtxMenu({ x: e.clientX, y: e.clientY })
    setCtxTarget('node')
  }
  function handlePaneContextMenu(e: MouseEvent | ReactMouseEvent): void {
    e.preventDefault()
    setCtxNodeIdState('')
    setCtxMenu({ x: e.clientX, y: e.clientY })
    setCtxTarget('pane')
  }
  /** 引脚的右键在捕获阶段先被拦下（React Flow 的 node / pane 菜单便不再触发）。 */
  function handlePinContextMenu(e: ReactMouseEvent): void {
    const pin = pinFromEvent(e)
    if (!pin) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu(null)
    setPinMenu(pin)
  }
  /** 节点标签（引脚菜单里用来标识连线的另一端）。 */
  function nodeLabelOf(id: string): string {
    return String(nodes.find((n) => n.id === id)?.data.label ?? id)
  }
  /** 断点开关（节点右键菜单）。 */
  function toggleBreakpoint(): void {
    const id = ctxNodeIdState
    const node = id ? useWorkflowsStore.getState().current?.nodes.find((n) => n.id === id) : undefined
    if (!id || !node) {
      setCtxMenu(null)
      return
    }
    useWorkflowsStore.getState().updateNodeData(id, { breakpoint: !node.data.params.breakpoint })
    setCtxMenu(null)
  }
  function doDuplicate(): void {
    if (ctxNodeIds.length > 0) duplicateNodes(ctxNodeIds)
    setCtxMenu(null)
  }
  function deleteContextNodes(): void {
    if (ctxNodeIds.length > 0) applyNodeChanges(ctxNodeIds.map((id) => ({ id, type: 'remove' as const })))
    setCtxMenu(null)
  }
  const ctxNode = ctxTarget === 'node' && ctxNodeId ? nodes.find((n) => n.id === ctxNodeId) : undefined
  const ctxIsSubgraph = !!ctxNode && ctxNode.type === 'subgraphNode'
  const ctxCanFold = ctxNodeIds.length >= 2
  function foldSelectionToFunction(): void {
    const cur = useWorkflowsStore.getState().current
    if (!cur) return
    const { nodes: nNode, edges: nEdge, warnings } = collapseToSubgraph(ctxNodeIds, cur.nodes, cur.edges)
    // 只有真成功（新节点 vs 原节点数不同）才弹"已折叠"；否则是被拦截，弹原因提示。
    const changed = nNode.length !== cur.nodes.length || nEdge.length !== cur.edges.length
    if (warnings.length > 0 && !changed) {
      toast.warning(getT('workflows.toast.foldBlocked'))
    } else if (changed) {
      toast.success(getT('workflows.toast.foldDone'), { duration: 2000 })
    }
    for (const w of warnings) useLogsStore.getState().warn(`[fold] ${w}`)
    replaceGraph(nNode, nEdge)
    setCtxMenu(null)
  }
  function expandSubgraphNode(): void {
    if (!ctxNodeId) return
    const cur = useWorkflowsStore.getState().current
    if (!cur) return
    const { nodes: nNode, edges: nEdge } = expandSubgraph(ctxNodeId, cur.nodes, cur.edges)
    replaceGraph(nNode, nEdge)
    toast.success(getT('workflows.toast.unfoldDone'), { duration: 2000 })
    setCtxMenu(null)
  }

  function handlePaletteSearchKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    const count = paletteItems.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (count === 0) return
      e.preventDefault()
      setPaletteIndex((i) => (e.key === 'ArrowDown' ? Math.min(i + 1, count - 1) : Math.max(i - 1, 0)))
    } else if (e.key === 'Enter') {
      const item = paletteItems[paletteIndex]
      if (item) {
        e.preventDefault()
        addAtCenter(item.payload)
      }
    } else if (e.key === 'Escape') {
      closePalette()
    }
  }

  const isValidConnection = makeIsValidConnection(nodes, edges)

  return (
    <div
      className="wf-canvas"
      ref={canvasRef}
      // 拖拽连线中：CSS 用它高亮所有可连接的引脚（悬停预览）。
      data-connecting={connecting ? '1' : undefined}
      onContextMenuCapture={handlePinContextMenu}
      onDragOver={(e) => {
        e.preventDefault()
        // 外部文件拖入 → 'copy'（原图留在磁盘，我们上传一份副本）。
        // 面板内部拖拽 → 'move'（我们在工作流中实例化一个节点）。
        const isFile = Array.from(e.dataTransfer.types).includes('Files')
        e.dataTransfer.dropEffect = isFile ? 'copy' : 'move'
        if (isFile && !fileDragging) setFileDragging(true)
      }}
      onDragLeave={(e) => {
        // 仅当光标真正离开画布时才清除，而不是进入子元素时
        // 误清（用 relatedTarget 判断）。
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFileDragging(false)
        }
      }}
      onDrop={(e) => {
        setFileDragging(false)
        // 1. External image file → auto-build a ready-to-run Image → Model skeleton.
        const file = e.dataTransfer.files?.[0]
        if (file) {
          e.preventDefault()
          handleFileDrop(file, e.clientX, e.clientY)
          return
        }
        // 2. Internal palette drop (existing).
        const payload = e.dataTransfer.getData('application/meshforge-node')
        if (!payload) return
        e.preventDefault()
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        spawnNode(payload, position, e.clientX, e.clientY)
      }}
    >
      {fileDragging && (
        <div className="wf-dropzone" aria-hidden="true">
          <div className="wf-dropzone__inner">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <p className="wf-dropzone__title">{t('workflows.dropzone.title')}</p>
            <p className="wf-dropzone__hint">{t('workflows.dropzone.hint')}</p>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onBeforeDelete={handleBeforeDelete}
        onConnectStart={handleConnectStart}
        onConnect={(connection: Connection) => {
          connectionCompletedRef.current = true
          connect(connection)
        }}
        onConnectEnd={handleConnectEnd}
        onEdgesChange={(changes: EdgeChange<WFEdge>[]) => applyEdgeChanges(changes)}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={{ type: 'workflowEdge' }}
        deleteKeyCode={subEditorOpen ? null : 'Delete'}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeDoubleClick={(_e, node) => {
          if (node.type === 'subgraphNode') onOpenSubgraph?.(node.id)
        }}
        fitView
        minZoom={0.2}
      >
        <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={gridMinorGap} lineWidth={1} color={gridMinor} />
        <Background id="grid-major" variant={BackgroundVariant.Lines} gap={gridMajorGap} lineWidth={1} color={gridMajor} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => nodeSpec(n.type ?? '').color}
          maskColor={minimapMask}
          style={{ backgroundColor: canvasBg }}
        />
      </ReactFlow>

      {/* Blueprint Comment group: boxes the current selection into a comment frame. */}
      {groupableNodes.length > 0 && (
        <div className="wf-comment-group">
          <button className="wf-comment-group__btn" onClick={groupAsComment}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
              <path d="M9 12h6M12 9v6" />
            </svg>
            {t('workflows.panel.groupIntoComment')}
          </button>
        </div>
      )}

      {/* Connection drag → compact node list at the drop point (not a modal). */}
      {paletteOpen && pendingConn && (
        <ConnMenu
          x={pendingDropPos?.x ?? 0}
          y={pendingDropPos?.y ?? 0}
          title={pendingConn.handleType === 'source' ? t('workflows.conn.target') : t('workflows.conn.source')}
          items={paletteItems}
          index={connIndex}
          onIndexChange={setConnIndex}
          onPick={addAtCenter}
          dotColor={paletteDotColor}
          emptyText={t('workflows.conn.empty')}
        />
      )}

      {paletteOpen && !pendingConn && (
        <NodePalette
          query={paletteQuery}
          onQueryChange={(v) => {
            setPaletteQuery(v)
            setPaletteIndex(0)
          }}
          onKeyDown={handlePaletteSearchKey}
          items={paletteItems}
          rows={paletteRows}
          index={paletteIndex}
          onIndexChange={setPaletteIndex}
          onPick={addAtCenter}
          groupLabelFor={groupLabelFor}
          dotColor={paletteDotColor}
          placeholder={t('workflows.palette.searchPlaceholder')}
          emptyText={pendingConn ? t('workflows.conn.empty') : t('workflows.palette.noMatches')}
          footerText={t('workflows.palette.footer')}
        />
      )}

      {/* Blueprint 上下文敏感动作（右键节点）。 */}
      {ctxMenu && ctxTarget === 'node' && ctxNodeIds.length > 0 && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          count={ctxNodeIds.length}
          groupable={groupableNodes.length}
          comment={ctxComment}
          canFold={ctxCanFold}
          isSubgraph={ctxIsSubgraph}
          onDuplicate={doDuplicate}
          onDelete={deleteContextNodes}
          onGroupComment={() => {
            groupAsComment()
            setCtxMenu(null)
          }}
          onToggleCommentCollapse={() => {
            if (ctxComment) commentOps?.toggleCollapse(ctxComment.id, !ctxComment.data?.params?.collapsed)
            setCtxMenu(null)
          }}
          onFold={foldSelectionToFunction}
          onExpand={expandSubgraphNode}
          onToggleBreakpoint={toggleBreakpoint}
        />
      )}

      {/* 引脚右键：列出该引脚上的连线，可逐条断开。 */}
      {pinMenu && (
        <PinMenu
          pin={pinMenu}
          edges={current?.edges ?? []}
          labelOf={nodeLabelOf}
          onDelete={(ids) => applyEdgeChanges(ids.map((id) => ({ id, type: 'remove' as const })))}
          onClose={() => setPinMenu(null)}
        />
      )}
    </div>
  )
}

export default Canvas
