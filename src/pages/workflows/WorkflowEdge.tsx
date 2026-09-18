/**
 * 工作流连线（Edge）渲染组件。
 *
 * 连线的颜色由两端端口类型决定：从源节点输出色渐变到目标节点输入色，
 * 沿用 Blueprint 配色。执行线（连接白色执行引脚）统一渲染为白色粗线；
 * 运行期间，已触发的执行线会变成流动的虚线，便于一眼看清当前执行路径。
 */

import { getBezierPath, useReactFlow, useEdges } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { nodePorts, nodeSpec, portColor, targetInputType, isExecHandle } from '../../types'
import { useWorkflowRunStore } from '../../stores/workflowRun'

/**
 * 工作流连线组件。按两端端口类型着色（源输出色 → 目标输入色的渐变，沿用
 * Blueprint 配色）；连接白色执行引脚的执行线渲染为纯白粗线，即 Blueprint 图
 * 标志性的"执行流"连线。运行期间，源端已触发的执行线转为流动虚线，使当前
 * 执行路径一目了然。
 */
export default function WorkflowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition
}: EdgeProps) {
  const { getNode } = useReactFlow()
  const edges = useEdges()
  const runState = useWorkflowRunStore((s) => s.runState)
  const nodeStates = useWorkflowRunStore((s) => s.nodeStates)

  const sourceNode = getNode(source)
  const targetNode = getNode(target)
  // 连线自身携带目标 handle id（EdgeProps 不暴露它），
  // 用于按匹配到的输入类型给多输入 handle（Select）着色。
  const sourceHandle = edges.find((e) => e.id === id)?.sourceHandle
  const targetHandle = edges.find((e) => e.id === id)?.targetHandle

  // 执行（exec）连线恒为白色，与其连接的数据脚位无关。
  if (isExecHandle(sourceHandle) || isExecHandle(targetHandle)) {
    const [execPath] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition
    })
    const running = runState === 'running' || runState === 'paused'
    const srcState = nodeStates[source]
    const flowing = running && (srcState === 'running' || srcState === 'succeeded')
    const targetActive = running && (nodeStates[target] === 'running' || nodeStates[target] === 'waiting')
    return (
      <path
        d={execPath}
        fill="none"
        style={{ stroke: 'var(--exec-wire, #e8e9eb)', strokeWidth: targetActive ? 3 : 2.5 }}
        className={`react-flow__edge-path ${flowing ? 'wf-edge--exec-flow' : ''}`}
      />
    )
  }

  // 源端：取输出类型色（多输入目标节点对源端无影响）。
  const sourcePort =
    sourceNode?.type === 'extensionNode' && sourceNode.data
      ? nodePorts(sourceNode.type, sourceNode.data.extensionId).output
      : nodeSpec(sourceNode?.type ?? '').output
  const sourceColor = portColor(sourcePort)
  // 目标端：按目标 handle 取对应输入类型色（兼容多输入 Select）。
  const targetColor = targetNode ? portColor(targetInputType(targetNode, targetHandle)) : portColor('any')

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })
  const gradientId = `wf-edge-${id}`

  // 此处读取 store 仅为保持订阅（颜色其实来自 getNode）——对多输入场景无害且留有余地。
  void edges

  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>
      </defs>
      <path
        d={edgePath}
        fill="none"
        style={{ stroke: `url(#${gradientId})`, strokeWidth: 2.5 }}
        className="react-flow__edge-path"
      />
    </>
  )
}
