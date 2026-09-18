/**
 * 工作流运行器的模块级运行态。
 *
 * 同一时刻只允许跑一个工作流，所有可变状态都挂在 `rt` 这一个对象上——
 * 这样引擎与各个 helper 可以共享它，而不需要重新赋值任何 import 进来的绑定
 * （ESM 的导入绑定是只读的，无法像 CommonJS 那样整体替换）。
 */

// ─── 工作流运行器：模块级运行态 ──────────────────────────────────────────────
// 一次只跑一个工作流。所有可变状态都挂在这个对象上，以便 helper 与引擎共享，
// 而无需重新赋值 import 进来的绑定。

import { DISPATCHER_PARAM, OUT_HANDLE, type WFEdge, type WFNode } from '../../types'
import type { NodeOutput } from './types'

/** 本次运行的共享可变状态；`run()` 开头会逐字段重置。 */
export const rt = {
  cancelRequested: false,
  waitResolve: null as ((action: 'continue' | 'cancel') => void) | null,
  // While 容器（手动模式）的暂停/续跑标志——由 continueWhile()/retryWhile() 设置。
  whileResolve: null as ((action: 'continue' | 'retry') => void) | null,
  // 断点 / 单步 / 手动暂停的统一闸门：暂停时挂在这里等待 继续 或 单步。
  pauseGateResolve: null as ((action: 'continue' | 'step') => void) | null,
  pauseRequested: false,
  stepOnce: false,
  /** 本次运行中已经命中过、不再重复触发的断点节点。 */
  bpConsumed: new Set<string>(),
  activeJobId: null as string | null,
  overrideImage: null as File | null,
  overrideUsed: false,
  outputs: new Map<string, NodeOutput>(),
  /** 多输出节点的按 handle 输出（key = `${nodeId}::${handle}`）；主输出仍在 outputs。 */
  outputsByHandle: new Map<string, NodeOutput>(),
  /** 运行期变量：变量名 → 文本值。Get/Set 节点靠名字跨节点读写（工作流级作用域）。 */
  vars: new Map<string, string>(),
  /** 事件分发器绑定表：分发器名 → 已登记的 Bind 节点 id（按登记顺序）。 */
  boundDispatchers: new Map<string, string[]>(),
  /** 由 run() 装配的「任意（子）图执行器」：execNode 需要它来内联执行子图内部。 */
  innerGraphRunner: null as ((nodes: WFNode[], edges: WFEdge[], depth: number) => Promise<void>) | null
}

/** 写入节点产物。无 handle 或 handle 为主输出时进 `outputs`，否则进 `outputsByHandle`。 */
export function storeOutput(nodeId: string, handle: string | null | undefined, out: NodeOutput | undefined): void {
  if (!out) return
  if (!handle || handle === OUT_HANDLE) rt.outputs.set(nodeId, out)
  else rt.outputsByHandle.set(`${nodeId}::${handle}`, out)
}

/** 读取节点产物，分流规则与 {@link storeOutput} 一致。 */
export function readOutput(nodeId: string, handle: string | null | undefined): NodeOutput | undefined {
  if (!handle || handle === OUT_HANDLE) return rt.outputs.get(nodeId)
  return rt.outputsByHandle.get(`${nodeId}::${handle}`)
}

/** 把图里所有 Bind 节点登记到同名事件分发器上（声明式绑定，一次运行内幂等）。 */
export function registerDispatchers(nodes: WFNode[]): void {
  for (const n of nodes) {
    if (n.type !== 'eventBindNode') continue
    const name = String(n.data?.params?.[DISPATCHER_PARAM] ?? '').trim()
    if (!name) continue
    const list = rt.boundDispatchers.get(name) ?? []
    if (!list.includes(n.id)) list.push(n.id)
    rt.boundDispatchers.set(name, list)
  }
}
