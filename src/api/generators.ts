/**
 * 生成器（模型生成器）与扩展（网格处理工具）的查询与调用。
 *
 * `listGenerators` 取模型生成器，`listExtensions` 取全部扩展并把结果缓存到
 * 类型模块（供全局快速读取）；`processMesh` 触发一次 mesh→mesh 处理任务，
 * `listDirFiles` 则用于"遍历目录"节点的文件列举。
 */

import { API_BASE, apiFetch } from './http'
import type { GeneratorInfo, WorkflowExtension } from '../types'
import { setExtensionsCache } from '../types'

// ─── Generators / Extensions ─────────────────────────────────────────────────

export async function listGenerators(): Promise<GeneratorInfo[]> {
  const res = await apiFetch(`${API_BASE}/generators`)
  if (!res.ok) throw new Error(`list generators failed: ${res.status}`)
  return res.json()
}

/** 统一的扩展列表（模型生成器 + 网格处理工具）。 */
export async function listExtensions(): Promise<WorkflowExtension[]> {
  const res = await apiFetch(`${API_BASE}/extensions`)
  if (!res.ok) throw new Error(`list extensions failed: ${res.status}`)
  const extensions = (await res.json()) as WorkflowExtension[]
  setExtensionsCache(extensions)
  return extensions
}

/** 运行一次网格处理工具（网格 → 网格）。 */
export async function processMesh(
  meshUrl: string,
  extensionId: string,
  params: Record<string, unknown>
): Promise<{ job_id: string }> {
  const res = await apiFetch(`${API_BASE}/process/mesh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mesh_url: meshUrl, extension_id: extensionId, params })
  })
  if (!res.ok) throw new Error(`process mesh failed: ${res.status}`)
  return res.json()
}

/**
 * 列出工作区某个子目录下的文件，供"遍历目录"节点（For Each）使用。
 *
 * @param dir 要列举的目录相对路径。
 * @param extensions 逗号分隔的后缀过滤，如 `glb,obj`。
 * @returns 匹配的文件路径数组。
 */
export async function listDirFiles(dir: string, extensions: string): Promise<string[]> {
  const res = await apiFetch(`${API_BASE}/files/list-dir?dir=${encodeURIComponent(dir)}&ext=${encodeURIComponent(extensions)}`)
  if (!res.ok) throw new Error(`list dir failed: ${res.status}`)
  const data = (await res.json()) as { files: string[] }
  return data.files
}
