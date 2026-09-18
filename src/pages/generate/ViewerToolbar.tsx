/**
 * GeneratePage 顶部工具栏与变换工具条。
 *
 * 从 GeneratePage 抽出的展示组件：全部状态与动作由页面（hook）传入，
 * 这里只负责渲染与弹层开关。
 */

import type { Dispatch, SetStateAction } from 'react'
import { useT } from '../../i18n'
import { useSceneStore, type LightSettings } from '../../stores/scene'
import {
  ChevronDown,
  DecimatePopover,
  EXPORT_FORMATS,
  LightPopover,
  SmoothPopover,
  Spinner
} from './ToolbarBits'
import { LibraryPanel } from './LibraryPanel'
import type { OpenPanel } from './viewerState'

interface ViewerToolbarProps {
  openPanel: OpenPanel
  setOpenPanel: Dispatch<SetStateAction<OpenPanel>>
  busy: boolean
  canUndoMesh: boolean
  canRedoMesh: boolean
  hasModel: boolean
  triangles: number | null
  light: LightSettings
  setLight: (patch: Partial<LightSettings>) => void
  // 网格动作（useMeshActions）
  importing: boolean
  decimating: boolean
  smoothing: boolean
  exporting: 'glb' | 'obj' | 'stl' | 'ply' | null
  unloadStatus: 'idle' | 'done'
  onUnloadAll: () => void
  onImportMesh: () => void
  onExport: (fmt: 'glb' | 'obj' | 'stl' | 'ply') => void
  onDecimate: (targetFaces: number) => void
  onSmooth: (iterations: number) => void
  // 资产库（useLibraryPanel）
  libraryEntries: Parameters<typeof LibraryPanel>[0]['entries']
  librarySelectedId: string | null
  libraryLoading: boolean
  libraryError: string | null
  librarySearch: string
  librarySort: Parameters<typeof LibraryPanel>[0]['sort']
  libraryCollapsed: string[]
  onLibraryRefresh: () => void
  onLibrarySelect: (id: string | null) => void
  onLibrarySearch: (v: string) => void
  onLibrarySort: (v: Parameters<typeof LibraryPanel>[0]['sort']) => void
  onLibraryToggleSection: (keys: string[], key: string) => void
  onLibraryOpen: Parameters<typeof LibraryPanel>[0]['onOpen']
}

