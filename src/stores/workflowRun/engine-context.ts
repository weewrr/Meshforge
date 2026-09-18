/**
 * 工作流执行引擎的模块间上下文类型。
 *
 * engine.ts 原本是一个 1000+ 行的单文件闭包，拆分为 executors / runners /
 * preflight 三个模块后，原先闭包共享的 set/get/辅助函数统一收敛为
 * `EngineCtx` 一个参数对象——各模块只依赖这个接口，不直接 import engine，
 * 从而保持依赖方向单向（engine → executors/runners/preflight）。
 */

import type { StoreApi } from 'zustand'
import type { WFEdge, WFNode } from '../../types'
import type { NodeOutput, NodeState, WorkflowRunState } from './types'

/** store 的 setState。 */
export type EngineSet = StoreApi<WorkflowRunState>['setState']
/** store 的 getState。 */
export type EngineGet = StoreApi<WorkflowRunState>['getState']

/** 执行引擎共用的日志接口（与 useLogsStore 的方法签名结构兼容）。 */
export interface EngineLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * executors / runners / preflight 共享的引擎上下文。
 * 字段语义与原 engine.ts 闭包内的同名局部函数完全一致。
 */
export interface EngineCtx {
  set: EngineSet
  get: EngineGet
  logger: EngineLogger
  /** 只改单个节点的运行态（pending/running/succeeded/failed/skipped/waiting）。 */
  setNodeState(id: string, state: NodeState): void
  /** 记录循环迭代进度：节点上显示 "index/total"，并供 Index 数据输出使用。 */
  setNodeIter(id: string, index: number, total: number): void
  /** 沿入边找该节点的第一个上游输出；找不到返回 undefined。 */
  findUpstream(nodeId: string, edges: WFEdge[]): NodeOutput | undefined
  /** 轮询后端任务直到终态，成功返回结果网格 URL，失败/取消抛异常。 */
  pollJob(jobId: string, nodeId: string, label: string): Promise<string>
  /** 断点 / 单步 / 手动暂停的统一闸门。 */
  gate(node: WFNode): Promise<void>
  /** 执行单个节点（executors 自递归与 runners 回调共用入口）。 */
  execNode(node: WFNode, edges: WFEdge[], depth?: number): Promise<void>
}
