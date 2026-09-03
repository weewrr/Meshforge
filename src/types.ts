import type { Node, Edge } from '@xyflow/react'

export type PortType = 'image' | 'text' | 'mesh' | 'any' | 'none'

export interface WFNodeData extends Record<string, unknown> {
  label: string
  color: string
  params: Record<string, unknown>
}

export type WFNode = Node<WFNodeData>
export type WFEdge = Edge

export interface Workflow {
  id: string
  name: string
  description: string
  folder?: string
  bookmarked?: boolean
  nodes: WFNode[]
  edges: WFEdge[]
  createdAt: string
  updatedAt: string
}

export interface WorkflowMeta {
  id: string
  name: string
  updatedAt: string
  folder?: string
  bookmarked?: boolean
}

export interface GeneratorInfo {
  id: string
  display_name: string
  is_loaded: boolean
}

// ─── Extensions (Modly parity) ───────────────────────────────────────────────
// Schema-driven extension nodes: a model generator (image → mesh) or a mesh
// processing tool (mesh → mesh). The node UI and the run engine both read
// `params` from this schema.

export type ParamType = 'select' | 'string' | 'int' | 'float'

export interface ParamSchema {
  id: string
  label: string
  type: ParamType
  default: string | number
  options?: { value: string | number; label?: string }[]
  min?: number
  max?: number
  tooltip?: string
  /** Show this param only when another param equals these values. */
  show_if?: Record<string, string | number | Array<string | number>>
}

export interface WorkflowExtension {
  id: string
  display_name: string
  /** 'model' = image→mesh generator; 'process' = mesh→mesh tool. */
  kind: 'model' | 'process'
  input: PortType
  output: PortType
  params: ParamSchema[]
  /** HuggingFace repo to download model weights from (manifest extensions). */
  hfRepo?: string
  /** Path prefixes to exclude / include during the weight download. */
  hfSkipPrefixes?: string[]
  hfIncludePrefixes?: string[]
}

// ─── Node specs ──────────────────────────────────────────────────────────────
// Single source of truth for node port typing, labels and colors. The canvas,
// connection validator and runner all read from this table.

export const NODE_SPECS: Record<
  string,
  { label: string; color: string; inputs: PortType[]; output: PortType }
> = {
  imageNode: { label: 'Image', color: '#38bdf8', inputs: [], output: 'image' },
  textNode: { label: 'Text', color: '#fbbf24', inputs: [], output: 'text' },
  meshNode: { label: 'Load 3D Mesh', color: '#a78bfa', inputs: [], output: 'mesh' },
  generatorNode: { label: 'Generate Mesh', color: '#34d399', inputs: ['image'], output: 'mesh' },
  previewNode: { label: 'Preview', color: '#38bdf8', inputs: ['mesh'], output: 'mesh' },
  outputNode: { label: 'Add to Scene', color: '#a78bfa', inputs: ['mesh'], output: 'none' },
  waitNode: { label: 'Wait', color: '#71717a', inputs: ['any'], output: 'any' },
  whileNode: { label: 'While', color: '#f59e0b', inputs: ['any'], output: 'any' },
  forEachNode: { label: 'For Each', color: '#38bdf8', inputs: ['any'], output: 'any' },
  extensionNode: { label: 'Extension', color: '#34d399', inputs: ['any'], output: 'any' }
}

export function nodeSpec(type: string) {
  return NODE_SPECS[type] ?? { label: type, color: '#71717a', inputs: [] as PortType[], output: 'none' as PortType }
}

export function isBranchStarter(type?: string): boolean {
  return type === 'waitNode'
}

export function isLoopStarter(type?: string): boolean {
  return type === 'whileNode' || type === 'forEachNode'
}

/** Container nodes whose on-canvas bounds define the loop body (Modly parity). */
export function isContainerType(type?: string): boolean {
  return type === 'whileNode'
}

// ─── Extension lookup (module-level cache, filled by api.listExtensions) ─────
let extensionCache: WorkflowExtension[] = []

export function setExtensionsCache(extensions: WorkflowExtension[]): void {
  extensionCache = extensions
}

export function getExtensionById(id: unknown): WorkflowExtension | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return extensionCache.find((e) => e.id === id)
}

export function allExtensions(): WorkflowExtension[] {
  return extensionCache
}

/** Ports of a dynamic extension node (port typing comes from the schema). */
export function nodePorts(type: string | undefined, extensionId?: unknown): { inputs: PortType[]; output: PortType } {
  if (type === 'extensionNode') {
    const ext = getExtensionById(extensionId)
    if (ext) return { inputs: ext.input === 'none' ? [] : [ext.input], output: ext.output }
    return { inputs: ['any'], output: 'any' }
  }
  const spec = nodeSpec(type ?? '')
  return { inputs: spec.inputs, output: spec.output }
}

export function portCompatible(source: PortType, target: PortType): boolean {
  if (source === 'none' || target === 'none') return false
  return source === target || source === 'any' || target === 'any'
}

// Standard handle ids — every node has at most one target handle ("in") and
// one source handle ("out"); port typing comes from NODE_SPECS.
export const IN_HANDLE = 'in'
export const OUT_HANDLE = 'out'
