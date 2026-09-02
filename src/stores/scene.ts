import { create } from 'zustand'

export interface LightSettings {
  ambient: number
  main: number
  fill: number
}

export const DEFAULT_LIGHT: LightSettings = { ambient: 0.7, main: 1.4, fill: 0.4 }

export type ViewMode = 'solid' | 'wireframe' | 'normals' | 'matcap' | 'uv'
export type GizmoMode = 'translate' | 'rotate' | 'scale'

export interface MeshStats {
  triangles: number
  vertices: number
}

interface SceneState {
  meshUrl: string | null
  lightSettings: LightSettings
  viewMode: ViewMode
  autoRotate: boolean
  gizmoMode: GizmoMode | null
  meshSelected: boolean
  meshStats: MeshStats | null
  meshHistory: string[]
  historyIndex: number
  setMesh: (url: string | null) => void
  /** Push a new mesh into history (run output, import, optimize…). */
  pushMeshUrl: (url: string) => void
  undoMesh: () => void
  redoMesh: () => void
  setLight: (patch: Partial<LightSettings>) => void
  setViewMode: (mode: ViewMode) => void
  toggleAutoRotate: () => void
  setGizmoMode: (mode: GizmoMode | null) => void
  setMeshSelected: (selected: boolean) => void
  setMeshStats: (stats: MeshStats | null) => void
}

export const useSceneStore = create<SceneState>((set, get) => ({
  meshUrl: null,
  lightSettings: { ...DEFAULT_LIGHT },
  viewMode: 'solid',
  autoRotate: false,
  gizmoMode: null,
  meshSelected: false,
  meshStats: null,
  meshHistory: [],
  historyIndex: -1,

  setMesh: (url) =>
    set(url === null
      ? { meshUrl: null, meshSelected: false, meshStats: null }
      : { meshUrl: url }),

  pushMeshUrl: (url) => {
    const { meshHistory, historyIndex } = get()
    const trimmed = meshHistory.slice(0, historyIndex + 1)
    trimmed.push(url)
    set({ meshHistory: trimmed, historyIndex: trimmed.length - 1, meshUrl: url, meshSelected: false })
  },

  undoMesh: () => {
    const { meshHistory, historyIndex } = get()
    if (historyIndex <= 0) return
    const idx = historyIndex - 1
    set({ historyIndex: idx, meshUrl: meshHistory[idx], meshSelected: false })
  },

  redoMesh: () => {
    const { meshHistory, historyIndex } = get()
    if (historyIndex >= meshHistory.length - 1) return
    const idx = historyIndex + 1
    set({ historyIndex: idx, meshUrl: meshHistory[idx], meshSelected: false })
  },

  setLight: (patch) =>
    set((s) => ({ lightSettings: { ...s.lightSettings, ...patch } })),

  setViewMode: (mode) => set({ viewMode: mode }),
  toggleAutoRotate: () => set((s) => ({ autoRotate: !s.autoRotate })),
  setGizmoMode: (mode) => set({ gizmoMode: mode }),
  setMeshSelected: (selected) => set({ meshSelected: selected }),
  setMeshStats: (stats) => set({ meshStats: stats })
}))
