import { useEffect, useState, type ReactElement } from 'react'
import { getWorkflow, saveWorkflow } from '../../api'
import { useWorkflowsStore } from '../../stores/workflows'
import { useAppStore } from '../../stores/app'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { Workflow } from '../../types'
import { useT } from '../../i18n'

// ─── Action icons ──────────────────────────────────────────────────────────
// Monochrome SVG icons (currentColor → themeable, consistent 1.75 stroke).

const ACTION_ICONS: Record<string, ReactElement> = {
  star: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  duplicate: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  rename: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
  close: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  plus: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  folder: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}


// ─── Mini graph preview ────────────────────────────────────────────────────
// Schematic SVG thumbnail built from stored node positions, no React Flow.

const VIEW_W = 200
const VIEW_H = 88
const PAD = 12

const MINI_TINTS: Record<string, { fill: string; stroke: string }> = {
  imageNode: { fill: 'rgba(56,189,248,0.20)', stroke: '#38bdf8' },
  textNode: { fill: 'rgba(251,113,133,0.20)', stroke: '#fb7185' },
  meshNode: { fill: 'rgba(167,139,250,0.22)', stroke: '#a78bfa' },
  generatorNode: { fill: 'rgba(52,211,153,0.20)', stroke: '#34d399' },
  previewNode: { fill: 'rgba(56,189,248,0.20)', stroke: '#38bdf8' },
  outputNode: { fill: 'rgba(167,139,250,0.22)', stroke: '#a78bfa' }
}
const MINI_DEFAULT = { fill: 'rgba(113,113,122,0.25)', stroke: '#71717a' }

