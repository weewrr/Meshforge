/**
 * 数值与逻辑运算类蓝图节点：判空/校验、布尔/算术/比较/拼接、类型转换、钳制、插值、随机。
 *
 * 简单二元运算（`bool`/`math`/`compare`/`concat`）共用一份 `COMPUTE_CONFIG` 配置表驱动；
 * 类型转换与 `clamp`/`lerp`/`random` 则各自有固定输入数，统一走 `ComputeShell` 渲染
 * 「N 个左侧数据引脚 + 单个 text 输出」的布局。
 */

import { type NodeProps, type Node } from '@xyflow/react'
import type { WFNodeData } from '../../../types'
import { useT } from '../../../i18n'
import { ComputeShell, NodeShell, useParam } from './primitives'

/** 判空/校验：上游有有效数据 → true；IsEmpty 上游文本为空 → true。 */
function TruthNode({ id, type }: { id: string; type: string }) {
  const t = useT()
  const hint = type === 'isValidNode' ? t('workflows.nodes.isValidHint') : t('workflows.nodes.isEmptyHint')
  return (
    <NodeShell id={id} type={type} label={type === 'isValidNode' ? t('workflows.palette.isValidLabel') : t('workflows.palette.isEmptyLabel')}>
      <span className="wf-hint">{hint}</span>
    </NodeShell>
  )
}
/** 判有效（IsValid）：上游有有效数据 → 输出 `true`，否则 `false`。 */
export function IsValidNode(p: NodeProps<Node<WFNodeData>>) {
  return <TruthNode id={p.id} type="isValidNode" />
}
/** 判空（IsEmpty）：上游文本为空 → 输出 `true`，否则 `false`。 */
export function IsEmptyNode(p: NodeProps<Node<WFNodeData>>) {
  return <TruthNode id={p.id} type="isEmptyNode" />
}

const COMPUTE_CONFIG: Record<
  string,
  { operators: string[]; defaultOp: string; inputs: number; hintKey: string; labelKey: string; useSeparator?: boolean }
> = {
  boolNode: { operators: ['and', 'or', 'xor'], defaultOp: 'and', inputs: 2, hintKey: 'workflows.nodes.boolHint', labelKey: 'workflows.palette.boolLabel' },
  mathNode: { operators: ['+', '-', '*', '/', 'min', 'max', 'abs'], defaultOp: '+', inputs: 2, hintKey: 'workflows.nodes.mathHint', labelKey: 'workflows.palette.mathLabel' },
  compareNode: { operators: ['==', '!=', '>', '>=', '<', '<='], defaultOp: '==', inputs: 2, hintKey: 'workflows.nodes.compareHint', labelKey: 'workflows.palette.compareLabel' },
  concatNode: { operators: [], defaultOp: '', inputs: 3, hintKey: 'workflows.nodes.concatHint', labelKey: 'workflows.palette.concatLabel', useSeparator: true }
}

function ComputeNode({ id, data, nodeType }: { id: string; data: WFNodeData; nodeType: string }) {
  const t = useT()
  const setParam = useParam(id)
  const cfg = COMPUTE_CONFIG[nodeType]
  const label = data.label || t(cfg.labelKey)
  return (
    <ComputeShell id={id} nodeType={nodeType} label={label} count={cfg.inputs}>
      {cfg.useSeparator && (
        <label className="wf-field">
          <span>{t('workflows.nodes.concatSeparatorLabel')}</span>
          <input
            className="wf-input nodrag"
            type="text"
            defaultValue={String(data.params.separator ?? '')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('separator', e.target.value)}
          />
        </label>
      )}
      {cfg.operators.length > 0 && (
        <label className="wf-field">
          <span>{t('workflows.nodes.opLabel')}</span>
          <select
            className="wf-input nodrag"
            value={String(data.params.operator ?? cfg.defaultOp)}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('operator', e.target.value)}
          >
            {cfg.operators.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="wf-hint">{t(cfg.hintKey)}</span>
    </ComputeShell>
  )
}
/** 布尔运算（Bool）：对两路输入做 and / or / xor，输出布尔结果。 */
export function BoolNode(p: NodeProps<Node<WFNodeData>>) {
  return <ComputeNode id={p.id} data={p.data} nodeType="boolNode" />
}
/** 算术运算（Math）：对两路输入做 + - * / min / max / abs，输出数值结果。 */
export function MathNode(p: NodeProps<Node<WFNodeData>>) {
  return <ComputeNode id={p.id} data={p.data} nodeType="mathNode" />
}
/** 比较运算（Compare）：按 == != > >= < <= 比较两路输入，输出布尔结果。 */
export function CompareNode(p: NodeProps<Node<WFNodeData>>) {
  return <ComputeNode id={p.id} data={p.data} nodeType="compareNode" />
}
/** 文本拼接（Concat）：把多路文本用分隔符拼成一段，输出拼接结果。 */
export function ConcatNode(p: NodeProps<Node<WFNodeData>>) {
  return <ComputeNode id={p.id} data={p.data} nodeType="concatNode" />
}

// ─── UE 标准数值节点：类型转换 / 钳制 / 插值 / 随机数 ────────────────────────

/** 类型转换（Cast）：把上游文本按目标类型重新解释（Text→Float / Int / Bool）。 */
export function CastNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="castNode" label={data.label}>
      <label className="wf-field">
        <span>{t('workflows.nodes.castToLabel')}</span>
        <select
          className="wf-input nodrag"
          value={String(data.params.to ?? 'float')}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('to', e.target.value)}
        >
          <option value="float">{t('workflows.nodes.variableFloat')}</option>
          <option value="int">{t('workflows.nodes.variableInt')}</option>
          <option value="text">{t('workflows.nodes.variableText')}</option>
          <option value="bool">{t('workflows.nodes.variableBool')}</option>
        </select>
      </label>
      <span className="wf-hint">{t('workflows.nodes.castHint')}</span>
    </NodeShell>
  )
}

/** 钳制（Clamp）：把输入值限制在最小值与最大值之间，输出 [min, max] 内的值。 */
export function ClampNode(p: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <ComputeShell id={p.id} nodeType="clampNode" label={p.data.label} count={3}>
      <span className="wf-hint">{t('workflows.nodes.clampHint')}</span>
    </ComputeShell>
  )
}

/** 线性插值（Lerp）：按 [0,1] 系数在 A、B 之间插值，输出中间值。 */
export function LerpNode(p: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <ComputeShell id={p.id} nodeType="lerpNode" label={p.data.label} count={3}>
      <span className="wf-hint">{t('workflows.nodes.lerpHint')}</span>
    </ComputeShell>
  )
}

/** 随机数（Random）：在 [min, max] 间生成一个随机值，输出该随机值。 */
export function RandomNode(p: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <ComputeShell id={p.id} nodeType="randomNode" label={p.data.label} count={2}>
      <span className="wf-hint">{t('workflows.nodes.randomHint')}</span>
    </ComputeShell>
  )
}
