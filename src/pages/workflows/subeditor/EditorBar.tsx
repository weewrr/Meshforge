/**
 * 子图编辑器顶部工具条（展示层）。
 *
 * 提供返回、草稿内撤销 / 重做、面包屑（改名 / 逐层跳回）、挂点计数与增删、
 * 添加节点下拉与"完成"。所有状态与动作都由 `EditorInner` 经 props 注入，本组件只渲染。
 */

import type { Dispatch, SetStateAction } from 'react'
import type { WFNode } from '../../../types'
import { useT } from '../../../i18n'

/**
 * 子图编辑器顶部工具条：返回 / 草稿内撤销重做 / 面包屑（可改名、可逐层跳回）
 * / 挂点计数与增删 / 添加节点下拉 / 完成。纯展示层，逻辑仍由 EditorInner 持有。
 */
export interface EditorBarProps {
  saveAndClose: () => void
  histSizes: readonly [number, number]
  undoLocal: () => void
  redoLocal: () => void
  current: { name: string } | null
  crumbs: string[]
  path: string[]
  renameSubgraphAt: (path: string[], name: string) => void
  jumpTo: (level: number) => void
  inputPins: WFNode[]
  outputPins: WFNode[]
  addInputPin: () => void
  addOutputPin: () => void
  addOpen: boolean
  setAddOpen: Dispatch<SetStateAction<boolean>>
  addQuery: string
  setAddQuery: Dispatch<SetStateAction<string>>
  addItems: { payload: string; label: string; color: string }[]
  addAt: (payload: string) => void
}

export function EditorBar({
  saveAndClose,
  histSizes,
  undoLocal,
  redoLocal,
  current,
  crumbs,
  path,
  renameSubgraphAt,
  jumpTo,
  inputPins,
  outputPins,
  addInputPin,
  addOutputPin,
  addOpen,
  setAddOpen,
  addQuery,
  setAddQuery,
  addItems,
  addAt
}: EditorBarProps) {
  const t = useT()
  return (
    <div className="wf-subeditor__bar">
      <button className="wf-tool-btn" onClick={saveAndClose}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5M11 18l-6-6 6-6" />
        </svg>
        {t('workflows.subeditor.back')}
      </button>

      {/* 草稿内的单步撤销 / 重做（与主画布的历史是两套，互不干扰）。 */}
      <span className="wf-toolbar__sep" />
      <button
        className="wf-tool-btn"
        title={t('workflows.subeditor.undo')}
        aria-label={t('workflows.subeditor.undo')}
        disabled={histSizes[0] === 0}
        onClick={undoLocal}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
        </svg>
      </button>
      <button
        className="wf-tool-btn"
        title={t('workflows.subeditor.redo')}
        aria-label={t('workflows.subeditor.redo')}
        disabled={histSizes[1] === 0}
        onClick={redoLocal}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
        </svg>
      </button>
      <span className="wf-toolbar__sep" />

      {/* 面包屑：工作流名 › 外层函数 › … › 当前函数；点击任意上层即跳回该层 */}
      <nav className="wf-subeditor__crumbs" aria-label={t('workflows.subeditor.title')}>
        <button className="wf-crumb" onClick={() => jumpTo(0)}>
          {current?.name ?? t('workflows.subeditor.root')}
        </button>
        {crumbs.map((label, i) => (
          <span key={`${path[i]}-${i}`} className="wf-crumb__group">
            <span className="wf-crumb__sep" aria-hidden="true">
              ›
            </span>
            {i === crumbs.length - 1 ? (
              <input
                className="wf-crumb__input"
                value={label}
                spellCheck={false}
                onChange={(e) => renameSubgraphAt(path, e.target.value)}
                placeholder={t('workflows.nodes.subgraphName')}
                title={t('workflows.subeditor.renameTitle')}
              />
            ) : (
              <button className="wf-crumb" onClick={() => jumpTo(i + 1)}>
                {label}
              </button>
            )}
          </span>
        ))}
      </nav>

      <span className="wf-toolbar__spacer" />
      <span className="wf-subeditor__meta">
        {t('workflows.subeditor.pins', { inputs: inputPins.length, outputs: outputPins.length })}
      </span>
      <button className="wf-tool-btn" onClick={addInputPin} title={t('workflows.subeditor.addInput')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t('workflows.subeditor.addInput')}
      </button>
      <button className="wf-tool-btn" onClick={addOutputPin} title={t('workflows.subeditor.addOutput')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t('workflows.subeditor.addOutput')}
      </button>
      <div className="wf-subeditor__add" style={{ position: 'relative' }}>
        <button className="wf-tool-btn" onClick={() => setAddOpen((v) => !v)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('workflows.subeditor.addNode')}
        </button>
        {addOpen && (
          <div className="wf-subeditor__menu">
            <input
              className="wf-palette__search"
              autoFocus
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addItems[0]) addAt(addItems[0].payload)
                if (e.key === 'Escape') setAddOpen(false)
              }}
              placeholder={t('workflows.palette.searchPlaceholder')}
            />
            <div className="wf-subeditor__list">
              {addItems.map((i) => (
                <button key={i.payload} className="wf-subeditor__item" onMouseDown={(e) => e.preventDefault()} onClick={() => addAt(i.payload)}>
                  <span className="wf-palette__dot" style={{ background: i.color }} />
                  {i.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <button className="wf-tool-btn" onClick={saveAndClose}>
        {t('workflows.subeditor.done')}
      </button>
    </div>
  )
}
