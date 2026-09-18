/**
 * "打开工作流"弹窗。
 *
 * 以卡片网格展示全部工作流，支持：搜索、按文件夹分组（可折叠 / 重命名颜色 /
 * 书签置顶）、把卡片拖进文件夹归类、以及重命名与删除两个确认弹窗。
 *
 * 注意：**文件夹本身不是后端概念**——它只存在于 localStorage（见 `./folders`），
 * 卡片上的 `folder` 字段是写在工作流文档里的归属标记，二者靠文件夹名关联。
 */

import { useEffect, useState, type ReactElement } from 'react'
import { getWorkflow, saveWorkflow } from '../../../api'
import { useWorkflowsStore } from '../../../stores/workflows'
import { useAppStore } from '../../../stores/app'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import type { Workflow } from '../../../types'
import { useT } from '../../../i18n'
import { ACTION_ICONS } from './icons'
import { WorkflowMiniPreview } from './MiniPreview'
import {
  FOLDER_COLORS,
  FOLDERS_KEY,
  FOLDER_COLORS_KEY,
  FOLDER_BOOKMARKS_KEY,
  readJson,
  writeJson
} from './folders'

/** 打开工作流弹窗。 */
export default function OpenPopup({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useAppStore((s) => s.locale)
  // 焦点陷阱同时处理 Escape 关闭，保证弹窗是"模态"的。
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  // 取别名，避免下面每个动作都写一遍完整 hook 名。
  const store = useWorkflowsStore
  const select = store((s) => s.select)
  const duplicate = store((s) => s.duplicate)
  const remove = store((s) => s.remove)
  const moveToFolder = store((s) => s.moveToFolder)
  const toggleBookmark = store((s) => s.toggleBookmark)

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [search, setSearch] = useState('')
  // null = 未在新建；'' = 已展开输入框但还没输入内容。用 null 与 '' 区分这两种状态。
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [colorPickerFolder, setColorPickerFolder] = useState<string | null>(null)

  // 文件夹元数据全部来自 localStorage（惰性初始化，只在首次挂载时读一次）。
  const [folders, setFolders] = useState<string[]>(() => readJson<string[]>(FOLDERS_KEY, []))
  const [folderColors, setFolderColors] = useState<Record<string, string>>(() =>
    readJson<Record<string, string>>(FOLDER_COLORS_KEY, {})
  )
  const [bookmarkedFolders, setBookmarkedFolders] = useState<string[]>(() =>
    readJson<string[]>(FOLDER_BOOKMARKS_KEY, [])
  )

  /**
   * 重新拉取全部工作流。
   *
   * 列表接口只返回元信息（列表页够用），这里为了渲染缩略图需要完整文档，
   * 因此逐个 `getWorkflow` 并发拉取；单个失败降级为 null 并在下一步过滤掉，
   * 不让一个坏文档搞崩整个弹窗。
   */
  async function refresh(): Promise<void> {
    const metas = await store.getState().loadList().then(() => store.getState().workflows)
    const full = await Promise.all(
      metas.map((m) => getWorkflow(m.id).catch(() => null))
    )
    setWorkflows(full.filter((w): w is Workflow => !!w))
  }

  useEffect(() => {
    void refresh()
    // 只在挂载时拉一次；后续刷新由各操作显式调用 refresh()。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape 键关闭"最上层"的那个：先关确认弹窗，最后才关整个面板。
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

  /** 更新文件夹列表并写盘。 */
  function persistFolders(next: string[]): void {
    setFolders(next)
    writeJson(FOLDERS_KEY, next)
  }

  /** 设置文件夹颜色并写盘。 */
  function setFolderColor(folder: string, color: string): void {
    const next = { ...folderColors, [folder]: color }
    setFolderColors(next)
    writeJson(FOLDER_COLORS_KEY, next)
  }

  /** 切换文件夹书签（决定分组排序时是否置顶）。 */
  function toggleFolderBookmark(folder: string): void {
    const next = bookmarkedFolders.includes(folder)
      ? bookmarkedFolders.filter((f) => f !== folder)
      : [...bookmarkedFolders, folder]
    setBookmarkedFolders(next)
    writeJson(FOLDER_BOOKMARKS_KEY, next)
  }

  /**
   * 删除文件夹。
   *
   * 只解除归属，**不删除里面的工作流**——把它们移回根级（未分组），
   * 避免用户误删一个文件夹就丢掉整组工作流。
   */
  function deleteFolder(name: string): void {
    persistFolders(folders.filter((f) => f !== name))
    for (const wf of workflows.filter((w) => w.folder === name)) {
      void moveToFolder(wf.id, undefined)
    }
    void refresh()
  }

  /** 打开某个工作流并关闭弹窗。 */
  function openWorkflow(id: string): void {
    void select(id)
    onClose()
  }

  /** 卡片的强调色取自它所属文件夹的颜色；未分组则无强调色。 */
  const workflowColor = (wf: Workflow): string | undefined =>
    wf.folder ? folderColors[wf.folder] : undefined

  /** 渲染一张工作流卡片。 */
  function renderCard(wf: Workflow): ReactElement {
    const color = workflowColor(wf)
    return (
      <div
        key={wf.id}
        className="wf-card"
        draggable
        onDragStart={(e) => {
          // 用自定义 MIME 类型：既能被本弹窗的文件夹识别，
          // 又不会被浏览器当成普通文本拖拽而插入其它输入框。
          e.dataTransfer.setData('application/meshforge-wf', wf.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => openWorkflow(wf.id)}
        title={wf.name}
      >
        <div className="wf-card__preview">
          {/* 有归属文件夹时铺一层同色光晕，让分组在视觉上可辨。 */}
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
                // 阻止冒泡：否则点动作按钮会同时触发卡片的"打开工作流"。
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
                // 只弹确认框，真正的删除在确认后进行。
                setDeleteTarget(wf.id)
              }}
            >
              {ACTION_ICONS.close}
            </button>
          </div>
        </div>
        <div className="wf-card__meta">
          <p className="wf-card__name">{wf.name || t('workflows.popup.untitled')}</p>
          {/* 时间格式跟随界面语言；固定 24 小时制避免系统区域设置差异。 */}
          <p className="wf-card__time">{new Date(wf.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</p>
        </div>
      </div>
    )
  }

  /** 渲染一个文件夹分组（标题行 + 其中的卡片 / 空态）。 */
  function renderFolder(folder: string): ReactElement {
    const inFolder = workflows
      .filter((w) => w.folder === folder)
      // updatedAt 是 ISO 字符串，字典序即时间序，可省去 Date 解析。
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const collapsed = collapsedFolders.has(folder)
    return (
      <div key={folder}>
        <div
          className={`wf-folder ${dragOverFolder === folder ? 'wf-folder--over' : ''}`}
          onClick={() =>
            // 不可变地切换折叠集合，让 React 能识别为状态变化。
            setCollapsedFolders((s) => {
              const next = new Set(s)
              if (next.has(folder)) next.delete(folder)
              else next.add(folder)
              return next
            })
          }
          onDragOver={(e) => {
            // 必须 preventDefault 才允许 drop，否则浏览器会用默认行为拒绝。
            e.preventDefault()
            // 阻止冒泡：否则外层的"空白区 drop = 移回根级"会抢先响应。
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
              // 用同色低透明度做底色，未设颜色时保持透明。
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
              // 再点一次收起色板（同一文件夹），点别的文件夹则直接切过去。
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
        {/* 色板只在当前选中的文件夹下方展开。 */}
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

  // 三种视图的数据源：搜索结果（仅搜索时用）/ 根级未分组 / 已书签。
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
      // 只有点在遮罩本身（而非对话框内部）时才关闭。
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
              // 置为 '' 展开输入框（而非直接建文件夹），等待用户输入名字。
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
            // 弹窗打开即聚焦搜索框：多数使用场景就是来找某个工作流。
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
                  // 空名或重名一律忽略，避免出现两个同名分组。
                  if (trimmed && !folders.includes(trimmed)) persistFolders([...folders, trimmed])
                  setNewFolderName(null)
                }
              }}
              // 失焦即取消新建，避免"想去点别处却留下一个空输入框"。
              onBlur={() => setNewFolderName(null)}
              placeholder={t('workflows.popup.folderName')}
            />
          </div>
        )}

        <div
          className="wf-open__body"
          // 整个列表区都要接受拖放，否则拖到卡片之间的空隙会落空。
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // 拖到列表背景（而非文件夹）上 → 移回根级。
            e.preventDefault()
            setDragOverFolder(null)
            const id = e.dataTransfer.getData('application/meshforge-wf')
            // 拖到空白处 = 移出文件夹（folder 置 undefined）。
            if (id) void moveToFolder(id, undefined).then(refresh)
          }}
        >
          {/* 既没有工作流也没有文件夹时给一个空态提示。 */}
          {workflows.length === 0 && folders.length === 0 && (
            <div className="wf-open__empty">
              <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M12 10v6M9 13h6" />
              </svg>
              <p>{t('workflows.popup.noSaved')}</p>
            </div>
          )}

          {/* 搜索时只显示平铺结果；清空搜索才回到"书签 + 文件夹 + 未分组"的常规视图。 */}
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
              {/* 文件夹排序：已书签的置顶，其余保持用户新建顺序。 */}
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
          // 点遮罩关闭；点卡片内部不关。
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
              // 聚焦时全选，便于直接覆盖输入。
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
              {/* 空名不允许提交，因此禁用按钮而不是提交后再报错。 */}
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
              {/* 弹窗里带上工作流名，让用户确认删的是哪一个。 */}
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
                  // 不等待删除完成就关弹窗：refresh 会自行同步列表。
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

  /**
   * 提交重命名。
   *
   * 定义在组件最后、但在上方 JSX 里被引用——函数声明会被提升，运行时无问题。
   * 这里是少数**绕过 store 直接调 API** 的地方：重命名弹窗只关心名字，
   * 不值得为此走一遍 store 的 rename + 脏标记 + 自动保存链路。
   */
  async function handleRename(): Promise<void> {
    if (!renameTarget) return
    const trimmed = renameTarget.value.trim()
    const wf = workflows.find((w) => w.id === renameTarget.id)
    // 名字没变或为空则直接关闭，不做无意义的写盘。
    if (wf && trimmed && trimmed !== wf.name) {
      await saveWorkflow({ ...wf, name: trimmed, updatedAt: new Date().toISOString() })
      await store.getState().loadList()
      await refresh()
    }
    setRenameTarget(null)
  }
}
