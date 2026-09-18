/**
 * 模型权重下载与"从本地目录安装扩展"接口。
 *
 * 两件事都围绕"模型文件怎么进入本机"：
 *  1. 权重下载走 Hugging Face，服务端以 **SSE** 流式回报每个文件的进度，
 *     支持暂停（保留 `.part`，可续传）与取消（清理 `.part`）。
 *  2. 从本地目录安装扩展。历史实现依赖 `<input webkitdirectory>`，会在
 *     这台机器上冻住渲染进程；现行实现改由主进程弹原生目录对话框，
 *     后端负责拷贝整棵树——渲染进程不再做任何文件 IO。
 */

import { API_BASE, apiFetch } from './http'

// ─── 模型权重下载（HF Hub → server/models/<ext_id>） ──────────────────────────

/** 单个模型扩展的权重下载状态。 */
export interface ModelStatusEntry {
  /** 扩展 id。 */
  extId: string
  /** Hugging Face 仓库 id（`user/repo`）。 */
  repoId: string
  /** 下载时跳过的路径前缀（如体积巨大的可选权重）。 */
  skipPrefixes: string[]
  /** 只下载这些路径前缀（与 skipPrefixes 二选一使用）。 */
  includePrefixes: string[]
  /** 权重是否已完整落盘。 */
  downloaded: boolean
  /** 已占用字节数。 */
  sizeBytes: number
}

/** SSE 进度事件；各字段随下载阶段递增出现，故大多可选。 */
export interface ModelDownloadInfo {
  /** 总进度 0~100。 */
  percent: number
  /** 当前正在下载的文件名。 */
  file?: string
  /** 当前文件序号（从 1 起）。 */
  fileIndex?: number
  /** 本仓库的文件总数。 */
  totalFiles?: number
  /** 阶段文案（如 `Downloading…` / `done`）。 */
  status?: string
  /** 已下载字节数。 */
  bytesDownloaded?: number
  /** 本仓库总字节数。 */
  totalBytes?: number
  /** 是否为"已暂停"末态。 */
  paused?: boolean
  /** 是否为"已取消"末态。 */
  cancelled?: boolean
  /** 失败原因。 */
  error?: string
}

/**
 * 列出所有声明了 HF 仓库的模型扩展的下载状态。
 *
 * 后端不可达时**返回空数组而不是抛错**：标题栏与模型页会无条件调用它来渲染
 * 徽标，后端未起来时不应让整页崩掉。
 *
 * @returns 下载状态数组（取不到时为 `[]`）。
 */
export async function listModelStatus(): Promise<ModelStatusEntry[]> {
  try {
    const res = await apiFetch(`${API_BASE}/model/status`)
    if (!res.ok) return []
    const data = (await res.json()) as { models?: ModelStatusEntry[] }
    return data.models ?? []
  } catch {
    return []
  }
}

/**
 * 请求暂停下载（fire-and-forget）。
 *
 * @param id 模型扩展 id。
 */
export async function pauseModelDownload(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/model/hf-download/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
}

/**
 * 请求取消下载（fire-and-forget）；服务端会清理对应的 `.part` 文件。
 *
 * @param id 模型扩展 id。
 */
export async function cancelModelDownload(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/model/hf-download/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
}

/**
 * 启动一次 HF 模型下载并消费其 SSE 进度流。
 *
 * 流结束（done / paused / cancelled / error）时以末态事件 resolve。
 * 暂停可续传：服务端保留 `.part` 文件，下次以相同 id 调用会经 Range
 * 头从中断处继续。
 *
 * @param opts 下载参数（含 id、repoId 与进度回调 `onEvent`）。
 * @returns 末尾聚合出的下载状态。
 */
export async function startModelDownload(opts: {
  id: string
  repoId: string
  skipPrefixes?: string[]
  includePrefixes?: string[]
  token?: string
  onEvent: (e: ModelDownloadInfo) => void
}): Promise<ModelDownloadInfo> {
  const params = new URLSearchParams({
    repo_id: opts.repoId,
    model_id: opts.id
  })
  // 前缀过滤是可选项，空值时不发参数（避免后端收到空字符串）。
  if (opts.skipPrefixes?.length) params.set('skip_prefixes', JSON.stringify(opts.skipPrefixes))
  if (opts.includePrefixes?.length) params.set('include_prefixes', JSON.stringify(opts.includePrefixes))

  // HF token 走 X-HF-Token 请求头而不是 URL query——query 会进入
  // 访问日志 / 浏览器历史 / 代理日志（优化文档 12.6 / 13.3）。
  const headers: Record<string, string> = {}
  if (opts.token) headers['X-HF-Token'] = opts.token

  // SSE 流式下载是长任务：关闭默认超时（文档 13.7），靠后端自身的暂停/取消事件收尾。
  const res = await apiFetch(`${API_BASE}/model/hf-download?${params.toString()}`, { headers, timeoutMs: 0 })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`model download failed: ${res.status} ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // buffer 累积跨 chunk 的半截帧：SSE 的一帧可能被 TCP 切成两次 read。
  let buffer = ''
  let last: ModelDownloadInfo = { percent: 0, status: 'Starting…' }

  const parseSse = (chunk: string): void => {
    buffer += chunk
    let idx: number
    // 以空行（\n\n）为帧边界；只处理完整帧，余下的留在 buffer 里等下一块。
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          // 事件是**增量**字段：与上一次状态合并，避免部分字段被覆盖成 undefined。
          const event = JSON.parse(line.slice(6)) as ModelDownloadInfo
          last = { ...last, ...event }
          opts.onEvent(last)
        } catch {
          /* 跳过格式错误的帧 */
        }
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parseSse(decoder.decode(value, { stream: true }))
  }
  // 流结束前可能还剩一个未以 \n\n 收尾的残帧，需再冲一次。
  parseSse(decoder.decode())
  return last
}

/**
 * 从浏览器上传的本地文件夹安装扩展（旧的 `webkitdirectory` 路径）。
 *
 * @param files 目录内的全部文件（`webkitRelativePath` 保留层级）。
 * @param rootDir 目录根名，后端据此重建目录结构。
 * @returns 安装结果。
 */
export async function installExtensionLocal(files: File[], rootDir: string): Promise<{ ok: boolean; message: string }> {
  const form = new FormData()
  files.forEach((f) => form.append('files', f, f.webkitRelativePath || f.name))
  form.append('root_dir', rootDir)
  const res = await apiFetch(`${API_BASE}/extensions/install-local`, { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `install failed: ${res.status}` }
  }
  return { ok: true, message: 'installed' }
}

/**
 * 通过主进程原生目录对话框选中的路径安装扩展（推荐路径）。
 *
 * 与上面的 webkitdirectory 上传不同：文件读取与拷贝全在后端完成，
 * 渲染进程只传一个路径字符串，因此不会因大量文件 IO 冻住 UI。
 *
 * @param folderPath 主进程通过 `fs:selectFolder` 返回的绝对路径。
 * @returns 安装结果。
 */
export async function installExtensionFromDir(folderPath: string): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch(`${API_BASE}/extensions/install-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `install failed: ${res.status}` }
  }
  return { ok: true, message: 'installed' }
}
