/**
 * 工作流运行器：图调度器。
 *
 * 从 engine.ts 原样迁出的三套调度循环（行为零变更）：
 *   * `runLoopOn`      —— 循环节点（For Each / While）的循环体片段执行；
 *   * `runDataGraphOn` —— 纯数据路径（旧版线性拓扑，兼容历史工作流）；
 *   * `runExecGraphOn` —— exec 驱动路径（白色 exec 边决定流转顺序）。
 *
 * 所有 store/闭包依赖经 `EngineCtx` 注入；节点执行通过 `exec` 回调传入。
 */

import { fullUrl, listDirFiles } from '../../api'
import {
  DISPATCHER_PARAM,
  EXEC_FALSE_HANDLE,
  EXEC_OUT_HANDLE,
  EXEC_TRUE_HANDLE,
  ITER_INDEX_HANDLE,
  SUBGRAPH_INPUT_NODE,
  SUBGRAPH_OUTPUT_NODE,
  isExecEdge,
  isExecIn,
  isExecNode,
  isLoopStarter,
  type WFEdge,
  type WFNode
} from '../../types'
import type { EngineCtx } from './engine-context'
import { Cancelled, loopSegment, topoSort, urlToFile, whileBodyNodes } from './helpers'
import { readOutput, registerDispatchers, rt, storeOutput } from './runtime'
import type { NodeOutput } from './types'

/**
 * 公共：执行循环节点的循环体片段（按次数 / 按文件遍历）。
 * 参数化到任意（子）图：主图与子图内部的循环都用同一套语义。
 */
