/**
 * 生成页 · workspace 资产库面板。
 *
 * 展示后端 workspace 里已产出的资产（工作流产物、导出文件等），按"来源域 → 能力"
 * 两级分组，支持搜索、排序、折叠，并提供一个"打开所选"动作。
 * 分组与过滤的纯逻辑都在 `assetLibrary.ts`，本组件只负责渲染与交互。
 */

import { useT } from '../../i18n'
import {
  LIBRARY_SORT_OPTIONS,
  describeOpenability,
  filterScopeGroups,
  isOpenable,
  type LibraryEntry,
  type LibrarySortMode
} from './assetLibrary'

/** 排序模式 → i18n key。 */
export const SORT_LABEL_KEYS: Record<LibrarySortMode, string> = {
  type: 'generate.library.sortType',
  name: 'generate.library.sortName',
  date: 'generate.library.sortDate'
}

/** 来源域 → i18n key；未登记时退化为后端给的字面标签。 */
export const SCOPE_LABEL_KEYS: Record<string, string> = {
  workflows: 'generate.library.scopeWorkflows',
  exports: 'generate.library.scopeExports'
}

/** 能力 → i18n key；未登记时退化为后端给的字面标签。 */
export const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  mesh: 'generate.library.capMesh',
  'rigged-mesh': 'generate.library.capRiggedMesh',
  'animation-motion': 'generate.library.capAnimationMotion',
  'landmarks-sidecar': 'generate.library.capLandmarksSidecar',
  'generated-world': 'generate.library.capGeneratedWorld',
  'scene-manifest': 'generate.library.capSceneManifest'
}

// ─── Library（workspace 资产库）面板 ────────────────────────────────────────

/** 面板属性。全部状态由父组件持有，本组件是纯受控组件。 */
export interface LibraryPanelProps {
  entries: LibraryEntry[]
  selectedId: string | null
  loading: boolean
  error: string | null
  search: string
  sort: LibrarySortMode
  /** 已折叠分组的 sectionKey 列表。 */
  collapsed: string[]
  onRefresh: () => void
  onSelect: (id: string) => void
  onSearch: (q: string) => void
  onSort: (mode: LibrarySortMode) => void
  onToggleSection: (keys: string[], key: string) => void
  onOpen: (entry: LibraryEntry | null) => void
}

/** 资产库面板。 */
export function LibraryPanel({
  entries, selectedId, loading, error, search, sort, collapsed,
  onRefresh, onSelect, onSearch, onSort, onToggleSection, onOpen
}: LibraryPanelProps) {
  const t = useT()

  const scopeGroups = filterScopeGroups(entries, search, sort)
  // 当前筛选结果里的全部 id：用来判断"选中的项是否还看得见"，
  // 避免搜索过滤之后仍能打开一个已不在列表里的条目。
  const visibleIds = new Set(
    scopeGroups.flatMap((g) => g.entryGroups.flatMap((cg) => cg.entries.map((e) => e.id)))
  )
  const selectedEntry =
    selectedId && visibleIds.has(selectedId)
      ? entries.find((e) => e.id === selectedId) ?? null
      : null
  // 加载中、未选中、或该条目本身不可打开时，禁用"打开"按钮。
  const openDisabled = !selectedEntry || !isOpenable(selectedEntry) || loading
  // 提示语优先级：有选中项 → 说明它能否打开；否则按"搜索无结果 / 未选中"提示。
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
      {/* 三态：加载中 / 筛选后为空 / 正常列表。 */}
      {loading ? (
        <p className="gp-menu__empty">{t('generate.library.loading')}</p>
      ) : scopeGroups.length === 0 ? (
        <p className="gp-menu__empty">
          {/* 区分"搜索无结果"与"后端压根没有索引到东西"，避免误导用户。 */}
          {search.trim()
            ? t('generate.library.noMatch', { query: search.trim() })
            : t('generate.library.noIndexed')}
        </p>
      ) : (
        <div className="gp-lib__list">
          {scopeGroups.map((scopeGroup) => {
            // 折叠状态按列表白名单判定：出现在 collapsed 里即为收起。
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
                {/* 收起的来源域不渲染其下的能力分组，减少 DOM 体量。 */}
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
        // 传入 null 表示"什么都没选"，由父组件决定如何处理（通常是无操作）。
        onClick={() => onOpen(selectedEntry)}
      >
        {t('generate.library.openSelected')}
      </button>
    </div>
  )
}
