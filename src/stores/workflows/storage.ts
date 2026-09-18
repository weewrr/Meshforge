/**
 * 仅前端本地的持久化：标签页顺序 + 上次打开的工作流。
 *
 * 这两项都属于"视觉状态"——后端按最近修改排序，并不关心标签顺序；但它们必须
 * 跨渲染进程崩溃重载存活（主进程会重载渲染进程），因此放在 localStorage
 * 而不是 store 内存里。
 */

// ─── 仅本地持久化：标签页顺序 + 上次打开的工作流 ─────────────────────────────

/** localStorage 键：标签页顺序。 */
const TAB_ORDER_KEY = 'meshforge.tabOrder'

/** localStorage 键：上次打开的工作流 id。
 *  用于让标签栏恢复到用户当时正在编辑的工作流，而不是列表里的第一个。 */
const LAST_WF_KEY = 'meshforge.lastWorkflowId'

/** 读取上次打开的工作流 id；存储不可用时返回 `null`。 */
export function loadLastWorkflowId(): string | null {
  try {
    return localStorage.getItem(LAST_WF_KEY)
  } catch {
    return null
  }
}

/** 记录上次打开的工作流 id。 */
export function saveLastWorkflowId(id: string): void {
  try {
    localStorage.setItem(LAST_WF_KEY, id)
  } catch {
    /* 存储不可用 —— 忽略，仅影响下次启动的恢复 */
  }
}

/** 清除"上次打开的工作流"。列表为空或目标已被删除时调用，避免恢复到不存在的工作流。 */
export function clearLastWorkflowId(): void {
  try {
    localStorage.removeItem(LAST_WF_KEY)
  } catch {
    /* 存储不可用 —— 忽略 */
  }
}

/** 读取标签页顺序；内容非法（非数组/元素非字符串）或存储不可用时返回空数组。 */
export function loadTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // 逐项校验类型：localStorage 里可能是旧版本或被外部改坏的数据。
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 持久化标签页顺序。 */
export function saveTabOrder(ids: string[]): void {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* 存储不可用 —— 顺序仅在本次会话内有效 */
  }
}

/** 按保存的标签顺序重排列表：顺序里已不存在的 id 忽略，未出现在顺序里的项追加到末尾。 */
export function applyTabOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items
  const byId = new Map(items.map((w) => [w.id, w]))
  const next: T[] = []
  for (const id of order) {
    const wf = byId.get(id)
    if (wf) {
      next.push(wf)
      // 取出后从 map 删除，剩下的就是"新出现、尚未排序"的项。
      byId.delete(id)
    }
  }
  next.push(...byId.values())
  return next
}
