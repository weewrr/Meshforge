// ─── Workflow execution engine ────────────────────────────────────────────────
// Frontend-driven runner, modeled after node-graph execution semantics:
//   * topological order decides execution sequence,
//   * Wait nodes pause the run and expose a Continue button (branch starter),
//   * While / For Each nodes repeat their dominated downstream segment,
//   * generator nodes call the backend job API and stream progress back,
//   * node outputs flow to downstream nodes via the outputs map.

import { create } from 'zustand'
import { cancelJob, fullUrl, getJob, listDirFiles, processMesh, submitImage } from '../api'
import {
  getExtensionById,
  isBranchStarter,
  isContainerType,
  isLoopStarter,
  type WFEdge,
  type WFNode,
  type Workflow
} from '../types'
import { useLogsStore } from './logs'
import { useSceneStore } from './scene'

export type RunState = 'idle' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

export type NodeState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'

interface NodeOutput {
  type: 'image' | 'text' | 'mesh'
  file?: File
  url?: string
  text?: string
}

class Cancelled extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Kahn topological sort. Any leftover nodes (shouldn't happen — the canvas
 *  forbids cycles) are appended in declaration order. */
export function topoSort(nodes: WFNode[], edges: WFEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const t of adj.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 0) - 1)
      if ((indeg.get(t) ?? 0) === 0) queue.push(t)
    }
  }
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id)
  return order
}

/** Nodes dominated by a loop starter: forward-reachable from it, stopping at
 *  other branch/loop starter boundaries. These are the nodes repeated on each
 *  iteration. */
function loopSegment(startId: string, nodeMap: Map<string, WFNode>, edges: WFEdge[]): WFNode[] {
  const result: WFNode[] = []
  const seen = new Set<string>([startId])
  const stack = [startId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const e of edges) {
      if (e.source !== id || seen.has(e.target)) continue
      seen.add(e.target)
      const type = nodeMap.get(e.target)?.type
      if (isBranchStarter(type) || isLoopStarter(type)) continue
      const node = nodeMap.get(e.target)
      if (node) result.push(node)
      stack.push(e.target)
    }
  }
  return result
}

// ─── While container geometry (Modly parity) ──────────────────────────────────
// The loop body of a While container = nodes parented to it, plus unparented
// nodes whose center lies inside the frame (covers palette clicks inside the
// container and frames resized around existing nodes).

function nodeBox(n: WFNode): { w: number; h: number } {
  const styleW = n.style?.width
  const styleH = n.style?.height
  return {
    w: n.measured?.width ?? n.width ?? (typeof styleW === 'number' ? styleW : 200),
    h: n.measured?.height ?? n.height ?? (typeof styleH === 'number' ? styleH : 80)
  }
}

function whileBodyNodes(w: WFNode, nodes: WFNode[]): WFNode[] {
  const { w: bw, h: bh } = nodeBox(w)
  const body: WFNode[] = []
  for (const n of nodes) {
    if (n.id === w.id) continue
    if (n.parentId === w.id) {
      body.push(n)
      continue
    }
    if (n.parentId || isContainerType(n.type)) continue
    const { w: nw, h: nh } = nodeBox(n)
    const cx = n.position.x + nw / 2
    const cy = n.position.y + nh / 2
    if (cx >= w.position.x && cx <= w.position.x + bw && cy >= w.position.y && cy <= w.position.y + bh) {
      body.push(n)
    }
  }
  return body
}

async function urlToFile(url: string, name: string): Promise<File> {
  const res = await fetch(fullUrl(url))
  if (!res.ok) throw new Error(`fetch input failed: ${res.status}`)
  const blob = await res.blob()
  return new File([blob], name, { type: blob.type || 'image/png' })
}

// ─── Engine runtime state (module scope, one run at a time) ──────────────────

let cancelRequested = false
let waitResolve: ((action: 'continue' | 'cancel') => void) | null = null
// While container (manual mode) pause/resume — set by continueWhile()/retryWhile().
let whileResolve: ((action: 'continue' | 'retry') => void) | null = null
let activeJobId: string | null = null
let overrideImage: File | null = null
let overrideUsed = false
const outputs = new Map<string, NodeOutput>()

interface WorkflowRunState {
  runState: RunState
  nodeStates: Record<string, NodeState>
  nodeProgress: Record<string, number>
  activeNodeId: string | null
  currentJobId: string | null
  currentWorkflowId: string | null
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  run: (workflow: Workflow, override?: File | null) => Promise<void>
  cancel: () => Promise<void>
  continueRun: () => void
  continueWhile: () => void
  retryWhile: () => void
  reset: () => void
}

