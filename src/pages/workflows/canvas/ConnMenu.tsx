/**
 * 连线拖拽落点弹出的「兼容节点」紧凑列表（Modly 对等交互）。
 *
 * 从引脚拖到空白画布时由主画布唤起，列出端口与待定连线兼容的节点，
 * 选中其一即在该处生成节点并自动接好这条边。非模态、键盘 / 鼠标均可操作。
 */

export interface ConnMenuItem {
  /** 拖拽时写入 dataTransfer 的 payload（节点类型标识）。 */
  payload: string
  /** 显示名。 */
  label: string
  /** 次级说明（如端口类型）。 */
  hint: string
}

export function ConnMenu({
  x,
  y,
  title,
  items,
  index,
  onIndexChange,
  onPick,
  dotColor,
  emptyText
}: {
  x: number
  y: number
  title: string
  items: ConnMenuItem[]
  index: number
  onIndexChange: (i: number) => void
  onPick: (payload: string) => void
  dotColor: (payload: string) => string
  emptyText: string
}) {
  return (
    <div
      className="wf-conn-menu"
      // 把菜单限制在视口内：减去预估宽（240）/高（340），避免贴边被裁。
      style={{
        left: Math.min(x + 12, window.innerWidth - 240),
        top: Math.min(y + 12, window.innerHeight - 340)
      }}
    >
      <div className="wf-conn-menu__title">{title}</div>
      <div className="wf-conn-menu__list">
        {items.map((item, idx) => (
          <button
            key={item.payload}
            className={`wf-conn-menu__item ${idx === index ? 'wf-conn-menu__item--active' : ''}`}
            onMouseEnter={() => onIndexChange(idx)}
            onClick={() => onPick(item.payload)}
          >
            <span className="wf-conn-menu__dot" style={{ background: dotColor(item.payload) }} />
            <span className="wf-conn-menu__label">{item.label}</span>
            <span className="wf-conn-menu__hint">{item.hint}</span>
          </button>
        ))}
        {items.length === 0 && <div className="wf-conn-menu__empty">{emptyText}</div>}
      </div>
    </div>
  )
}
