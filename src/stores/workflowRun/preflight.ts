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
import { getT } from '../../i18n'
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
      else issues.push(getT('workflows.runLog.noImageSelected', { label }))
    }
    if (node.type === 'meshNode') {
      if (String(params.source ?? 'file') === 'current') {
        if (!useSceneStore.getState().meshUrl) {
          issues.push(getT('workflows.runLog.noCurrentMesh', { label }))
        }
      } else if (!params.url) {
        issues.push(getT('workflows.runLog.noMeshFileSelected', { label }))
      }
    }
    if (node.type === 'generatorNode' && !params.generatorId) {
      issues.push(getT('workflows.runLog.noGeneratorSelected', { label }))
    }
    if (node.type === 'generatorNode' && !hasIncoming) {
      issues.push(getT('workflows.runLog.needsImageUpstream', { label }))
    }
    if (node.type === 'extensionNode') {
      const ext = getExtensionById(nodeExtensionId(node))
      if (!ext) {
        issues.push(getT('workflows.runLog.unknownExtension', { label }))
      } else if (!hasIncoming) {
        // 扩展是模型类还是网格类，决定上游端口类型的措辞。
        issues.push(
          getT(
            ext.kind === 'model'
              ? 'workflows.runLog.needsUpstreamImage'
              : 'workflows.runLog.needsUpstreamMesh',
            { label }
          )
        )
      }
    }
    if (
      (node.type === 'previewNode' || node.type === 'outputNode' || node.type === 'waitNode') &&
      !hasIncoming
    ) {
      issues.push(getT('workflows.runLog.missingInput', { label }))
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
      const label = node.data.label
      if (!name) logger.warn(getT('workflows.runLog.varNameNotSet', { label }))
      else if (!declaredVars.has(name)) logger.warn(getT('workflows.runLog.varUndeclared', { label, name }))
    }
    if (node.type === 'eventCallNode') {
      const name = String(node.data.params?.[DISPATCHER_PARAM] ?? '').trim()
      if (!name) logger.warn(getT('workflows.runLog.eventNameNotSet', { label: node.data.label }))
    }
  }
  return issues
}
