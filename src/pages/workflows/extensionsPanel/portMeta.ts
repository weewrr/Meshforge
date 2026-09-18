/**
 * 端口类型 → 颜色 / 文案映射，画布与扩展面板共用同一套。
 *
 * 目前仅区分 `image` / `text` / `mesh`，其余一律归为 `any`（灰色），
 * 以保证未识别类型也不会破坏连线着色。
 */

/** 端口类型对应的连接线颜色。 */
export function portColor(t: string): string {
  switch (t) {
    case 'image':
      return '#38bdf8'
    case 'text':
      return '#fb7185'
    case 'mesh':
      return '#a78bfa'
    default:
      return '#71717a'
  }
}

export function portLabel(t: string): string {
  switch (t) {
    case 'image':
      return 'workflows.panel.portImage'
    case 'text':
      return 'workflows.panel.portText'
    case 'mesh':
      return 'workflows.panel.portMesh'
    default:
      return 'workflows.panel.portAny'
  }
}
