/**
 * 扩展（模型 / 处理器）管理页。
 *
 * 列出后端已加载的全部扩展，支持按来源（GitHub / HuggingFace / ModelScope）
 * 安装、本地文件夹安装、重新扫描、关键词搜索、筛选与排序；对 HuggingFace 托管的
 * 模型权重支持下载 / 暂停 / 继续 / 取消；并提供详情抽屉与卸载确认。
 *
 * 结构（优化文档 7.3 拆分）：状态逻辑在 useExtensionInstall / useModelDownloads /
 * useUninstall 三个 hook 里，工具栏与列表渲染在 Toolbar / ExtensionList 组件里，
 * 本文件只做组装。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { listExtensions, type InstallProgress } from '../api'
import { useT } from '../i18n'
import { SegmentedControl } from '../components/ui'
import {
  SOURCES,
  toExt,
  type Ext,
  type FilterId,
  type SortId,
  type SourceId
} from './models/types'
import { CUBE_ICON } from './models/ui'
import { DisabledBar } from './models/DisabledBar'
import { ExtensionDrawer } from './models/ExtensionDrawer'
import { ExtensionList } from './models/ExtensionList'
import { InstallProgressBar } from './models/InstallProgressBar'
import { Toolbar } from './models/Toolbar'
import { UninstallModal } from './models/UninstallModal'
import { useExtensionInstall } from './models/useExtensionInstall'
import { useModelDownloads } from './models/useModelDownloads'
import { useRestore } from './models/useRestore'
import { useUninstall } from './models/useUninstall'

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const t = useT()
  const [extensions, setExtensions] = useState<Ext[]>([])
  const [loading, setLoading] = useState(true)

  // 搜索 / 过滤 / 排序 / 抽屉
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [sort, setSort] = useState<SortId>('name')
  const [sortOpen, setSortOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sortRef = useRef<HTMLDivElement>(null)

  // 安装 / 下载 / 卸载 / 恢复四类状态逻辑
  const install = useExtensionInstall(refresh)
  const downloads = useModelDownloads()
  const uninstall = useUninstall(refresh, setSelectedId)
  const restore = useRestore(refresh)

  // ── Data loading ─────────────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const list = await listExtensions()
      setExtensions(list.map(toExt))
    } catch {
      setExtensions([])
    } finally {
      setLoading(false)
    }
    void downloads.refreshModelStatus()
    // 已停用条带与本列表同源（都来自后端），任何一次刷新都带上它，
    // 否则卸载后条带要等下次手动刷新才出现。
    void restore.refreshDisabled()
  }

  // 挂载时拉一次列表；refresh 每次渲染重建，刻意不进依赖（仅首挂载加载）。
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(() => { void refresh() }, [])

  // "/" focuses the search field
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 点击外部时关闭排序下拉
  useEffect(() => {
    if (!sortOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortOpen])

  // ── Derived lists ────────────────────────────────────────────────────────

  const counts = useMemo(() => ({
    all: extensions.length,
    process: extensions.filter((e) => e.type === 'process').length,
    model: extensions.filter((e) => e.type === 'model').length,
    official: extensions.filter((e) => e.trusted).length
  }), [extensions])

  const filteredExtensions = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = extensions.filter((e) => {
      if (q) {
        const haystack = `${e.name} ${e.description ?? ''} ${e.author ?? ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (filter === 'process') return e.type === 'process'
      if (filter === 'model') return e.type === 'model'
      if (filter === 'official') return e.trusted
      return true
    })
    const sorters: Record<SortId, (a: Ext, b: Ext) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
    }
    return [...list].sort(sorters[sort])
  }, [extensions, search, filter, sort])

  const processList = filteredExtensions.filter((e) => e.type === 'process')
  const meshModelList = filteredExtensions.filter((e) => e.type === 'model' && e.category !== 'multiview' && e.category !== 'image')
  const viewModelList = filteredExtensions.filter((e) => e.type === 'model' && e.category === 'multiview')
  const imageModelList = filteredExtensions.filter((e) => e.type === 'model' && e.category === 'image')
  const grouped = filter === 'all' || filter === 'official'

  const selectedExt = selectedId ? extensions.find((e) => e.id === selectedId) ?? null : null

  const sourcePlaceholder: Record<SourceId, string> = {
    github: t('models.ghUrlPlaceholder'),
    huggingface: t('models.hfUrlPlaceholder'),
    modelscope: t('models.msUrlPlaceholder')
  }
  const sourceAria: Record<SourceId, string> = {
    github: t('models.ghUrlAria'),
    huggingface: t('models.hfUrlAria'),
    modelscope: t('models.msUrlAria')
  }
  const cardActions = {
    onOpen: (e: Ext) => setSelectedId(e.id),
    onUninstall: uninstall.openUninstallModal,
    onInstall: (e: Ext) => void downloads.handleDownload(e),
    onPause: (e: Ext) => void downloads.handlePause(e),
    onResume: (e: Ext) => downloads.handleResume(e),
    onCancel: (e: Ext) => void downloads.handleCancel(e)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ex">
      {/* 页头 */}
      <div className="ex-head">
        <div>
          <h1 className="ex-head__title">{t('models.title')}</h1>
          <p className="ex-head__subtitle">
            {t('models.subtitle', { all: counts.all, process: counts.process, model: counts.model })}
          </p>
        </div>
        <div className="ex-head__actions">
          <button
            onClick={() => void install.handleLocalInstall()}
            disabled={install.isInstalling}
            title={t('models.linkFolderTitle')}
            className="ex-head__btn"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
            {t('models.linkFolder')}
          </button>
          <button
            onClick={install.toggleGHForm}
            className="ex-head__btn"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            {install.showGHForm ? t('models.cancel') : t('models.installFromGitHub')}
          </button>
        </div>
      </div>

      <Toolbar
        search={search}
        setSearch={setSearch}
        searchRef={searchRef}
        filter={filter}
        setFilter={setFilter}
        counts={counts}
        sort={sort}
        setSort={setSort}
        sortOpen={sortOpen}
        setSortOpen={setSortOpen}
        sortRef={sortRef}
        loading={loading}
        onReload={() => void install.handleReload()}
      />

      {/* Install from GitHub / HuggingFace / ModelScope */}
      {install.showGHForm && (
        <div className="ex-ghform">
          <div className="ex-ghform__box">
            <div className="ex-ghform__source">
              <span className="ex-ghform__sourcelabel">{t('models.installFromSource')}</span>
              <SegmentedControl
                value={install.source}
                onChange={(s) => { install.setSource(s); install.setGhErr(null); install.setGhOk(false) }}
                ariaLabel={t('models.installFromSource')}
                options={SOURCES.map((s) => ({ value: s.id, label: t(s.tkey) }))}
              />
            </div>
            <div className="ex-ghform__row">
              <input
                type="text"
                aria-label={sourceAria[install.source]}
                value={install.ghUrl}
                onChange={(e) => { install.setGhUrl(e.target.value); install.setGhErr(null); install.setGhOk(false) }}
                onKeyDown={(e) => e.key === 'Enter' && !install.isInstalling && void install.handleGHInstall()}
                placeholder={sourcePlaceholder[install.source]}
                autoFocus
                disabled={install.isInstalling}
              />
              <button
                onClick={() => void install.handleGHInstall()}
                disabled={!install.ghUrl.trim() || install.isInstalling}
                className="ex-ghform__submit"
              >
                {install.isInstalling ? (
                  <span className="ex-spinner" />
                ) : (
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                )}
                {install.isInstalling ? t('models.installing') : t('models.install')}
              </button>
            </div>

            {install.isInstalling && install.installProgress && (
              <InstallProgressBar progress={install.installProgress as InstallProgress} />
            )}

            {install.ghOk && (
              <div className="ex-ghform__ok">
                <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <p>{t('models.installSucceeded')}</p>
              </div>
            )}

            {install.ghErr && (
              <div className="ex-ghform__err">
                <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p>{install.ghErr}</p>
              </div>
            )}

            <p className="ex-ghform__hint">
              {t('models.ghHintBefore')} <span className="mono">manifest.json</span> {t('models.ghHintAnd')} <span className="mono">generator.py</span> {t('models.ghHintAfter')}
            </p>
          </div>
        </div>
      )}

      {/* 已停用的内置扩展：卸载 ≠ 删除，可一键放回来 */}
      <DisabledBar
        items={restore.disabled}
        busy={restore.restoring}
        onRestore={(ids) => void restore.restore(ids)}
      />

      {/* Extensions list */}
      <div className="ex-list">
        {extensions.length === 0 && !loading ? (
          <div className="ex-empty">
            <div className="ex-empty__icon">{CUBE_ICON}</div>
            <div className="ex-empty__text">
              <p className="ex-empty__title">{t('models.emptyTitle')}</p>
              <p className="ex-empty__sub">{t('models.emptySub')}</p>
            </div>
          </div>
        ) : loading ? (
          <div className="ex-loading">
            <span className="ex-spinner ex-spinner--lg" />
          </div>
        ) : filteredExtensions.length === 0 ? (
          <div className="ex-noresult">
            <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <p>{t('models.noMatch', { search })}</p>
          </div>
        ) : (
          <ExtensionList
            grouped={grouped}
            processList={processList}
            meshModelList={meshModelList}
            viewModelList={viewModelList}
            imageModelList={imageModelList}
            flatList={filteredExtensions}
            downloading={downloads.downloading}
            modelStatus={downloads.modelStatus}
            isInstalling={install.isInstalling}
            actions={cardActions}
          />
        )}
      </div>

      {/* Detail drawer */}
      {selectedExt && (
        <ExtensionDrawer
          ext={selectedExt}
          dl={downloads.downloading[selectedExt.id]}
          installed={!!downloads.modelStatus[selectedExt.id]?.downloaded}
          disabled={install.isInstalling}
          onClose={() => setSelectedId(null)}
          {...cardActions}
        />
      )}

      {/* 确认卸载 */}
      {uninstall.uninstallTarget && (
        <UninstallModal
          ext={uninstall.uninstallTarget}
          busy={uninstall.uninstallBusy}
          error={uninstall.uninstallError}
          onCancel={() => uninstall.setUninstallTarget(null)}
          onConfirm={(ext) => void uninstall.handleUninstallConfirm(ext)}
        />
      )}
    </div>
  )
}
