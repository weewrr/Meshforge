/**
 * 流程与控制类蓝图节点：等待、While 循环、ForEach 遍历、跳线、选择器、
 * 条件分支、顺序、常量/变量、数据门。
 *
 * 这一族节点负责"执行流"与"数据路由"，对应 Unreal Blueprint 的 exec 引脚
 * 与流程控制。引脚位置、断点、运行状态高亮等都依赖 `primitives` 的通用外壳。
 */

import { type CSSProperties } from 'react'
import { Handle, Position, NodeResizer, type NodeProps, type Node } from '@xyflow/react'
import {
  EXEC_FALSE_HANDLE,
  EXEC_IN_HANDLE,
  EXEC_OUT_HANDLE,
  EXEC_TRUE_HANDLE,
  IN_HANDLE,
  OUT_HANDLE,
  nodeSpec,
  type WFNodeData
} from '../../../types'
import { useWorkflowRunStore } from '../../../stores/workflowRun'
import { useT } from '../../../i18n'
import { BreakpointDot, IterIndexHandle, NodeShell, useParam } from './primitives'

// ─── Blueprint-style layout / control nodes ───────────────────────────────────

/** 等待节点：一次 exec 暂停点。运行到此后停下，暂停态下显示「继续」按钮，点击才往下走。 */
export function WaitNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const paused = useWorkflowRunStore((s) => s.runState === 'paused' && s.nodeStates[id] === 'waiting')
  const continueRun = useWorkflowRunStore((s) => s.continueRun)

  return (
    <NodeShell id={id} type="waitNode" label={data.label}>
      {paused ? (
        <button className="wf-wait-btn nodrag" onClick={continueRun}>
          ▶ {t('workflows.nodes.continue')}
        </button>
      ) : (
        <span className="wf-hint">{t('workflows.nodes.waitHint')}</span>
      )}
    </NodeShell>
  )
}

/**
 * While 循环容器：一个可缩放的虚线框，框内的节点即循环体（Modly 对齐）。
 *
 * 通过 React Flow 的 `parentId` 机制，子节点渲染在框之上；运行时每一轮迭代
 * 重复执行框内节点。顶部带 exec 输入/输出与迭代计数，暂停态下可「继续/重试」。
 */
export function WhileNode({ id, data, selected }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const running = state === 'running'
  const runState = useWorkflowRunStore((s) => s.runState)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const continueWhile = useWorkflowRunStore((s) => s.continueWhile)
  const retryWhile = useWorkflowRunStore((s) => s.retryWhile)
  const isPaused = runState === 'paused' && activeNodeId === id
  const iter = useWorkflowRunStore((s) => s.nodeIter[id])
  const spec = nodeSpec('whileNode')

  return (
    <div className={`wf-while ${running ? 'wf-while--running' : ''} ${isPaused ? 'wf-while--paused' : ''} ${selected ? 'wf-while--selected' : ''}`}>
      <NodeResizer
        minWidth={280}
        minHeight={160}
        lineStyle={{ borderColor: 'transparent' }}
        handleStyle={{ background: spec.color, border: 'none', width: 10, height: 10, borderRadius: 3 }}
        isVisible={selected}
      />
      <Handle id={EXEC_IN_HANDLE} type="target" position={Position.Left} className="wf-handle wf-handle--exec" style={{ top: '10px' }} />
      <Handle id={EXEC_OUT_HANDLE} type="source" position={Position.Right} className="wf-handle wf-handle--exec" style={{ top: '10px' }} />
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" />
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" />
      <IterIndexHandle />

      <div className="wf-while__header">
        <BreakpointDot id={id} />
        <span className="wf-while__glyph">↻</span>
        <span className="wf-while__title">{data.label}</span>
        {iter && (
          <span className="wf-iter">
            {t('workflows.nodes.iterCount', { index: iter.index, total: iter.total })}
          </span>
        )}
        <label className="wf-while__loop">
          <span>{t('workflows.nodes.loop')}</span>
          <input
            className="wf-while__num"
            // 不用 type="number"：在本机画布里渲染数字输入框会导致渲染进程崩溃（见 ParamControl）。
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            defaultValue={Number(data.params.iterations ?? 0)}
            disabled={runState === 'running' || runState === 'paused'}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const raw = e.target.value
              if (raw !== '' && raw !== '-' && !/^-?\d*$/.test(raw)) return
              const n = parseInt(raw, 10)
              if (!isNaN(n)) setParam('iterations', Math.max(0, n))
            }}
          />
          <span>×</span>
        </label>
        <div className="wf-while__header-spacer" />
        {isPaused && (
          <div className="wf-while__actions">
            <button className="wf-while__btn wf-while__btn--continue" onClick={continueWhile}>
              ▶ {t('workflows.nodes.continue')}
            </button>
            <button className="wf-while__btn" onClick={retryWhile}>
              ↻ {t('workflows.nodes.retry')}
            </button>
          </div>
        )}
      </div>

      <div className="wf-while__body">
        <span className="wf-while__hint">{isPaused ? t('workflows.nodes.whilePaused') : t('workflows.nodes.whileBodyHint')}</span>
      </div>
    </div>
  )
}

