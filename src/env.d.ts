export {}

declare global {
  interface Window {
    meshforge?: {
      winMin: () => Promise<void>
      winMax: () => Promise<void>
      winClose: () => Promise<void>
      getRam: () => Promise<{ total: number; free: number; percent: number }>
    }
  }
}
