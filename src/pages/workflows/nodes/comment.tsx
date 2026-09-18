/**
 * 注释框节点（Unreal Blueprint Comment）。
 *
 * 框本身不参与执行流，只是画布上的可命名/配色/折叠注解区域。标题栏随缩放
 * "反向"放大以保持可读，折叠则是"缩框 + 隐藏成员"的原子操作——因涉及节点表，
 * 必须由画布侧通过 `CommentOpsContext` 完成，否则会出现脏状态。
 */

import { useContext, type CSSProperties } from 'react'
import { NodeResizer, useStore, type NodeProps, type Node } from '@xyflow/react'
import type { WFNodeData } from '../../../types'
import { useLogsStore } from '../../../stores/logs'
import { CommentOpsContext } from '../commentUtils'
import { useT } from '../../../i18n'
import { useParam } from './primitives'

const COMMENT_COLORS = ['#38bdf8', '#facc15', '#34d399', '#fb7185', '#a78bfa', '#94a3b8']

/** Comment Box（注释框）：可命名/配色/折叠的注解区域（Unreal Blueprint Comment）。 */
export function CommentNode({ id, data, selected }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const commentOps = useContext(CommentOpsContext)
  const text = String(data.params.text ?? data.label ?? '')
  const color = String(data.params.color ?? '#38bdf8')
  const collapsed = !!data.params.collapsed

  // 蓝图语义：注释框标题栏随缩放"反向"缩放 —— 缩小时标题仍保持屏幕上的可读尺寸，
  // 放大到 1x 以上则回归正常比例（只放大不缩小）。量化到 0.05 一档，避免缩放时每帧
  // 都改内联样式。折叠态的高度是固定的，所以放大倍数要收紧，免得标题溢出边框。
  const zoom = useStore((s) => s.transform[2])
  const headK =
    Math.round(Math.min(collapsed ? 1.25 : 2.4, Math.max(1, 1 / Math.max(zoom, 0.1))) * 20) / 20
  // 缩得很小时只保留标题（色板、正文收起），再小一点连折叠按钮也收起来。
  const zoomedOut = zoom < 0.55
  const farOut = zoom < 0.32

  // 折叠必须是"缩框 + 隐藏成员"的原子操作，而这只有画布能做（它持有节点表）。
  // 若 CommentOpsContext 缺失，退化成"只改视觉"会留下框缩了、成员还露在外面的脏状态，
  // 所以这里宁可不动作并出声提示，也不做半套折叠。
  function toggleCollapse(): void {
    if (!commentOps) {
      useLogsStore.getState().warn('comment collapse ignored: CommentOpsContext missing')
      return
    }
    commentOps.toggleCollapse(id, !collapsed)
  }

  return (
    <div
      className={`wf-comment ${collapsed ? 'wf-comment--collapsed' : ''} ${selected ? 'wf-comment--selected' : ''} ${
        zoomedOut ? 'wf-comment--zoomed-out' : ''
      } ${farOut ? 'wf-comment--far-out' : ''}`}
      style={{ borderColor: color, background: `${color}14`, '--wf-head-k': headK } as CSSProperties}
    >
      <NodeResizer
        minWidth={140}
        minHeight={50}
        lineStyle={{ borderColor: 'transparent' }}
        // 句柄随标题栏一起反向缩放，缩到很小时也点得中。
        handleStyle={{ background: color, width: 10 * headK, height: 10 * headK, borderRadius: 3, border: 'none' }}
        isVisible={selected && !collapsed}
      />
      <div className="wf-comment__head" style={{ color }}>
        <svg className="wf-comment__glyph" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
        </svg>
        <input
          className="wf-comment__title nodrag"
          value={text}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('text', e.target.value)}
          placeholder={t('workflows.nodes.commentPlaceholder')}
          spellCheck={false}
        />
        <div className="wf-comment__swatches">
          {COMMENT_COLORS.map((c) => (
            <button
              key={c}
              className={`wf-comment__swatch ${c === color ? 'is-on' : ''}`}
              style={{ background: c }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setParam('color', c)}
              aria-label={c}
            />
          ))}
        </div>
        <button
          className="wf-comment__collapse"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleCollapse}
          title={t(collapsed ? 'workflows.nodes.commentExpand' : 'workflows.nodes.collapse')}
          aria-label={t(collapsed ? 'workflows.nodes.commentExpand' : 'workflows.nodes.collapse')}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && <div className="wf-comment__body">{t('workflows.nodes.commentBody')}</div>}
    </div>
  )
}
