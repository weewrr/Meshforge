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
  paramPortTypeOf,
  portColor,
  type ParamSchema,
  type PortType,
  type WFNodeData
} from '../../../types'
import { useT } from '../../../i18n'
import { NodeShell, PortTag, useConnectedHandles, useParam } from './primitives'

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
  const outputType = (ext?.output ?? 'none') as PortType
  const hasParams = (ext?.params.length ?? 0) > 0
  // 折叠态存在节点自身参数里（与断点 `params.breakpoint` 同一套做法）：
  // 随工作流一起保存、子图草稿里也走同一条写入路径（useParam）。
  const collapsed = data.params?.collapsed === true
  const conn = useConnectedHandles(id)
  // 折叠时只保留"有连线"的参数引脚：空引脚折叠后既没有内容可看、也没有线可连，
  // 藏起来才是折叠的意义（参考 UE 蓝图收起来的紧凑节点）。
  const wiredParams = (ext?.params ?? []).filter(
    (p) => p.type !== 'label' && conn.targets.has(paramHandleFor(p.id))
  )

  const isVisible = (param: ParamSchema): boolean => {
    if (!param.show_if) return true
    return Object.entries(param.show_if).every(([key, expected]) => {
      const current = (data.params[key] as string | number | undefined) ?? ext?.params.find((p) => p.id === key)?.default
      return Array.isArray(expected)
        ? current != null && expected.includes(current)
        : current === expected
    })
  }

  /** 参数引脚：端口类型（图片/文本）由 schema 决定，位置挂在所在行上。 */
  const paramPin = (param: ParamSchema) => (
    <Handle
      id={paramHandleFor(param.id)}
      type="target"
      position={Position.Left}
      className="wf-handle wf-handle--param"
      style={{ top: '50%', background: portColor(paramPortTypeOf(param)) }}
    />
  )

  return (
    <NodeShell
      id={id}
      type="extensionNode"
      label={label}
      extensionId={data.extensionId as string}
      collapsed={collapsed}
      onToggleCollapse={() => setParam('collapsed', !collapsed)}
    >
      {collapsed ? (
        // 一个引脚都没接线时不给节点体（空 body 会被 CSS `:empty` 收起），
        // 折叠态就是纯标题栏——UE 蓝图里收起来的节点也是这个形态。
        wiredParams.length > 0 ? (
          <div className="wf-ext-params wf-ext-params--folded">
            {wiredParams.map((param) => (
              <div key={param.id} className="wf-param wf-param--wired">
                {paramPin(param)}
                <span className="wf-param__wired" title={param.tooltip ?? ''}>
                  {param.label}
                </span>
              </div>
            ))}
          </div>
        ) : null
      ) : (
        <>
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
                // 说明型参数（type='label'）：只渲染一行静态文案——它的 default 本身就是
                // 要说的话。既不给输入框（改了没用），也不给引脚（它不是值）。
                if (param.type === 'label') {
                  return (
                    <div key={param.id} className="wf-param wf-param--note" title={param.tooltip ?? ''}>
                      <span className="wf-param__note">{String(param.default)}</span>
                    </div>
                  )
                }
                // pin_only：保留默认值与参数引脚，但不摆内联输入框。想改值的用户
                // 从左侧引脚喂变量；节点上只留一行"默认值 + 可接什么类型"的说明。
                // type='image' 同理（值不可能靠打字给出）：引脚是图片端口，提示改成"接一张图片"。
                const isImage = param.type === 'image'
                const pinOnly = param.pin_only === true || isImage
                const isNumeric = param.type === 'int' || param.type === 'float'
                return (
                  <div key={param.id} className="wf-param">
                    {/* Blueprint 风格参数引脚：可从其它节点(text/any 输出)输入，缺省时用内联控件值。
                        图片参数走 image 端口（天蓝），数字/文本参数走 text（玫红）——
                        端口类型由 `paramPortType()` 按 schema 判定，连线校验读的是同一个函数。 */}
                    {paramPin(param)}
                    {pinOnly ? (
                      <div className="wf-field wf-field--pinonly" title={param.tooltip ?? ''}>
                        <span>{param.label}</span>
                        <span className="wf-field__hint">
                          {isImage
                            ? t('workflows.nodes.pinOnlyHintImage')
                            : t(
                                isNumeric ? 'workflows.nodes.pinOnlyHintNumber' : 'workflows.nodes.pinOnlyHintText',
                                { value: String(val) }
                              )}
                        </span>
                      </div>
                    ) : (
                      <label className="wf-field">
                        <span>{param.label}</span>
                        <ParamControl param={param} value={val} onChange={(v) => setParam(param.id, v)} />
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </NodeShell>
  )
}
