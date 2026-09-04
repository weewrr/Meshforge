import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { IN_HANDLE, OUT_HANDLE, allExtensions, getExtensionById, isContainerType, nodePorts, nodeSpec, portCompatible, type WFEdge, type WFNode } from '../types'
import { useWorkflowsStore } from '../stores/workflows'
import { useWorkflowRunStore } from '../stores/workflowRun'
import { useNavigationStore } from '../stores/navigation'
import { useLogsStore } from '../stores/logs'
import { uploadFile } from '../api'
import ExtensionsPanel from './workflows/ExtensionsPanel'
import WorkflowEdge from './workflows/WorkflowEdge'
import OpenPopup from './workflows/OpenPopup'
import { nodeTypes } from './workflows/nodes'
import { useT } from '../i18n'

function reaches(
  from: string,
  to: string,
  edges: WFEdge[]
): boolean {
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    for (const e of edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target)
        stack.push(e.target)
      }
    }
  }
  return false
}

const edgeTypes = { workflowEdge: WorkflowEdge }

/** Topmost While container whose screen rect contains the given client point.
 *  Uses the DOM node wrapper, so it stays correct at any zoom / pan state. */
function containerAtScreen(clientX: number, clientY: number): WFNode | undefined {
  const nds = useWorkflowsStore.getState().current?.nodes ?? []
  for (let i = nds.length - 1; i >= 0; i--) {
    const n = nds[i]
    if (!isContainerType(n.type)) continue
    const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${n.id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return n
  }
  return undefined
}

function nodeSize(n: WFNode): { w: number; h: number } {
  return {
    w: n.measured?.width ?? n.width ?? (typeof n.style?.width === 'number' ? n.style.width : 200),
    h: n.measured?.height ?? n.height ?? (typeof n.style?.height === 'number' ? n.style.height : 80)
  }
}

const PALETTE_NODES: { payload: string; labelKey: string; hintKey: string }[] = [
  { payload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', hintKey: 'workflows.palette.imageHint' },
  { payload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', hintKey: 'workflows.palette.textHint' },
  { payload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', hintKey: 'workflows.palette.meshHint' },
  { payload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', hintKey: 'workflows.palette.generateHint' },
  { payload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', hintKey: 'workflows.palette.previewHint' },
  { payload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', hintKey: 'workflows.palette.outputHint' },
  { payload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', hintKey: 'workflows.palette.waitHint' },
  { payload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', hintKey: 'workflows.palette.whileHint' },
  { payload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', hintKey: 'workflows.palette.forEachHint' }
]

function Canvas() {
  const { screenToFlowPosition } = useReactFlow()
  const t = useT()
  const current = useWorkflowsStore((s) => s.current)
  const applyNodeChanges = useWorkflowsStore((s) => s.applyNodeChanges)
  const applyEdgeChanges = useWorkflowsStore((s) => s.applyEdgeChanges)
  const connect = useWorkflowsStore((s) => s.connect)
  const addNode = useWorkflowsStore((s) => s.addNode)
  const replaceNodes = useWorkflowsStore((s) => s.replaceNodes)

  const canvasRef = useRef<HTMLDivElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  // Connection-drag linking (Modly parity): dragging from a handle onto empty
  // canvas opens a compact node list at the drop point filtered to compatible
  // nodes; picking one spawns the node there and wires the edge automatically.
  const pendingConnectionRef = useRef<{ nodeId: string; handleType: string | null; handleId: string | null } | null>(null)
  const connectionCompletedRef = useRef(false)
  const [pendingDropPos, setPendingDropPos] = useState<{ x: number; y: number } | null>(null)
  const [connIndex, setConnIndex] = useState(0)
  // Active row for the Space palette (↑↓ navigation, Modly NodePalette parity).
  const [paletteIndex, setPaletteIndex] = useState(0)
  // External image drag (from desktop) → show a drop hint and create a workflow
  // skeleton on drop (Image node + first model extension + edge).
  const [fileDragging, setFileDragging] = useState(false)

  function closePalette(): void {
    pendingConnectionRef.current = null
    setPendingDropPos(null)
    setPaletteOpen(false)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
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
  }, [])

  // When opened from a connection drag, the palette only lists nodes whose
  // ports are compatible with the pending connection (Modly parity). Extension
  // nodes participate with their schema-driven ports.
  const pendingConn = pendingConnectionRef.current
  const paletteItems = [
    ...PALETTE_NODES.map((n) => {
      const type = n.payload.slice('builtin:'.length)
      return { payload: n.payload, label: t(n.labelKey), hint: t(n.hintKey), ports: nodePorts(type) }
    }),
    ...allExtensions().map((e) => ({
      payload: `extension:${e.id}`,
      label: e.display_name,
      hint: t(e.kind === 'model' ? 'workflows.palette.kindGenerate' : 'workflows.palette.kindTools'),
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
      // New node becomes the TARGET of the pending edge.
      const out = nodePorts(sourceNode.type, sourceNode.data?.extensionId).output
      const targetIn = n.ports.inputs[0]
      return targetIn !== undefined && portCompatible(out, targetIn)
    }
    // New node becomes the SOURCE of the pending edge.
    const out = n.ports.output
    const targetIn = nodePorts(sourceNode.type, sourceNode.data?.extensionId).inputs[0]
    if (out === 'none' || targetIn === undefined) return false
    if (!portCompatible(out, targetIn)) return false
    // Single-input rule: the target handle must be free.
    const handleId = pendingConn.handleId ?? undefined
    return !cur.edges.some((e) => e.target === sourceNode.id && e.targetHandle === handleId)
  })

  // Palette keyboard navigation. Connection-drag list: ↑↓ over compatible
  // nodes, Enter to pick. Space palette: same keys with its own active row
  // (Modly NodePalette parity). When the Space search box is focused its own
  // onKeyDown drives navigation (window handler skips it to avoid double-fire).
  useEffect(() => {
    if (!paletteOpen) return
    const onKey = (e: KeyboardEvent): void => {
      const count = paletteItems.length
      const inSearch = !!(e.target as HTMLElement).classList?.contains('wf-palette__search')
      // Space palette's search box owns its keys while focused (its onKeyDown
      // drives ↑↓/Enter/Escape) — skip here to avoid double-firing.
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
    // Auto-wire when the palette was opened from a connection drag.
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

  /** Create a node, auto-attaching it to a While container when dropped inside one. */
  function spawnNode(
    payload: string,
    position: { x: number; y: number },
    clientX?: number,
    clientY?: number
  ): WFNode | null {
    const node = createNodeFromPayload(payload, position)
    if (!node) return null
    if (!isContainerType(node.type) && clientX !== undefined && clientY !== undefined) {
      const parent = containerAtScreen(clientX, clientY)
      if (parent) {
        node.parentId = parent.id
        node.position = { x: position.x - parent.position.x, y: position.y - parent.position.y }
      }
    }
    addNode(node)
    return node
  }

  // Drop an external image file onto the canvas → auto-create a ready-to-run
  // Image → Model skeleton. Picks the first installed model-kind extension; if
  // none are loaded, falls back to the legacy `generatorNode` (mock-relief).
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

  // When a node is dropped, attach/detach it to a While container based on its
  // center falling inside the container's bounds (Modly parity). Children keep a
  // parentId + parent-relative position without `extent`, so they can be dragged
  // back out.
  function handleNodeDragStop(_e: unknown, dragged: WFNode): void {
    if (isContainerType(dragged.type)) return
    const nds = useWorkflowsStore.getState().current?.nodes ?? []
    const containers = nds.filter((n) => isContainerType(n.type))
    if (containers.length === 0 && !dragged.parentId) return

    const parent = dragged.parentId ? nds.find((n) => n.id === dragged.parentId) : undefined
    const absX = (parent?.position.x ?? 0) + dragged.position.x
    const absY = (parent?.position.y ?? 0) + dragged.position.y
    const { w, h } = nodeSize(dragged)
    const cx = absX + w / 2
    const cy = absY + h / 2

    const container = containers.find((g) => {
      const gw = g.measured?.width ?? g.width ?? (typeof g.style?.width === 'number' ? g.style.width : 0)
      const gh = g.measured?.height ?? g.height ?? (typeof g.style?.height === 'number' ? g.style.height : 0)
      return cx >= g.position.x && cx <= g.position.x + gw && cy >= g.position.y && cy <= g.position.y + gh
    })

    const newParentId = container?.id
    if (newParentId === dragged.parentId) return

    const next: WFNode[] = nds.map((n) => {
      if (n.id !== dragged.id) return n
      if (container) {
        return {
          ...n,
          parentId: container.id,
          position: { x: absX - container.position.x, y: absY - container.position.y }
        }
      }
      const { parentId: _p, extent: _ext, ...rest } = n
      return { ...rest, position: { x: absX, y: absY } }
    })

    // React Flow requires the parent to appear before its child in the array.
    if (newParentId) {
      const cIdx = next.findIndex((n) => n.id === dragged.id)
      const pIdx = next.findIndex((n) => n.id === newParentId)
      if (pIdx > cIdx) {
        const [child] = next.splice(cIdx, 1)
        next.splice(next.findIndex((n) => n.id === newParentId) + 1, 0, child)
      }
    }
    replaceNodes(next)
  }

  // Deleting a While container re-parents its children to the canvas (positions
  // become absolute) instead of deleting them along with the container.
  function handleBeforeDelete({ nodes: doomed, edges: doomedEdges }: { nodes: WFNode[]; edges: WFEdge[] }): Promise<{
    nodes: WFNode[]
    edges: WFEdge[]
  }> {
    const containers = doomed.filter((n) => isContainerType(n.type))
    if (containers.length === 0) return Promise.resolve({ nodes: doomed, edges: doomedEdges })
    const containerIds = new Set(containers.map((c) => c.id))
    const containerById = new Map(containers.map((c) => [c.id, c]))

    const cur = useWorkflowsStore.getState().current
    const rescued = cur?.nodes.filter((n) => n.parentId && containerIds.has(n.parentId)) ?? []
    const rescuedIds = new Set(rescued.map((n) => n.id))
    if (rescued.length > 0 && cur) {
      const next = cur.nodes.map((n) => {
        if (!(n.parentId && containerIds.has(n.parentId))) return n
        const container = containerById.get(n.parentId)!
        const { parentId: _p, extent: _ext, ...rest } = n
        return {
          ...rest,
          position: { x: container.position.x + n.position.x, y: container.position.y + n.position.y }
        }
      })
      replaceNodes(next, { history: false })
    }

    const deletedNodes = doomed.filter((n) => !rescuedIds.has(n.id))
    const deletedIds = new Set(deletedNodes.map((n) => n.id))
    const edges = doomedEdges.filter((e) => deletedIds.has(e.source) || deletedIds.has(e.target))
    return Promise.resolve({ nodes: deletedNodes, edges })
  }

  // Connection drag → palette (Modly parity). If the drag completes normally
  // (dropped on another handle) nothing happens; dropping on empty canvas opens
  // the compatible-node palette.
  function handleConnectStart(_e: unknown, params: { nodeId: string | null; handleType: string | null; handleId: string | null }): void {
    pendingConnectionRef.current = {
      nodeId: params.nodeId ?? '',
      handleType: params.handleType,
      handleId: params.handleId ?? null
    }
    connectionCompletedRef.current = false
  }

  function handleConnectEnd(e: MouseEvent | TouchEvent): void {
    if (connectionCompletedRef.current || !pendingConnectionRef.current?.nodeId) {
      pendingConnectionRef.current = null
      return
    }
    const target = e.target as Element
    // Dropped on a real handle or a plain node → no palette. A While container's
    // empty body counts as empty canvas (it's a giant node).
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

  const nodes = current?.nodes ?? []
  const edges = (current?.edges ?? []).map((e) => ({ ...e, type: e.type ?? 'workflowEdge' }))

  const isValidConnection = ((connection: Connection | Edge) => {
    const source = nodes.find((n) => n.id === connection.source)
    const target = nodes.find((n) => n.id === connection.target)
    if (!source || !target) return false
    if (source.id === target.id) return false

    const sourceOut = nodePorts(source.type, source.data?.extensionId).output
    const targetIn = nodePorts(target.type, target.data?.extensionId).inputs[0]
    if (targetIn === undefined) return false
    if (!portCompatible(sourceOut, targetIn)) return false

    // One edge per input handle.
    if (edges.some((e) => e.target === target.id && e.targetHandle === connection.targetHandle)) {
      return false
    }
    // Reject connections that would create a cycle.
    return !reaches(target.id, source.id, edges)
  }) as IsValidConnection

  return (
    <div
      className="wf-canvas"
      ref={canvasRef}
      onDragOver={(e) => {
        e.preventDefault()
        // External file drag → 'copy' (the image stays on disk, we upload a copy).
        // Internal palette drag → 'move' (we instantiate a node in the workflow).
        const isFile = Array.from(e.dataTransfer.types).includes('Files')
        e.dataTransfer.dropEffect = isFile ? 'copy' : 'move'
        if (isFile && !fileDragging) setFileDragging(true)
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor truly leaves the canvas, not when crossing
        // into a child element (relatedTarget check).
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
        onNodesChange={(changes: NodeChange<WFNode>[]) => applyNodeChanges(changes)}
        onNodeDragStart={() => useWorkflowsStore.getState().pushHistory()}
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
        deleteKeyCode="Delete"
        fitView
        minZoom={0.2}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#23262f" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => nodeSpec(n.type ?? '').color}
          maskColor="rgba(15,17,21,0.75)"
          style={{ backgroundColor: '#12141a' }}
        />
      </ReactFlow>

      {/* Connection drag → compact node list at the drop point (not a modal). */}
      {paletteOpen && pendingConn && (
        <div
          className="wf-conn-menu"
          style={{
            left: Math.min((pendingDropPos?.x ?? 0) + 12, window.innerWidth - 240),
            top: Math.min((pendingDropPos?.y ?? 0) + 12, window.innerHeight - 340)
          }}
        >
          <div className="wf-conn-menu__title">
            {pendingConn.handleType === 'source' ? t('workflows.conn.target') : t('workflows.conn.source')}
          </div>
          <div className="wf-conn-menu__list">
            {paletteItems.map((item, idx) => (
              <button
                key={item.payload}
                className={`wf-conn-menu__item ${idx === connIndex ? 'wf-conn-menu__item--active' : ''}`}
                onMouseEnter={() => setConnIndex(idx)}
                onClick={() => addAtCenter(item.payload)}
              >
                <span
                  className="wf-conn-menu__dot"
                  style={{
                    background: item.payload.startsWith('extension:')
                      ? '#34d399'
                      : nodeSpec(item.payload.slice('builtin:'.length)).color
                  }}
                />
                <span className="wf-conn-menu__label">{item.label}</span>
                <span className="wf-conn-menu__hint">{item.hint}</span>
              </button>
            ))}
            {paletteItems.length === 0 && (
              <div className="wf-conn-menu__empty">{t('workflows.conn.empty')}</div>
            )}
          </div>
        </div>
      )}

      {paletteOpen && !pendingConn && (
        <div className="wf-palette">
          <div className="wf-palette__card">
            <input
              className="wf-palette__search"
              autoFocus
              placeholder={t('workflows.palette.searchPlaceholder')}
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value)
                setPaletteIndex(0)
              }}
              onKeyDown={(e) => {
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
              }}
            />
            <div className="wf-palette__list">
              {paletteItems.map((item, idx) => (
                <button
                  key={item.payload}
                  className={`wf-palette__item ${idx === paletteIndex ? 'wf-palette__item--active' : ''}`}
                  onMouseEnter={() => setPaletteIndex(idx)}
                  onClick={() => addAtCenter(item.payload)}
                >
                  <span className="wf-palette__label">{item.label}</span>
                  <span className="wf-palette__hint">{item.hint}</span>
                </button>
              ))}
              {paletteItems.length === 0 && (
                <div className="wf-palette__empty">
                  {pendingConn ? t('workflows.conn.empty') : t('workflows.palette.noMatches')}
                </div>
              )}
            </div>
            <div className="wf-palette__footer">{t('workflows.palette.footer')}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function createNodeFromPayload(payload: string, position: { x: number; y: number }): WFNode | null {
  const id = crypto.randomUUID()
  if (payload.startsWith('builtin:')) {
    const type = payload.slice('builtin:'.length)
    const spec = nodeSpec(type)
    if (!spec) return null
    const defaults: Record<string, Record<string, unknown>> = {
      imageNode: { url: '', fileName: '' },
      textNode: { text: 'A 3D model' },
      meshNode: { url: '', fileName: '' },
      generatorNode: { generatorId: 'mock-relief' },
      outputNode: {},
      previewNode: {},
      waitNode: {},
      whileNode: { iterations: 2 },
      forEachNode: { items: 'view 1, view 2' }
    }
    return {
      id,
      type,
      position,
      // RF shows node wrappers (and their handles) only when dimensions are
      // known; initialWidth/Height make the first frame stable before the
      // ResizeObserver measurement kicks in (initial* gets overwritten).
      ...(type === 'whileNode'
        ? { style: { width: 340, height: 220 }, initialWidth: 340, initialHeight: 220 }
        : { initialWidth: 200, initialHeight: 80 }),
      data: { label: spec.label, color: spec.color, params: { ...(defaults[type] ?? {}) } }
    }
  }
  if (payload.startsWith('generator:')) {
    const generatorId = payload.slice('generator:'.length)
    const spec = nodeSpec('generatorNode')
    return {
      id,
      type: 'generatorNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: `Generate (${generatorId})`,
        color: spec.color,
        params: { generatorId }
      }
    }
  }
  if (payload.startsWith('extension:')) {
    const extensionId = payload.slice('extension:'.length)
    const ext = getExtensionById(extensionId)
    const spec = nodeSpec('extensionNode')
    return {
      id,
      type: 'extensionNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: ext?.display_name ?? 'Extension',
        color: spec.color,
        extensionId,
        params: {
          extensionId,
          ...Object.fromEntries((ext?.params ?? []).map((p) => [p.id, p.default]))
        }
      }
    }
  }
  return null
}

// ─── Help modal ──────────────────────────────────────────────────────────────

function HelpModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const rows: [string, string][] = [
    ['Space', t('workflows.help.openPanel')],
    ['Ctrl + Z / Ctrl + Y', t('workflows.help.undoRedo')],
    ['Ctrl + T', t('workflows.help.newWorkflow')],
    ['Ctrl + W', t('workflows.help.closeTab')],
    ['Ctrl + Tab', t('workflows.help.switchTab')],
    ['Delete', t('workflows.help.deleteNode')],
    ['Drag', t('workflows.help.drag')],
    ['Connect', t('workflows.help.connect')],
    ['Wait node', t('workflows.help.waitNode')]
  ]
  return (
    <div
      className="wf-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="wf-modal__card wf-modal__card--wide">
        <p className="wf-modal__title">{t('workflows.help.title')}</p>
        <div className="wf-help">
          {rows.map(([key, desc]) => (
            <div key={key} className="wf-help__row">
              <span className="wf-help__key">{key}</span>
              <span className="wf-help__desc">{desc}</span>
            </div>
          ))}
        </div>
        <div className="wf-modal__actions">
          <button className="primary" onClick={onClose}>
            {t('workflows.help.gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function WorkflowsPage() {
  const t = useT()
  const workflows = useWorkflowsStore((s) => s.workflows)
  const current = useWorkflowsStore((s) => s.current)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const dirty = useWorkflowsStore((s) => s.dirty)
  const canUndo = useWorkflowsStore((s) => s.canUndo)
  const canRedo = useWorkflowsStore((s) => s.canRedo)
  const loadList = useWorkflowsStore((s) => s.loadList)
  const select = useWorkflowsStore((s) => s.select)
  const create = useWorkflowsStore((s) => s.create)
  const rename = useWorkflowsStore((s) => s.rename)
  const remove = useWorkflowsStore((s) => s.remove)
  const duplicate = useWorkflowsStore((s) => s.duplicate)
  const importWorkflow = useWorkflowsStore((s) => s.importWorkflow)
  const undo = useWorkflowsStore((s) => s.undo)
  const redo = useWorkflowsStore((s) => s.redo)
  const save = useWorkflowsStore((s) => s.save)

  const runState = useWorkflowRunStore((s) => s.runState)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const runningWorkflowId = useWorkflowRunStore((s) =>
    s.runState === 'running' || s.runState === 'paused' ? s.currentWorkflowId : null
  )
  const run = useWorkflowRunStore((s) => s.run)
  const cancel = useWorkflowRunStore((s) => s.cancel)
  const continueRun = useWorkflowRunStore((s) => s.continueRun)

  const go = useNavigationStore((s) => s.go)

  const [openPopupVisible, setOpenPopupVisible] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)

  const reorderTab = useWorkflowsStore((s) => s.reorderTab)

  // Native-dialog workflow import — the main process opens the dialog, reads
  // the JSON and returns its content (the sandboxed renderer has no fs access,
  // and <input type=file> freezes this machine's renderer, see HANDOFF §6).
  async function openImportPicker(): Promise<void> {
    if (!window.meshforge?.selectWorkflowFile) {
      useLogsStore.getState().warn('[workflows] native file dialog unavailable (browser-only run)')
      return
    }
    const picked = await window.meshforge.selectWorkflowFile()
    if (!picked) return
    try {
      const parsed = JSON.parse(picked.content)
      if (typeof parsed?.id !== 'string' || !Array.isArray(parsed?.nodes)) {
        throw new Error('Not a valid workflow JSON')
      }
      await importWorkflow(parsed)
    } catch (err) {
      useLogsStore.getState().error(`import workflow: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  useEffect(() => {
    if (!loaded) void loadList()
  }, [loaded, loadList])

  // Close the tab context menu on any outside click.
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [tabMenu])

  // Tab + editing shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if ((e.ctrlKey || e.metaKey) && !typing) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault()
          undo()
          return
        }
        if (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')) {
          e.preventDefault()
          redo()
          return
        }
        if (e.key.toLowerCase() === 't') {
          e.preventDefault()
          void create()
          return
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          if (workflows.length < 2 || !current) return
          const idx = workflows.findIndex((w) => w.id === current.id)
          if (idx < 0) return
          const next = e.shiftKey
            ? (idx - 1 + workflows.length) % workflows.length
            : (idx + 1) % workflows.length
          void select(workflows[next].id)
        }
        return
      }
      // Ctrl+W works even while typing (name field) — closing a tab is never a text edit.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (current) void remove(current.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workflows, current, undo, redo, create, save, select, remove])

  const busy = runState === 'running' || runState === 'paused'
  const activeLabel = activeNodeId
    ? current?.nodes.find((n) => n.id === activeNodeId)?.data.label ?? ''
    : ''

  function exportCurrent(): void {
    if (!current) return
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${current.name || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleRun(): Promise<void> {
    if (!current) return
    // Flush the pending autosave first so the run uses the latest graph.
    await save()
    await run(useWorkflowsStore.getState().current ?? current)
  }

  return (
    <div className="wf-page">
      <div className="wf-tabs" role="tablist">
        {workflows.map((w) => (
          <div
            key={w.id}
            className={`wf-tab ${current?.id === w.id ? 'wf-tab--active' : ''}`}
            role="tab"
            aria-selected={current?.id === w.id}
            tabIndex={current?.id === w.id ? 0 : -1}
            draggable
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void select(w.id)
              }
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('meshforge/tab-id', w.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('meshforge/tab-id')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverTab(w.id)
            }}
            onDragLeave={() => setDragOverTab((cur) => (cur === w.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverTab(null)
              const dragId = e.dataTransfer.getData('meshforge/tab-id')
              if (dragId) reorderTab(dragId, w.id)
            }}
            onDragEnd={() => setDragOverTab(null)}
            onClick={() => void select(w.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                void remove(w.id)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu({ id: w.id, x: e.clientX, y: e.clientY })
            }}
          >
            {dragOverTab === w.id && <span className="wf-tab__drop" />}
            {w.bookmarked && <span className="wf-tab__star" title={t('workflows.tab.favorited')}>★</span>}
            <span className="wf-tab__name">{w.name}</span>
            {runningWorkflowId === w.id && (
              <span className="wf-tab__running" title={t('workflows.tab.running')} />
            )}
            {!busy && (
              <button
                className="wf-tab__close"
                title={t('workflows.tab.close')}
                aria-label={t('workflows.tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(w.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="wf-tab__add" title={t('workflows.tab.new')} aria-label={t('workflows.tab.new')} onClick={() => void create()}>
          +
        </button>
      </div>

      {/* Tab context menu */}
      {tabMenu && (
        <div className="wf-ctxmenu" style={{ left: tabMenu.x, top: tabMenu.y }}>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              void select(tabMenu.id)
              setOpenPopupVisible(true)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.openList')}
          </button>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              void duplicate(tabMenu.id)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.duplicate')}
          </button>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              const wf = workflows.find((w) => w.id === tabMenu.id)
              if (wf && current?.id === wf.id) exportCurrent()
              setTabMenu(null)
            }}
            disabled={current?.id !== tabMenu.id}
          >
            {t('workflows.ctxMenu.export')}
          </button>
          <div className="wf-ctxmenu__sep" />
          <button
            className="wf-ctxmenu__item wf-ctxmenu__item--danger"
            onClick={() => {
              void remove(tabMenu.id)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.delete')}
          </button>
        </div>
      )}

      <div className="wf-body">
        <div className="wf-main">
          <div className="wf-toolbar">
            <button className="wf-tool-btn" title={t('workflows.toolbar.openWorkflow')} onClick={() => setOpenPopupVisible(true)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
              {t('workflows.toolbar.open')}
            </button>
            <button className="wf-tool-btn" title={t('workflows.toolbar.importJson')} onClick={openImportPicker}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
                <polyline points="7 9 12 4 17 9" />
                <line x1="12" y1="4" x2="12" y2="16" />
              </svg>
              {t('workflows.toolbar.import')}
            </button>
            <button
              className="wf-tool-btn"
              title={t('workflows.toolbar.exportJson')}
              disabled={!current}
              onClick={exportCurrent}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
                <polyline points="7 15 12 20 17 15" />
                <line x1="12" y1="4" x2="12" y2="16" />
              </svg>
              {t('workflows.toolbar.export')}
            </button>
            <span className="wf-toolbar__sep" />
            <button className="wf-tool-btn" title={t('workflows.toolbar.undo')} aria-label={t('workflows.toolbar.undo')} disabled={!canUndo} onClick={undo}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
              </svg>
            </button>
            <button className="wf-tool-btn" title={t('workflows.toolbar.redo')} aria-label={t('workflows.toolbar.redo')} disabled={!canRedo} onClick={redo}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
              </svg>
            </button>

            {current ? (
              <input
                className="wf-toolbar__name"
                value={current.name}
                onChange={(e) => rename(e.target.value)}
                disabled={busy}
              />
            ) : (
              <span className="wf-toolbar__name">…</span>
            )}
            <span className={`wf-toolbar__dirty ${dirty ? '' : 'wf-toolbar__dirty--saved'}`}>
              {dirty ? t('workflows.toolbar.unsaved') : t('workflows.toolbar.saved')}
            </span>

            <span className="wf-toolbar__spacer" />

            <div className="wf-toolbar__actions">
              {busy && activeLabel && (
                <span className="wf-toolbar__step" title={activeLabel}>
                  {activeLabel}
                </span>
              )}
              {runState === 'paused' && (
                <button className="primary" onClick={continueRun}>
                  {t('workflows.toolbar.continue')}
                </button>
              )}
              {busy ? (
                <button className="wf-stop-btn" onClick={() => void cancel()}>
                  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="1.5" />
                  </svg>
                  {t('workflows.toolbar.stop')}
                </button>
              ) : (
                <>
                  <button
                    className="wf-run-btn"
                    disabled={!current || current.nodes.length === 0}
                    title={t('workflows.toolbar.runWorkflow')}
                    onClick={() => void handleRun()}
                  >
                    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {t('workflows.toolbar.run')}
                  </button>
                  <button className="ghost" title={t('workflows.toolbar.viewerTitle')} onClick={() => go('generate')}>
                    {t('workflows.toolbar.viewer')}
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </>
              )}
              <button
                className={`wf-tool-btn ${helpOpen ? 'wf-tool-btn--active' : ''}`}
                title={t('workflows.toolbar.helpTitle')}
                aria-label={t('workflows.toolbar.helpTitle')}
                onClick={() => setHelpOpen(true)}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
            </div>
          </div>

          {current ? (
            <ReactFlowProvider key={current.id}>
              <Canvas />
            </ReactFlowProvider>
          ) : (
            <div className="wf-empty">{t('workflows.loading')}</div>
          )}
        </div>
        <ExtensionsPanel />
      </div>

      {openPopupVisible && <OpenPopup onClose={() => setOpenPopupVisible(false)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  )
}
