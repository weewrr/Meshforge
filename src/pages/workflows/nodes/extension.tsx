/**
 * 扩展节点（schema 驱动，Modly 对齐）。
 *
 * 节点的可用参数、输入/输出类型都由扩展的 schema 动态决定，而非写死在代码里。
 * 因此这里不渲染固定表单，而是遍历 `ext.params` 生成控件，并用 `show_if` 做
 * 条件显隐。数字参数同样要绕开 `<input type="number">` 的渲染崩溃（见下方注释）。
 */

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import {
  getExtensionById,
  paramHandleFor,
  portColor,
  type ParamSchema,
  type PortType,
  type WFNodeData
} from '../../../types'
import { useT } from '../../../i18n'
import { NodeShell, PortTag, useParam } from './primitives'

// ─── Extension node (schema-driven, Modly parity) ────────────────────────────

function ParamControl({
  param,
  value,
  onChange
}: {
  param: ParamSchema
  value: string | number
  onChange: (v: string | number) => void
}) {
  if (param.type === 'select') {
    return (
      <select
        className="wf-input nodrag"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {param.options?.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label ?? String(o.value)}
          </option>
        ))}
      </select>
    )
  }
  if (param.type === 'int' || param.type === 'float') {
    // 本机的 Chromium 在 React Flow 画布里渲染 <input type="number"> 会直接崩溃
    // （实测：任何带数字输入框的节点都会让渲染进程退出，错误码 0xC0000005 / 0x7003）。
    // 为对齐 Modly：改用 text 输入 + inputMode + 正则把关，在 onChange 里解析。
    const isFloat = param.type === 'float'
    return (
      <input
        className="wf-input wf-input--num nodrag"
        type="text"
        inputMode={isFloat ? 'decimal' : 'numeric'}
        autoComplete="off"
        spellCheck={false}
        min={param.min}
        max={param.max}
        defaultValue={value}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const raw = isFloat ? e.target.value.replace(',', '.') : e.target.value
          // 允许输入过程中的中间态（''、'-'、'1.'、'-1' 等），这些暂不成形的串先放行。
          if (raw !== '' && raw !== '-' && !(isFloat ? /^-?\d*\.?\d*$/.test(raw) : /^-?\d*$/.test(raw))) return
          const n = isFloat ? parseFloat(raw) : parseInt(raw, 10)
          if (!isNaN(n)) onChange(n)
        }}
      />
    )
  }
  return (
    <input
      className="wf-input nodrag"
      type="text"
      defaultValue={value as string}
      placeholder={param.tooltip ?? ''}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function ExtensionNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const ext = getExtensionById(String(data.extensionId ?? ''))
  const label = ext?.display_name ?? t('workflows.nodes.extension')
  const inputType = (ext?.input ?? 'any') as PortType
  const outputType = (ext?.output ?? 'mesh') as PortType
  const hasParams = (ext?.params.length ?? 0) > 0

  const isVisible = (param: ParamSchema): boolean => {
    if (!param.show_if) return true
    return Object.entries(param.show_if).every(([key, expected]) => {
      const current = (data.params[key] as string | number | undefined) ?? ext?.params.find((p) => p.id === key)?.default
      return Array.isArray(expected)
        ? current != null && expected.includes(current)
        : current === expected
    })
  }

  return (
    <NodeShell id={id} type="extensionNode" label={label} extensionId={data.extensionId as string}>
      <div className="wf-ext-io">
        <PortTag type={inputType} />
        {ext?.output !== 'none' && (
          <>
            <span className="wf-ext-arrow">→</span>
            <PortTag type={outputType} />
          </>
        )}
      </div>
      {hasParams && (
        <div className="wf-ext-params">
          {ext!.params.filter(isVisible).map((param) => {
            const val = (data.params[param.id] ?? param.default) as string | number
            return (
              <div key={param.id} className="wf-param">
                {/* Blueprint 风格参数引脚：可从其它节点(text/any 输出)输入，缺省时用内联控件值 */}
                <Handle
                  id={paramHandleFor(param.id)}
                  type="target"
                  position={Position.Left}
                  className="wf-handle wf-handle--param"
                  style={{ top: '50%', background: portColor('text') }}
                />
                <label className="wf-field">
                  <span>{param.label}</span>
                  <ParamControl param={param} value={val} onChange={(v) => setParam(param.id, v)} />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </NodeShell>
  )
}
