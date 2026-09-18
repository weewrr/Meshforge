/**
 * 应用内日志缓冲。
 *
 * 前端所有模块的诊断输出统一走这里，而不是各写各的 `console.log`：
 * 一是便于设置页的日志面板渲染，二是写入时同步镜像到控制台，
 * 由 Electron 主进程转发到终端，保证渲染进程崩溃后仍有现场可查。
 */

import { create } from 'zustand'

/** 日志级别。 */
export type LogLevel = 'info' | 'warn' | 'error'

/** 一条日志记录。 */
export interface LogEntry {
  /** 写入时刻的毫秒时间戳，供按时间轴排布与展示。 */
  ts: number
  level: LogLevel
  message: string
}

/** 环形缓冲上限：超出后从头部丢弃，防止长时间运行把内存吃满。 */
const MAX_LOGS = 500

/** 日志 store 的形状：一条数据 + 若干写入/清理动作。 */
interface LogsState {
  logs: LogEntry[]
  log: (level: LogLevel, message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  clear: () => void
}

export const useLogsStore = create<LogsState>((set) => ({
  logs: [],
  log: (level, message) => {
    // 镜像到控制台：Electron 主进程会把渲染进程的 console 输出转发到终端，
    // 因此即使 UI 已经消失（例如 Import → Mesh 之后渲染进程崩溃），崩溃现场依然可观察。
    if (level === 'error') console.error(`[meshforge] ${message}`)
    else if (level === 'warn') console.warn(`[meshforge] ${message}`)
    else console.info(`[meshforge] ${message}`)
    // 追加一条并把总长度裁到 MAX_LOGS：先取尾部 MAX_LOGS-1 条，再拼上新项。
    set((s) => ({ logs: [...s.logs.slice(-(MAX_LOGS - 1)), { ts: Date.now(), level, message }] }))
  },
  // getState() 而非闭包里的 log：store 动作互相调用时，闭包内的引用可能已过期。
  info: (message) => useLogsStore.getState().log('info', message),
  warn: (message) => useLogsStore.getState().log('warn', message),
  error: (message) => useLogsStore.getState().log('error', message),
  clear: () => set({ logs: [] })
}))
