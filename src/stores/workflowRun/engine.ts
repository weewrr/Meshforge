// ─── 工作流运行器：执行引擎 ──────────────────────────────────────────────────────
// 纯前端驱动的运行器，语义仿照节点图（node-graph）的执行模型：
//   * 拓扑序决定执行先后；
//   * Wait 节点会挂起运行并给出「继续」按钮（分支起点）；
//   * While / For Each 节点重复执行其支配的下游片段；
//   * 生成器节点调用后端任务 API，并把进度流式回传；
//   * 节点输出经 outputs 映射流向下游节点。
//
// 文件结构（原 1000+ 行单文件按依赖方向拆分，行为零变更）：
//   * engine.ts（本文件）—— 引擎装配：闸门/轮询/生命周期 action；
//   * engine-context.ts  —— 模块间共享的 EngineCtx 类型；
//   * executors.ts       —— execNode：按节点类型分派的执行语义；
//   * runners.ts         —— 循环体 / 纯数据图 / exec 图三套调度器；
//   * preflight.ts       —— 运行前预检。

import { cancelJob, getJob } from '../../api'
import { VAR_NAME_PARAM, isExecEdge, type WFEdge, type WFNode } from '../../types'
import { useLogsStore } from '../logs'
import { getT } from '../../i18n'
import type { EngineCtx, EngineSet, EngineGet } from './engine-context'
import { execNode as execNodeImpl } from './executors'
import { Cancelled, sleep } from './helpers'
import { readOutput, rt } from './runtime'
import { collectPreflightIssues } from './preflight'
import { runDataGraphOn, runExecGraphOn } from './runners'
import type { NodeOutput, NodeState, WorkflowRunState } from './types'
import { MAX_GRAPH_DEPTH } from './types'

/** run() 装配的执行接口（与 store 的其他 state 字段合并成 WorkflowRunState）。 */
export type RunEngine = Pick<
  WorkflowRunState,
  'run' | 'cancel' | 'continueRun' | 'pause' | 'stepOver' | 'continueWhile' | 'retryWhile' | 'reset'
>

/**
 * 创建执行引擎：把跑一次工作流所需的全套动作挂到 zustand store 上。
 *
 * @param set store 的 setState（写状态）
 * @param get store 的 getState（读状态，用于读取最新 activeNodeId 等）
 * @returns 与运行相关的 8 个 action
 */