/** ForEach 遍历：对一组图片/文本（或工作区目录）逐个迭代，并输出当前迭代序号。 */
export function ForEachNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const runState = useWorkflowRunStore((s) => s.runState)
  const iter = useWorkflowRunStore((s) => s.nodeIter[id])
  const locked = runState === 'running' || runState === 'paused'
  return (
    <NodeShell id={id} type="forEachNode" label={data.label}>
      <IterIndexHandle />
      <label className="wf-field">
        <span>{t('workflows.nodes.iterModeLabel')}</span>
        <select
          className="wf-input nodrag"
          defaultValue={String(data.params.mode ?? 'image')}
          disabled={locked}
          onChange={(e) => setParam('mode', e.target.value)}
        >
          <option value="image">{t('workflows.nodes.iterImage')}</option>
          <option value="text">{t('workflows.nodes.iterText')}</option>
        </select>
      </label>
      <label className="wf-field">
        <span>{t('workflows.nodes.workspaceDirLabel')}</span>
        <input
          className="wf-input"
          type="text"
          defaultValue={String(data.params.dir ?? '')}
          placeholder={t('workflows.nodes.workspaceDirPlaceholder')}
          disabled={locked}
          onChange={(e) => setParam('dir', e.target.value)}
        />
      </label>
      <label className="wf-field">
        <span>{t('workflows.nodes.itemsLabel')}</span>
        <input
          className="wf-input"
          type="text"
          defaultValue={String(data.params.items ?? '')}
          disabled={locked}
          placeholder={t('workflows.nodes.itemsPlaceholder')}
          onChange={(e) => setParam('items', e.target.value)}
        />
      </label>
      <span className="wf-hint">{t('workflows.nodes.foreachHint')}</span>
      {iter && (
        <span className="wf-iter">
          {t('workflows.nodes.iterCount', { index: iter.index, total: iter.total })}
        </span>
      )}
    </NodeShell>
  )
}

/** Reroute 跳线点：纯透传结点，用于整理长连线与跨圈布线。 */
export function RerouteNode(_props: NodeProps<Node<WFNodeData>>) {
  return (
    <div className="wf-reroute">
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ top: '50%' }} />
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ top: '50%' }} />
    </div>
  )
}

/** Select 选择器：N 路输入，取其一透传（Unreal Blueprint Select 的多输入一输出）。 */
export function SelectNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const spec = nodeSpec('selectNode')
  const n = Math.max(1, spec.inputs.length)
  const mode = String(data.params.mode ?? 'auto')

  return (
    <div className={`wf-select wf-node--${state}`}>
      {Array.from({ length: n }, (_, i) => (
        <Handle
          key={i}
          id={`in${i}`}
          type="target"
          position={Position.Left}
          className="wf-handle"
          style={{ top: `${((i + 1) / (n + 1)) * 100}%` }}
        />
      ))}
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className="wf-handle" style={{ top: '50%' }} />
      <div className="wf-node__header" style={{ borderTopColor: spec.color }}>
        <BreakpointDot id={id} />
        <span className="wf-node__dot" style={{ background: spec.color }} />
        <span className="wf-node__title">{data.label}</span>
      </div>
      <div className="wf-select__body">
        <label className="wf-field">
          <span>{t('workflows.nodes.selectModeLabel')}</span>
          <select
            className="wf-input nodrag"
            value={mode}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('mode', e.target.value)}
          >
            <option value="auto">{t('workflows.nodes.selectAuto')}</option>
            {Array.from({ length: n }, (_, i) => (
              <option key={i} value={String(i)}>
                {t('workflows.nodes.selectIndex', { index: i })}
              </option>
            ))}
          </select>
        </label>
        <span className="wf-hint">{t('workflows.nodes.selectHint')}</span>
      </div>
    </div>
  )
}

