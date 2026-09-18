/**
 * 应用级偏好设置。
 *
 * 对应 Modly 的 appStore / agentStore：UI 选项、外部服务集成与内置 Agent 的
 * 默认参数。整份状态持久化在 localStorage——本构建没有走 Electron 的设置 IPC，
 * 因此由渲染进程自己持有这份状态。
 *
 * 例外（优化文档 13.3）：`hfToken` 与 `agentApiKey` 是敏感凭据，不进
 * localStorage——由 Electron 主进程经 safeStorage 加密落盘（secret-store.ts），
 * 渲染层只经受控 IPC 读写，并在启动时自动把旧版明文迁移过去。
 */

import { create } from 'zustand'

// ─── 应用级偏好 ───────────────────────────────────────────────────────────────

/** 思考模式：`auto` = 交给模型自行决定是否输出思考过程。 */
export type ThinkingMode = 'auto' | 'on' | 'off'
/** 界面缩放档位，映射到 `UI_SCALE_ZOOM`。 */
export type UiScale = 'small' | 'medium' | 'large' | 'very-large'
/** 界面语言。 */
export type UiLocale = 'en' | 'zh'
/** 明暗主题。 */
export type UiTheme = 'dark' | 'light'
/** 内置 Agent 对接的后端类型；`openai` 泛指任何 OpenAI 兼容端点。 */
export type AgentProvider = 'openai' | 'ollama'

/** 全部可持久化的应用设置。 */
export interface AppSettings {
  /** 底部状态栏各指标的显示开关（旧版是单一的 showMetrics，见 load() 里的迁移逻辑）。 */
  showCpu: boolean
  showRam: boolean
  showVram: boolean
  showGpu: boolean
  /** 是否启用 Atkinson 字体。 */
  useAtkinsonFont: boolean
  uiScale: UiScale
  locale: UiLocale
  theme: UiTheme
  /** HuggingFace 访问令牌，用于拉取需要授权的模型权重。 */
  hfToken: string
  agentProvider: AgentProvider
  /** Agent 后端地址；provider = 'openai' 时使用。 */
  agentBaseUrl: string
  agentApiKey: string
  /** Ollama 服务地址；provider = 'ollama' 时使用。默认指向本机 11434。 */
  ollamaUrl: string
  defaultModel: string
  defaultThinking: ThinkingMode
  /** 模型权重目录。 */
  modelsDir: string
  /** 运行产物（上传/生成的网格）目录。 */
  workspaceDir: string
  /** 工作流文档目录。 */
  workflowsDir: string
  /** 指定 CUDA 设备序号；'auto' = 交给后端自行选择。 */
  gpuDevice: string
  /** 是否以半精度推理——显存不足时首先要动的开关。 */
  fp16: boolean
  /** 显存上限（GB）。用字符串是因为要允许"留空 = 不限"这种表达。 */
  vramLimit: string
  /** 并行推理进程数，同样是字符串以允许留空。 */
  parallelWorkers: string
}

/** 全新安装或读取失败时的兜底值。 */
const DEFAULTS: AppSettings = {
  showCpu: true,
  showRam: true,
  showVram: true,
  showGpu: true,
  useAtkinsonFont: false,
  uiScale: 'medium',
  locale: 'en',
  theme: 'dark',
  hfToken: '',
  agentProvider: 'openai' as AgentProvider,
  agentBaseUrl: '',
  agentApiKey: '',
  ollamaUrl: 'http://localhost:11434',
  defaultModel: '',
  defaultThinking: 'auto',
  modelsDir: '~/.meshforge/models',
  workspaceDir: '~/Documents/Meshforge',
  workflowsDir: '~/.meshforge/workflows',
  gpuDevice: 'auto',
  fp16: true,
  vramLimit: '8',
  parallelWorkers: '1'
}

/** localStorage 键名。 */
const STORAGE_KEY = 'meshforge.settings'

/** 存放于主进程 safeStorage（不进 localStorage）的敏感键。 */
const SECRET_KEYS = ['hfToken', 'agentApiKey'] as const

