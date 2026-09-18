/**
 * 工作流运行前预检：一次性收集所有配置问题，尽早失败。
 *
 * 从 engine.ts 原样迁出（行为零变更）：只做检查与日志，不修改任何运行态。
 */

import {
  DISPATCHER_PARAM,
  VAR_NAME_PARAM,
  getExtensionById,
  type WFNode,
  type WFEdge
} from '../../types'
import { useSceneStore } from '../scene'
import type { EngineLogger } from './engine-context'
import { nodeExtensionId } from './helpers'

/**
 * 收集预检问题与告警。
 *
 * @param workflow.nodes / workflow.edges 目标（子）图
 * @param hasOverride 本次运行是否携带覆盖图片（只能救第一个缺图的 imageNode）
 * @param logger 日志器：告警类问题（未阻断）直接打 warn，硬性问题返回给调用方
 * @returns 硬性问题列表——非空时运行应当以 failed 收尾
 */
export function collectPreflightIssues(
  nodes: WFNode[],
  edges: WFEdge[],
  hasOverride: boolean,
  logger: EngineLogger
): string[] {
  const issues: string[] = []
  // 覆盖图至多被消耗一次，因此只有第一个缺图的 imageNode 能被覆盖救场。
  let overrideAvailable = hasOverride
  for (const node of nodes) {
    const label = node.data.label
    const hasIncoming = edges.some((e) => e.target === node.id)
    const params = node.data.params
    if (node.type === 'imageNode' && !params.url) {
      if (overrideAvailable) overrideAvailable = false
      else issues.push(`${label}: 未选择图片`)
    }
    if (node.type === 'meshNode') {
      if (String(params.source ?? 'file') === 'current') {
        if (!useSceneStore.getState().meshUrl) {
          issues.push(`${label}: 3D 查看器中没有当前模型`)
        }
      } else if (!params.url) {
        issues.push(`${label}: 未选择网格文件`)
      }
    }
    if (node.type === 'generatorNode' && !params.generatorId) {
      issues.push(`${label}: 未选择生成器`)
    }
    if (node.type === 'generatorNode' && !hasIncoming) {
      issues.push(`${label}: 需要上游图片连接`)
    }
    if (node.type === 'extensionNode') {
      const ext = getExtensionById(nodeExtensionId(node))
      if (!ext) {
        issues.push(`${label}: 未知扩展`)
      } else if (!hasIncoming) {
        issues.push(`${label}: 需要上游${ext.kind === 'model' ? '图片' : '网格'}连接`)
      }
    }
    if (
      (node.type === 'previewNode' || node.type === 'outputNode' || node.type === 'waitNode') &&
      !hasIncoming
    ) {
      issues.push(`${label}: 缺少输入连接`)
    }
  }
  // 变量 / 事件分发器的"编译期检查"：只提示，不阻断运行（图可能仍在搭建中）。
  const declaredVars = new Set(
    nodes
      .filter((n) => n.type === 'variableSetNode')
      .map((n) => String(n.data.params?.[VAR_NAME_PARAM] ?? '').trim())
      .filter(Boolean)
  )
  for (const node of nodes) {
    if (node.type === 'variableGetNode') {
      const name = String(node.data.params?.[VAR_NAME_PARAM] ?? '').trim()
      if (!name) logger.warn(`preflight: ${node.data.label}: 未设置变量名`)
      else if (!declaredVars.has(name)) logger.warn(`preflight: ${node.data.label}: 变量『${name}』没有任何 Set 节点声明`)
    }
    if (node.type === 'eventCallNode') {
      const name = String(node.data.params?.[DISPATCHER_PARAM] ?? '').trim()
      if (!name) logger.warn(`preflight: ${node.data.label}: 未设置事件名`)
    }
  }
  return issues
}
