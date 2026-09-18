/**
 * 子图（函数）节点：把一组蓝图节点内联封装成一个可复用的函数节点。
 *
 * `SubgraphNode` 在画布上呈现为一个函数框，输入/输出引脚由子图文档决定；
 * `SubgraphInput`/`SubgraphOutput` 是子图**内部**的输入/出口占位节点，保存时
 * 同步为该函数实例的引脚标题与颜色。同一 `subgraphRef` 多处引用共享同一份定义。
 */

import { useContext, type CSSProperties } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import {
  IN_HANDLE,
  OUT_HANDLE,
  getSubgraphDoc,
  nodeSpec,
  portColor,
  subgraphInHandle,
  subgraphOutHandle,
  subgraphPinLabel,
  type PortType,
  type WFNodeData
} from '../../../types'
import { useWorkflowsStore } from '../../../stores/workflows'
import { useWorkflowRunStore } from '../../../stores/workflowRun'
import { expandSubgraph } from '../subgraphUtils'
import { useT } from '../../../i18n'
import { SubgraphOpsContext, useParam } from './primitives'

/** 函数/子图折叠节点：把一组节点内联封装；可改名、展开还原。
 *  同一函数可被多处引用（params.subgraphRef 相同）——改一处全局生效。 */
export function SubgraphNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const replaceGraph = useWorkflowsStore((s) => s.replaceGraph)
  const renameSubgraph = useWorkflowsStore((s) => s.renameSubgraph)
  const ops = useContext(SubgraphOpsContext)
  const doc = getSubgraphDoc({ data: data as unknown as { params?: Record<string, unknown> } })
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const spec = nodeSpec('subgraphNode')
  const inputs = doc?.inputs ?? []
  const outputs = doc?.outputs ?? (doc?.out ? [doc.out] : [])
  const title = String(data.params.subgraphLabel ?? data.label ?? 'Function')
  const isInstance = typeof data.params.subgraphRef === 'string' && data.params.subgraphRef !== id

  function doExpand(): void {
    if (ops) {
      ops.expand(id)
      return
    }
    const cur = useWorkflowsStore.getState().current
    if (!cur) return
    const { nodes, edges } = expandSubgraph(id, cur.nodes, cur.edges)
    replaceGraph(nodes, edges)
  }

  return (
    <div className={`wf-node wf-subgraph wf-node--${state}`} style={{ '--node-color': spec.color } as CSSProperties}>
      {inputs.map((inp, i) => {
        const top = `${((i + 1) / (inputs.length + 1)) * 100}%`
        return (
          <Handle
            key={inp.refId}
            id={subgraphInHandle(i)}
            type="target"
            position={Position.Left}
            className="wf-handle"
            style={{ top, background: portColor(inp.type) }}
          />
        )
      })}
      {inputs.map((inp, i) => (
        <span
          key={`lbl-in-${inp.refId}`}
          className="wf-pin-label wf-pin-label--in"
          style={{ top: `${((i + 1) / (inputs.length + 1)) * 100}%` }}
          title={inp.label ?? subgraphPinLabel('in', i)}
        >
          {inp.label ?? subgraphPinLabel('in', i)}
        </span>
      ))}
      {outputs.map((o, i) => (
        <Handle
          key={o.refId}
          id={subgraphOutHandle(i)}
          type="source"
          position={Position.Right}
          className="wf-handle"
          style={{ top: `${((i + 1) / (outputs.length + 1)) * 100}%`, background: portColor(o.type) }}
        />
      ))}
      {outputs.map((o, i) => (
        <span
          key={`lbl-out-${o.refId}`}
          className="wf-pin-label wf-pin-label--out"
          style={{ top: `${((i + 1) / (outputs.length + 1)) * 100}%` }}
          title={o.label ?? subgraphPinLabel('out', i)}
        >
          {o.label ?? subgraphPinLabel('out', i)}
        </span>
      ))}

      <div className="wf-node__header">
        <svg className="wf-flow__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
          <circle cx="18" cy="17" r="3" />
        </svg>
        <input
          className="wf-subgraph__title nodrag"
          value={title}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            // 编辑器内改的是草稿；主画布上改名会同步到该函数的全部实例。
            if (ops) setParam('subgraphLabel', e.target.value)
            else renameSubgraph(id, e.target.value)
          }}
          placeholder={t('workflows.nodes.subgraphName')}
          spellCheck={false}
        />
        {isInstance && (
          <span className="wf-subgraph__shared" title={t('workflows.nodes.subgraphShared')}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M9 15l6-6M8 7h-.5a4.5 4.5 0 0 0 0 9H8M16 17h.5a4.5 4.5 0 0 0 0-9H16" />
            </svg>
          </span>
        )}
      </div>
      <div className="wf-node__body">
        <span className="wf-hint">
          {t('workflows.nodes.subgraphHint', { count: inputs.length })}
          {outputs.length > 0 ? ` · ${t('workflows.nodes.subgraphOutputsHint', { count: outputs.length })}` : ''}
        </span>
        <button className="wf-upload__btn nodrag" onPointerDown={(e) => e.stopPropagation()} onClick={doExpand}>
          {t('workflows.nodes.subgraphExpand')}
        </button>
      </div>
    </div>
  )
}

/** 子图内部"输入挂点"占位节点：表示函数的一个输入。
 *  可改名、可切换端口类型——保存时同步为该函数实例的输入引脚标题/颜色。 */
export function SubgraphInputNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const index = Number(data.params.index ?? 0)
  const name = String(data.params.name ?? data.label ?? subgraphPinLabel('in', index))
  const type = String(data.params.type ?? 'text') as PortType
  return (
    <div className="wf-subinput" style={{ '--node-color': portColor(type) } as CSSProperties} title={name}>
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ top: '50%' }} />
      <span className="wf-subinput__glyph" style={{ background: portColor(type) }} />
      <input
        className="wf-subinput__name nodrag"
        value={name}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setParam('name', e.target.value)}
        placeholder={t('workflows.nodes.pinName')}
        spellCheck={false}
      />
      <select
        className="wf-subinput__type nodrag"
        value={type}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setParam('type', e.target.value)}
        title={t('workflows.nodes.pinType')}
      >
        <option value="any">any</option>
        <option value="image">image</option>
        <option value="text">text</option>
        <option value="mesh">mesh</option>
      </select>
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ top: '50%', background: portColor(type) }} />
    </div>
  )
}

/** 子图内部"输出挂点"占位节点（Exit）：内部源节点连到它的输入，即子图的一个输出。 */
export function SubgraphOutputNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const index = Number(data.params.index ?? 0)
  const name = String(data.params.name ?? data.label ?? subgraphPinLabel('out', index))
  const type = String(data.params.type ?? 'any') as PortType
  return (
    <div className="wf-suboutput" style={{ '--node-color': portColor(type) } as CSSProperties} title={name}>
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ top: '50%', background: portColor(type) }} />
      <span className="wf-suboutput__glyph" style={{ background: portColor(type) }} />
      <input
        className="wf-suboutput__name nodrag"
        value={name}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setParam('name', e.target.value)}
        placeholder={t('workflows.nodes.pinName')}
        spellCheck={false}
      />
      <select
        className="wf-suboutput__type nodrag"
        value={type}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setParam('type', e.target.value)}
        title={t('workflows.nodes.pinType')}
      >
        <option value="any">any</option>
        <option value="image">image</option>
        <option value="text">text</option>
        <option value="mesh">mesh</option>
      </select>
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ top: '50%', background: portColor(type) }} />
    </div>
  )
}
