/**
 * 扩展面板的条目（内置节点与逻辑节点共用）。
 *
 * 面板上的每个可拖拽块都对应一个 `PanelItem`；拖拽时通过 `dragPayload`
 * 把节点类型写进 dataTransfer，画布在 drop 时据此创建对应节点。
 */

export interface PanelItem {
  /** 拖拽时写入 dataTransfer 的载荷，画布的 drop 处理据此识别要创建的节点类型。 */
  dragPayload: string
  /** 直接写死的显示名（与 `labelKey` 二选一）。 */
  label?: string
  /** 走 i18n 的显示名 key（与 `label` 二选一）。 */
  labelKey?: string
  /** 条目色条 / 图标的主题色。 */
  color: string
  /** 显示在条目左侧的字形字符（如 ▶ ★ 等）。 */
  glyph: string
}

