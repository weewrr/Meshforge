/**
 * workspace 资产库面板的加载 / 搜索 / 排序 / 折叠状态。
 *
 * 从 GeneratePage 抽出的纯逻辑 hook：面板打开时懒加载（首次），
 * Refresh 强制刷新；并发保护防止重复请求把 loading 提前释放。
 */

import { useEffect, useState } from 'react'
import { listLibrary } from '../../api'
import {
  getDefaultCollapsedSectionKeys,
  isOpenable,
  type LibraryEntry,
  type LibrarySortMode
} from './assetLibrary'

export function useLibraryPanel(openPanel: string | null) {
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([])
  const [librarySelectedId, setLibrarySelectedId] = useState<string | null>(null)
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [librarySearch, setLibrarySearch] = useState('')
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>('type')
  // 折叠分区用惰性初始值：只在首次挂载时读一次 localStorage 默认值。
  const [libraryCollapsed, setLibraryCollapsed] = useState<string[]>(() => getDefaultCollapsedSectionKeys())

  /** 打开面板时懒加载（首次），force = Refresh 强制刷新。 */
  async function loadLibrary(force = false): Promise<void> {
    // 并发保护：已在加载中就忽略，避免重复请求把 loading 状态提前释放。
    if (libraryLoading) return
    if (libraryLoaded && !force) return
    setLibraryLoading(true)
    setLibraryError(null)
    try {
      const entries = await listLibrary()
      setLibraryEntries(entries)
      // 保留原选中项（若仍在列表中），否则优先落到第一个"可打开"的条目。
      setLibrarySelectedId((cur) =>
        cur && entries.some((e) => e.id === cur) ? cur : entries.find(isOpenable)?.id ?? entries[0]?.id ?? null
      )
      setLibraryLoaded(true)
    } catch (err) {
      setLibraryLoaded(false)
      setLibraryError(String(err instanceof Error ? err.message : err))
    } finally {
      setLibraryLoading(false)
    }
  }

  useEffect(() => {
    if (openPanel !== 'library' || libraryLoaded || libraryLoading) return
    void loadLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel, libraryLoaded, libraryLoading])

  return {
    libraryEntries,
    librarySelectedId,
    setLibrarySelectedId,
    libraryLoading,
    libraryError,
    librarySearch,
    setLibrarySearch,
    librarySort,
    setLibrarySort,
    libraryCollapsed,
    setLibraryCollapsed,
    loadLibrary
  }
}