function WorkflowMiniPreview({ wf }: { wf: Workflow }) {
  if (wf.nodes.length === 0) {
    return (
      <div className="wf-open__mini-empty">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="16" width="7" height="5" rx="1" />
          <path d="M10 5.5h5a2 2 0 0 1 2 2V16" />
        </svg>
      </div>
    )
  }

  const boxes = wf.nodes.map((n) => ({
    id: n.id,
    type: n.type ?? '',
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? (n.style?.width as number | undefined) ?? 150,
    h: n.height ?? (n.style?.height as number | undefined) ?? 48
  }))
  const boxById = new Map(boxes.map((b) => [b.id, b]))

  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const scale = Math.min(
    (VIEW_W - PAD * 2) / Math.max(maxX - minX, 1),
    (VIEW_H - PAD * 2) / Math.max(maxY - minY, 1),
    0.5
  )
  const offX = (VIEW_W - (maxX - minX) * scale) / 2
  const offY = (VIEW_H - (maxY - minY) * scale) / 2
  const tx = (x: number): number => offX + (x - minX) * scale
  const ty = (y: number): number => offY + (y - minY) * scale

  return (
    <svg aria-hidden="true" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="wf-open__mini" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="wf-mini-grid" width="11" height="11" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="#23262f" />
        </pattern>
      </defs>
      <rect width={VIEW_W} height={VIEW_H} fill="url(#wf-mini-grid)" />
      {wf.edges.map((e) => {
        const s = boxById.get(e.source)
        const t = boxById.get(e.target)
        if (!s || !t) return null
        const x1 = tx(s.x + s.w)
        const y1 = ty(s.y + s.h / 2)
        const x2 = tx(t.x)
        const y2 = ty(t.y + t.h / 2)
        const d = Math.max(Math.abs(x2 - x1) * 0.45, 6)
        return (
          <path
            key={e.id}
            d={`M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke="#5b5b66"
            strokeWidth="1"
            strokeLinecap="round"
            opacity="0.9"
          />
        )
      })}
      {boxes.map((b) => {
        const tint = MINI_TINTS[b.type] ?? MINI_DEFAULT
        return (
          <rect
            key={b.id}
            x={tx(b.x)}
            y={ty(b.y)}
            width={Math.max(b.w * scale, 3)}
            height={Math.max(b.h * scale, 3)}
            rx="2"
            fill={tint.fill}
            stroke={tint.stroke}
            strokeWidth="0.75"
          />
        )
      })}
    </svg>
  )
}

// ─── Folders (names + colors + bookmarks persist in localStorage) ──────────

const FOLDER_COLORS = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#fb7185']

const FOLDERS_KEY = 'meshforge.folders.v1'
const FOLDER_COLORS_KEY = 'meshforge.folderColors.v1'
const FOLDER_BOOKMARKS_KEY = 'meshforge.folderBookmarks.v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

// ─── Popup ──────────────────────────────────────────────────────────────────

export default function OpenPopup({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useAppStore((s) => s.locale)
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const store = useWorkflowsStore
  const select = store((s) => s.select)
  const duplicate = store((s) => s.duplicate)
  const remove = store((s) => s.remove)
  const moveToFolder = store((s) => s.moveToFolder)
  const toggleBookmark = store((s) => s.toggleBookmark)

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [search, setSearch] = useState('')
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [colorPickerFolder, setColorPickerFolder] = useState<string | null>(null)

  const [folders, setFolders] = useState<string[]>(() => readJson<string[]>(FOLDERS_KEY, []))
  const [folderColors, setFolderColors] = useState<Record<string, string>>(() =>
    readJson<Record<string, string>>(FOLDER_COLORS_KEY, {})
  )
  const [bookmarkedFolders, setBookmarkedFolders] = useState<string[]>(() =>
    readJson<string[]>(FOLDER_BOOKMARKS_KEY, [])
  )

  async function refresh(): Promise<void> {
    const metas = await store.getState().loadList().then(() => store.getState().workflows)
    const full = await Promise.all(
      metas.map((m) => getWorkflow(m.id).catch(() => null))
    )
    setWorkflows(full.filter((w): w is Workflow => !!w))
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape closes whichever modal is topmost.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (deleteTarget) setDeleteTarget(null)
      else if (renameTarget) setRenameTarget(null)
      else if (newFolderName !== null) setNewFolderName(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteTarget, renameTarget, newFolderName, onClose])

  function persistFolders(next: string[]): void {
    setFolders(next)
    writeJson(FOLDERS_KEY, next)
  }

  function setFolderColor(folder: string, color: string): void {
    const next = { ...folderColors, [folder]: color }
    setFolderColors(next)
    writeJson(FOLDER_COLORS_KEY, next)
  }

  function toggleFolderBookmark(folder: string): void {
    const next = bookmarkedFolders.includes(folder)
      ? bookmarkedFolders.filter((f) => f !== folder)
      : [...bookmarkedFolders, folder]
    setBookmarkedFolders(next)
    writeJson(FOLDER_BOOKMARKS_KEY, next)
  }

  function deleteFolder(name: string): void {
    persistFolders(folders.filter((f) => f !== name))
    for (const wf of workflows.filter((w) => w.folder === name)) {
      void moveToFolder(wf.id, undefined)
    }
    void refresh()
  }

  function openWorkflow(id: string): void {
    void select(id)
    onClose()
  }

  const workflowColor = (wf: Workflow): string | undefined =>
    wf.folder ? folderColors[wf.folder] : undefined

  function renderCard(wf: Workflow): ReactElement {
    const color = workflowColor(wf)
    return (
      <div
        key={wf.id}
        className="wf-card"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/meshforge-wf', wf.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => openWorkflow(wf.id)}
        title={wf.name}
      >
        <div className="wf-card__preview">
          {color && (
            <div
              className="wf-card__glow"
              style={{
                background: `radial-gradient(ellipse 90% 110% at 50% 45%, ${color}30, ${color}08 60%, transparent 80%)`
              }}
            />
          )}
          <WorkflowMiniPreview wf={wf} />
          <div className="wf-card__actions">
            <button
              className={`wf-card__action ${wf.bookmarked ? 'wf-card__action--starred' : ''}`}
              title={wf.bookmarked ? t('workflows.popup.unfavorite') : t('workflows.popup.favorite')}
              aria-label={wf.bookmarked ? t('workflows.popup.unfavorite') : t('workflows.popup.favorite')}
              onClick={(e) => {
                e.stopPropagation()
                void toggleBookmark(wf.id).then(refresh)
              }}
            >
              {ACTION_ICONS.star}
            </button>
            <button
              className="wf-card__action"
              title={t('workflows.popup.duplicate')}
              aria-label={t('workflows.popup.duplicate')}
              onClick={(e) => {
                e.stopPropagation()
                void duplicate(wf.id).then(refresh)
              }}
            >
              {ACTION_ICONS.duplicate}
            </button>
            <button
              className="wf-card__action"
              title={t('workflows.popup.rename')}
              aria-label={t('workflows.popup.rename')}
              onClick={(e) => {
                e.stopPropagation()
                setRenameTarget({ id: wf.id, value: wf.name })
              }}
            >
              {ACTION_ICONS.rename}
            </button>
            <button
              className="wf-card__action wf-card__action--danger"
              title={t('workflows.popup.delete')}
              aria-label={t('workflows.popup.delete')}
              onClick={(e) => {
                e.stopPropagation()
                setDeleteTarget(wf.id)
              }}
            >
              {ACTION_ICONS.close}
            </button>
          </div>
        </div>
        <div className="wf-card__meta">
          <p className="wf-card__name">{wf.name || t('workflows.popup.untitled')}</p>
          <p className="wf-card__time">{new Date(wf.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</p>
        </div>
      </div>
    )
  }

  function renderFolder(folder: string): ReactElement {
    const inFolder = workflows
      .filter((w) => w.folder === folder)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const collapsed = collapsedFolders.has(folder)
    return (
      <div key={folder}>
        <div
          className={`wf-folder ${dragOverFolder === folder ? 'wf-folder--over' : ''}`}
          onClick={() =>
            setCollapsedFolders((s) => {
              const next = new Set(s)
              if (next.has(folder)) next.delete(folder)
              else next.add(folder)
              return next
            })
          }
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOverFolder(folder)
          }}
          onDragLeave={() => setDragOverFolder(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOverFolder(null)
            const id = e.dataTransfer.getData('application/meshforge-wf')
            if (id) void moveToFolder(id, folder).then(refresh)
          }}
        >
          <span className={`wf-folder__chevron ${collapsed ? '' : 'wf-folder__chevron--open'}`}>›</span>
          <span
            className="wf-folder__icon"
            style={{
              color: folderColors[folder] ?? 'currentColor',
              background: folderColors[folder] ? `${folderColors[folder]}22` : 'transparent'
            }}
          >
            {ACTION_ICONS.folder}
          </span>
          <span className="wf-folder__name">{folder}</span>
          <span className="wf-folder__count">{inFolder.length}</span>
          <span className="wf-folder__spacer" />
          <button
            className={`wf-folder__btn ${bookmarkedFolders.includes(folder) ? 'wf-folder__btn--starred' : ''}`}
            title={bookmarkedFolders.includes(folder) ? t('workflows.popup.unfavoriteFolder') : t('workflows.popup.favoriteFolder')}
            aria-label={bookmarkedFolders.includes(folder) ? t('workflows.popup.unfavoriteFolder') : t('workflows.popup.favoriteFolder')}
            onClick={(e) => {
              e.stopPropagation()
              toggleFolderBookmark(folder)
            }}
          >
            {ACTION_ICONS.star}
          </button>
          <button
            className="wf-folder__btn"
            title={t('workflows.popup.folderColor')}
            aria-label={t('workflows.popup.folderColor')}
            onClick={(e) => {
              e.stopPropagation()
              setColorPickerFolder((cur) => (cur === folder ? null : folder))
            }}
          >
            <span
              className="wf-folder__swatch"
              style={{ background: folderColors[folder] ?? 'transparent' }}
            />
          </button>
          <button
            className="wf-folder__btn wf-folder__btn--danger"
            title={t('workflows.popup.deleteFolder')}
            aria-label={t('workflows.popup.deleteFolder')}
            onClick={(e) => {
              e.stopPropagation()
              deleteFolder(folder)
            }}
          >
            {ACTION_ICONS.close}
          </button>
        </div>
        {colorPickerFolder === folder && (
          <div className="wf-folder__colors">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                className={`wf-folder__color ${folderColors[folder] === c ? 'wf-folder__color--active' : ''}`}
                style={{ background: c }}
                aria-label={t('workflows.popup.setFolderColor', { color: c })}
                onClick={() => {
                  setFolderColor(folder, c)
                  setColorPickerFolder(null)
                }}
              />
            ))}
          </div>
        )}
        {!collapsed && inFolder.length > 0 && (
          <div className="wf-open__grid wf-open__grid--in-folder">{inFolder.map(renderCard)}</div>
        )}
        {!collapsed && inFolder.length === 0 && (
          <p className="wf-folder__empty">{t('workflows.popup.emptyFolder')}</p>
        )}
      </div>
    )
  }

  const query = search.trim().toLowerCase()
  const matches = query
    ? workflows
        .filter((w) => (w.name || 'Untitled').toLowerCase().includes(query))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : []
  const rootWorkflows = workflows
    .filter((w) => !w.folder)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const bookmarked = workflows.filter((w) => w.bookmarked).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return (
    <div
      ref={trapRef}
      className="wf-open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="wf-open__dialog">
        <div className="wf-open__header">
          <p>{t('workflows.popup.title')}</p>
          <div className="wf-open__header-actions">
            <button
              className="wf-open__icon-btn"
              title={t('workflows.popup.newFolder')}
              aria-label={t('workflows.popup.newFolder')}
              onClick={() => setNewFolderName('')}
            >
              {ACTION_ICONS.plus}
            </button>
            <button className="wf-open__icon-btn" title={t('workflows.popup.close')} aria-label={t('workflows.popup.close')} onClick={onClose}>
              {ACTION_ICONS.close}
            </button>
          </div>
        </div>

        <div className="wf-open__search-row">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('workflows.popup.search')}
            className="wf-open__search"
          />
        </div>

        {newFolderName !== null && (
          <div className="wf-open__new-folder">
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = newFolderName.trim()
                  if (trimmed && !folders.includes(trimmed)) persistFolders([...folders, trimmed])
                  setNewFolderName(null)
                }
              }}
              onBlur={() => setNewFolderName(null)}
              placeholder={t('workflows.popup.folderName')}
            />
          </div>
        )}

        <div
          className="wf-open__body"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Drop on the list background (not a folder) → move back to root.
            e.preventDefault()
            setDragOverFolder(null)
            const id = e.dataTransfer.getData('application/meshforge-wf')
            if (id) void moveToFolder(id, undefined).then(refresh)
          }}
        >
          {workflows.length === 0 && folders.length === 0 && (
            <div className="wf-open__empty">
              <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M12 10v6M9 13h6" />
              </svg>
              <p>{t('workflows.popup.noSaved')}</p>
            </div>
          )}

          {query !== '' ? (
            matches.length === 0 ? (
              <p className="wf-open__empty">{t('workflows.popup.noMatch', { search: search.trim() })}</p>
            ) : (
              <div className="wf-open__grid">{matches.map(renderCard)}</div>
            )
          ) : (
            <>
              {bookmarked.length > 0 && (
                <>
                  <div className="wf-open__section-title">{t('workflows.popup.favorited')}</div>
                  <div className="wf-open__grid">{bookmarked.map(renderCard)}</div>
                </>
              )}
              {[...bookmarkedFolders.filter((f) => folders.includes(f)), ...folders.filter((f) => !bookmarkedFolders.includes(f))].map(
                renderFolder
              )}
              <div className="wf-open__section-title">{t('workflows.popup.ungrouped')}</div>
              {rootWorkflows.length > 0 ? (
                <div className="wf-open__grid">{rootWorkflows.map(renderCard)}</div>
              ) : (
                <p className="wf-open__empty">{t('workflows.popup.noUngrouped')}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Rename modal */}
      {renameTarget && (
        <div
          className="wf-modal"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRenameTarget(null)
          }}
        >
          <div className="wf-modal__card">
            <p className="wf-modal__title">{t('workflows.popup.renameTitle')}</p>
            <input
              autoFocus
              value={renameTarget.value}
              onChange={(e) => setRenameTarget({ ...renameTarget, value: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename()
              }}
              placeholder={t('workflows.popup.renamePlaceholder')}
            />
            <div className="wf-modal__actions">
              <button className="ghost" onClick={() => setRenameTarget(null)}>
                {t('workflows.popup.cancel')}
              </button>
              <button className="primary" disabled={!renameTarget.value.trim()} onClick={() => void handleRename()}>
                {t('workflows.popup.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div
          className="wf-modal"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleteTarget(null)
          }}
        >
          <div className="wf-modal__card">
            <p className="wf-modal__title">{t('workflows.popup.deleteTitle')}</p>
            <p className="wf-modal__text">
              {t('workflows.popup.deleteConfirm', {
                name: workflows.find((w) => w.id === deleteTarget)?.name || t('workflows.popup.untitled')
              })}
            </p>
            <div className="wf-modal__actions">
              <button className="ghost" onClick={() => setDeleteTarget(null)}>
                {t('workflows.popup.cancel')}
              </button>
              <button
                className="wf-modal__delete"
                onClick={() => {
                  void remove(deleteTarget).then(refresh)
                  setDeleteTarget(null)
                }}
              >
                {t('workflows.popup.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  async function handleRename(): Promise<void> {
    if (!renameTarget) return
    const trimmed = renameTarget.value.trim()
    const wf = workflows.find((w) => w.id === renameTarget.id)
    if (wf && trimmed && trimmed !== wf.name) {
      await saveWorkflow({ ...wf, name: trimmed, updatedAt: new Date().toISOString() })
      await store.getState().loadList()
      await refresh()
    }
    setRenameTarget(null)
  }
}
