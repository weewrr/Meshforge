/**
 * 工作区资产库接口。
 *
 * 资产库是"生成过的模型 / 导入的网格"的聚合视图，供生成页的 LibraryPanel
 * 展示与复用。目前只有一个列举接口；后端把条目按递归 `updatedAt` 排序后返回。
 */

import { API_BASE, apiFetch } from './http'

// ─── 工作区资产库 ─────────────────────────────────────────────────────────────

import type { LibraryEntry } from '../pages/generate/assetLibrary'

/**
 * 列举工作区资产库中的全部条目。
 *
 * 后端返回 `{ success, entries?, message? }`；`success` 为 false 时以
 * `message` 抛出失败原因，否则返回条目数组（缺省为空）。
 *
 * @returns 资产条目数组。
 */
export async function listLibrary(): Promise<LibraryEntry[]> {
  const res = await apiFetch(`${API_BASE}/library`)
  if (!res.ok) throw new Error(`list library failed: ${res.status}`)
  const data = (await res.json()) as { success: boolean; entries?: LibraryEntry[]; message?: string }
  if (!data.success) throw new Error(data.message ?? 'list library failed')
  return data.entries ?? []
}
