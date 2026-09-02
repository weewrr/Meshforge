import { create } from 'zustand'

export type Page = 'workflows' | 'generate' | 'models' | 'settings'

interface NavigationState {
  page: Page
  go: (page: Page) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  page: 'generate',
  go: (page) => set({ page })
}))
