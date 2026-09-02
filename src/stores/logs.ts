import { create } from 'zustand'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  message: string
}

const MAX_LOGS = 500

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
  log: (level, message) =>
    set((s) => ({ logs: [...s.logs.slice(-(MAX_LOGS - 1)), { ts: Date.now(), level, message }] })),
  info: (message) => useLogsStore.getState().log('info', message),
  warn: (message) => useLogsStore.getState().log('warn', message),
  error: (message) => useLogsStore.getState().log('error', message),
  clear: () => set({ logs: [] })
}))
