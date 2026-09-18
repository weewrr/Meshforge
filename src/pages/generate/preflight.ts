/**
 * 运行前 preflight（提交前校验）。
 *
 * 这些规则与运行引擎"同一套"，目的是在真正触发生成之前就拦下明显跑不通的
 * 工作流（缺素材、缺上游、引用了空当前模型等），避免白等几秒再失败。
 * `firstPreflightIssue` 返回第一条问题、无则 `null`；`formatElapsed` 把秒数
 * 格式化为 `mm:ss` 供 HUD 展示。
 */

import { getT } from '../../i18n'
import { useSceneStore } from '../../stores/scene'
import type { WFEdge, WFNode } from '../../types'

/** 把累计秒数格式化为 `mm:ss`（不足两位补零），用于运行时耗时显示。 */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** 运行前 preflight：与运行引擎同一套规则，返回第一条问题（无则 null）。 */
export function firstPreflightIssue(nodes: WFNode[], edges: WFEdge[]): string | null {
  for (const node of nodes) {
    const label = node.data.label
    const hasIncoming = edges.some((e) => e.target === node.id)
    const params = node.data.params
    // 图片节点必须已选图片：否则没有输入素材，生成直接失败。
    if (node.type === 'imageNode' && !params.url) return getT('generate.preflight.noImage', { label })
    // 网格节点（从文件）：必须已选网格文件。
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') !== 'current' &&
      !params.url
    ) {
      return getT('generate.preflight.noMeshFile', { label })
    }
    // 网格节点（用当前模型）：必须场景中已有可引用模型，否则无物可用。
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') === 'current' &&
      !useSceneStore.getState().meshUrl
    ) {
      return getT('generate.preflight.noCurrentModel', { label })
    }
    // 生成器节点必须指定具体 generatorId，否则引擎不知用哪个生成器。
    if (node.type === 'generatorNode' && !params.generatorId) return getT('generate.preflight.noGenerator', { label })
    // 生成器须有上游（图片）输入，否则没有要生成的东西。
    if (node.type === 'generatorNode' && !hasIncoming) return getT('generate.preflight.needUpstreamImage', { label })
    // 预览/输出/等待节点是"消费上游"的：没有入边就没有数据源，纯摆设。
    if (
      (node.type === 'previewNode' || node.type === 'outputNode' || node.type === 'waitNode') &&
      !hasIncoming
    ) {
      return getT('generate.preflight.missingInput', { label })
    }
  }
  return null
}
