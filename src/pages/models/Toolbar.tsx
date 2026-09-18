/**
 * ModelsPage 工具栏：搜索框、筛选按钮组、排序下拉、重新扫描。
 *
 * 从 ModelsPage 抽出的展示组件——全部状态由页面持有，这里只发回调。
 */

import type { RefObject } from 'react'
import { FILTERS, SORTS, type FilterId, type SortId } from './types'
import { useT } from '../../i18n'

interface ToolbarProps {
  search: string
  setSearch: (v: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  filter: FilterId
  setFilter: (f: FilterId) => void
  counts: Record<FilterId, number>
  sort: SortId
  setSort: (s: SortId) => void
  sortOpen: boolean
  setSortOpen: (v: boolean) => void
  sortRef: RefObject<HTMLDivElement | null>
  loading: boolean
  onReload: () => void
}

export function Toolbar(props: ToolbarProps) {
  const {
    search, setSearch, searchRef, filter, setFilter, counts,
    sort, setSort, sortOpen, setSortOpen, sortRef, loading, onReload
  } = props
  const t = useT()

  return (
    <div className="ex-toolbar">
      <label className="ex-search">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
        </svg>
        <input
          ref={searchRef}
          type="text"
          aria-label={t('models.searchAria')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
        />
        {search ? (
          <button onClick={() => setSearch('')} aria-label={t('models.clearSearch')} className="ex-search__clear">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : (
          <kbd className="ex-search__kbd">/</kbd>
        )}
      </label>

      <div className="ex-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`ex-filters__btn ${filter === f.id ? 'ex-filters__btn--active' : ''}`}
          >
            {t(f.tkey)}
            <span className={`ex-filters__count ${filter === f.id ? 'ex-filters__count--active' : ''}`}>
              {counts[f.id]}
            </span>
          </button>
        ))}
      </div>

      <div className="ex-sort" ref={sortRef}>
        <button onClick={() => setSortOpen(!sortOpen)} aria-haspopup="true" aria-expanded={sortOpen} aria-label={t('models.sortAria')} className="ex-sort__btn">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 5v14M7 19l-3-3M7 5l3 3M17 19V5M17 5l-3 3M17 19l3-3" />
          </svg>
          {t(SORTS.find((s) => s.id === sort)!.tkey)}
        </button>
        {sortOpen && (
          <div className="ex-sort__menu">
            {SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => { setSort(s.id); setSortOpen(false) }}
                className={`ex-sort__option ${sort === s.id ? 'ex-sort__option--active' : ''}`}
              >
                {t(s.tkey)}
                {sort === s.id && (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12 4.5 4.5L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onReload}
        disabled={loading}
        title={t('models.reloadTitle')}
        aria-label={t('models.reloadAria')}
        className="ex-reload"
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={loading ? 'ex-spin' : ''}>
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
      </button>
    </div>
  )
}