export function ViewerToolbar(props: ViewerToolbarProps) {
  const {
    openPanel, setOpenPanel, busy, canUndoMesh, canRedoMesh, hasModel, triangles, light,
    importing, decimating, smoothing, exporting, unloadStatus,
    onUnloadAll, onImportMesh, onExport, onDecimate, onSmooth,
    libraryEntries, librarySelectedId, libraryLoading, libraryError,
    librarySearch, librarySort, libraryCollapsed,
    onLibraryRefresh, onLibrarySelect, onLibrarySearch, onLibrarySort,
    onLibraryToggleSection, onLibraryOpen
  } = props
  const t = useT()
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const redoMesh = useSceneStore((s) => s.redoMesh)

  return (
    <div className="gp-toolbar">
      {/* 释放内存 */}
      <button className="gp-toolbtn" onClick={onUnloadAll} disabled={busy} title={t('generate.actions.freeModelTitle')}>
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
        </svg>
        {unloadStatus === 'done' ? t('generate.actions.freed') : t('generate.actions.freeMemory')}
      </button>

      <div className="gp-toolbar__sep" />

      {/* 撤销 / 重做 */}
      <button className="gp-toolbtn gp-toolbtn--icon" onClick={undoMesh} disabled={!canUndoMesh} title={t('generate.actions.undo')} aria-label={t('generate.actions.undo')}>
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 7v6h6" />
          <path d="M3 13a9 9 0 1 0 2.28-5.93" />
        </svg>
      </button>
      <button className="gp-toolbtn gp-toolbtn--icon" onClick={redoMesh} disabled={!canRedoMesh} title={t('generate.actions.redo')} aria-label={t('generate.actions.redo')}>
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M21 7v6h-6" />
          <path d="M21 13a9 9 0 1 1-2.28-5.93" />
        </svg>
      </button>

      <div className="gp-toolbar__sep" />

      {/* 导入 */}
      <div className="gp-relative">
        <button
          className={`gp-toolbtn ${openPanel === 'import' ? 'gp-toolbtn--active' : ''}`}
          onClick={() => setOpenPanel((p) => (p === 'import' ? null : 'import'))}
          disabled={importing}
        >
          {importing ? <Spinner /> : (
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
          {importing ? t('generate.import.importing') : t('generate.import.title')}
          {!importing && <ChevronDown />}
        </button>
        {openPanel === 'import' && (
          <div className="gp-menu">
            <button onClick={onImportMesh}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>
                <span className="gp-menu__title">{t('generate.import.mesh')}</span>
                <span className="gp-menu__desc">{t('generate.import.formats')}</span>
              </span>
            </button>
          </div>
        )}
      </div>

      {/* 资产库 */}
      <div className="gp-relative">
        <button
          className={`gp-toolbtn ${openPanel === 'library' ? 'gp-toolbtn--active' : ''}`}
          onClick={() => setOpenPanel((p) => (p === 'library' ? null : 'library'))}
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" />
          </svg>
          {t('generate.library.title')}
        </button>
        {openPanel === 'library' && (
          <LibraryPanel
            entries={libraryEntries}
            selectedId={librarySelectedId}
            loading={libraryLoading}
            error={libraryError}
            search={librarySearch}
            sort={librarySort}
            collapsed={libraryCollapsed}
            onRefresh={onLibraryRefresh}
            onSelect={onLibrarySelect}
            onSearch={onLibrarySearch}
            onSort={onLibrarySort}
            onToggleSection={onLibraryToggleSection}
            onOpen={onLibraryOpen}
          />
        )}
      </div>

      {hasModel && (
        <>
          <div className="gp-toolbar__sep" />

          {/* 导出 */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn ${openPanel === 'export' || exporting ? 'gp-toolbtn--active' : ''}`}
              onClick={() => setOpenPanel((p) => (p === 'export' ? null : 'export'))}
              disabled={exporting !== null}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 5 17 10" />
                <line x1="12" y1="5" x2="12" y2="15" />
              </svg>
              {exporting ? t('generate.export.exportingFmt', { fmt: exporting }) : t('generate.export.title')}
              <ChevronDown />
            </button>
            {openPanel === 'export' && (
              <div className="gp-menu">
                {EXPORT_FORMATS.map(({ fmt, descKey }) => (
                  <button
                    key={fmt}
                    disabled={exporting !== null}
                    onClick={() => { onExport(fmt); setOpenPanel(null) }}
                  >
                    <span className="gp-menu__fmt">.{fmt}</span>
                    <span className="gp-menu__desc">{exporting === fmt ? t('generate.export.processing') : t(descKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 平滑 */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn ${openPanel === 'smooth' || smoothing ? 'gp-toolbtn--active' : ''}`}
              onClick={() => setOpenPanel((p) => (p === 'smooth' ? null : 'smooth'))}
              disabled={smoothing}
            >
              {smoothing ? <Spinner /> : (
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
              {smoothing ? t('generate.common.processing') : t('generate.smooth.title')}
            </button>
            {openPanel === 'smooth' && (
              <SmoothPopover smoothing={smoothing} onSmooth={onSmooth} onClose={() => setOpenPanel(null)} />
            )}
          </div>

          {/* 减面 */}
          <div className="gp-relative">
            <button
              className={`gp-toolbtn ${openPanel === 'decimate' || decimating ? 'gp-toolbtn--active' : ''}`}
              onClick={() => setOpenPanel((p) => (p === 'decimate' ? null : 'decimate'))}
              disabled={decimating}
            >
              {decimating ? <Spinner /> : (
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polygon points="12 2 22 20 2 20" />
                  <line x1="12" y1="9" x2="8" y2="17" />
                  <line x1="12" y1="9" x2="16" y2="17" />
                  <line x1="8" y1="17" x2="16" y2="17" />
                </svg>
              )}
              {decimating ? t('generate.common.processing') : t('generate.decimate.title')}
            </button>
            {openPanel === 'decimate' && (
              <DecimatePopover
                currentTriangles={triangles}
                decimating={decimating}
                onDecimate={onDecimate}
                onClose={() => setOpenPanel(null)}
              />
            )}
          </div>
        </>
      )}

      <div className="gp-spacer" />

      {/* Light — 始终靠右 */}
      <div className="gp-relative">
        <button
          className={`gp-toolbtn gp-toolbtn--icon ${openPanel === 'light' ? 'gp-toolbtn--active' : ''}`}
          title={t('generate.light.title')}
          aria-label={t('generate.light.title')}
          onClick={() => setOpenPanel((p) => (p === 'light' ? null : 'light'))}
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="12" cy="12" r="4" />
            <line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" />
            <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
            <line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" />
            <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
          </svg>
        </button>
        {openPanel === 'light' && (
          <LightPopover
            settings={light}
            onChange={(patch) => props.setLight(patch)}
            onClose={() => setOpenPanel(null)}
          />
        )}
      </div>
    </div>
  )
}

/** 变换工具条（模型选中后出现）：移动 / 旋转 / 缩放手柄开关。 */
export function GizmoToolbar() {
  const t = useT()
  const meshSelected = useSceneStore((s) => s.meshSelected)
  const gizmoMode = useSceneStore((s) => s.gizmoMode)
  const setGizmoMode = useSceneStore((s) => s.setGizmoMode)
  const hasModel = useSceneStore((s) => !!s.meshUrl)
  if (!hasModel || !meshSelected) return null

  return (
    <div className="gp-tools">
      <button
        className={`gp-tools__btn ${gizmoMode === 'translate' ? 'gp-tools__btn--active' : ''}`}
        title={t('generate.tools.move')}
        aria-label={t('generate.tools.move')}
        onClick={() => setGizmoMode(gizmoMode === 'translate' ? null : 'translate')}
      >
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" />
          <polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" />
          <line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
        </svg>
      </button>
      <button
        className={`gp-tools__btn ${gizmoMode === 'rotate' ? 'gp-tools__btn--active' : ''}`}
        title={t('generate.tools.rotate')}
        aria-label={t('generate.tools.rotate')}
        onClick={() => setGizmoMode(gizmoMode === 'rotate' ? null : 'rotate')}
      >
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M21 2v6h-6" />
          <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
        </svg>
      </button>
      <button
        className={`gp-tools__btn ${gizmoMode === 'scale' ? 'gp-tools__btn--active' : ''}`}
        title={t('generate.tools.scale')}
        aria-label={t('generate.tools.scale')}
        onClick={() => setGizmoMode(gizmoMode === 'scale' ? null : 'scale')}
      >
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
        </svg>
      </button>
    </div>
  )
}
