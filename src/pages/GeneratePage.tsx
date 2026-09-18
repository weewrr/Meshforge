// ─── 生成页：左侧工作流参数面板 + 右侧 3D 查看器 ──────────────────────────────
// 这是应用的主工作台。用户在这里挑选工作流、填写参数、执行生成，并在右侧
// three.js 查看器里预览/导入/导出网格。页面同时承载与"智能体对话模式"的切换。
//
// 结构（优化文档 7.3 拆分）：网格动作在 useMeshActions、资产库状态在
// useLibraryPanel、顶部工具栏与变换工具条在 ViewerToolbar；本文件保留
// 工作流选择 / 参数编辑 / 运行控制的主体逻辑。

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fullUrl, getWorkflow, saveWorkflow } from '../api'
import ErrorBoundary, { type ErrorBoundaryFallbackProps } from '../components/ErrorBoundary'
// three.js（约 2MB）再延后一层加载：页面骨架、参数面板与对话区先绘制出来，
// 视口在 Suspense 兜底之后异步补上，避免首屏被大包阻塞。
const Viewer3D = lazy(() => import('../components/Viewer3D'))
import { getT, useT } from '../i18n'
import { useLogsStore } from '../stores/logs'
import { useNavigationStore } from '../stores/navigation'
import { useSceneStore } from '../stores/scene'
import { topoSort, useWorkflowRunStore, HUNYUAN_MV_GENERATOR } from '../stores/workflowRun'
import { useWorkflowsStore } from '../stores/workflows'
import type { WFEdge, WFNode, Workflow } from '../types'
import ChatPanel from './generate/chatPanel'
import { isOpenable, toggleSectionKey, type LibraryEntry } from './generate/assetLibrary'
import { firstPreflightIssue } from './generate/preflight'
import { findStaleAssetRefs } from './generate/staleAssets'
import { WorkflowDropdown } from './generate/WorkflowDropdown'
import {
  GeneratorParamRow,
  ImageParamRow,
  MeshParamRow,
  TextParamRow,
  WaitParamRow,
  type PatchFn
} from './generate/ParamRows'
import { GenerationHUD, ViewerLoadError } from './generate/ToolbarBits'
import { GizmoToolbar, ViewerToolbar } from './generate/ViewerToolbar'
import { useLibraryPanel } from './generate/useLibraryPanel'
import { useMeshActions } from './generate/useMeshActions'
import type { OpenPanel } from './generate/viewerState'

/** 左侧面板宽度的下限（px）：再窄参数行就放不下了。 */
const MIN_WIDTH = 220
/** 左侧面板宽度的上限（px）：再宽会挤压 3D 视口。 */
const MAX_WIDTH = 520
/** 左侧面板的初始宽度（px）。 */
const DEFAULT_WIDTH = 320

// ─── 主页面 ────────────────────────────────────────────────────────────────

