// Space 唤起的节点面板（Blueprint 风格）：搜索框 + 分组行 + 键盘导航。

import type { KeyboardEventHandler } from 'react'
import type { PortType } from '../../../types'

export interface PaletteItem {
  payload: string
  label: string
  hint: string
  group: string
  ports: { inputs: PortType[]; output: PortType }
}

export interface PaletteRow {
  key: string
  group?: string
  item?: PaletteItem
  selIdx: number
}

/**
 * Space 节点面板组件。
 *
 * @param query 当前搜索词。
 * @param onQueryChange 搜索词变化回调。
 * @param onKeyDown 搜索框键盘事件（↑↓/Enter/Escape 导航）。
 * @param items 过滤后的全部条目（含连线拖拽时的兼容过滤）。
 * @param rows 渲染行：分组标题与条目按 `paletteItems` 顺序穿插。
 * @param index 当前高亮条目序号。
 * @param onIndexChange 高亮变化回调。
 * @param onPick 选中某 payload 的回调。
 * @param groupLabelFor 分组 key → 标题文案。
 * @param dotColor 按 payload 取磁贴圆点颜色。
 * @param placeholder 搜索框占位符。
 * @param emptyText 无匹配时的提示文案。
 * @param footerText 底部说明文案。
 */
export function NodePalette({
  query,
  onQueryChange,
  onKeyDown,
  items,
  rows,
  index,
  onIndexChange,
  onPick,
  groupLabelFor,
  dotColor,
  placeholder,
  emptyText,
  footerText
}: {
  query: string
  onQueryChange: (v: string) => void
  onKeyDown: KeyboardEventHandler<HTMLInputElement>
  items: PaletteItem[]
  rows: PaletteRow[]
  index: number
  onIndexChange: (i: number) => void
  onPick: (payload: string) => void
  groupLabelFor: Record<string, string>
  dotColor: (payload: string) => string
  placeholder: string
  emptyText: string
  footerText: string
}) {
  return (
    <div className="wf-palette">
      <div className="wf-palette__card">
        <input
          className="wf-palette__search"
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="wf-palette__list">
          {rows.map((row) =>
            row.group ? (
              <div key={row.key} className="wf-palette__group">
                {groupLabelFor[row.group] ?? row.group}
              </div>
            ) : (
              <button
                key={row.key}
                className={`wf-palette__item ${row.selIdx === index ? 'wf-palette__item--active' : ''}`}
                onMouseEnter={() => onIndexChange(row.selIdx)}
                onClick={() => row.item && onPick(row.item.payload)}
              >
                <span className="wf-palette__dot" style={{ background: dotColor(row.item!.payload) }} />
                <span className="wf-palette__label">{row.item!.label}</span>
                <span className="wf-palette__hint">{row.item!.hint}</span>
              </button>
            )
          )}
          {items.length === 0 && <div className="wf-palette__empty">{emptyText}</div>}
        </div>
        <div className="wf-palette__footer">{footerText}</div>
      </div>
    </div>
  )
}
