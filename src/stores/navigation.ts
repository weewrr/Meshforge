import { create } from 'zustand'

export type Page = 'workflows' | 'generate' | 'models' | 'settings'

// Crash recovery: the main process auto-reloads the renderer after a
// renderer-process-gone / unresponsive event. Zustand state is lost on reload,
// which used to drop the user back on the default 'generate' page (perceived as
// "jumped back to home"). localStorage survives reload, so we persist the last
// page and restore it on startup.
const LAST_PAGE_KEY = 'meshforge.lastPage'

const PAGES: readonly Page[] = ['workflows', 'generate', 'models', 'settings']

function loadLastPage(): Page {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY)
    return (PAGES as readonly string[]).includes(raw ?? '') ? (raw as Page) : 'generate'
  } catch {
    return 'generate'
  }
}

function savePage(page: Page): void {
  try {
    localStorage.setItem(LAST_PAGE_KEY, page)
  } catch {
    /* storage unavailable — session-only navigation */
  }
}

interface NavigationState {
  page: Page
  go: (page: Page) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  page: loadLastPage(),
  go: (page) => {
    savePage(page)
    set({ page })
  }
}))
