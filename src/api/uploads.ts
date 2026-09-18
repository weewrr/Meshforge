/**
 * 节点内嵌资源的上传与"按路径导入"。
 *
 * `uploadFile` 是最普通的 `<input type=file>` 上传；`importMeshByPath` /
 * `importImageByPath` 则走主进程原生文件对话框选中的绝对路径，由后端
 * 直接服务或拷贝文件，不经渲染进程的字节传输。
 */

import { API_BASE, apiFetch } from './http'

// ─── Uploads (node-embedded assets) ──────────────────────────────────────────

export async function uploadFile(file: File): Promise<{ url: string; fileName: string }> {
  const form = new FormData()
  form.append('file', file)
  // 大文件上传是长任务：关闭默认 30s 超时（文档 13.7）。
  const res = await apiFetch(`${API_BASE}/upload`, { method: 'POST', body: form, timeoutMs: 0 })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  return res.json()
}

/**
 * 按绝对文件系统路径导入网格（与 Modly 对齐）。
 *
 * 原生文件对话框运行在 Electron 主进程；后端通过 `/optimize/serve-file`
 * 直接服务该文件（或经 trimesh 转换的 GLB）。不经过渲染进程的字节传输，
 * 也不涉及 Chromium 的 `<input type=file>`。
 *
 * @param path 网格文件的绝对路径。
 * @returns 含可访问的 `url`。
 */
export async function importMeshByPath(path: string): Promise<{ url: string }> {
  // 后端要拷贝/转换整个网格文件（可能数 GB）：关闭默认超时。
  const res = await apiFetch(`${API_BASE}/optimize/import-by-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    timeoutMs: 0
  })
  if (!res.ok) {
    let detail = `import mesh failed: ${res.status}`
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch { /* non-JSON error body */ }
    throw new Error(detail)
  }
  return res.json()
}

/**
 * 按绝对文件路径导入图片（与 Modly 对齐）。原生文件对话框在 Electron 主进程
 * 中打开；后端把文件拷入 workspace/uploads，并返回与 /upload 相同的结构——
 * 因此 imageNode、生成页预览与智能体附件都无需改动即可消费。
 * 全程不涉及 Chromium 的 <input type=file>，
 * 也就不会触发这台机器上已知的渲染进程冻结问题。
 */
export async function importImageByPath(path: string): Promise<{ url: string; fileName: string }> {
  const res = await apiFetch(`${API_BASE}/upload/from-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    timeoutMs: 0
  })
  if (!res.ok) {
    let detail = `import image failed: ${res.status}`
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch { /* non-JSON error body */ }
    throw new Error(detail)
  }
  return res.json()
}
