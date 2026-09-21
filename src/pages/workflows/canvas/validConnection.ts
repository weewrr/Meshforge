// 连线合法性校验：exec 引脚语义、端口类型兼容、单入边与防环。

import type { Connection, Edge, IsValidConnection } from '@xyflow/react'
import {
  isExecHandle,
  isExecIn,
  isExecNode,
  isExecOut,
  isParamHandle,
  nodePorts,
  paramPortType,
  portCompatible,
  type WFEdge,
  type WFNode
} from '../../../types'
import { reaches } from '../canvasUtils'

export function makeIsValidConnection(nodes: WFNode[], edges: WFEdge[]): IsValidConnection {
  return ((connection: Connection | Edge) => {
    const source = nodes.find((n) => n.id === connection.source)
    const target = nodes.find((n) => n.id === connection.target)
    if (!source || !target) return false
    if (source.id === target.id) return false

    // 执行(exec)引脚：连接必须是从 流程节点的 exec 输出 → 另一流程节点的 exec-in。
    // 只参与执行顺序，不参与数据类型校验。exec 输出可多个（Branch 的 true/false、
    // Sequence 的多个序号），exec-in 每个节点至多一条。
    if (isExecHandle(connection.sourceHandle) || isExecHandle(connection.targetHandle)) {
      return (
        isExecNode(source.type) &&
        isExecNode(target.type) &&
        isExecOut(connection.sourceHandle) &&
        isExecIn(connection.targetHandle) &&
        !edges.some((e) => e.target === target.id && isExecIn(e.targetHandle)) // 每个 exec-in 只能有一条入边
      )
    }

    const sourceOut = nodePorts(source.type, source.data?.extensionId).output
    // 参数引脚按该参数在 schema 里的类型校验（`type: 'image'` 的参数接图片，
    // 其余参数接文本）；普通数据引脚按原端口类型。
    const targetIn = isParamHandle(connection.targetHandle)
      ? paramPortType(target, connection.targetHandle)
      : nodePorts(target.type, target.data?.extensionId).inputs[0]
    if (targetIn === undefined) return false
    if (!portCompatible(sourceOut, targetIn)) return false

    // 每个输入 handle 至多一条入边。
    if (edges.some((e) => e.target === target.id && e.targetHandle === connection.targetHandle)) {
      return false
    }
    // 拒绝会形成环的连线。
    return !reaches(target.id, source.id, edges)
  }) as IsValidConnection
}
