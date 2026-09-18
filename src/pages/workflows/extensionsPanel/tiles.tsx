/**
 * 扩展面板里的瓦片按钮。
 *
 * 两类：PanelTile（内置面板项）与 FunctionTile（扩展提供的功能项），
 * 统一尺寸与拖拽行为，让内置与扩展项在面板里视觉一致。
 */

import { useWorkflowsStore } from '../../../stores/workflows'
import { useT } from '../../../i18n'
import type { FunctionEntry } from '../subgraphUtils'
import { TILE_ICONS } from './TileIcons'
import type { PanelItem } from './types'

/** 单个可拖入画布的面板磁贴（显示字形 + 名称，拖拽即创建对应节点）。 */
export function PanelTile({ item }: { item: PanelItem }) {
  const t = useT()
  const labelText = item.labelKey ? t(item.labelKey) : item.label ?? ''
  return (
    <div
      className="wf-tile"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/meshforge-node', item.dragPayload)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title={t('workflows.panel.dragToAdd', { label: labelText })}
    >
      <span className="wf-tile__glyph" style={{ color: item.color }}>
        {TILE_ICONS[item.glyph] ?? item.glyph}
      </span>
      <span className="wf-tile__label">{labelText}</span>
    </div>
  )
}

/** 函数库条目（My Blueprint 风格）：列出工作流里所有已折叠函数及其实例数。 */
export function FunctionTile({ fn, onOpen }: { fn: FunctionEntry; onOpen?: (path: string[]) => void }) {
  const t = useT()
  const instantiateFunction = useWorkflowsStore((s) => s.instantiateFunction)
  return (
    <div
      className="wf-tile wf-tile--fn"
      title={t('workflows.panel.fnHint', { inputs: fn.inputs, outputs: fn.outputs })}
    >
      <span className="wf-tile__glyph" style={{ color: '#22d3ee' }}>
        {TILE_ICONS.function}
      </span>
      <span className="wf-tile__label">{fn.label}</span>
      {fn.instances.length > 1 && <span className="wf-tile__badge">×{fn.instances.length}</span>}
      <button
        className="wf-tile__mini"
        title={t('workflows.panel.fnInsert')}
        aria-label={t('workflows.panel.fnInsert')}
        onClick={() => instantiateFunction(fn.id)}
      >
        +
      </button>
      {onOpen && (
        <button
          className="wf-tile__mini"
          title={t('workflows.panel.fnOpen')}
          aria-label={t('workflows.panel.fnOpen')}
          onClick={() => onOpen(fn.path)}
        >
          ⌗
        </button>
      )}
    </div>
  )
}

