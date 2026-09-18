/**
 * 系统监控与"清理"类接口。
 *
 * 两组职责：一是标题栏的实时资源监视（CPU / 内存 / 显存），由 `Chrome` 定时
 * 轮询 `getSystemStats`；二是设置页存储面板的清理动作（临时缓存、生成产物、
 * 保存的工作流），每个清理接口都返回"删了多少项、释放了多少字节"，
 * 让 UI 能直接给出反馈。
 *
 * 显存与 CPU 在部分平台/驱动下取不到，因此 `SystemStats` 里这些字段允许 `null`
 * ——UI 必须按"未知"渲染，而不是当成 0。
 */

import { API_BASE, apiFetch } from './http'

// ─── 系统指标（标题栏监视器） ─────────────────────────────────────────────────

/** 标题栏显示的实时资源占用；取不到的指标为 `null`。 */
export interface SystemStats {
  /** CPU 总体占用百分比。 */
  cpuPercent: number | null
  /** 内存：total / used 单位字节，percent 为占用百分比。 */
  memory: { total: number | null; used: number | null; percent: number | null }
  /** 显卡信息；无可用 GPU 时为 `null`。 */
  gpu: { vramTotal: number | null; vramUsed: number | null; vramPercent: number | null; util: number | null } | null
}

/**
 * 读取一次系统资源快照（标题栏定时调用）。
 *
 * @returns 当前 CPU / 内存 / 显存占用。
 */
export async function getSystemStats(): Promise<SystemStats> {
  const res = await apiFetch(`${API_BASE}/system/stats`)
  if (!res.ok) throw new Error(`system stats failed: ${res.status}`)
  return res.json()
}

/** 启动探测的 GPU 信息（cuda 不可用时 cudaAvailable=false，前端据此提示降级）。 */
export interface GpuDetectInfo {
  cudaAvailable: boolean
  count: number
  names: string[]
}

/** 后端运行时真实生效配置（GET /settings/runtime，文档 13.2 设置契约）。 */
export interface RuntimeInfo {
  dataDir: string
  workspaceDir: string
  workflowsDir: string
  modelsDir: string
  extensionsDir: string
  port: number
  maxConcurrentPerModel: number
  gpu: GpuDetectInfo
  /** 前端设置项 → 后端是否已接线；false 表示仅存 localStorage、暂不生效。 */
  wired: Record<string, boolean>
}

/** 读取后端实际生效的目录 / 端口 / 未接线标记，供设置页展示。 */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const res = await apiFetch(`${API_BASE}/settings/runtime`)
  if (!res.ok) throw new Error(`runtime info failed: ${res.status}`)
  return res.json()
}

/** 清理类接口的统一返回：删除条目数与释放字节数。 */
export interface ClearCacheResult {
  /** 删除的条目数。 */
  removed: number
  /** 释放的字节数。 */
  freedBytes: number
}

/** 删除临时缓存（未被工作流引用的上传文件、临时文件）。 */
export async function clearCache(): Promise<ClearCacheResult> {
  const res = await apiFetch(`${API_BASE}/settings/clear-cache`, { method: 'POST' })
  if (!res.ok) throw new Error(`clear cache failed: ${res.status}`)
  return res.json()
}

/** 在系统文件管理器中打开缓存（uploads）目录。 */
export async function openCacheFolder(): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${API_BASE}/settings/open-cache-folder`, { method: 'POST' })
  if (!res.ok) throw new Error(`open cache folder failed: ${res.status}`)
  return res.json()
}

/** 删除已生成的模型产物（`workspace/<job_id>/model.glb` 等）。 */
export async function clearGenerated(): Promise<ClearCacheResult> {
  const res = await apiFetch(`${API_BASE}/settings/clear-generated`, { method: 'POST' })
  if (!res.ok) throw new Error(`clear generated failed: ${res.status}`)
  return res.json()
}

/**
 * 删除全部已保存的工作流定义（`workspace/workflows/*.json`）。
 *
 * @returns 删除数量与释放字节数。
 */
export async function clearWorkflows(): Promise<ClearCacheResult> {
  const res = await apiFetch(`${API_BASE}/settings/clear-workflows`, { method: 'POST' })
  if (!res.ok) throw new Error(`clear workflows failed: ${res.status}`)
  return res.json()
}
