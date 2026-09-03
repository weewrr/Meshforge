import { create } from 'zustand'

// ─── App-wide preferences ───────────────────────────────────────────────────
// Mirrors Modly's appStore/agentStore: UI options, integrations and agent
// defaults. Persisted to localStorage — there is no Electron settings IPC in
// this build, so the renderer owns the state.

export type ThinkingMode = 'auto' | 'on' | 'off'
export type UiScale = 'small' | 'medium' | 'large' | 'very-large'
export type UiLocale = 'en' | 'zh'

export interface AppSettings {
  showRamIndicator: boolean
  useAtkinsonFont: boolean
  uiScale: UiScale
  locale: UiLocale
  hfToken: string
  ollamaUrl: string
  defaultModel: string
  defaultThinking: ThinkingMode
  modelsDir: string
  workspaceDir: string
  workflowsDir: string
  gpuDevice: string
  fp16: boolean
  vramLimit: string
  parallelWorkers: string
}

const DEFAULTS: AppSettings = {
  showRamIndicator: true,
  useAtkinsonFont: false,
  uiScale: 'medium',
  locale: 'en',
  hfToken: '',
  ollamaUrl: 'http://localhost:11434',
  defaultModel: 'qwen2.5:3b',
  defaultThinking: 'auto',
  modelsDir: '~/.meshforge/models',
  workspaceDir: '~/Documents/Meshforge',
  workflowsDir: '~/.meshforge/workflows',
  gpuDevice: 'auto',
  fp16: true,
  vramLimit: '8',
  parallelWorkers: '1'
}

const STORAGE_KEY = 'meshforge.settings'

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

const UI_SCALE_ZOOM: Record<UiScale, number> = {
  small: 0.9,
  medium: 1,
  large: 1.12,
  'very-large': 1.25
}

interface AppState extends AppSettings {
  patch: (p: Partial<AppSettings>) => void
  applyUi: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  ...load(),

  patch: (p) => {
    set(p)
    const { patch: _patch, applyUi: _applyUi, ...rest } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
    } catch {
      /* storage unavailable — settings stay in memory */
    }
    get().applyUi()
  },

  applyUi: () => {
    const { useAtkinsonFont, uiScale, locale } = get()
    document.documentElement.classList.toggle('font-atkinson', useAtkinsonFont)
    document.documentElement.style.zoom = String(UI_SCALE_ZOOM[uiScale])
    document.documentElement.lang = locale
  }
}))

// Apply persisted UI options once on load.
useAppStore.getState().applyUi()