export const useWorkflowRunStore = create<WorkflowRunState>((set, get) => {
  const logger = useLogsStore.getState()

  function setNodeState(id: string, state: NodeState): void {
    set((s) => ({ nodeStates: { ...s.nodeStates, [id]: state } }))
  }

  function findUpstream(nodeId: string, edges: WFEdge[]): NodeOutput | undefined {
    for (const e of edges) {
      if (e.target !== nodeId) continue
      const out = outputs.get(e.source)
      if (out) return out
    }
    return undefined
  }

  async function pollJob(jobId: string, nodeId: string, label: string): Promise<string> {
    for (;;) {
      if (cancelRequested) {
        await cancelJob(jobId).catch(() => undefined)
        throw new Cancelled()
      }
      const status = await getJob(jobId)
      set((s) => ({
        nodeProgress: { ...s.nodeProgress, [nodeId]: status.progress },
        currentJobId: jobId
      }))
      if (status.state === 'succeeded') {
        logger.info(`${label}: mesh ready`)
        return status.result_url ?? ''
      }
      if (status.state === 'failed') throw new Error(`${label}: ${status.error ?? 'generation failed'}`)
      if (status.state === 'cancelled') throw new Cancelled()
      await sleep(500)
    }
  }

  async function execNode(node: WFNode, edges: WFEdge[]): Promise<void> {
    const label = node.data.label
    setNodeState(node.id, 'running')
    set({ activeNodeId: node.id })
    const params = node.data.params

    switch (node.type) {
      case 'imageNode': {
        let file: File | null = null
        if (overrideImage && !overrideUsed) {
          file = overrideImage
          overrideUsed = true
          logger.info(`${label}: using override image`)
        } else {
          const url = String(params.url ?? '')
          if (!url) throw new Error(`${label}: no image configured`)
          file = await urlToFile(url, String(params.fileName ?? 'input.png'))
        }
        outputs.set(node.id, { type: 'image', file })
        break
      }

      case 'textNode': {
        outputs.set(node.id, { type: 'text', text: String(params.text ?? '') })
        break
      }

      case 'meshNode': {
        if (String(params.source ?? 'file') === 'current') {
          const current = useSceneStore.getState().meshUrl
          if (!current) throw new Error(`${label}: no current model in the 3D viewer`)
          logger.info(`${label}: using current model from viewer`)
          outputs.set(node.id, { type: 'mesh', url: current })
          break
        }
        const url = String(params.url ?? '')
        if (!url) throw new Error(`${label}: no mesh file configured`)
        outputs.set(node.id, { type: 'mesh', url })
        break
      }

      case 'generatorNode': {
        const generatorId = String(params.generatorId ?? '')
        if (!generatorId) throw new Error(`${label}: no generator selected`)
        const upstream = findUpstream(node.id, edges)
        if (!upstream || upstream.type !== 'image' || !upstream.file) {
          throw new Error(`${label}: needs an upstream image`)
        }
        logger.info(`${label}: submitting to '${generatorId}'`)
        const { job_id } = await submitImage(upstream.file, generatorId, params)
        activeJobId = job_id
        const resultUrl = await pollJob(job_id, node.id, label)
        activeJobId = null
        set({ currentJobId: null })
        outputs.set(node.id, { type: 'mesh', url: resultUrl })
        break
      }

      case 'extensionNode': {
        const extensionId = String(params.extensionId ?? '')
        const ext = getExtensionById(extensionId)
        if (!ext) throw new Error(`${label}: unknown extension '${extensionId}'`)
        if (ext.kind === 'process') {
          // Mesh processing tool (mesh → mesh / none).
          const upstream = findUpstream(node.id, edges)
          if (!upstream || upstream.type !== 'mesh' || !upstream.url) {
            throw new Error(`${label}: needs an upstream mesh`)
          }
          logger.info(`${label}: processing mesh`)
          const { job_id } = await processMesh(upstream.url, ext.id, params)
          activeJobId = job_id
          const resultUrl = await pollJob(job_id, node.id, label)
          activeJobId = null
          set({ currentJobId: null })
          if (ext.output !== 'none') {
            outputs.set(node.id, { type: 'mesh', url: resultUrl })
          }
          break
        }
        // Model generator (image → mesh), same pipeline as generatorNode.
        const upstream = findUpstream(node.id, edges)
        if (!upstream || upstream.type !== 'image' || !upstream.file) {
          throw new Error(`${label}: needs an upstream image`)
        }
        logger.info(`${label}: submitting to '${ext.id}'`)
        const { job_id } = await submitImage(upstream.file, ext.id, params)
        activeJobId = job_id
        const resultUrl = await pollJob(job_id, node.id, label)
        activeJobId = null
        set({ currentJobId: null })
        outputs.set(node.id, { type: 'mesh', url: resultUrl })
        break
      }

      case 'previewNode':
      case 'outputNode': {
        const upstream = findUpstream(node.id, edges)
        if (!upstream || upstream.type !== 'mesh' || !upstream.url) {
          throw new Error(`${label}: needs an upstream mesh`)
        }
        useSceneStore.getState().pushMeshUrl(fullUrl(upstream.url))
        logger.info(`${label}: mesh pushed to viewer`)
        if (node.type === 'previewNode') outputs.set(node.id, upstream)
        break
      }

      case 'waitNode': {
        const upstream = findUpstream(node.id, edges)
        if (upstream) outputs.set(node.id, upstream)
        setNodeState(node.id, 'waiting')
        set({ runState: 'paused', activeNodeId: node.id })
        logger.info(`${label}: paused — waiting for user to continue`)
        const action = await new Promise<'continue' | 'cancel'>((resolve) => {
          waitResolve = resolve
        })
        waitResolve = null
        if (action === 'cancel') throw new Cancelled()
        set({ runState: 'running' })
        break
      }

      default:
        // Unknown node type — treat as no-op.
        break
    }

    setNodeState(node.id, 'succeeded')
    set((s) => ({ nodeProgress: { ...s.nodeProgress, [node.id]: 1 } }))
    set({ activeNodeId: get().activeNodeId === node.id ? null : get().activeNodeId })
  }

  return {
    runState: 'idle',
    nodeStates: {},
    nodeProgress: {},
    activeNodeId: null,
    currentJobId: null,
    currentWorkflowId: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,

    run: async (workflow, override) => {
      if (get().runState === 'running' || get().runState === 'paused') return
      cancelRequested = false
      waitResolve = null
      whileResolve = null
      activeJobId = null
      overrideUsed = false
      overrideImage = override ?? null
      outputs.clear()

      logger.info(`Run started: ${workflow.name}`)
      set({
        runState: 'running',
        nodeStates: Object.fromEntries(workflow.nodes.map((n) => [n.id, 'pending' as NodeState])),
        nodeProgress: {},
        activeNodeId: null,
        currentJobId: null,
        currentWorkflowId: workflow.id,
        startedAt: Date.now(),
        finishedAt: null,
        lastError: null
      })

      const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
      const edges = workflow.edges

      // ─── Preflight: fail fast with all configuration issues at once ──────
      const issues: string[] = []
      let overrideAvailable = !!override
      for (const node of workflow.nodes) {
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
          const ext = getExtensionById(String(params.extensionId ?? ''))
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
      if (issues.length > 0) {
        for (const issue of issues) logger.error(`preflight: ${issue}`)
        set({
          runState: 'failed',
          lastError: issues.join('；'),
          finishedAt: Date.now(),
          nodeStates: Object.fromEntries(workflow.nodes.map((n) => [n.id, 'pending' as NodeState]))
        })
        return
      }

      const order = topoSort(workflow.nodes, edges)
      const executed = new Set<string>()

      // Nodes owned by a While container run inside the loop only.
      const whileOwned = new Set<string>()
      for (const n of workflow.nodes) {
        if (n.type !== 'whileNode') continue
        for (const b of whileBodyNodes(n, workflow.nodes)) whileOwned.add(b.id)
      }

      try {
        for (const id of order) {
          if (cancelRequested) throw new Cancelled()
          if (executed.has(id)) continue
          const node = nodeMap.get(id)
          if (!node) continue
          if (whileOwned.has(id)) continue

          if (isLoopStarter(node.type)) {
            setNodeState(id, 'running')
            const label = node.data.label
            const upstream = findUpstream(id, edges)
            if (upstream) outputs.set(id, upstream)

            // While container: body = nodes inside the frame. Fall back to the
            // edge-dominated segment for legacy workflows wired via connections.
            const segment =
              node.type === 'whileNode'
                ? whileBodyNodes(node, workflow.nodes).length > 0
                  ? whileBodyNodes(node, workflow.nodes)
                  : loopSegment(id, nodeMap, edges)
                : loopSegment(id, nodeMap, edges)
            const segOrder = topoSort(segment, edges)

            const runBodyOnce = async (): Promise<void> => {
              for (const sid of segOrder) {
                const segNode = nodeMap.get(sid)
                if (!segNode) continue
                await execNode(segNode, edges)
                executed.add(sid)
              }
            }

            if (node.type === 'forEachNode') {
              // For Each: iterate over files in a workspace dir (mode=image/text)
              // or a comma-separated item list (legacy). Each iteration emits the
              // current file as this node's output for body nodes to consume.
              const mode = String(node.data.params.mode ?? 'image')
              const dir = String(node.data.params.dir ?? '')
              let files: string[] = []
              if (dir) {
                try {
                  files = await listDirFiles(dir, mode === 'text' ? 'txt,md,json,csv' : 'png,jpg,jpeg,webp')
                } catch {
                  files = []
                }
              }
              if (files.length === 0) {
                files = String(node.data.params.items ?? '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              }
              const iterations = Math.max(1, files.length)
              for (let i = 0; i < iterations; i++) {
                if (cancelRequested) throw new Cancelled()
                if (files.length > 0) {
                  const url = files[i % files.length]
                  if (mode === 'text') {
                    const res = await fetch(fullUrl(url))
                    outputs.set(id, { type: 'text', text: await res.text() })
                  } else {
                    const file = await urlToFile(url, url.split('/').pop() ?? 'input.png')
                    outputs.set(id, { type: 'image', file })
                  }
                }
                logger.info(`${label}: iteration ${i + 1}/${iterations} (${files[i % Math.max(1, files.length)] ?? ''})`)
                await runBodyOnce()
              }
            } else {
              // While: auto mode runs `iterations` times, then — and in manual
              // mode (iterations empty / 0) immediately — pauses on the node for
              // Continue (proceed) / Retry (run the body once more), Modly parity.
              const iterations = Number(node.data.params.iterations ?? 0)
              const manual = !(iterations >= 1)
              if (!manual) {
                for (let i = 0; i < iterations; i++) {
                  if (cancelRequested) throw new Cancelled()
                  logger.info(`${label}: iteration ${i + 1}/${iterations}`)
                  await runBodyOnce()
                }
              }
              for (;;) {
                if (cancelRequested) throw new Cancelled()
                setNodeState(id, 'waiting')
                set({ runState: 'paused', activeNodeId: id })
                logger.info(`${label}: paused — Continue 或 Retry`)
                const action = await new Promise<'continue' | 'retry'>((resolve) => {
                  whileResolve = resolve
                })
                whileResolve = null
                if (cancelRequested) throw new Cancelled()
                set({ runState: 'running' })
                if (action === 'continue') break
                logger.info(`${label}: retry — re-running loop body`)
                await runBodyOnce()
              }
            }
            setNodeState(id, 'succeeded')
            executed.add(id)
          } else {
            await execNode(node, edges)
            executed.add(id)
          }
        }

        // Mark unexecuted nodes as skipped (e.g. behind a failed branch).
        set((s) => {
          const states = { ...s.nodeStates }
          for (const n of workflow.nodes) {
            if (states[n.id] === 'pending') states[n.id] = 'skipped'
          }
          return { nodeStates: states }
        })

        set({ runState: 'succeeded', activeNodeId: null, finishedAt: Date.now() })
        logger.info('Run succeeded')
      } catch (e) {
        if (e instanceof Cancelled) {
          set({ runState: 'cancelled', activeNodeId: null, finishedAt: Date.now() })
          logger.warn('Run cancelled')
        } else {
          const message = e instanceof Error ? e.message : String(e)
          set({
            runState: 'failed',
            activeNodeId: null,
            finishedAt: Date.now(),
            lastError: message
          })
          logger.error(`Run failed: ${message}`)
          const active = get().activeNodeId
          if (active) setNodeState(active, 'failed')
        }
        set((s) => {
          const states = { ...s.nodeStates }
          for (const n of workflow.nodes) {
            if (states[n.id] === 'pending') states[n.id] = 'skipped'
          }
          return { nodeStates: states }
        })
      } finally {
        activeJobId = null
        overrideImage = null
      }
    },

    cancel: async () => {
      cancelRequested = true
      if (waitResolve) waitResolve('cancel')
      if (whileResolve) whileResolve('continue')
      if (activeJobId) await cancelJob(activeJobId).catch(() => undefined)
    },

    continueRun: () => {
      if (waitResolve) waitResolve('continue')
    },

    continueWhile: () => {
      if (whileResolve) whileResolve('continue')
    },

    retryWhile: () => {
      if (whileResolve) whileResolve('retry')
    },

    reset: () => {
      cancelRequested = true
      if (waitResolve) waitResolve('cancel')
      if (whileResolve) whileResolve('continue')
      whileResolve = null
      set({
        runState: 'idle',
        nodeStates: {},
        nodeProgress: {},
        activeNodeId: null,
        currentJobId: null,
        currentWorkflowId: null,
        startedAt: null,
        finishedAt: null,
        lastError: null
      })
    }
  }
})