export function createEngine(set: EngineSet, get: EngineGet): RunEngine {
  // 日志 store 的实例在引擎创建时就取好：它是 zustand 全局单例，无需每次重新获取。
  const logger = useLogsStore.getState()

  /** 只改单个节点的运行态（pending/running/succeeded/failed/skipped/waiting）。 */
  function setNodeState(id: string, state: NodeState): void {
    set((s) => ({ nodeStates: { ...s.nodeStates, [id]: state } }))
  }

  /** 记录循环迭代进度：节点上显示 "index/total"，并供 Index 数据输出使用。 */
  function setNodeIter(id: string, index: number, total: number): void {
    set((s) => ({ nodeIter: { ...s.nodeIter, [id]: { index, total } } }))
  }

  /** 沿入边找该节点的第一个上游输出；找不到返回 undefined（调用方自行决定是否报错）。 */
  function findUpstream(nodeId: string, edges: WFEdge[]): NodeOutput | undefined {
    for (const e of edges) {
      if (e.target !== nodeId) continue
      const out = readOutput(e.source, e.sourceHandle)
      if (out) return out
    }
    return undefined
  }

  /**
   * 轮询后端任务直到终态，并同步把进度写进 nodeProgress。
   *
   * @param jobId 后端返回的任务 id
   * @param nodeId 归属节点（用于把进度渲染到该节点上）
   * @param label 节点标题（仅用于日志文案）
   * @returns 成功时的结果网格 URL；失败/取消则抛异常
   */
  async function pollJob(jobId: string, nodeId: string, label: string): Promise<string> {
    for (;;) {
      // 取消优先于本轮轮询：先把后端任务也撤掉，再抛 Cancelled 让上层统一收尾。
      if (rt.cancelRequested) {
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

  /**
   * 断点 / 单步 / 手动暂停的统一闸门：在执行一个节点之前，按需把运行挂起。
   * 暂停后由 continueRun()（继续到底）或 stepOver()（只走一个节点）放行。
   */
  async function gate(node: WFNode): Promise<void> {
    const bp = !!node.data?.params?.breakpoint
    const wantPause = rt.pauseRequested || rt.stepOnce || (bp && !rt.bpConsumed.has(node.id))
    if (!wantPause) return
    rt.pauseRequested = false
    rt.stepOnce = false
    // 同一个断点在一次运行里只停一次，否则恢复后会立刻再次命中。
    if (bp) rt.bpConsumed.add(node.id)
    setNodeState(node.id, 'waiting')
    set({ runState: 'paused', activeNodeId: node.id, pausedAt: node.id })
    logger.info(getT('workflows.runLog.paused', { label: node.data.label }))
    // 挂起在这里等 UI 放行；resolve 函数被存到 rt.pauseGateResolve 供 stepOver/continueRun 调用。
    const action = await new Promise<'continue' | 'step'>((resolve) => {
      rt.pauseGateResolve = resolve
    })
    rt.pauseGateResolve = null
    if (rt.cancelRequested) throw new Cancelled()
    // 「单步」放行后要立刻把 stepOnce 重置回 true，让下一个节点再次命中闸门。
    if (action === 'step') rt.stepOnce = true
    set({ runState: 'running', pausedAt: null })
  }

  // 拆分模块共享的上下文：execNode 通过它递归（见 engine-context.ts 的说明）。
  function execNodeLocal(node: WFNode, edges: WFEdge[], depth = 0): Promise<void> {
    return execNodeImpl(ctx, node, edges, depth)
  }
  const ctx: EngineCtx = {
    set,
    get,
    logger,
    setNodeState,
    setNodeIter,
    findUpstream,
    pollJob,
    gate,
    execNode: execNodeLocal
  }

  return {
    /**
     * 启动一次运行。
     *
     * @param workflow 要执行的工作流快照
     * @param override 可选的覆盖图片：替换图中第一个 imageNode 的输入（只生效一次）
     */
    run: async (workflow, override) => {
      // 运行中/暂停中一律忽略重复启动，避免两套执行流并行写同一份 outputs。
      if (get().runState === 'running' || get().runState === 'paused') return
      rt.cancelRequested = false
      rt.waitResolve = null
      rt.whileResolve = null
      rt.pauseGateResolve = null
      rt.pauseRequested = false
      rt.stepOnce = false
      rt.bpConsumed.clear()
      rt.activeJobId = null
      rt.overrideUsed = false
      rt.overrideImage = override ?? null
      rt.outputs.clear()
      rt.outputsByHandle.clear()
      rt.vars.clear()
      rt.boundDispatchers.clear()

      // 变量初始化：由 Set 节点声明的 default 预置，供尚未执行到的 Get 读取。
      for (const n of workflow.nodes) {
        if (n.type !== 'variableSetNode') continue
        const name = String(n.data.params?.[VAR_NAME_PARAM] ?? '').trim()
        if (name && n.data.params?.default !== undefined) rt.vars.set(name, String(n.data.params.default))
      }

      logger.info(`Run started: ${workflow.name}`)
      set({
        runState: 'running',
        nodeStates: Object.fromEntries(workflow.nodes.map((n) => [n.id, 'pending' as NodeState])),
        nodeProgress: {},
        nodeIter: {},
        activeNodeId: null,
        pausedAt: null,
        currentJobId: null,
        currentWorkflowId: workflow.id,
        startedAt: Date.now(),
        finishedAt: null,
        lastError: null
      })

      const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
      const edges = workflow.edges

      // ─── 预检：一次性收集所有配置问题，尽早失败 ────────────────────────────
      const issues = collectPreflightIssues(workflow.nodes, edges, !!override, logger)
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

      // 任意（子）图执行器：execNode 在处理 subgraphNode 时回调它内联执行函数体。
      rt.innerGraphRunner = async (nodes, graphEdges, depth) => {
        if (depth > MAX_GRAPH_DEPTH) {
          logger.warn(getT('workflows.runLog.depthExceeded', { depth: MAX_GRAPH_DEPTH }))
          return
        }
        const map = new Map(nodes.map((n) => [n.id, n]))
        const exec = (node: WFNode, eds: WFEdge[]): Promise<void> => execNodeLocal(node, eds, depth)
        // 子图是否含 exec 边，决定用哪套调度器——与主图判定规则保持一致。
        if (graphEdges.some((e) => isExecEdge(e.sourceHandle, e.targetHandle))) {
          await runExecGraphOn(ctx, nodes, graphEdges, map, exec)
        } else {
          await runDataGraphOn(ctx, nodes, graphEdges, map, exec)
        }
      }

      const hasExec = edges.some((e) => isExecEdge(e.sourceHandle, e.targetHandle))

      try {
        if (hasExec) await runExecGraphOn(ctx, workflow.nodes, edges, nodeMap, (n, eds) => execNodeLocal(n, eds, 0))
        else await runDataGraphOn(ctx, workflow.nodes, edges, nodeMap, (n, eds) => execNodeLocal(n, eds, 0))

        // 把没被执行的节点标记为跳过（例如落在未走到的分支后面）。
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
          // 把当前节点标成失败态，UI 上能直接定位到出错的那一步。
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
        // 无论成功/失败/取消，都要清掉"随本次运行而生"的临时状态，防止串到下一次运行。
        rt.activeJobId = null
        rt.overrideImage = null
        rt.innerGraphRunner = null
        rt.pauseGateResolve = null
        rt.pauseRequested = false
        rt.stepOnce = false
      }
    },

    /** 请求取消当前运行：唤醒所有挂起点，并撤销后端正在跑的任务。 */
    cancel: async () => {
      rt.cancelRequested = true
      if (rt.waitResolve) rt.waitResolve('cancel')
      // While 的挂起没有"取消"语义，用 'continue' 让它退出循环等待。
      if (rt.whileResolve) rt.whileResolve('continue')
      if (rt.pauseGateResolve) rt.pauseGateResolve('continue')
      if (rt.activeJobId) await cancelJob(rt.activeJobId).catch(() => undefined)
    },

    /** 从挂起处继续执行到底。 */
    continueRun: () => {
      if (rt.waitResolve) rt.waitResolve('continue')
      if (rt.pauseGateResolve) rt.pauseGateResolve('continue')
    },

    /** 请求在下一次闸门处暂停（对正在跑的节点不生效，只在节点边界生效）。 */
    pause: () => {
      if (get().runState !== 'running') return
      rt.pauseRequested = true
    },

    /** 单步：放行当前挂起的闸门，并让下一个节点再次命中暂停。 */
    stepOver: () => {
      if (!rt.pauseGateResolve) return
      rt.pauseGateResolve('step')
    },

    /** While 的人工循环：再跑一轮循环体。 */
    continueWhile: () => {
      if (rt.whileResolve) rt.whileResolve('continue')
    },

    /** While 的人工循环：重跑一轮循环体（与 continue 的区别仅在日志语义）。 */
    retryWhile: () => {
      if (rt.whileResolve) rt.whileResolve('retry')
    },

    /** 复位到空闲态：取消进行中的运行并清空全部运行期状态。 */
    reset: () => {
      rt.cancelRequested = true
      if (rt.waitResolve) rt.waitResolve('cancel')
      if (rt.whileResolve) rt.whileResolve('continue')
      if (rt.pauseGateResolve) rt.pauseGateResolve('continue')
      rt.whileResolve = null
      rt.bpConsumed.clear()
      set({
        runState: 'idle',
        nodeStates: {},
        nodeProgress: {},
        nodeIter: {},
        activeNodeId: null,
        pausedAt: null,
        currentJobId: null,
        currentWorkflowId: null,
        startedAt: null,
        finishedAt: null,
        lastError: null
      })
    }
  }
}