/** 读取已持久化的设置并与默认值合并；解析失败或存储不可用时回退到 `DEFAULTS`。 */
function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw) as Partial<AppSettings> & {
      showMetrics?: boolean
      showRamIndicator?: boolean
    }
    // 迁移旧版的两个开关：早期的"显示指标"与"显示内存指示器"是单一开关，
    // 现在拆成四个按指标独立的开关，旧值统一套用到这四个上。
    const legacy = saved.showMetrics ?? saved.showRamIndicator
    if (legacy !== undefined) {
      saved.showCpu = saved.showCpu ?? legacy
      saved.showRam = saved.showRam ?? legacy
      saved.showVram = saved.showVram ?? legacy
      saved.showGpu = saved.showGpu ?? legacy
    }
    // 迁移完成后删掉旧字段，避免它们被再次写回 localStorage。
    delete saved.showMetrics
    delete saved.showRamIndicator
    // 敏感凭据不再从 localStorage 恢复（改由启动时的 migrateSecrets 水合）；
    // 这里删掉是为了把历史版本落盘的明文凭据从存储里清出去。
    delete saved.hfToken
    delete saved.agentApiKey
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 缩放档位 → CSS zoom 值。数组写法保证四个档位都有映射，漏配会被类型检查拦住。 */
const UI_SCALE_ZOOM: Record<UiScale, number> = {
  small: 0.9,
  medium: 1,
  large: 1.12,
  'very-large': 1.25
}

/** store 形状 = 全部设置字段 + 两个动作。 */
interface AppState extends AppSettings {
  /** 局部更新设置：立即生效、落盘，并重新套用 UI。 */
  patch: (p: Partial<AppSettings>) => void
  /** 把缩放 / 语言 / 主题套用到 `<html>` 上。 */
  applyUi: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // 初始值直接来自 localStorage，避免首帧先渲染默认值再跳变。
  ...load(),

  patch: (p) => {
    // 敏感凭据改走主进程 safeStorage，不进 localStorage 也不进这条同步路径。
    const { hfToken, agentApiKey, ...restPatch } = p as Partial<AppSettings>
    const bridge = window.meshforge
    if (hfToken !== undefined) void bridge?.setSecret?.('hfToken', hfToken)
    if (agentApiKey !== undefined) void bridge?.setSecret?.('agentApiKey', agentApiKey)
    set(restPatch)
    // 落盘时剔除动作函数与敏感凭据：它们不可序列化或不应明文落盘。
    const { patch: _patch, applyUi: _applyUi, hfToken: _hf, agentApiKey: _ak, ...rest } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
    } catch {
      /* 存储不可用 —— 设置只保留在内存里 */
    }
    get().applyUi()
  },

  applyUi: () => {
    const { useAtkinsonFont, uiScale, locale, theme } = get()
    // 全部挂在 <html> 上：样式表按 .font-atkinson 与 [data-theme] 选择器取值。
    document.documentElement.classList.toggle('font-atkinson', useAtkinsonFont)
    document.documentElement.style.zoom = String(UI_SCALE_ZOOM[uiScale])
    document.documentElement.lang = locale
    document.documentElement.dataset.theme = theme
  }
}))

// 启动时立即套用一次，保证缩放/主题/字体在首帧就正确。
useAppStore.getState().applyUi()

// 凭据迁移 + 水合：把历史版本残留在 localStorage 里的明文 HF Token /
// Agent API Key 搬进主进程 safeStorage，然后从存储里清除；
// 再从 safeStorage 读回当前值填进内存状态。非 Electron 环境无桥接，
// 凭据保持空字符串（不影响其余功能）。
void (async () => {
  const bridge = window.meshforge
  if (!bridge?.getSecret || !bridge.setSecret) return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AppSettings>
      let migrated = false
      for (const key of SECRET_KEYS) {
        const legacyValue = saved[key]
        if (typeof legacyValue === 'string' && legacyValue) {
          // 只在安全存储还没有该凭据时迁移，避免旧明文覆盖用户新改的值。
          const existing = await bridge.getSecret(key)
          if (!existing) await bridge.setSecret(key, legacyValue)
          migrated = true
        }
      }
      if (migrated) {
        const cleaned = JSON.parse(raw) as Record<string, unknown>
        for (const key of SECRET_KEYS) delete cleaned[key]
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
      }
    }
    const [hfToken, agentApiKey] = await Promise.all([
      bridge.getSecret('hfToken'),
      bridge.getSecret('agentApiKey')
    ])
    useAppStore.setState({ hfToken, agentApiKey })
  } catch {
    /* 迁移失败不阻塞启动：凭据留空，用户可在设置页重填 */
  }
})()
