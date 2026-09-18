/**
 * 打开工作流弹窗里的缩略图预览。
 *
 * 把工作流的节点 / 连线数据直接画成静态 SVG（不加载 React Flow），
 * 让用户在打开前就能凭缩略图认出目标工作流。
 */

import type { Workflow } from '../../../types'

// ─── 微型图预览 ────────────────────────────────────────────────────────────
/**
 * 工作流缩略图。
 *
 * 直接按存储的节点坐标画一张示意性 SVG（节点 = 色块，连线 = 贝塞尔曲线），
 * **不挂载 React Flow**——"打开工作流"弹窗里可能同时列出几十个工作流，
 * 每个都实例化一张画布会非常昂贵。
 */

/** 缩略图 viewBox 宽度。 */
const VIEW_W = 200
/** 缩略图 viewBox 高度。 */
const VIEW_H = 88
/** 四周留白（viewBox 单位），避免节点贴着边框。 */
const PAD = 12

/** 节点类型 → 色块配色。刻意与画布上节点的主色保持一致，便于跨视图辨认。 */
const MINI_TINTS: Record<string, { fill: string; stroke: string }> = {
  imageNode: { fill: 'rgba(56,189,248,0.20)', stroke: '#38bdf8' },
  textNode: { fill: 'rgba(251,113,133,0.20)', stroke: '#fb7185' },
  meshNode: { fill: 'rgba(167,139,250,0.22)', stroke: '#a78bfa' },
  generatorNode: { fill: 'rgba(52,211,153,0.20)', stroke: '#34d399' },
  previewNode: { fill: 'rgba(56,189,248,0.20)', stroke: '#38bdf8' },
  outputNode: { fill: 'rgba(167,139,250,0.22)', stroke: '#a78bfa' }
}
/** 未登记类型的兜底配色（中性灰）。 */
const MINI_DEFAULT = { fill: 'rgba(113,113,122,0.25)', stroke: '#71717a' }

/** 工作流缩略图。 */
export function WorkflowMiniPreview({ wf }: { wf: Workflow }) {
  // 空工作流单独渲染一个"空图"图标：同时规避后面包围盒计算的除零与空数组展开。
  if (wf.nodes.length === 0) {
    return (
      <div className="wf-open__mini-empty">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="16" width="7" height="5" rx="1" />
          <path d="M10 5.5h5a2 2 0 0 1 2 2V16" />
        </svg>
      </div>
    )
  }

  const boxes = wf.nodes.map((n) => ({
    id: n.id,
    type: n.type ?? '',
    x: n.position.x,
    y: n.position.y,
    // 尺寸优先取实测值，其次取样式里写死的宽高，最后落到默认尺寸。
    w: n.width ?? (n.style?.width as number | undefined) ?? 150,
    h: n.height ?? (n.style?.height as number | undefined) ?? 48
  }))
  const boxById = new Map(boxes.map((b) => [b.id, b]))

  // 求所有节点的包围盒。Math.max(..., 1) 防止单节点/单轴（宽或高为 0）时除零。
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  // 等比缩放以适应 viewBox；上限 0.5——再放大就会让两三个节点显得夸张。
  const scale = Math.min(
    (VIEW_W - PAD * 2) / Math.max(maxX - minX, 1),
    (VIEW_H - PAD * 2) / Math.max(maxY - minY, 1),
    0.5
  )
  // 缩放后在 viewBox 内居中。
  const offX = (VIEW_W - (maxX - minX) * scale) / 2
  const offY = (VIEW_H - (maxY - minY) * scale) / 2
  // 坐标变换：把工作流坐标映射到 viewBox 坐标。
  const tx = (x: number): number => offX + (x - minX) * scale
  const ty = (y: number): number => offY + (y - minY) * scale

  return (
    <svg aria-hidden="true" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="wf-open__mini" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="wf-mini-grid" width="11" height="11" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="#23262f" />
        </pattern>
      </defs>
      {/* 点阵网格底：给缩略图一点"画布"的质感，且不干扰上方节点。 */}
      <rect width={VIEW_W} height={VIEW_H} fill="url(#wf-mini-grid)" />
      {wf.edges.map((e) => {
        const s = boxById.get(e.source)
        const t = boxById.get(e.target)
        // 端点缺失（例如连线指向已被删除的节点）时跳过，避免画出悬空曲线。
        if (!s || !t) return null
        // 从源节点右缘中点连到目标节点左缘中点。
        const x1 = tx(s.x + s.w)
        const y1 = ty(s.y + s.h / 2)
        const x2 = tx(t.x)
        const y2 = ty(t.y + t.h / 2)
        // 控制点水平外扩量；设下限 6 以免两点几乎同列时曲线退化成直线。
        const d = Math.max(Math.abs(x2 - x1) * 0.45, 6)
        return (
          <path
            key={e.id}
            d={`M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke="#5b5b66"
            strokeWidth="1"
            strokeLinecap="round"
            opacity="0.9"
          />
        )
      })}
      {boxes.map((b) => {
        const tint = MINI_TINTS[b.type] ?? MINI_DEFAULT
        return (
          <rect
            key={b.id}
            x={tx(b.x)}
            y={ty(b.y)}
            // 缩到极小的节点仍保留 3px 最小边长，否则会彻底看不见。
            width={Math.max(b.w * scale, 3)}
            height={Math.max(b.h * scale, 3)}
            rx="2"
            fill={tint.fill}
            stroke={tint.stroke}
            strokeWidth="0.75"
          />
        )
      })}
    </svg>
  )
}
