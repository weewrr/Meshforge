import { allExtensions, getExtensionById, isContainerType, nodeSpec, type WFEdge, type WFNode } from '../../types'
import { useWorkflowsStore } from '../../stores/workflows'

/** Is `to` reachable from `from` along the given edges (cycle check)? */
export function reaches(
  from: string,
  to: string,
  edges: WFEdge[]
): boolean {
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    for (const e of edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target)
        stack.push(e.target)
      }
    }
  }
  return false
}

/** Topmost While container whose screen rect contains the given client point.
 *  Uses the DOM node wrapper, so it stays correct at any zoom / pan state. */
export function containerAtScreen(clientX: number, clientY: number): WFNode | undefined {
  const nds = useWorkflowsStore.getState().current?.nodes ?? []
  for (let i = nds.length - 1; i >= 0; i--) {
    const n = nds[i]
    if (!isContainerType(n.type)) continue
    const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${n.id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return n
  }
  return undefined
}

export function nodeSize(n: WFNode): { w: number; h: number } {
  return {
    w: n.measured?.width ?? n.width ?? (typeof n.style?.width === 'number' ? n.style.width : 200),
    h: n.measured?.height ?? n.height ?? (typeof n.style?.height === 'number' ? n.style.height : 80)
  }
}

export const PALETTE_NODES: { payload: string; labelKey: string; hintKey: string }[] = [
  { payload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', hintKey: 'workflows.palette.imageHint' },
  { payload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', hintKey: 'workflows.palette.textHint' },
  { payload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', hintKey: 'workflows.palette.meshHint' },
  { payload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', hintKey: 'workflows.palette.generateHint' },
  { payload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', hintKey: 'workflows.palette.previewHint' },
  { payload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', hintKey: 'workflows.palette.outputHint' },
  { payload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', hintKey: 'workflows.palette.waitHint' },
  { payload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', hintKey: 'workflows.palette.whileHint' },
  { payload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', hintKey: 'workflows.palette.forEachHint' }
]

/** Instantiate a WFNode from a palette payload string (builtin:* / generator:* / extension:*). */
export function createNodeFromPayload(payload: string, position: { x: number; y: number }): WFNode | null {
  const id = crypto.randomUUID()
  if (payload.startsWith('builtin:')) {
    const type = payload.slice('builtin:'.length)
    const spec = nodeSpec(type)
    if (!spec) return null
    const defaults: Record<string, Record<string, unknown>> = {
      imageNode: { url: '', fileName: '' },
      textNode: { text: 'A 3D model' },
      meshNode: { url: '', fileName: '' },
      generatorNode: { generatorId: 'mock-relief' },
      outputNode: {},
      previewNode: {},
      waitNode: {},
      whileNode: { iterations: 2 },
      forEachNode: { items: 'view 1, view 2' }
    }
    return {
      id,
      type,
      position,
      // RF shows node wrappers (and their handles) only when dimensions are
      // known; initialWidth/Height make the first frame stable before the
      // ResizeObserver measurement kicks in (initial* gets overwritten).
      ...(type === 'whileNode'
        ? { style: { width: 340, height: 220 }, initialWidth: 340, initialHeight: 220 }
        : { initialWidth: 200, initialHeight: 80 }),
      data: { label: spec.label, color: spec.color, params: { ...(defaults[type] ?? {}) } }
    }
  }
  if (payload.startsWith('generator:')) {
    const generatorId = payload.slice('generator:'.length)
    const spec = nodeSpec('generatorNode')
    return {
      id,
      type: 'generatorNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: `Generate (${generatorId})`,
        color: spec.color,
        params: { generatorId }
      }
    }
  }
  if (payload.startsWith('extension:')) {
    const extensionId = payload.slice('extension:'.length)
    const ext = getExtensionById(extensionId)
    const spec = nodeSpec('extensionNode')
    return {
      id,
      type: 'extensionNode',
      position,
      initialWidth: 200,
      initialHeight: 80,
      data: {
        label: ext?.display_name ?? 'Extension',
        color: spec.color,
        extensionId,
        params: {
          extensionId,
          ...Object.fromEntries((ext?.params ?? []).map((p) => [p.id, p.default]))
        }
      }
    }
  }
  return null
}
