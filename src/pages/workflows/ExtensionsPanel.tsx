import { useEffect, useMemo, useRef, useState } from 'react'
import { listExtensions } from '../../api'
import { NODE_SPECS, nodeSpec } from '../../types'
import type { WorkflowExtension } from '../../types'

interface PanelItem {
  dragPayload: string
  label: string
  color: string
  glyph: string
}

const BUILTIN_ITEMS: PanelItem[] = [
  { dragPayload: 'builtin:imageNode', label: 'Image', color: '#38bdf8', glyph: '🖼' },
  { dragPayload: 'builtin:textNode', label: 'Text', color: '#fbbf24', glyph: 'T' },
  { dragPayload: 'builtin:meshNode', label: 'Load 3D Mesh', color: '#a78bfa', glyph: '◈' },
  { dragPayload: 'builtin:generatorNode', label: 'Generate Mesh', color: '#34d399', glyph: '⚙' },
  { dragPayload: 'builtin:outputNode', label: 'Add to Scene', color: '#a78bfa', glyph: '⬒' },
  { dragPayload: 'builtin:previewNode', label: 'Preview', color: '#38bdf8', glyph: '▦' },
  { dragPayload: 'builtin:waitNode', label: 'Wait', color: '#71717a', glyph: '⏸' },
  { dragPayload: 'builtin:whileNode', label: 'While', color: '#f59e0b', glyph: '↻' },
  { dragPayload: 'builtin:forEachNode', label: 'For Each', color: '#38bdf8', glyph: '⧉' }
]

const PANEL_MIN = 200
const PANEL_MAX = 480

function PanelTile({ item }: { item: PanelItem }) {
  return (
    <div
      className="wf-tile"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/meshforge-node', item.dragPayload)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title={`拖到画布添加 ${item.label}`}
    >
      <span className="wf-tile__glyph" style={{ color: item.color }}>
        {item.glyph}
      </span>
      <span className="wf-tile__label">{item.label}</span>
    </div>
  )
}

export default function ExtensionsPanel() {
  const [extensions, setExtensions] = useState<WorkflowExtension[]>([])
  const [search, setSearch] = useState('')
  const [width, setWidth] = useState(232)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    listExtensions().then(setExtensions).catch(() => undefined)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX.current - e.clientX
      setWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW.current + delta)))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const query = search.trim().toLowerCase()
  const builtinItems = BUILTIN_ITEMS.filter((n) => !query || n.label.toLowerCase().includes(query))
  const modelItems = useMemo(
    () =>
      extensions
        .filter((e) => e.kind === 'model' && (!query || e.display_name.toLowerCase().includes(query)))
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: nodeSpec('extensionNode').color,
          glyph: '⚙'
        })),
    [extensions, query]
  )
  const processItems = useMemo(
    () =>
      extensions
        .filter((e) => e.kind === 'process' && (!query || e.display_name.toLowerCase().includes(query)))
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: nodeSpec('extensionNode').color,
          glyph: '◈'
        })),
    [extensions, query]
  )

  return (
    <div className="wf-panel" style={{ width }}>
      <div
        className="wf-panel__resizer"
        onMouseDown={(e) => {
          dragging.current = true
          startX.current = e.clientX
          startW.current = width
          document.body.style.cursor = 'col-resize'
          e.preventDefault()
        }}
      />
      <div className="wf-panel__inner">
        <div className="wf-panel__header">
          <h2>节点</h2>
          <p>拖拽到画布</p>
        </div>
        <input
          className="wf-panel__search"
          type="text"
          placeholder="搜索…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">基础</div>
          <div className="wf-panel__grid">
            {builtinItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            生成器
            <span className="wf-panel__count">{modelItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {modelItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            网格工具
            <span className="wf-panel__count">{processItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {processItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__legend">
          {(['image', 'text', 'mesh', 'any'] as const).map((t) => (
            <span key={t} className="wf-panel__legend-item">
              <i style={{ background: portColor(t) }} />
              {portLabel(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function portColor(t: string): string {
  switch (t) {
    case 'image':
      return '#38bdf8'
    case 'text':
      return '#fbbf24'
    case 'mesh':
      return '#a78bfa'
    default:
      return '#71717a'
  }
}

function portLabel(t: string): string {
  switch (t) {
    case 'image':
      return '图片'
    case 'text':
      return '文本'
    case 'mesh':
      return '网格'
    default:
      return '任意'
  }
}
