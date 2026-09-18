/**
 * 工作流定义的持久化接口（工作区 `workspace/workflows/*.json`）。
 *
 * 前端另有一份本地 store 缓存与自动保存，但**真正的落盘以后端为准**：
 * 列举 / 读取在打开工作流列表与切换标签页时调用，保存由自动保存定时器触发，
 * 删除则是用户显式操作。
 *
 * 注意 `saveWorkflow` 是"整份覆盖"语义——调用方必须先合并好完整图，
 * 不要用局部 patch 的直觉调用它。
 */

import { API_BASE, apiFetch } from './http'
import type { Workflow, WorkflowMeta } from '../types'

// ─── 工作流 ───────────────────────────────────────────────────────────────────

/**
 * 列举全部工作流的元信息（不含图数据，用于列表渲染）。
 *
 * @returns 工作流元信息数组。
 */
export async function listWorkflows(): Promise<WorkflowMeta[]> {
  const res = await apiFetch(`${API_BASE}/workflows`)
  if (!res.ok) throw new Error(`list workflows failed: ${res.status}`)
  return res.json()
}

/**
 * 读取单个工作流的完整定义（含节点与连线）。
 *
 * @param id 工作流 id。
 * @returns 完整的工作流对象。
 */
export async function getWorkflow(id: string): Promise<Workflow> {
  const res = await apiFetch(`${API_BASE}/workflows/${id}`)
  if (!res.ok) throw new Error(`get workflow failed: ${res.status}`)
  return res.json()
}

/**
 * 保存工作流（整份覆盖）。
 *
 * @param workflow 要写入的完整工作流对象。
 */
export async function saveWorkflow(workflow: Workflow): Promise<void> {
  const res = await apiFetch(`${API_BASE}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workflow)
  })
  if (!res.ok) throw new Error(`save workflow failed: ${res.status}`)
}

/**
 * 删除指定 id 的工作流。
 *
 * @param id 要删除的工作流 id。
 */
export async function deleteWorkflow(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/workflows/${id}`, { method: 'DELETE' })
}
