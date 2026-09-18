/**
 * 3D 查看器的场景状态。
 *
 * 只存"看得见的东西"：当前网格 URL、灯光、显示模式，以及一份网格 URL 的历史栈
 * （运行产物、导入、优化都会压栈，所以查看器自己有独立的撤销/重做）。
 * 真正的 three.js 对象（scene / camera / renderer）由 `components/Viewer3D.tsx`
 * 持有，这里不放实例。
 */

import { create } from 'zustand'

/** 三点光照强度（环境光 / 主光 / 补光）。 */
export interface LightSettings {
  ambient: number
  main: number
  fill: number
}

/** 默认灯光强度：偏亮的主光配中等环境光，兼顾金属材质与素模的可读性。 */
export const DEFAULT_LIGHT: LightSettings = { ambient: 0.7, main: 1.4, fill: 0.4 }

/** 网格显示模式。 */
export type ViewMode = 'solid' | 'wireframe' | 'normals' | 'matcap' | 'uv'
/** 变换手柄模式；`null` = 不显示手柄。 */
export type GizmoMode = 'translate' | 'rotate' | 'scale'

/** 网格规模统计，展示在查看器角落。 */
export interface MeshStats {
  triangles: number
  vertices: number
}

/** 场景 store 的形状：查看器状态 + 动作。 */
interface SceneState {
  /** 当前展示的网格 URL；`null` = 空场景。 */
  meshUrl: string | null
  lightSettings: LightSettings
  viewMode: ViewMode
  autoRotate: boolean
  gizmoMode: GizmoMode | null
  meshSelected: boolean
  meshStats: MeshStats | null
  /** 网格 URL 历史栈 + 当前指针，构成查看器内的独立撤销/重做。 */
  meshHistory: string[]
  historyIndex: number
  setMesh: (url: string | null) => void
  /** 把新网格压入历史栈（运行产物、导入、优化等都会调用），并立即切换过去。 */
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
  // -1 表示"还没有任何网格"，pushMeshUrl 会把它推进到 0。
  historyIndex: -1,

  // 置空时连带清掉选中态与统计，避免查看器残留上一个网格的信息。
  setMesh: (url) =>
    set(url === null
      ? { meshUrl: null, meshSelected: false, meshStats: null }
      : { meshUrl: url }),

  pushMeshUrl: (url) => {
    // 从当前指针处截断：在历史中间压入新项时，其后的"未来"分支作废。
    const { meshHistory, historyIndex } = get()
    const trimmed = meshHistory.slice(0, historyIndex + 1)
    trimmed.push(url)
    set({ meshHistory: trimmed, historyIndex: trimmed.length - 1, meshUrl: url, meshSelected: false })
  },

  undoMesh: () => {
    const { meshHistory, historyIndex } = get()
    // 已在栈底则不动（-1 是无网格，0 是第一个网格）。
    if (historyIndex <= 0) return
    const idx = historyIndex - 1
    set({ historyIndex: idx, meshUrl: meshHistory[idx], meshSelected: false })
  },

  redoMesh: () => {
    const { meshHistory, historyIndex } = get()
    // 已在栈顶则不动。
    if (historyIndex >= meshHistory.length - 1) return
    const idx = historyIndex + 1
    set({ historyIndex: idx, meshUrl: meshHistory[idx], meshSelected: false })
  },

  // 灯光是局部更新：只改传入的两三个通道，其余保持。
  setLight: (patch) =>
    set((s) => ({ lightSettings: { ...s.lightSettings, ...patch } })),

  setViewMode: (mode) => set({ viewMode: mode }),
  toggleAutoRotate: () => set((s) => ({ autoRotate: !s.autoRotate })),
  setGizmoMode: (mode) => set({ gizmoMode: mode }),
  setMeshSelected: (selected) => set({ meshSelected: selected }),
  setMeshStats: (stats) => set({ meshStats: stats })
}))
