import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
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
  { dragPayload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', color: '#38bdf8', glyph: 'image' },
  { dragPayload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', color: '#fb7185', glyph: 'text' },
  { dragPayload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', color: '#a78bfa', glyph: 'mesh' },
  { dragPayload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', color: '#34d399', glyph: 'generate' },
  { dragPayload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', color: '#a78bfa', glyph: 'output' },
  { dragPayload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', color: '#38bdf8', glyph: 'preview' },
  { dragPayload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', color: '#71717a', glyph: 'wait' },
  { dragPayload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', color: '#facc15', glyph: 'loop' },
  { dragPayload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', color: '#38bdf8', glyph: 'forEach' }
]

/** Monochrome SVG tile icons (currentColor → themeable, consistent stroke). */
const TILE_ICONS: Record<string, ReactElement> = {
  image: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  text: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M4 7V5h16v2M12 5v14M9 19h6" />
    </svg>
  ),
  mesh: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  ),
  generate: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
    </svg>
  ),
  output: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  preview: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  wait: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  loop: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  forEach: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

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
        {TILE_ICONS[item.glyph] ?? item.glyph}
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
          glyph: 'generate'
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
          glyph: 'mesh'
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
      return '#fb7185'
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
