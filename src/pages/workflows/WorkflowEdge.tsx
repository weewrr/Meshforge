import { getBezierPath, useReactFlow, useEdges } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { nodePorts, nodeSpec } from '../../types'

const PORT_COLOR: Record<string, string> = {
  image: '#38bdf8',
  text: '#fb7185',
  mesh: '#a78bfa',
  any: '#71717a'
}

// Edge colored by the port types it connects: a gradient from the source
// node's output color to the target node's input color.
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

  const sourceNode = getNode(source)
  const targetNode = getNode(target)

  const sourceColor =
    sourceNode?.type === 'extensionNode'
      ? PORT_COLOR[nodePorts(sourceNode.type, sourceNode.data?.extensionId).output] ?? '#a78bfa'
      : nodeSpec(sourceNode?.type ?? '').color
  const targetIn = nodePorts(targetNode?.type ?? '', targetNode?.data?.extensionId).inputs[0] ?? 'mesh'
  const targetColor = PORT_COLOR[targetIn] ?? '#a78bfa'

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })
  const gradientId = `wf-edge-${id}`

  // Reading the store here keeps this component subscribed even though the
  // color inputs come from getNode — harmless and future-proof for multi-input.
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
