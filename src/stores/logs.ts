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
  log: (level, message) => {
    // Mirror to the console: the Electron main process forwards renderer
    // console output to the terminal, so crash traces stay observable even
    // when the UI is gone (e.g. renderer crash after Import → Mesh).
    if (level === 'error') console.error(`[meshforge] ${message}`)
    else if (level === 'warn') console.warn(`[meshforge] ${message}`)
    else console.info(`[meshforge] ${message}`)
    set((s) => ({ logs: [...s.logs.slice(-(MAX_LOGS - 1)), { ts: Date.now(), level, message }] }))
  },
  info: (message) => useLogsStore.getState().log('info', message),
  warn: (message) => useLogsStore.getState().log('warn', message),
  error: (message) => useLogsStore.getState().log('error', message),
  clear: () => set({ logs: [] })
}))