/** Branch 条件分支：一个 exec 输入，按条件走 true / false 两路 exec 输出。 */
export function BranchNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const spec = nodeSpec('branchNode')
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')

  return (
    <div className={`wf-branch wf-node--${state}`} style={{ '--node-color': spec.color } as CSSProperties}>
      <Handle id={EXEC_IN_HANDLE} type="target" position={Position.Left} className="wf-handle wf-handle--exec" style={{ top: '14px' }} />
      <Handle id={IN_HANDLE} type="target" position={Position.Left} className="wf-handle" style={{ top: '70%' }} />
      <Handle id={EXEC_TRUE_HANDLE} type="source" position={Position.Right} className="wf-handle wf-handle--exec" style={{ top: '38%' }} />
      <Handle id={EXEC_FALSE_HANDLE} type="source" position={Position.Right} className="wf-handle wf-handle--exec" style={{ top: '68%' }} />

      <div className="wf-node__header">
        <BreakpointDot id={id} />
        <svg className="wf-flow__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 12h8M12 8v8" />
        </svg>
        <span className="wf-node__title">{data.label}</span>
      </div>
      <div className="wf-node__body">
        <label className="wf-field">
          <span>{t('workflows.nodes.branchCondLabel')}</span>
          <select
            className="wf-input nodrag"
            value={String(data.params.condition ?? 'true')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('condition', e.target.value === 'true')}
          >
            <option value="true">{t('workflows.nodes.branchTrue')}</option>
            <option value="false">{t('workflows.nodes.branchFalse')}</option>
          </select>
        </label>
        <span className="wf-hint">{t('workflows.nodes.branchHint')}</span>
        <div className="wf-branch__labels">
          <span style={{ color: spec.color }}>T</span>
          <span style={{ color: 'var(--danger-bright)' }}>F</span>
        </div>
      </div>
    </div>
  )
}

/** Sequence 顺序：一个 exec 输入，依序触发多个 exec 输出。 */
export function SequenceNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const spec = nodeSpec('sequenceNode')
  const state = useWorkflowRunStore((s) => s.nodeStates[id] ?? 'pending')
  const n = Math.max(1, Math.min(16, Number(data.params.outputs ?? 2) || 2))

  return (
    <div className={`wf-sequence wf-node--${state}`} style={{ '--node-color': spec.color } as CSSProperties}>
      <Handle id={EXEC_IN_HANDLE} type="target" position={Position.Left} className="wf-handle wf-handle--exec" style={{ top: '40%' }} />
      {Array.from({ length: n }, (_, i) => {
        const top = ((i + 1) / (n + 1)) * 100
        return (
          <Handle
            key={i}
            id={`exec-${i}`}
            type="source"
            position={Position.Right}
            className="wf-handle wf-handle--exec"
            style={{ top: `${top}%` }}
          />
        )
      })}

      <div className="wf-node__header">
        <BreakpointDot id={id} />
        <svg className="wf-flow__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 17V7l4 4 4-4v10" />
        </svg>
        <span className="wf-node__title">{data.label}</span>
      </div>
      <div className="wf-node__body">
        <label className="wf-field">
          <span>{t('workflows.nodes.sequenceOutputsLabel')}</span>
          <input
            className="wf-input wf-input--num nodrag"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            defaultValue={n}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const raw = e.target.value
              if (raw !== '' && raw !== '-' && !/^-?\d*$/.test(raw)) return
              const v = parseInt(raw, 10)
              if (!isNaN(v)) setParam('outputs', Math.max(1, Math.min(16, v)))
            }}
          />
        </label>
        <span className="wf-hint">{t('workflows.nodes.sequenceHint')}</span>
      </div>
    </div>
  )
}

/** 变量/常量：内联编辑一个值，输出为 text 数据引脚（可接任意文本/参数引脚）。 */
export function VariableNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const dtype = String(data.params.dtype ?? 'text')
  return (
    <NodeShell id={id} type="variableNode" label={data.label}>
      <label className="wf-field">
        <span>{t('workflows.nodes.variableTypeLabel')}</span>
        <select
          className="wf-input nodrag"
          value={dtype}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('dtype', e.target.value)}
        >
          <option value="text">{t('workflows.nodes.variableText')}</option>
          <option value="float">{t('workflows.nodes.variableFloat')}</option>
          <option value="int">{t('workflows.nodes.variableInt')}</option>
          <option value="bool">{t('workflows.nodes.variableBool')}</option>
        </select>
      </label>
      <label className="wf-field">
        <span>{t('workflows.nodes.variableValueLabel')}</span>
        {dtype === 'bool' ? (
          <select
            className="wf-input nodrag"
            value={String(data.params.value ?? 'true')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('value', e.target.value === 'true')}
          >
            <option value="true">{t('workflows.nodes.branchTrue')}</option>
            <option value="false">{t('workflows.nodes.branchFalse')}</option>
          </select>
        ) : (
          <input
            className="wf-input nodrag"
            type="text"
            inputMode={dtype === 'int' ? 'numeric' : dtype === 'float' ? 'decimal' : 'text'}
            autoComplete="off"
            spellCheck={false}
            defaultValue={String(data.params.value ?? '')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setParam('value', e.target.value)}
          />
        )}
      </label>
    </NodeShell>
  )
}

/** 数据门：open 时为真则透传上游数据，否则无输出。 */
export function GateNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="gateNode" label={data.label}>
      <label className="wf-field">
        <select
          className="wf-input nodrag"
          value={String(data.params.open ?? 'true')}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setParam('open', e.target.value === 'true')}
        >
          <option value="true">{t('workflows.nodes.gateOpen')}</option>
          <option value="false">{t('workflows.nodes.gateClosed')}</option>
        </select>
      </label>
      <span className="wf-hint">{t('workflows.nodes.gateHint')}</span>
    </NodeShell>
  )
}
