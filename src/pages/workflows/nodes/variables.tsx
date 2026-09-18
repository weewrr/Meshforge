/**
 * 变量读写、事件分发器与结构体节点（补充 UE 标准语义）。
 *
 * 变量（`Get`/`Set`）按名字在运行期读写共享变量；事件分发器（`Call`/`Bind`）
 * 通过名字调用/绑定一个事件；`Make`/`Break Struct` 把多路数据组装进/拆出一段
 * 结构体文本。名字输入带 datalist 提示，避免手敲已声明的变量/分发器名。
 */

import { useMemo, type CSSProperties } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import {
  DISPATCHER_PARAM,
  IN_HANDLE,
  STRUCT_FIELDS_PARAM,
  VAR_NAME_PARAM,
  declaredDispatchers,
  declaredVariables,
  nodeSpec,
  portColor,
  structFields,
  structOutHandle,
  type WFNodeData
} from '../../../types'
import { useWorkflowsStore } from '../../../stores/workflows'
import { useWorkflowRunStore } from '../../../stores/workflowRun'
import { useT } from '../../../i18n'
import { BreakpointDot, ComputeShell, NodeShell, useParam } from './primitives'

// ─── 变量读写 / 事件分发器 / 结构体（UE 标准语义补充）──────────────────────────

/** 「按名字配对」的输入框（变量名 / 分发器名）：带 datalist 提示已声明的名字。 */
function NameField({
  listId,
  names,
  value,
  label,
  placeholder,
  onChange
}: {
  listId: string
  names: string[]
  value: string
  label: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <label className="wf-field">
      <span>{label}</span>
      <input
        className="wf-input nodrag"
        type="text"
        list={listId}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </label>
  )
}

/** 已声明的变量名（选择器返回拼好的字符串，避免每次编辑都重渲染节点）。 */
function useDeclaredVarNames(): string[] {
  const joined = useWorkflowsStore((s) => declaredVariables(s.current?.nodes ?? []).join('\u0000'))
  return useMemo(() => (joined ? joined.split('\u0000') : []), [joined])
}

/** 已声明的事件分发器名。 */
function useDeclaredDispatcherNames(): string[] {
  const joined = useWorkflowsStore((s) => declaredDispatchers(s.current?.nodes ?? []).join('\u0000'))
  return useMemo(() => (joined ? joined.split('\u0000') : []), [joined])
}

/** 变量读取（Get Variable）：按变量名取运行期值，未赋值时回退到 fallback。 */
export function VariableGetNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const names = useDeclaredVarNames()
  const name = String(data.params[VAR_NAME_PARAM] ?? '')
  return (
    <NodeShell id={id} type="variableGetNode" label={name ? `${data.label} · ${name}` : data.label}>
      <NameField
        listId={`wf-vars-${id}`}
        names={names}
        value={name}
        label={t('workflows.nodes.varNameLabel')}
        placeholder={t('workflows.nodes.varNamePlaceholder')}
        onChange={(v) => setParam(VAR_NAME_PARAM, v)}
      />
      <label className="wf-field">
        <span>{t('workflows.nodes.varFallbackLabel')}</span>
        <input
          className="wf-input nodrag"
          type="text"
          defaultValue={String(data.params.fallback ?? '')}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('fallback', e.target.value)}
        />
      </label>
      <span className="wf-hint">{t('workflows.nodes.varGetHint')}</span>
    </NodeShell>
  )
}

/** 变量写入（Set Variable）：exec 流经时写入变量，并把该值原样输出给下游。 */
export function VariableSetNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const names = useDeclaredVarNames()
  const name = String(data.params[VAR_NAME_PARAM] ?? '')
  return (
    <NodeShell id={id} type="variableSetNode" label={name ? `${data.label} · ${name}` : data.label}>
      <NameField
        listId={`wf-vars-${id}`}
        names={names}
        value={name}
        label={t('workflows.nodes.varNameLabel')}
        placeholder={t('workflows.nodes.varNamePlaceholder')}
        onChange={(v) => setParam(VAR_NAME_PARAM, v)}
      />
      <label className="wf-field">
        <span>{t('workflows.nodes.varDefaultLabel')}</span>
        <input
          className="wf-input nodrag"
          type="text"
          defaultValue={String(data.params.default ?? '')}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('default', e.target.value)}
        />
      </label>
      <span className="wf-hint">{t('workflows.nodes.varSetHint')}</span>
    </NodeShell>
  )
}

