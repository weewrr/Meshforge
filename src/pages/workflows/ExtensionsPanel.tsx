import { useEffect, useMemo, useRef, useState } from 'react'
import { listExtensions } from '../../api'
import { NODE_SPECS, nodeSpec } from '../../types'
import type { WorkflowExtension } from '../../types'
import { useT } from '../../i18n'

interface PanelItem {
  dragPayload: string
  label?: string
  labelKey?: string
  color: string
  glyph: string
}

const BUILTIN_ITEMS: PanelItem[] = [
  { dragPayload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', color: '#38bdf8', glyph: '🖼' },
  { dragPayload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', color: '#fbbf24', glyph: 'T' },
  { dragPayload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', color: '#a78bfa', glyph: '◈' },
  { dragPayload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', color: '#34d399', glyph: '⚙' },
  { dragPayload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', color: '#a78bfa', glyph: '⬒' },
  { dragPayload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', color: '#38bdf8', glyph: '▦' },
  { dragPayload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', color: '#71717a', glyph: '⏸' },
  { dragPayload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', color: '#f59e0b', glyph: '↻' },
  { dragPayload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', color: '#38bdf8', glyph: '⧉' }
]

const PANEL_MIN = 200
const PANEL_MAX = 480

function PanelTile({ item }: { item: PanelItem }) {
  const t = useT()
  const labelText = item.labelKey ? t(item.labelKey) : item.label ?? ''
  return (
    <div
      className="wf-tile"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/meshforge-node', item.dragPayload)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title={t('workflows.panel.dragToAdd', { label: labelText })}
    >
      <span className="wf-tile__glyph" style={{ color: item.color }}>
        {item.glyph}
      </span>
      <span className="wf-tile__label">{labelText}</span>
    </div>
  )
}

export default function ExtensionsPanel() {
  const t = useT()
  const [extensions, setExtensions] = useState<WorkflowExtension[]>([])
  const [search, setSearch] = useState('')
  const [width, setWidth] = useState(300)
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
  const builtinItems = BUILTIN_ITEMS.filter((n) => {
    const labelText = (n.labelKey ? t(n.labelKey) : n.label ?? '').toLowerCase()
    return !query || labelText.includes(query)
  })
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
          <h2>{t('workflows.panel.title')}</h2>
          <p>{t('workflows.panel.dragToCanvas')}</p>
        </div>
        <input
          className="wf-panel__search"
          type="text"
          placeholder={t('workflows.panel.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">{t('workflows.panel.groupBasic')}</div>
          <div className="wf-panel__grid">
            {builtinItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupGenerators')}
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
            {t('workflows.panel.groupMeshTools')}
            <span className="wf-panel__count">{processItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {processItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__legend">
          {(['image', 'text', 'mesh', 'any'] as const).map((pt) => (
            <span key={pt} className="wf-panel__legend-item">
              <i style={{ background: portColor(pt) }} />
              {t(portLabel(pt))}
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
      return 'workflows.panel.portImage'
    case 'text':
      return 'workflows.panel.portText'
    case 'mesh':
      return 'workflows.panel.portMesh'
    default:
      return 'workflows.panel.portAny'
  }
}