export async function runLoopOn(
  ctx: EngineCtx,
  node: WFNode,
  allNodes: WFNode[],
  allEdges: WFEdge[],
  nodeMapLocal: Map<string, WFNode>,
  runBody: (sid: string, sn: WFNode) => Promise<void>
): Promise<void> {
  const { set, logger, setNodeIter, setNodeState } = ctx
  const id = node.id
  const label = node.data.label
  // While 优先用它自己声明的循环体集合；声明为空时回退到按拓扑支配关系推断。
  const segment =
    node.type === 'whileNode'
      ? whileBodyNodes(node, allNodes).length > 0
        ? whileBodyNodes(node, allNodes)
        : loopSegment(id, nodeMapLocal, allEdges)
      : loopSegment(id, nodeMapLocal, allEdges)
  const segOrder = topoSort(segment, allEdges)
  const runBodyOnce = async (): Promise<void> => {
    for (const sid of segOrder) {
      const sn = nodeMapLocal.get(sid)
      if (!sn) continue
      await runBody(sid, sn)
    }
  }
  if (node.type === 'forEachNode') {
    // For Each：遍历工作区目录里的文件，或回退到逗号分隔的字面量列表。
    const mode = String(node.data.params.mode ?? 'image')
    const dir = String(node.data.params.dir ?? '')
    let files: string[] = []
    if (dir) {
      try {
        files = await listDirFiles(dir, mode === 'text' ? 'txt,md,json,csv' : 'png,jpg,jpeg,webp')
      } catch {
        // 目录不可读（不存在 / 越权）时静默降级到字面量列表，而不是让整次运行失败。
        files = []
      }
    }
    if (files.length === 0) {
      files = String(node.data.params.items ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    }
    // 空列表也要跑一轮：让循环体内"无输入"的路径至少被执行一次。
    const iterations = Math.max(1, files.length)
    for (let i = 0; i < iterations; i++) {
      if (rt.cancelRequested) throw new Cancelled()
      setNodeIter(id, i + 1, iterations)
      // Index 输出：当前迭代下标（0 起），可接到数值/文本节点上。
      storeOutput(id, ITER_INDEX_HANDLE, { type: 'text', text: String(i) })
      if (files.length > 0) {
        // 用取模兜底，保证 files 非空时下标永不越界。
        const url = files[i % files.length]
        if (mode === 'text') {
          const res = await fetch(fullUrl(url))
          rt.outputs.set(id, { type: 'text', text: await res.text() })
        } else {
          const file = await urlToFile(url, url.split('/').pop() ?? 'input.png')
          rt.outputs.set(id, { type: 'image', file })
        }
      }
      logger.info(`${label}: iteration ${i + 1}/${iterations} (${files[i % Math.max(1, files.length)] ?? ''})`)
      await runBodyOnce()
    }
  } else {
    // While：auto 模式按 `iterations` 次数自动跑；manual（0/空）则挂起等
    // Continue / Retry 指令。
    const iterations = Number(node.data.params.iterations ?? 0)
    const manual = !(iterations >= 1)
    if (!manual) {
      for (let i = 0; i < iterations; i++) {
        if (rt.cancelRequested) throw new Cancelled()
        setNodeIter(id, i + 1, iterations)
        storeOutput(id, ITER_INDEX_HANDLE, { type: 'text', text: String(i) })
        logger.info(`${label}: iteration ${i + 1}/${iterations}`)
        await runBodyOnce()
      }
    }
    // manual 模式（以及 auto 跑完后的收尾）统一进这个挂起循环，等用户决定。
    for (;;) {
      if (rt.cancelRequested) throw new Cancelled()
      setNodeState(id, 'waiting')
      set({ runState: 'paused', activeNodeId: id })
      logger.info(`${label}: paused — Continue 或 Retry`)
      const action = await new Promise<'continue' | 'retry'>((resolve) => {
        rt.whileResolve = resolve
      })
      rt.whileResolve = null
      if (rt.cancelRequested) throw new Cancelled()
      set({ runState: 'running' })
      if (action === 'continue') break
      logger.info(`${label}: retry — re-running loop body`)
      await runBodyOnce()
    }
  }
}

/** 纯数据路径（旧版线性拓扑，用于兼容历史工作流）。 */
export async function runDataGraphOn(
  ctx: EngineCtx,
  allNodes: WFNode[],
  allEdges: WFEdge[],
  nodeMapLocal: Map<string, WFNode>,
  exec: (node: WFNode, edges: WFEdge[]) => Promise<void>
): Promise<void> {
  const { setNodeState, findUpstream } = ctx
  const order = topoSort(allNodes, allEdges)
  const executed = new Set<string>()
  registerDispatchers(allNodes)
  // 先算出所有 While 的循环体成员，把它们从主拓扑里摘出去，避免重复执行。
  const whileOwned = new Set<string>()
  for (const n of allNodes) {
    if (n.type !== 'whileNode') continue
    for (const b of whileBodyNodes(n, allNodes)) whileOwned.add(b.id)
  }
  for (const id of order) {
    if (rt.cancelRequested) throw new Cancelled()
    if (executed.has(id)) continue
    const node = nodeMapLocal.get(id)
    if (!node) continue
    if (whileOwned.has(id)) continue
    // 子图挂点占位节点没有执行逻辑，跳过（其值已在进入子图时预先注入）。
    if (node.type === SUBGRAPH_INPUT_NODE || node.type === SUBGRAPH_OUTPUT_NODE) {
      executed.add(id)
      continue
    }
    if (isLoopStarter(node.type)) {
      setNodeState(id, 'running')
      const upstream = findUpstream(id, allEdges)
      if (upstream) rt.outputs.set(id, upstream)
      await runLoopOn(ctx, node, allNodes, allEdges, nodeMapLocal, async (sid, sn) => {
        await exec(sn, allEdges)
        executed.add(sid)
      })
      setNodeState(id, 'succeeded')
      executed.add(id)
    } else {
      await exec(node, allEdges)
      executed.add(id)
    }
  }
}

/** exec 驱动路径：白色 exec 边决定流转顺序，数据边只负责喂值。 */
export async function runExecGraphOn(
  ctx: EngineCtx,
  allNodes: WFNode[],
  allEdges: WFEdge[],
  nodeMapLocal: Map<string, WFNode>,
  exec: (node: WFNode, edges: WFEdge[]) => Promise<void>
): Promise<void> {
  const { logger, setNodeState, gate } = ctx
  const executed = new Set<string>()
  // Bind 是声明节点：进入这个图就先全部登记，等 Call 触发其链路。
  registerDispatchers(allNodes)

  const findUpstreamOn = (nodeId: string): NodeOutput | undefined => {
    for (const e of allEdges) {
      if (e.target !== nodeId) continue
      const out = readOutput(e.source, e.sourceHandle)
      if (out) return out
    }
    return undefined
  }

  const resolveBranchOn = (node: WFNode): boolean => {
    const up = findUpstreamOn(node.id)
    if (up) {
      const v = up.text ?? up.file ?? up.url
      if (v !== undefined) {
        // 真值字面量白名单：'yes'/'1' 也算真，空串明确算假。
        const tgt = String(v).trim().toLowerCase()
        if (tgt === 'true' || tgt === '1' || tgt === 'yes') return true
        if (tgt === 'false' || tgt === '0' || tgt === 'no' || tgt === '') return false
        return !!v
      }
    }
    // 无上游数据时退回节点上的手填条件。
    return !!node.data.params?.condition
  }

  /** 递归拉取该节点所有非 exec 上游的数据（数据节点由这里被间接带动执行）。 */
  const ensureDataInputs = async (nodeId: string): Promise<void> => {
    for (const e of allEdges) {
      if (e.target !== nodeId) continue
      if (isExecEdge(e.sourceHandle, e.targetHandle)) continue
      const src = nodeMapLocal.get(e.source)
      if (!src) continue
      if (isExecNode(src.type)) continue // 流程节点由 exec 调度，不在此被动触发
      await executeNode(e.source)
    }
  }

  const executeNode = async (id: string): Promise<void> => {
    if (executed.has(id)) return
    const node = nodeMapLocal.get(id)
    if (!node) return
    if (rt.cancelRequested) throw new Cancelled()
    // Bind 是声明节点：不占用执行流，只在 Call 触发时驱动其后续链路。
    if (node.type === 'eventBindNode') {
      executed.add(id)
      return
    }
    await ensureDataInputs(id)

    if (!isExecNode(node.type)) {
      await exec(node, allEdges)
      executed.add(id)
      return
    }

    // 断点 / 单步 / 手动暂停只对"流程节点"生效（数据节点由 exec 调度间接带上）。
    await gate(node)

    // 默认从唯一的 exec 输出口往下走；Branch/Sequence 会改写这个出口列表。
    let outs: string[] = [EXEC_OUT_HANDLE]
    if (node.type === 'branchNode') {
      setNodeState(id, 'running')
      const cond = resolveBranchOn(node)
      logger.info(`${node.data.label}: branch → ${cond ? 'True' : 'False'}`)
      outs = [cond ? EXEC_TRUE_HANDLE : EXEC_FALSE_HANDLE]
      setNodeState(id, 'succeeded')
    } else if (node.type === 'sequenceNode') {
      setNodeState(id, 'running')
      // 出口数夹在 1..16：既防 0（无出口=断流）也防手填超大值撑爆画布。
      const n = Math.max(1, Math.min(16, Number(node.data.params?.outputs ?? 2) || 2))
      outs = Array.from({ length: n }, (_, i) => `exec-${i}`)
      setNodeState(id, 'succeeded')
    } else if (isLoopStarter(node.type)) {
      setNodeState(id, 'running')
      const upstream = findUpstreamOn(id)
      if (upstream) rt.outputs.set(id, upstream)
      await runLoopOn(ctx, node, allNodes, allEdges, nodeMapLocal, async (sid) => {
        await executeNode(sid)
      })
      setNodeState(id, 'succeeded')
    } else {
      // wait / set / call / bind：沿用 execNode 的语义（含暂停与事件登记）。
      await exec(node, allEdges)
    }
    executed.add(id)

    // 事件分发器：Call 触发时，把已 Bind 到同名分发器的链路的后续节点一并执行。
    const extra: string[] = []
    if (node.type === 'eventCallNode') {
      const name = String(node.data.params?.[DISPATCHER_PARAM] ?? '').trim()
      const binds = name ? rt.boundDispatchers.get(name) ?? [] : []
      if (binds.length === 0) logger.warn(`${node.data.label}: 事件 '${name}' 没有任何 Bind 绑定`)
      for (const bindId of binds) {
        for (const e of allEdges) {
          if (e.source !== bindId || e.sourceHandle !== EXEC_OUT_HANDLE) continue
          extra.push(e.target)
        }
      }
    }
    for (const h of outs) {
      for (const e of allEdges) {
        if (e.source !== id || e.sourceHandle !== h) continue
        if (!executed.has(e.target)) await executeNode(e.target)
      }
    }
    for (const t of extra) await executeNode(t)
  }

  // 入口：无 exec 入边的流程节点（可多个并行）。Bind 是声明节点，不作为入口。
  const roots = allNodes.filter(
    (n) =>
      isExecNode(n.type) &&
      n.type !== 'eventBindNode' &&
      !allEdges.some((e) => e.target === n.id && isExecIn(e.targetHandle))
  )
  for (const r of roots) await executeNode(r.id)

  // 兜底：未被 exec 链覆盖的数据节点（纯数据子图 / 旁路数据）按数据 DAG 顺序执行。
  const remaining = allNodes.filter((n) => !executed.has(n.id))
  if (remaining.length > 0) {
    for (const id of topoSort(remaining, allEdges)) {
      if (rt.cancelRequested) throw new Cancelled()
      if (executed.has(id)) continue
      await executeNode(id)
    }
  }
}
