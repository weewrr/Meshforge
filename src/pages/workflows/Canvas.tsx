import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange
} from '@xyflow/react'
import {
  IN_HANDLE,
  OUT_HANDLE,
  allExtensions,
  isContainerType,
  nodePorts,
  nodeSpec,
  portCompatible,
  type WFEdge,
  type WFNode
} from '../../types'
import { useAppStore } from '../../stores/app'
import { useLogsStore } from '../../stores/logs'
import { useWorkflowsStore } from '../../stores/workflows'
import { uploadFile } from '../../api'
import { useT } from '../../i18n'
import WorkflowEdge from './WorkflowEdge'
import { nodeTypes } from './nodes'
import { createNodeFromPayload, reaches, containerAtScreen, nodeSize, PALETTE_NODES } from './canvasUtils'

const edgeTypes = { workflowEdge: WorkflowEdge }

function Canvas() {
  const { screenToFlowPosition } = useReactFlow()
  const t = useT()
  const theme = useAppStore((s) => s.theme)
  const canvasBg = theme === 'light' ? '#e9eef5' : '#0a0e18'
  // Blueprint graph paper: fine minor grid + emphasized major grid, panning
  // and zooming with the canvas like real drafting paper.
  const gridMinor = theme === 'light' ? 'rgba(30, 90, 150, 0.14)' : 'rgba(96, 165, 250, 0.1)'
  const gridMajor = theme === 'light' ? 'rgba(23, 90, 140, 0.26)' : 'rgba(125, 211, 252, 0.16)'
  const minimapMask = theme === 'light' ? 'rgba(46, 63, 92, 0.32)' : 'rgba(9, 13, 21, 0.75)'
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
        <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={20} lineWidth={1} color={gridMinor} />
        <Background id="grid-major" variant={BackgroundVariant.Lines} gap={100} lineWidth={1} color={gridMajor} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => nodeSpec(n.type ?? '').color}
          maskColor={minimapMask}
          style={{ backgroundColor: canvasBg }}
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

export default Canvas
