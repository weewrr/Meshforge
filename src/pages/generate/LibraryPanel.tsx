import { useT } from '../../i18n'
import {
  LIBRARY_SORT_OPTIONS,
  describeOpenability,
  filterScopeGroups,
  isOpenable,
  toggleSectionKey,
  type LibraryEntry,
  type LibrarySortMode
} from './assetLibrary'

export const SORT_LABEL_KEYS: Record<LibrarySortMode, string> = {
  type: 'generate.library.sortType',
  name: 'generate.library.sortName',
  date: 'generate.library.sortDate'
}

export const SCOPE_LABEL_KEYS: Record<string, string> = {
  workflows: 'generate.library.scopeWorkflows',
  exports: 'generate.library.scopeExports'
}

export const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  mesh: 'generate.library.capMesh',
  'rigged-mesh': 'generate.library.capRiggedMesh',
  'animation-motion': 'generate.library.capAnimationMotion',
  'landmarks-sidecar': 'generate.library.capLandmarksSidecar',
  'generated-world': 'generate.library.capGeneratedWorld',
  'scene-manifest': 'generate.library.capSceneManifest'
}

// ─── Library（workspace 资产库）面板 ────────────────────────────────────────

export interface LibraryPanelProps {
  entries: LibraryEntry[]
  selectedId: string | null
  loading: boolean
  error: string | null
  search: string
  sort: LibrarySortMode
  collapsed: string[]
  onRefresh: () => void
  onSelect: (id: string) => void
  onSearch: (q: string) => void
  onSort: (mode: LibrarySortMode) => void
  onToggleSection: (keys: string[], key: string) => void
  onOpen: (entry: LibraryEntry | null) => void
}

export function LibraryPanel({
  entries, selectedId, loading, error, search, sort, collapsed,
  onRefresh, onSelect, onSearch, onSort, onToggleSection, onOpen
}: LibraryPanelProps) {
  const t = useT()

  const scopeGroups = filterScopeGroups(entries, search, sort)
  const visibleIds = new Set(
    scopeGroups.flatMap((g) => g.entryGroups.flatMap((cg) => cg.entries.map((e) => e.id)))
  )
  const selectedEntry =
    selectedId && visibleIds.has(selectedId)
      ? entries.find((e) => e.id === selectedId) ?? null
      : null
  const openDisabled = !selectedEntry || !isOpenable(selectedEntry) || loading
  const selectedMessage = selectedEntry
    ? describeOpenability(selectedEntry)
    : scopeGroups.length === 0 && search.trim()
      ? t('generate.library.noMatch', { query: search.trim() })
      : t('generate.library.selectHint')

  return (
    <div className="gp-menu gp-menu--wide gp-lib">
      <div className="gp-menu__head">
        <p className="gp-menu__label">{t('generate.library.workspaceTitle')}</p>
        <p className="gp-menu__text">{t('generate.library.workspaceDesc')}</p>
      </div>
      <button
        className="gp-lib__refresh"
        onClick={onRefresh}
        disabled={loading}
      >
        {t('generate.library.refresh')}
      </button>
      <div className="gp-lib__bar">
        <input
          className="gp-lib__search"
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('generate.library.searchPlaceholder')}
        />
        <select
          className="gp-lib__sort"
          value={sort}
          onChange={(e) => onSort(e.target.value as LibrarySortMode)}
        >
          {LIBRARY_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{t(SORT_LABEL_KEYS[opt.value])}</option>
          ))}
        </select>
      </div>
      {loading ? (
        <p className="gp-menu__empty">{t('generate.library.loading')}</p>
      ) : scopeGroups.length === 0 ? (
        <p className="gp-menu__empty">
          {search.trim()
            ? t('generate.library.noMatch', { query: search.trim() })
            : t('generate.library.noIndexed')}
        </p>
      ) : (
        <div className="gp-lib__list">
          {scopeGroups.map((scopeGroup) => {
            const scopeExpanded = !collapsed.includes(scopeGroup.sectionKey)
            return (
              <div key={scopeGroup.sectionKey} className="gp-lib__scope">
                <button
                  className="gp-lib__section"
                  aria-expanded={scopeExpanded}
                  onClick={() => onToggleSection(collapsed, scopeGroup.sectionKey)}
                >
                  <span className="gp-lib__section-name">{t(SCOPE_LABEL_KEYS[scopeGroup.sourceScope] ?? scopeGroup.sourceScopeLabel)}</span>
                  <span className="gp-lib__section-toggle">{scopeExpanded ? t('generate.library.hide') : t('generate.library.show')}</span>
                </button>
                {scopeExpanded && scopeGroup.entryGroups.map((group) => {
                  const capExpanded = !collapsed.includes(group.sectionKey)
                  return (
                    <div key={group.sectionKey} className="gp-lib__cap">
                      <button
                        className="gp-lib__section gp-lib__section--cap"
                        aria-expanded={capExpanded}
                        onClick={() => onToggleSection(collapsed, group.sectionKey)}
                      >
                        <span className="gp-lib__section-name">{t(CAPABILITY_LABEL_KEYS[group.capability] ?? group.capabilityLabel)}</span>
                        <span className="gp-lib__section-toggle">{capExpanded ? t('generate.library.hide') : t('generate.library.show')}</span>
                      </button>
                      {capExpanded && group.entries.map((entry) => {
                        const selected = entry.id === selectedId
                        return (
                          <button
                            key={entry.id}
                            className={`gp-lib__item ${selected ? 'gp-lib__item--selected' : ''}`}
                            aria-pressed={selected}
                            onClick={() => onSelect(entry.id)}
                          >
                            <span className="gp-lib__item-name">{entry.displayName}</span>
                            <span className="gp-lib__item-cap">{entry.capability}</span>
                            <span className="gp-lib__item-path">{entry.workspacePath}</span>
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
      <div className="gp-menu__hint">
        {selectedMessage}
        {error && <span className="gp-lib__error">{error}</span>}
      </div>
      <button
        className="gp-menu__primary"
        disabled={openDisabled}
        onClick={() => onOpen(selectedEntry)}
      >
        {t('generate.library.openSelected')}
      </button>
    </div>
  )
}
