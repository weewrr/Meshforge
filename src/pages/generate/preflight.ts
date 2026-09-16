import { getT } from '../../i18n'
import { useSceneStore } from '../../stores/scene'
import type { WFEdge, WFNode } from '../../types'

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
    if (node.type === 'imageNode' && !params.url) return getT('generate.preflight.noImage', { label })
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') !== 'current' &&
      !params.url
    ) {
      return getT('generate.preflight.noMeshFile', { label })
    }
    if (
      node.type === 'meshNode' &&
      String(params.source ?? 'file') === 'current' &&
      !useSceneStore.getState().meshUrl
    ) {
      return getT('generate.preflight.noCurrentModel', { label })
    }
    if (node.type === 'generatorNode' && !params.generatorId) return getT('generate.preflight.noGenerator', { label })
    if (node.type === 'generatorNode' && !hasIncoming) return getT('generate.preflight.needUpstreamImage', { label })
    if (
      (node.type === 'previewNode' || node.type === 'outputNode' || node.type === 'waitNode') &&
      !hasIncoming
    ) {
      return getT('generate.preflight.missingInput', { label })
    }
  }
  return null
}