export default function GeneratePage() {
  const go = useNavigationStore((s) => s.go)
  const workflows = useWorkflowsStore((s) => s.workflows)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const loadList = useWorkflowsStore((s) => s.loadList)
  const selectInStore = useWorkflowsStore((s) => s.select)

  const meshUrl = useSceneStore((s) => s.meshUrl)
  const pushMeshUrl = useSceneStore((s) => s.pushMeshUrl)
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const redoMesh = useSceneStore((s) => s.redoMesh)
  // 撤销/重做是否可用，取决于历史游标是否触到两端。
  const canUndoMesh = useSceneStore((s) => s.historyIndex > 0)
  const canRedoMesh = useSceneStore((s) => s.historyIndex < s.meshHistory.length - 1)
  const meshStats = useSceneStore((s) => s.meshStats)
  const meshSelected = useSceneStore((s) => s.meshSelected)
  const gizmoMode = useSceneStore((s) => s.gizmoMode)
  const setGizmoMode = useSceneStore((s) => s.setGizmoMode)
  const light = useSceneStore((s) => s.lightSettings)
  const setLight = useSceneStore((s) => s.setLight)

  const runState = useWorkflowRunStore((s) => s.runState)
  const run = useWorkflowRunStore((s) => s.run)
  const cancel = useWorkflowRunStore((s) => s.cancel)

  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const [selectedId, setSelectedId] = useState('')
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [nodes, setNodes] = useState<WFNode[]>([])
  const [edges, setEdges] = useState<WFEdge[]>([])
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [mode, setMode] = useState<'basic' | 'chat'>('basic')
  // 拖拽标记放 ref 里：mousemove 高频触发，用 state 会引发无谓重渲染。
  const dragging = useRef(false)

  // 网格动作与资产库状态（拆出的 hook）
  const meshActions = useMeshActions(meshUrl, pushMeshUrl, setOpenPanel)
  const library = useLibraryPanel(openPanel)

  /** 运行中或暂停中都算"忙"：此时禁止改工作流选择、生成、清空等操作。 */
  const busy = runState === 'running' || runState === 'paused'
  const hasModel = !!meshUrl
  const t = useT()

  useEffect(() => {
    // 列表只加载一次；用 loaded 兜住 StrictMode 下的重复挂载。
    if (!loaded) void loadList()
  }, [loaded, loadList])

  // 默认选中：优先取编辑器当前打开的工作流，否则取列表第一个
  useEffect(() => {
    if (!selectedId && workflows.length > 0) {
      setSelectedId(useWorkflowsStore.getState().current?.id ?? workflows[0].id)
    }
  }, [workflows, selectedId])

  // 选中项变化时拉取完整工作流（列表里只有摘要，不含 nodes/edges）。
  useEffect(() => {
    if (!selectedId) return
    getWorkflow(selectedId)
      .then((wf) => {
        setWorkflow(wf)
        setNodes(wf.nodes)
        setEdges(wf.edges)
        // 行为债清偿（§19.3）：旧版工作流可能引用 workspace 外磁盘路径或
        // 已被清理的临时转换目录，加载时一次性提醒，避免到运行期才报 403/404。
        const stale = findStaleAssetRefs(wf.nodes)
        if (stale.length > 0) {
          useLogsStore.getState().warn(getT('generate.log.staleAssets', { count: stale.length, labels: stale.join(', ') }))
        }
      })
      .catch(() => setWorkflow(null))
  }, [selectedId])

  /** 打开选中的库资产：直接加载到 3D 查看器并计入撤销历史。 */
  function handleOpenLibraryAsset(entry: LibraryEntry | null): void {
    if (!entry || !isOpenable(entry)) return
    pushMeshUrl(fullUrl(entry.url))
    useLogsStore.getState().info(getT('generate.log.libraryOpen', { path: entry.workspacePath }))
    setOpenPanel(null)
  }

  /** 局部更新某个节点的参数（只合并 patch 字段，其余原样保留）。 */
  const patchNode = useCallback<PatchFn>((nodeId, patch) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
          : n
      )
    )
  }, [])

  // 参数修改后 500ms 防抖保存（首次挂载跳过）
  const didMount = useRef(false)
  useEffect(() => {
    // 首次挂载时 nodes/edges 刚从后端载入，不该立刻回写覆盖，因此直接跳过一轮。
    if (!didMount.current) { didMount.current = true; return }
    if (!workflow || !selectedId) return
    const timer = setTimeout(() => {
      void saveWorkflow({
        ...workflow,
        nodes,
        edges,
        updatedAt: new Date().toISOString()
      }).catch(() => undefined)
    }, 500)
    // 依赖变化时取消上一轮定时器，实现真正的"最后一次修改后 500ms 才存"。
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅对可编辑状态防抖
  }, [nodes, edges])

  // 网格历史快捷键 Ctrl+Z / Ctrl+Y
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 'z') { e.preventDefault(); undoMesh() }
      if (e.key === 'y') { e.preventDefault(); redoMesh() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoMesh, redoMesh])

  // Gizmo 快捷键：W 移动 / R 旋转 / S 缩放 / Esc 退出
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // 焦点在输入控件里时不抢键，否则用户在文本框打 w/s/r 会被当成快捷键。
      const el = document.activeElement as HTMLElement | null
      if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return
      if (e.key === 'Escape') { setGizmoMode(null); return }
      if (!hasModel || !meshSelected) return
      const k = e.key.toLowerCase()
      // 再按同一个键则取消该模式（开关式切换）。
      if (k === 'w') setGizmoMode(gizmoMode === 'translate' ? null : 'translate')
      else if (k === 'r') setGizmoMode(gizmoMode === 'rotate' ? null : 'rotate')
      else if (k === 's') setGizmoMode(gizmoMode === 'scale' ? null : 'scale')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasModel, meshSelected, gizmoMode, setGizmoMode])

  // 参数行按拓扑序展示（只展示带参数的节点类型）
  const paramNodes = workflow
    ? topoSort(nodes, edges)
        .map((id) => nodes.find((n) => n.id === id)!)
        .filter((n) =>
          n.type === 'imageNode' || n.type === 'textNode' || n.type === 'meshNode' ||
          n.type === 'waitNode' || n.type === 'generatorNode'
        )
    : []

  // 提交前的第一处问题：非空即代表"不可运行"，用于禁用生成按钮并给出提示。
  const preflightIssue = workflow ? firstPreflightIssue(nodes, edges) : null

  // 判断每个 imageNode 是否直连 hunyuan3d-2-mv 生成器（四视角）：若是则在图片区
  // 显示 4 视角上传 UI。
  const mvImageNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of nodes) {
      if (n.type !== 'generatorNode') continue
      if (String(n.data.params.generatorId ?? '') !== HUNYUAN_MV_GENERATOR) continue
      const up = edges.find((e) => e.target === n.id)?.source
      if (up) ids.add(up)
    }
    return ids
  }, [nodes, edges])

  function handleGenerate(): void {
    if (!workflow || preflightIssue) return
    // 先把当前编辑态落盘再运行：避免运行器读到旧快照（比如刚改完参数就点生成）。
    const wf = { ...workflow, nodes, edges, updatedAt: new Date().toISOString() }
    void saveWorkflow(wf).catch(() => undefined)
    void run(wf)
  }

  // 左面板拖宽
  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      // 用 movementX 增量累加并夹在 [MIN_WIDTH, MAX_WIDTH] 内。
      setPanelWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + ev.movementX)))
    }
    const onUp = (): void => {
      dragging.current = false
      // 松手即解绑，避免监听器泄漏到后续交互。
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  /** 跳到工作流编辑器（若已有选中项，顺带把它设为编辑器当前工作流）。 */
  function openEditor(): void {
    if (selectedId) void selectInStore(selectedId)
    go('workflows')
  }

  return (
    <div className="gp">
      {/* 左侧工作流面板 */}
      <aside className="gp-panel" style={{ width: panelWidth }}>
        {/* 模式切换：basic / chat */}
        <div className="gp-mode">
          <div className="gp-mode__box">
            {(['basic', 'chat'] as const).map((m) => (
              <button
                key={m}
                className={`gp-mode__btn ${mode === m ? 'gp-mode__btn--active' : ''}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {t(m === 'basic' ? 'generate.mode.basic' : 'generate.mode.chat')}
              </button>
            ))}
          </div>
        </div>

        {mode === 'chat' ? (
          <ChatPanel />
        ) : (
          <>
            <div className="gp-panel__header">
              <h2 className="gp-panel__title">{t('generate.panel.title')}</h2>
              <div className="gp-panel__selectrow">
                <WorkflowDropdown
                  workflows={workflows}
                  value={selectedId}
                  onChange={setSelectedId}
                  disabled={busy}
                />
                {selectedId && (
                  <button className="gp-edit" title={t('generate.actions.editWorkflow')} aria-label={t('generate.actions.editWorkflow')} onClick={openEditor}>
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted2)' }}>
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* 参数行列表 */}
            <div className="gp-params">
              {paramNodes.map((node) => (
                <div key={node.id} className="gp-row">
                  {node.type === 'imageNode' && <ImageParamRow node={node} onPatch={patchNode} mv={mvImageNodeIds.has(node.id)} />}
                  {node.type === 'textNode' && <TextParamRow node={node} onPatch={patchNode} />}
                  {node.type === 'meshNode' && <MeshParamRow node={node} onPatch={patchNode} />}
                  {node.type === 'waitNode' && <WaitParamRow nodeId={node.id} />}
                  {node.type === 'generatorNode' && <GeneratorParamRow node={node} />}
                </div>
              ))}
              {workflow && paramNodes.length === 0 && (
                <div className="gp-params__empty">
                  <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                  <p>{t('generate.empty.noConfigurableNodes')}</p>
                  <button className="gp-params__link" onClick={openEditor}>
                    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    {t('generate.empty.openEditor')}
                  </button>
                </div>
              )}
              {!workflow && (
                <div className="gp-params__empty">
                  <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <path d="M17.5 14.5v6M14.5 17.5h6" />
                  </svg>
                  <p>{t('generate.empty.noWorkflows')}<br />{t('generate.empty.createWorkflowTab')}</p>
                </div>
              )}
            </div>

            {/* 底部：preflight 警告 + 运行按钮 */}
            <div className="gp-panel__footer">
              {preflightIssue && !busy && (
                <div className="gp-warn">
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span>{preflightIssue}</span>
                </div>
              )}
              {busy ? (
                <button className="gp-generate gp-generate--stop" onClick={() => void cancel()}>{t('generate.actions.stop')}</button>
              ) : (
                <button
                  className="gp-generate"
                  disabled={!workflow || nodes.length === 0 || !!preflightIssue}
                  onClick={handleGenerate}
                >
                  {t('generate.actions.generate')}
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      {/* 拖宽手柄 */}
      <div className="gp-resizer" onMouseDown={onResizeDown} />

      {/* 右侧：工具栏 + 3D 查看器 */}
      <div className="gp-main">
        <ViewerToolbar
          openPanel={openPanel}
          setOpenPanel={setOpenPanel}
          busy={busy}
          canUndoMesh={canUndoMesh}
          canRedoMesh={canRedoMesh}
          hasModel={hasModel}
          triangles={meshStats?.triangles ?? null}
          light={light}
          setLight={setLight}
          importing={meshActions.importing}
          decimating={meshActions.decimating}
          smoothing={meshActions.smoothing}
          exporting={meshActions.exporting}
          unloadStatus={meshActions.unloadStatus}
          onUnloadAll={meshActions.handleUnloadAll}
          onImportMesh={() => void meshActions.handleImportMesh()}
          onExport={(fmt) => void meshActions.handleExport(fmt)}
          onDecimate={meshActions.handleDecimate}
          onSmooth={meshActions.handleSmooth}
          libraryEntries={library.libraryEntries}
          librarySelectedId={library.librarySelectedId}
          libraryLoading={library.libraryLoading}
          libraryError={library.libraryError}
          librarySearch={library.librarySearch}
          librarySort={library.librarySort}
          libraryCollapsed={library.libraryCollapsed}
          onLibraryRefresh={() => void library.loadLibrary(true)}
          onLibrarySelect={library.setLibrarySelectedId}
          onLibrarySearch={library.setLibrarySearch}
          onLibrarySort={library.setLibrarySort}
          onLibraryToggleSection={(keys, key) => library.setLibraryCollapsed(toggleSectionKey(keys, key))}
          onLibraryOpen={handleOpenLibraryAsset}
        />

        {/* 变换工具条（模型选中后出现） */}
        <GizmoToolbar />

        <div className="gp-viewer">
          <ErrorBoundary
            label="Viewer3D"
            fallback={({ error }: ErrorBoundaryFallbackProps) => <ViewerLoadError error={error} />}
          >
            {/* 始终挂载：没有模型时的空状态（常驻地面网格 + 提示浮层）由
                Viewer3D 内部渲染，与 modly 行为保持一致。 */}
            <Suspense fallback={<div className="gp-viewer__deferred" aria-hidden="true" />}>
              <Viewer3D url={meshUrl} light={light} />
            </Suspense>
          </ErrorBoundary>
          <GenerationHUD nodes={nodes} />
        </div>
      </div>
    </div>
  )
}
