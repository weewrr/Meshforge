/**
 * 工作流页面：应用内的可视化编程主界面。
 *
 * 顶层聚合标签页、工具栏、扩展面板与画布，并负责把子图编辑器、打开 / 帮助
 * 弹窗叠加其上；运行态（暂停 / 单步）的工具条与全局快捷键也在此集中管理。
 */

import { useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorkflowsStore } from '../stores/workflows'
import { useWorkflowRunStore } from '../stores/workflowRun'
import { useNavigationStore } from '../stores/navigation'
import { useLogsStore } from '../stores/logs'
import { toast } from '../stores/toasts'
import ExtensionsPanel from './workflows/extensionsPanel'
import OpenPopup from './workflows/openPopup'
import HelpModal from './workflows/HelpModal'
import Canvas from './workflows/canvas'
import SubgraphEditor from './workflows/subeditor'
import { useSubEditorOpen } from './workflows/subEditorState'
import { useT } from '../i18n'

/**
 * 工作流页面根组件。聚合标签页、工具栏、扩展面板与画布，并挂载
 * 子图编辑器 / 打开 / 帮助三类叠加弹层；运行期工具条与全局快捷键在此统一处理。
 */
export default function WorkflowsPage() {
  const t = useT()
  const workflows = useWorkflowsStore((s) => s.workflows)
  const current = useWorkflowsStore((s) => s.current)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const dirty = useWorkflowsStore((s) => s.dirty)
  const canUndo = useWorkflowsStore((s) => s.canUndo)
  const canRedo = useWorkflowsStore((s) => s.canRedo)
  const loadList = useWorkflowsStore((s) => s.loadList)
  const select = useWorkflowsStore((s) => s.select)
  const create = useWorkflowsStore((s) => s.create)
  const rename = useWorkflowsStore((s) => s.rename)
  const remove = useWorkflowsStore((s) => s.remove)
  const duplicate = useWorkflowsStore((s) => s.duplicate)
  const importWorkflow = useWorkflowsStore((s) => s.importWorkflow)
  const undo = useWorkflowsStore((s) => s.undo)
  const redo = useWorkflowsStore((s) => s.redo)
  const save = useWorkflowsStore((s) => s.save)

  const runState = useWorkflowRunStore((s) => s.runState)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const runningWorkflowId = useWorkflowRunStore((s) =>
    s.runState === 'running' || s.runState === 'paused' ? s.currentWorkflowId : null
  )
  const run = useWorkflowRunStore((s) => s.run)
  const cancel = useWorkflowRunStore((s) => s.cancel)
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const pause = useWorkflowRunStore((s) => s.pause)
  const stepOver = useWorkflowRunStore((s) => s.stepOver)
  // 子图编辑器打开时，页面级快捷键（含 Ctrl+Z）让位给编辑器自己的草稿历史。
  const subEditorOpen = useSubEditorOpen()

  const go = useNavigationStore((s) => s.go)

  const [openPopupVisible, setOpenPopupVisible] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)
  // 子图编辑器路径：进入 subgraphNode 时记录从根到当前层的 subgraph 节点 id 序列。
  const [subEditorPath, setSubEditorPath] = useState<string[] | null>(null)

  const reorderTab = useWorkflowsStore((s) => s.reorderTab)

  // 原生对话框导入工作流——主进程打开对话框、读取 JSON 并返回内容
  // （沙箱化的渲染进程没有文件系统权限，且 <input type=file> 会冻住
  // 这台机器的渲染进程，见 HANDOFF §6）。
  async function openImportPicker(): Promise<void> {
    if (!window.meshforge?.selectWorkflowFile) {
      useLogsStore.getState().warn('[workflows] native file dialog unavailable (browser-only run)')
      return
    }
    const picked = await window.meshforge.selectWorkflowFile()
    if (!picked) return
    try {
      const parsed = JSON.parse(picked.content)
      if (typeof parsed?.id !== 'string' || !Array.isArray(parsed?.nodes)) {
        throw new Error('Not a valid workflow JSON')
      }
      await importWorkflow(parsed)
      toast.success(t('workflows.importOk'))
    } catch (err) {
      useLogsStore.getState().error(`import workflow: ${err instanceof Error ? err.message : String(err)}`)
      toast.error(t('workflows.importFail'))
    }
  }

  useEffect(() => {
    if (!loaded) void loadList()
  }, [loaded, loadList])

  // 点击外部任意处时关闭标签页右键菜单。
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [tabMenu])

  // 标签页与编辑相关快捷键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 子图编辑器覆盖在主画布之上，它自己处理 Ctrl+Z / 方向键等，这里全部让位。
      if (subEditorOpen) return
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if ((e.ctrlKey || e.metaKey) && !typing) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault()
          undo()
          return
        }
        if (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')) {
          e.preventDefault()
          redo()
          return
        }
        if (e.key.toLowerCase() === 't') {
          e.preventDefault()
          void create()
          return
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          if (workflows.length < 2 || !current) return
          const idx = workflows.findIndex((w) => w.id === current.id)
          if (idx < 0) return
          const next = e.shiftKey
            ? (idx - 1 + workflows.length) % workflows.length
            : (idx + 1) % workflows.length
          void select(workflows[next].id)
        }
        return
      }
      // Ctrl+W 在输入（名称字段）时也要生效——关闭标签页永远不算文本编辑。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (current) void remove(current.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workflows, current, undo, redo, create, save, select, remove, subEditorOpen])

  const busy = runState === 'running' || runState === 'paused'
  const activeLabel = activeNodeId
    ? current?.nodes.find((n) => n.id === activeNodeId)?.data.label ?? ''
    : ''

  function exportCurrent(): void {
    if (!current) return
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${current.name || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(t('workflows.exportOk'))
  }

  async function handleRun(): Promise<void> {
    if (!current) return
    // 先冲掉待写的自动保存，让运行用的是最新图。
    await save()
    await run(useWorkflowsStore.getState().current ?? current)
  }

  return (
    <div className="wf-page">
      <div className="wf-tabs" role="tablist">
        {workflows.map((w) => (
          <div
            key={w.id}
            className={`wf-tab ${current?.id === w.id ? 'wf-tab--active' : ''}`}
            role="tab"
            aria-selected={current?.id === w.id}
            tabIndex={current?.id === w.id ? 0 : -1}
            draggable
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void select(w.id)
              }
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('meshforge/tab-id', w.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('meshforge/tab-id')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverTab(w.id)
            }}
            onDragLeave={() => setDragOverTab((cur) => (cur === w.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverTab(null)
              const dragId = e.dataTransfer.getData('meshforge/tab-id')
              if (dragId) reorderTab(dragId, w.id)
            }}
            onDragEnd={() => setDragOverTab(null)}
            onClick={() => void select(w.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                void remove(w.id)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu({ id: w.id, x: e.clientX, y: e.clientY })
            }}
          >
            {dragOverTab === w.id && <span className="wf-tab__drop" />}
            {w.bookmarked && (
              <span className="wf-tab__star" title={t('workflows.tab.favorited')}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </span>
            )}
            <span className="wf-tab__name">{w.name}</span>
            {runningWorkflowId === w.id && (
              <span className="wf-tab__running" title={t('workflows.tab.running')} />
            )}
            {!busy && (
              <button
                className="wf-tab__close"
                title={t('workflows.tab.close')}
                aria-label={t('workflows.tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(w.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="wf-tab__add" title={t('workflows.tab.new')} aria-label={t('workflows.tab.new')} onClick={() => void create()}>
          +
        </button>
      </div>

      {/* 标签页右键菜单 */}
      {tabMenu && (
        <div className="wf-ctxmenu" style={{ left: tabMenu.x, top: tabMenu.y }}>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              void select(tabMenu.id)
              setOpenPopupVisible(true)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.openList')}
          </button>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              void duplicate(tabMenu.id)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.duplicate')}
          </button>
          <button
            className="wf-ctxmenu__item"
            onClick={() => {
              const wf = workflows.find((w) => w.id === tabMenu.id)
              if (wf && current?.id === wf.id) exportCurrent()
              setTabMenu(null)
            }}
            disabled={current?.id !== tabMenu.id}
          >
            {t('workflows.ctxMenu.export')}
          </button>
          <div className="wf-ctxmenu__sep" />
          <button
            className="wf-ctxmenu__item wf-ctxmenu__item--danger"
            onClick={() => {
              void remove(tabMenu.id)
              setTabMenu(null)
            }}
          >
            {t('workflows.ctxMenu.delete')}
          </button>
        </div>
      )}

      <div className="wf-body">
        <div className="wf-main">
          <div className="wf-toolbar">
            <button className="wf-tool-btn" title={t('workflows.toolbar.openWorkflow')} onClick={() => setOpenPopupVisible(true)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
              {t('workflows.toolbar.open')}
            </button>
            <button className="wf-tool-btn" title={t('workflows.toolbar.importJson')} onClick={openImportPicker}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
                <polyline points="7 9 12 4 17 9" />
                <line x1="12" y1="4" x2="12" y2="16" />
              </svg>
              {t('workflows.toolbar.import')}
            </button>
            <button
              className="wf-tool-btn"
              title={t('workflows.toolbar.exportJson')}
              disabled={!current}
              onClick={exportCurrent}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
                <polyline points="7 15 12 20 17 15" />
                <line x1="12" y1="4" x2="12" y2="16" />
              </svg>
              {t('workflows.toolbar.export')}
            </button>
            <span className="wf-toolbar__sep" />
            <button className="wf-tool-btn" title={t('workflows.toolbar.undo')} aria-label={t('workflows.toolbar.undo')} disabled={!canUndo} onClick={undo}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
              </svg>
            </button>
            <button className="wf-tool-btn" title={t('workflows.toolbar.redo')} aria-label={t('workflows.toolbar.redo')} disabled={!canRedo} onClick={redo}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
              </svg>
            </button>

            {current ? (
              <input
                className="wf-toolbar__name"
                value={current.name}
                onChange={(e) => rename(e.target.value)}
                disabled={busy}
              />
            ) : (
              <span className="wf-toolbar__name">…</span>
            )}
            <span className={`wf-toolbar__dirty ${dirty ? '' : 'wf-toolbar__dirty--saved'}`}>
              {dirty ? t('workflows.toolbar.unsaved') : t('workflows.toolbar.saved')}
            </span>

            <span className="wf-toolbar__spacer" />

            <div className="wf-toolbar__actions">
              {busy && activeLabel && (
                <span className="wf-toolbar__step" title={activeLabel}>
                  {activeLabel}
                </span>
              )}
              {runState === 'paused' && (
                <>
                  <button className="primary" onClick={continueRun}>
                    {t('workflows.toolbar.continue')}
                  </button>
                  <button className="wf-tool-btn" title={t('workflows.toolbar.step')} onClick={stepOver}>
                    {t('workflows.toolbar.step')}
                  </button>
                </>
              )}
              {busy ? (
                <>
                  {runState === 'running' && (
                    <button className="wf-tool-btn" title={t('workflows.toolbar.pause')} onClick={pause}>
                      {t('workflows.toolbar.pause')}
                    </button>
                  )}
                  <button className="wf-stop-btn" onClick={() => void cancel()}>
                    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="4" y="4" width="16" height="16" rx="1.5" />
                    </svg>
                    {t('workflows.toolbar.stop')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="wf-run-btn"
                    disabled={!current || current.nodes.length === 0}
                    title={t('workflows.toolbar.runWorkflow')}
                    onClick={() => void handleRun()}
                  >
                    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {t('workflows.toolbar.run')}
                  </button>
                  <button className="ghost" title={t('workflows.toolbar.viewerTitle')} onClick={() => go('generate')}>
                    {t('workflows.toolbar.viewer')}
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </>
              )}
              <button
                className={`wf-tool-btn ${helpOpen ? 'wf-tool-btn--active' : ''}`}
                title={t('workflows.toolbar.helpTitle')}
                aria-label={t('workflows.toolbar.helpTitle')}
                onClick={() => setHelpOpen(true)}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
            </div>
          </div>

          {current ? (
            <ReactFlowProvider key={current.id}>
              <Canvas
                onOpenSubgraph={(id) => setSubEditorPath([id])}
              />
            </ReactFlowProvider>
          ) : (
            <div className="wf-empty">{t('workflows.loading')}</div>
          )}
        </div>
        <ExtensionsPanel onOpenFunction={(p) => setSubEditorPath(p.length > 0 ? p : null)} />
      </div>

      {openPopupVisible && <OpenPopup onClose={() => setOpenPopupVisible(false)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {subEditorPath && (
        <SubgraphEditor
          path={subEditorPath}
          onClose={() => setSubEditorPath(null)}
          onDescend={(innerId) => setSubEditorPath((p) => [...(p ?? []), innerId])}
          onJump={(p) => setSubEditorPath(p.length > 0 ? p : null)}
        />
      )}
    </div>
  )
}
