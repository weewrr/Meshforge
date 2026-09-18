/**
 * 全局非侵入式提示（toast）store。
 *
 * 现状问题：用户的操作成败过去只能看底部日志面板（`logs` store），普通用户
 * 不常驻看那。这里提供一个轻量的全局提示条：`toast()` 触发，自动消失，
 * 成功/失败/警告/信息四类，带可选的操作按钮（如失败后的「重试」）。
 *
 * 设计：
 *  - 用 `useSyncExternalStore` 做最小订阅，不引入额外依赖；
 *  - 每条 toast 有自增 id，`duration` 后自动移除（`-1` 表示常驻，需手动关）；
 *  - 最多同时显示 `MAX_VISIBLE` 条，超出时挤掉最早的。
 */

import { useSyncExternalStore } from 'react'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  duration: number
  action?: ToastAction
}

const MAX_VISIBLE = 4

let nextId = 1
let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function push(kind: ToastKind, message: string, opts: { duration?: number; action?: ToastAction } = {}): number {
  const id = nextId++
  const toast: Toast = {
    id,
    kind,
    message,
    duration: opts.duration ?? (kind === 'error' ? 6000 : 3500),
    ...(opts.action ? { action: opts.action } : {})
  }
  toasts = [...toasts.slice(-(MAX_VISIBLE - 1)), toast]
  emit()
  if (toast.duration > 0) {
    setTimeout(() => dismiss(id), toast.duration)
  }
  return id
}

/** 移除一条 toast。 */
export function dismiss(id: number): void {
  const next = toasts.filter((t) => t.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

/** 清空全部 toast。 */
export function clearToasts(): void {
  if (toasts.length === 0) return
  toasts = []
  emit()
}

/** 便捷入口：`toast.success('已保存')`、`toast.error('失败了', { action })`。 */
export const toast = {
  success: (message: string, opts?: { duration?: number; action?: ToastAction }) =>
    push('success', message, opts),
  error: (message: string, opts?: { duration?: number; action?: ToastAction }) =>
    push('error', message, opts),
  warning: (message: string, opts?: { duration?: number; action?: ToastAction }) =>
    push('warning', message, opts),
  info: (message: string, opts?: { duration?: number; action?: ToastAction }) =>
    push('info', message, opts)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): Toast[] {
  return toasts
}

/** 订阅当前可见的 toast 列表（供 <Toasts/> 组件渲染）。 */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}