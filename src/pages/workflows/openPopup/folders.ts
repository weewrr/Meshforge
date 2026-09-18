/**
 * 打开弹窗里的"文件夹"数据层：名称、配色与收藏状态都持久化在 localStorage。
 *
 * 文件夹把工作流按主题归类，配色用于左侧色条，收藏则把常用工作流钉在顶部。
 */

// ─── 文件夹（名称 + 配色 + 收藏，均持久化在 localStorage）─────────────────────

/** 文件夹可选配色板：固定 6 色循环使用，新增文件夹时按顺序取下一个。 */
export const FOLDER_COLORS = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#fb7185']

/** 文件夹名称映射（id → 名称）的 localStorage 键。 */
export const FOLDERS_KEY = 'meshforge.folders.v1'
/** 文件夹配色映射（id → 颜色）的 localStorage 键。 */
export const FOLDER_COLORS_KEY = 'meshforge.folderColors.v1'
/** 收藏的工作流 id 列表的 localStorage 键。 */
export const FOLDER_BOOKMARKS_KEY = 'meshforge.folderBookmarks.v1'

/**
 * 从 localStorage 读取 JSON；键缺失或解析失败时回退到 `fallback`。
 *
 * 用 try/catch 兜底：隐私模式或配额超限会让 `getItem` / `JSON.parse` 抛错，
 * 此时静默回退，避免弹窗整体崩溃。
 *
 * @param key localStorage 键名。
 * @param fallback 读取失败时使用的值。
 * @returns 解析出的对象，或 `fallback`。
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** 把任意值序列化为 JSON 写入 localStorage。 */
export function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}
