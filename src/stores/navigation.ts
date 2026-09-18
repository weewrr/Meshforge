/**
 * 顶层页面导航。
 *
 * 除记录当前页面外，还负责把页面落盘以实现崩溃恢复：主进程在
 * `renderer-process-gone` / `unresponsive` 之后会自动重载渲染进程，
 * 而 Zustand 状态在重载后丢失——用户会被丢回默认的 `generate` 页，
 * 表现为"莫名跳回首页"。localStorage 能跨重载存活，故在此持久化。
 */

import { create } from 'zustand'

/** 顶层页面标识。 */
export type Page = 'workflows' | 'generate' | 'models' | 'settings'

/** localStorage 中记录"最后所在页面"的键名。 */
const LAST_PAGE_KEY = 'meshforge.lastPage'

/** 全部合法页面，用于校验从 localStorage 读回的值。 */
const PAGES: readonly Page[] = ['workflows', 'generate', 'models', 'settings']

/** 读取上次所在页面；值非法或存储不可用时回退到 `generate`。 */
function loadLastPage(): Page {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY)
    return (PAGES as readonly string[]).includes(raw ?? '') ? (raw as Page) : 'generate'
  } catch {
    return 'generate'
  }
}

/** 持久化当前页面；存储不可用时静默降级为"仅本次会话有效"。 */
function savePage(page: Page): void {
  try {
    localStorage.setItem(LAST_PAGE_KEY, page)
  } catch {
    /* 存储不可用 —— 本次会话内导航仍然正常 */
  }
}

/** 导航 store 的形状。 */
interface NavigationState {
  page: Page
  go: (page: Page) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  // 初始值直接来自 localStorage，因此启动即恢复到上次页面，无闪烁。
  page: loadLastPage(),
  go: (page) => {
    // 先落盘再改状态：即使随后的渲染崩溃，下次启动也能恢复到目标页。
    savePage(page)
    set({ page })
  }
}))
