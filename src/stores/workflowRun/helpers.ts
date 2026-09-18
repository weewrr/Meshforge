// ─── 工作流运行器：图结构 / 取值辅助 ──────────────────────────────────────────
/**
 * 运行器的图结构与取值辅助函数。
 *
 * 这里只放纯函数：拓扑排序、循环体判定、参数引脚解析、上游产物取值等。
 * 它们不持有状态（可变状态全部挂在 `runtime.ts` 的 `rt` 上），因此可以被
 * 执行引擎和 UI 的静态分析共同复用。
 */

import { fullUrl } from '../../api'
import {
  inputIndexForHandle,
  isBranchStarter,
  isContainerType,
  isExecEdge,
  isLoopStarter,
  paramIdFromHandle,
  type WFEdge,
  type WFNode,
  type WorkflowExtension
} from '../../types'
import { readOutput } from './runtime'
import { MV_VIEW_TAGS, type MvViewTag, type NodeOutput } from './types'

/** 用户取消运行时抛出。引擎在多个检查点捕获它，把运行态切到 `cancelled`。 */
export class Cancelled extends Error {}

/** 可被取消打断的等待。粒度要短——每轮循环都要重新检查取消标志。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 判断一个输出是否为"空值"（无任何数据），供 Select 的 auto 模式挑选首个有数据输入。 */
export function isVoidOutput(out: NodeOutput | undefined): boolean {
  if (!out) return true
  return !out.file && !out.url && !out.text && (!out.items || out.items.length === 0)
}

/** 把值按"类布尔"规则解析：`true`/`1`/`yes` 为真，`false`/`0`/`no`/空串为假，
 *  其余非空值回退到 JS 自身真值判断。 */
export function truthy(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  return !!v
}

/** 收集某节点所有数据输入（按 handle 下标对齐），用于布尔/数值/文本计算节点。 */
export function textInputs(nodeId: string, edges: WFEdge[]): string[] {
  const arr: string[] = []
  for (const e of edges) {
    if (e.target !== nodeId) continue
    // exec 引脚传递的是控制流而非数据，必须排除。
    if (isExecEdge(e.sourceHandle, e.targetHandle)) continue
    const idx = inputIndexForHandle(e.targetHandle)
    const out = readOutput(e.source, e.sourceHandle)
    arr[idx] = String(out?.text ?? '')
  }
  return arr
}

/**
 * Blueprint 风格参数引脚：把接到本节点 `p:<paramId>` 引脚上的上游文本输出，
 * 覆盖到对应的模型参数上（数值型从文本协调为数字）；未接线的参数保留内联值。
 */
export function resolveParamPins(
  node: WFNode,
  edges: WFEdge[],
  ext: WorkflowExtension
): Record<string, unknown> {
  const base = (node.data?.params ?? {}) as Record<string, unknown>
  const result: Record<string, unknown> = { ...base }
  for (const e of edges) {
    if (e.target !== node.id) continue
    const pid = paramIdFromHandle(e.targetHandle)
    // 不是参数引脚（例如执行流引脚）就跳过。
    if (!pid) continue
    const out = readOutput(e.source, e.sourceHandle)
    if (!out) continue
    const text = String(out.text ?? '')
    const schema = ext.params.find((p) => p.id === pid)
    if (schema && (schema.type === 'int' || schema.type === 'float')) {
      const n = Number(text)
      // 文本解析不出数字时回退到内联值，再回退到 schema 默认值，
      // 保证参数永远是个有效数字而不是 NaN。
      result[pid] = Number.isNaN(n) ? (base[pid] ?? schema.default) : n
    } else {
      result[pid] = text
    }
  }
  return result
}

/** 取节点的扩展 id。
 *  画布上的实时节点把 id 放在 `data.extensionId`，而部分已序列化的工作流会把它
 *  放在 `data.params.extensionId` 里；这里两处都查，避免运行器丢 id。 */
export function nodeExtensionId(node: WFNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>
  const p = (data.params ?? {}) as Record<string, unknown>
  return String(p.extensionId ?? data.extensionId ?? '')
}

/** Kahn 拓扑排序。剩余未入序的节点（理论上不该出现——画布禁止成环）按声明顺序
 *  追加到末尾，保证返回结果始终覆盖全部节点、不会漏项。 */
export function topoSort(nodes: WFNode[], edges: WFEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    // 忽略指向已删除节点的悬空连线。
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
  }
  // 入度为 0 的节点即起始集合。
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
  // 兜底：若有环导致未入序的节点，按声明顺序补齐。
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id)
  return order
}

/** 找出被某个循环起始节点"支配"的节点：从它出发正向可达，但遇到其它分支/循环
 *  起始节点就停止。这些就是每次迭代要重复执行的节点。 */
export function loopSegment(startId: string, nodeMap: Map<string, WFNode>, edges: WFEdge[]): WFNode[] {
  const result: WFNode[] = []
  const seen = new Set<string>([startId])
  const stack = [startId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const e of edges) {
      if (e.source !== id || seen.has(e.target)) continue
      seen.add(e.target)
      const type = nodeMap.get(e.target)?.type
      // 嵌套的分支/循环有自己的作用域，不纳入本层循环体。
      if (isBranchStarter(type) || isLoopStarter(type)) continue
      const node = nodeMap.get(e.target)
      if (node) result.push(node)
      stack.push(e.target)
    }
  }
  return result
}