/** Call / Bind 事件分发器的公共外壳：只差一句说明文案。 */
function DispatcherShell({ id, type, data }: { id: string; type: string; data: WFNodeData }) {
  const t = useT()
  const setParam = useParam(id)
  const names = useDeclaredDispatcherNames()
  const name = String(data.params[DISPATCHER_PARAM] ?? '')
  const isCall = type === 'eventCallNode'
  return (
    <NodeShell id={id} type={type} label={name ? `${data.label} · ${name}` : data.label}>
      <NameField
        listId={`wf-disp-${id}`}
        names={names}
        value={name}
        label={t('workflows.nodes.dispatcherLabel')}
        placeholder={t('workflows.nodes.dispatcherPlaceholder')}
        onChange={(v) => setParam(DISPATCHER_PARAM, v)}
      />
      <span className="wf-hint">{isCall ? t('workflows.nodes.eventCallHint') : t('workflows.nodes.eventBindHint')}</span>
    </NodeShell>
  )
}
/** 事件调用（Call Dispatcher）：按名字触发一个已声明的事件分发器。 */
export function EventCallNode(p: NodeProps<Node<WFNodeData>>) {
  return <DispatcherShell id={p.id} type="eventCallNode" data={p.data} />
}
/** 事件绑定（Bind Dispatcher）：按名字绑定到一个事件分发器，供其回调时执行下游。 */
export function EventBindNode(p: NodeProps<Node<WFNodeData>>) {
  return <DispatcherShell id={p.id} type="eventBindNode" data={p.data} />
}

/** 结构体字段名输入（逗号分隔，决定 Make 的输入数 / Break 的输出引脚名）。 */
function StructFieldsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  return (
    <label className="wf-field">
      <span>{t('workflows.nodes.structFieldsLabel')}</span>
      <input
        className="wf-input nodrag"
        type="text"
        defaultValue={value}
        spellCheck={false}
        placeholder={t('workflows.nodes.structFieldsPlaceholder')}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/** Make Struct：把 N 路输入按字段顺序组装成一段结构体文本。 */
export function MakeStructNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const fields = structFields(data.params[STRUCT_FIELDS_PARAM])
  const n = Math.max(1, Math.min(8, fields.length))
  return (
    <ComputeShell id={id} nodeType="makeStructNode" label={data.label} count={n}>
      <StructFieldsField
        value={String(data.params[STRUCT_FIELDS_PARAM] ?? '')}
        onChange={(v) => setParam(STRUCT_FIELDS_PARAM, v)}
      />
      <span className="wf-hint">{t('workflows.nodes.makeStructHint', { count: n })}</span>
    </ComputeShell>
  )
}

/** Break Struct：把一个结构体文本拆成按字段命名的多路输出。 */
export function BreakStructNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const spec = nodeSpec('breakStructNode')
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const fields = structFields(data.params[STRUCT_FIELDS_PARAM])
  const topFor = (i: number): string => `${((i + 1) / (fields.length + 1)) * 100}%`
  return (
    <div className={`wf-compute wf-node--${state}`} style={{ '--node-color': spec.color } as CSSProperties}>
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ top: '50%', background: portColor('text') }} />
      {fields.map((f, i) => (
        <Handle
          key={`h-${i}`}
          id={structOutHandle(i)}
          type="source"
          position={Position.Right}
          className="wf-handle"
          style={{ top: topFor(i), background: portColor('text') }}
        />
      ))}
      {fields.map((f, i) => (
        <span key={`l-${i}`} className="wf-pin-label wf-pin-label--out" style={{ top: topFor(i) }} title={f}>
          {f}
        </span>
      ))}
      <div className="wf-node__header">
        <BreakpointDot id={id} />
        <span className="wf-node__dot" style={{ background: spec.color }} />
        <span className="wf-node__title">{data.label}</span>
      </div>
      <div className="wf-node__body">
        <StructFieldsField
          value={String(data.params[STRUCT_FIELDS_PARAM] ?? '')}
          onChange={(v) => setParam(STRUCT_FIELDS_PARAM, v)}
        />
        <span className="wf-hint">{t('workflows.nodes.breakStructHint')}</span>
      </div>
    </div>
  )
}
