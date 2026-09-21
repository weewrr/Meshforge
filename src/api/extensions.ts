/**
 * 扩展（插件）的安装 / 卸载 / 重载接口。
 *
 * 扩展是 MeshForge 的模型与工具来源：既可以从 GitHub / Hugging Face /
 * ModelScope 的 URL 安装，也可以指向本地目录。安装是**长流程**（下载 →
 * 解包 → 校验 → 落位），因此拆成两个调用：`installExtension` 发起，
 * `installExtensionStatus` 轮询阶段性进度。
 *
 * 本模块所有写操作都以 `{ ok, message }` 表达结果、不向上抛错，
 * 让调用方（设置页 / 模型页）能统一按"成功-失败"两分支渲染，而不必写 try/catch。
 */

import { API_BASE, apiFetch } from './http'

// ─── 扩展 ─────────────────────────────────────────────────────────────────────

/** 扩展安装的阶段性状态，前端据此决定进度环与文案。 */
export type InstallStep = 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'

/** 安装进度快照；后端未在安装中时 `installExtensionStatus` 返回 `null`。 */
export interface InstallProgress {
  /** 当前阶段。 */
  step: InstallStep
  /** 阶段内百分比（部分阶段没有可量化的进度，故可选）。 */
  percent?: number
  /** 正在安装的扩展 id。 */
  extensionId?: string
  /** 面向用户的补充说明（后端已本地化）。 */
  message?: string
}

/**
 * 按 URL 安装扩展（异步发起，不等待完成）。
 *
 * @param url 扩展来源 URL（GitHub / HF / ModelScope）或本地路径。
 * @returns 安装是否成功发起；成功后需用 {@link installExtensionStatus} 跟踪进度。
 */
export async function installExtension(url: string): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch(`${API_BASE}/extensions/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
  // 后端出错时可能返回非 JSON 体，故先兜底成 {} 再取 detail。
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `install failed: ${res.status}` }
  }
  return { ok: true, message: 'installed' }
}

/**
 * 查询当前安装进度。
 *
 * @returns 进度快照；无进行中的安装时返回 `null`。
 */
export async function installExtensionStatus(): Promise<InstallProgress | null> {
  const res = await apiFetch(`${API_BASE}/extensions/install/status`)
  if (!res.ok) return null
  const data = (await res.json()) as { progress: InstallProgress | null }
  return data.progress
}

/**
 * 卸载指定 id 的扩展。
 *
 * 同样以 `{ ok, message }` 表达结果，不向上抛错。
 *
 * **两种语义**：清单扩展（`extensions/<id>/`）是真删目录；内置扩展磁盘上没有目录，
 * 卸载 = 停用（记进后端停用表，跨重启保持隐藏）。`builtin` 字段让调用方切换文案。
 *
 * @param id 要卸载的扩展 id。
 * @returns 卸载结果；`builtin` 为 true 表示只是停用、可恢复。
 */
export async function uninstallExtension(
  id: string
): Promise<{ ok: boolean; message: string; builtin: boolean }> {
  const res = await apiFetch(`${API_BASE}/extensions/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return {
      ok: false,
      message: (body as { detail?: string }).detail ?? `uninstall failed: ${res.status}`,
      builtin: false
    }
  }
  return { ok: true, message: 'uninstalled', builtin: (body as { builtin?: boolean }).builtin === true }
}

/** 已停用（可恢复）的内置扩展条目。 */
export interface DisabledExtension {
  /** 扩展 id。 */
  id: string
  /** 后端给到的原始显示名（未本地化）。 */
  display_name: string
  /** 类别：模型生成器或网格处理工具。 */
  kind: 'model' | 'process'
  /** 更细的分类（生视图 / 图像 / 网格 / 处理）。 */
  category?: string
}

/**
 * 列出被停用的内置扩展。
 *
 * 用于模型页渲染"已停用"条带——内置扩展卸载后并非消失，而是被记进了停用表，
 * 用户可以在这里把它们放回来。
 *
 * @returns 停用项列表；请求失败时返回空数组（条带不显示即可，不阻断页面）。
 */
export async function listDisabledExtensions(): Promise<DisabledExtension[]> {
  try {
    const res = await apiFetch(`${API_BASE}/extensions/disabled`)
    if (!res.ok) return []
    const data = (await res.json()) as { items?: DisabledExtension[] }
    return data.items ?? []
  } catch {
    return []
  }
}

/**
 * 恢复（取消停用）指定的内置扩展。
 *
 * @param ids 要恢复的扩展 id 列表。
 * @returns 恢复结果；`restored` 为真正恢复注册的 id（不在停用表里的会被忽略）。
 */
export async function restoreExtensions(
  ids: string[]
): Promise<{ ok: boolean; message: string; restored: string[] }> {
  try {
    const res = await apiFetch(`${API_BASE}/extensions/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: (body as { detail?: string }).detail ?? `restore failed: ${res.status}`,
        restored: []
      }
    }
    return { ok: true, message: 'restored', restored: (body as { restored?: string[] }).restored ?? [] }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), restored: [] }
  }
}

/**
 * 通知后端重新扫描并加载扩展目录。
 *
 * 用 try/catch 包住整个请求，任何异常都转成 `message` 返回，
 * 因为重载失败通常不影响主流程，无需中断调用方。
 *
 * @returns 重载结果。
 */
export async function reloadExtensionsApi(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await apiFetch(`${API_BASE}/extensions/reload`, { method: 'POST' })
    if (!res.ok) return { ok: false, message: `reload failed: ${res.status}` }
    return { ok: true, message: 'reloaded' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