// ─── While 容器几何（与 Modly 对齐） ─────────────────────────────────────────
// While 容器的循环体 = 显式以它为 parent 的节点，加上虽然未挂父级、
// 但中心点落在容器框内的节点（覆盖"在容器内点击面板添加"与"先有节点后拉大容器"
// 这两种情况）。

/** 取节点实际尺寸：优先用实测值，其次显式宽高，最后落到默认 200×80。 */
function nodeBox(n: WFNode): { w: number; h: number } {
  const styleW = n.style?.width
  const styleH = n.style?.height
  return {
    w: n.measured?.width ?? n.width ?? (typeof styleW === 'number' ? styleW : 200),
    h: n.measured?.height ?? n.height ?? (typeof styleH === 'number' ? styleH : 80)
  }
}

/** 计算 While 容器的循环体节点。 */
export function whileBodyNodes(w: WFNode, nodes: WFNode[]): WFNode[] {
  const { w: bw, h: bh } = nodeBox(w)
  const body: WFNode[] = []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (n.id === w.id) continue
    // 显式挂在容器下的节点直接算循环体成员。
    if (n.parentId === w.id) {
      body.push(n)
      continue
    }
    // 注释框只是"注解容器"，不构成结构层级：其成员仍然按绝对坐标参与循环体判定，
    // 否则给循环体加个注释框就会把里面的节点从循环体里"摘掉"。
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    const inComment = parent?.type === 'commentNode'
    // 挂在其它真实父级下的节点属于别的容器，跳过。
    if (n.parentId && !inComment) continue
    // 容器本身不嵌套计入循环体。
    if (isContainerType(n.type)) continue
    // 注释框内的节点坐标是相对注释框的，换算回绝对坐标再判定。
    const abs = inComment && parent ? { x: parent.position.x + n.position.x, y: parent.position.y + n.position.y } : n.position
    const { w: nw, h: nh } = nodeBox(n)
    const cx = abs.x + nw / 2
    const cy = abs.y + nh / 2
    // 以"节点中心是否落在容器框内"为准，避免只看左上角导致压边节点被误判。
    if (cx >= w.position.x && cx <= w.position.x + bw && cy >= w.position.y && cy <= w.position.y + bh) {
      body.push(n)
    }
  }
  return body
}

/**
 * 为四视角生成器（Hunyuan3D 2 MV）从上游节点解析这 4 张图。
 *
 * 上游可能是：旧式 图片节点（带 4 视角的 views，Generate 页变通路径），或
 * 新式 数组节点（多张顺序排列的图片）。数组节点时用节点上的 view_<tag>_index
 * 参数（外部映射）指明哪一项是 front/left/back/right；缺省时按顺序 0..3 取用。
 */
export function mvViewsFrom(node: WFNode, upstream: NodeOutput): { front: File; views: Partial<Record<MvViewTag, File>> } | null {
  const params = (node.data?.params ?? {}) as Record<string, unknown>
  if (upstream.type === 'image') {
    if (!upstream.file) return null
    return { front: upstream.file, views: upstream.views ?? {} }
  }
  if (upstream.type === 'array' && upstream.items && upstream.items.length > 0) {
    const arr = upstream.items
    // 按 tag 读外部映射参数；越界或非整数一律视为"未指定"。
    const itemAt = (tag: MvViewTag): File | undefined => {
      const n = Number(params[`view_${tag}_index`] ?? '')
      return Number.isInteger(n) && n >= 0 && n < arr.length ? arr[n] : undefined
    }
    // front 是必填项：没显式指定就用第一张。
    const front = itemAt('front') ?? arr[0]
    const views: Partial<Record<MvViewTag, File>> = {}
    for (const tag of MV_VIEW_TAGS) {
      const f = itemAt(tag)
      if (f) views[tag] = f
    }
    return { front, views }
  }
  return null
}

/** 把后端产物 URL 拉成一个 `File`，以便作为 multipart 字段继续提交。 */
export async function urlToFile(url: string, name: string): Promise<File> {
  const full = fullUrl(url)
  let res: Response
  try {
    // 用 no-store：同一资源通常此前已被 <img>（no-cors）加载过，缓存里留下的条目
    // 不含 CORS 校验信息；随后 cors 模式的 fetch 命中该缓存条目时会在完全不发
    // 网络请求的情况下直接失败。强制每次走网络重新校验。
    res = await fetch(full, { cache: 'no-store' })
  } catch (e) {
    // 把底层原因与请求地址一起抛出——单独的 "Failed to fetch" 无法定位问题。
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`urlToFile: ${why} (GET ${full})`)
  }
  if (!res.ok) throw new Error(`fetch input failed: ${res.status}`)
  const blob = await res.blob()
  // 部分后端不返回 Content-Type，导致 blob.type 为空，这里兜底成 image/png。
  return new File([blob], name, { type: blob.type || 'image/png' })
}
