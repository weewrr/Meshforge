export {}

declare global {
  interface Window {
    meshforge?: {
      winMin: () => Promise<void>
      winMax: () => Promise<void>
      winClose: () => Promise<void>
      getRam: () => Promise<{ total: number; free: number; percent: number }>
      selectMeshFile: () => Promise<string | null>
      selectImageFile: () => Promise<string | null>
      selectWorkflowFile: () => Promise<{ name: string; content: string } | null>
      selectFolder: () => Promise<string | null>
      getLastCrash: () => Promise<{ reason: string; at: number } | null>
    }
  }
}
