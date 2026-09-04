const API_BASE = 'http://127.0.0.1:8766'

import type { GeneratorInfo, Workflow, WorkflowExtension, WorkflowMeta } from './types'
import { setExtensionsCache } from './types'

export function fullUrl(path: string): string {
  return path.startsWith('http') || path.startsWith('blob:') ? path : `${API_BASE}${path}`
}

// ─── Generators / Extensions ─────────────────────────────────────────────────

export async function listGenerators(): Promise<GeneratorInfo[]> {
  const res = await fetch(`${API_BASE}/generators`)
  if (!res.ok) throw new Error(`list generators failed: ${res.status}`)
  return res.json()
}

/** Unified extension list (model generators + mesh processing tools). */
export async function listExtensions(): Promise<WorkflowExtension[]> {
  const res = await fetch(`${API_BASE}/extensions`)
  if (!res.ok) throw new Error(`list extensions failed: ${res.status}`)
  const extensions = (await res.json()) as WorkflowExtension[]
  setExtensionsCache(extensions)
  return extensions
}

/** Run a mesh processing tool (mesh → mesh). */
export async function processMesh(
  meshUrl: string,
  extensionId: string,
  params: Record<string, unknown>
): Promise<{ job_id: string }> {
  const res = await fetch(`${API_BASE}/process/mesh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mesh_url: meshUrl, extension_id: extensionId, params })
  })
  if (!res.ok) throw new Error(`process mesh failed: ${res.status}`)
  return res.json()
}

/** List files under a workspace subdirectory (For Each iterator). */
export async function listDirFiles(dir: string, extensions: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/files/list-dir?dir=${encodeURIComponent(dir)}&ext=${encodeURIComponent(extensions)}`)
  if (!res.ok) throw new Error(`list dir failed: ${res.status}`)
  const data = (await res.json()) as { files: string[] }
  return data.files
}

// ─── Generation jobs ─────────────────────────────────────────────────────────

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobStatus {
  job_id: string
  state: JobState
  progress: number
  message: string
  result_url: string | null
  error: string | null
}

export async function submitImage(
  image: File,
  generatorId: string,
  params: Record<string, unknown> = {}
): Promise<{ job_id: string }> {
  const form = new FormData()
  form.append('image', image)
  form.append('generator_id', generatorId)
  const passthrough = { ...params }
  delete passthrough.generatorId
  form.append('params_json', JSON.stringify(passthrough))
  let res: Response
  try {
    res = await fetch(`${API_BASE}/generate/from-image`, {
      method: 'POST',
      body: form
    })
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`submitImage: ${why} (POST ${API_BASE}/generate/from-image, generator=${generatorId}, image=${image.name})`)
  }
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`submit failed: ${res.status} ${detail}`)
  }
  return res.json()
}

export async function getJob(jobId: string): Promise<JobStatus> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/generate/jobs/${jobId}`)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`getJob: ${why} (GET ${API_BASE}/generate/jobs/${jobId})`)
  }
  if (!res.ok) throw new Error(`job status failed: ${res.status}`)
  return res.json()
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`${API_BASE}/generate/jobs/${jobId}/cancel`, { method: 'POST' })
}

// ─── Uploads (node-embedded assets) ──────────────────────────────────────────

export async function uploadFile(file: File): Promise<{ url: string; fileName: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  return res.json()
}

/**
 * Import a mesh by absolute filesystem path (Modly-aligned). The native file
 * dialog runs in the Electron main process; the backend serves the file (or a
 * trimesh-converted GLB) through /optimize/serve-file. No bytes go through the
 * renderer and no Chromium <input type=file> is involved.
 */
export async function importMeshByPath(path: string): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/optimize/import-by-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
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
 * Import an image by absolute filesystem path (Modly-aligned). The native file
 * dialog runs in the Electron main process; the backend copies the file into
 * workspace/uploads and returns the same shape as /upload — so imageNode,
 * Generate-page preview and agent attachments all consume it unchanged. No
 * Chromium <input type=file> is involved.
 */
export async function importImageByPath(path: string): Promise<{ url: string; fileName: string }> {
  const res = await fetch(`${API_BASE}/upload/from-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
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

// ─── Workflows ───────────────────────────────────────────────────────────────

export async function listWorkflows(): Promise<WorkflowMeta[]> {
  const res = await fetch(`${API_BASE}/workflows`)
  if (!res.ok) throw new Error(`list workflows failed: ${res.status}`)
  return res.json()
}

export async function getWorkflow(id: string): Promise<Workflow> {
  const res = await fetch(`${API_BASE}/workflows/${id}`)
  if (!res.ok) throw new Error(`get workflow failed: ${res.status}`)
  return res.json()
}

export async function saveWorkflow(workflow: Workflow): Promise<void> {
  const res = await fetch(`${API_BASE}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workflow)
  })
  if (!res.ok) throw new Error(`save workflow failed: ${res.status}`)
}

export async function deleteWorkflow(id: string): Promise<void> {
  await fetch(`${API_BASE}/workflows/${id}`, { method: 'DELETE' })
}

// ─── Agent (ChatPanel) ───────────────────────────────────────────────────────

export interface AgentAction {
  tool: string
  result: string
  payload?: {
    type?: string
    url?: string
    face_count?: string | number
    workflow_id?: string
    workflow_name?: string
    workflow?: { name: string; description: string; nodes: unknown[]; edges: unknown[] }
  } | null
}

export interface AgentChatResult {
  message: string
  actions: AgentAction[]
  thinking: string | null
}

export async function agentChat(
  messages: { role: string; content: string; images?: string[] }[],
  opts: {
    ollamaUrl: string
    model: string
    context: Record<string, unknown>
    thinking: string
  }
): Promise<AgentChatResult> {
  const res = await fetch(`${API_BASE}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ollama_url: opts.ollamaUrl,
      model: opts.model,
      context: opts.context,
      thinking: opts.thinking
    })
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`agent chat failed: ${res.status} ${detail}`)
  }
  return res.json()
}

export async function agentModels(ollamaUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE}/agent/models?ollama_url=${encodeURIComponent(ollamaUrl)}`)
    if (!res.ok) return []
    const data = (await res.json()) as { models: string[] }
    return data.models ?? []
  } catch {
    return []
  }
}

// ─── Extensions ──────────────────────────────────────────────────────────────

export type InstallStep = 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'

export interface InstallProgress {
  step: InstallStep
  percent?: number
  extensionId?: string
  message?: string
}

export async function installExtension(url: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/extensions/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `install failed: ${res.status}` }
  }
  return { ok: true, message: 'installed' }
}

export async function installExtensionStatus(): Promise<InstallProgress | null> {
  const res = await fetch(`${API_BASE}/extensions/install/status`)
  if (!res.ok) return null
  const data = (await res.json()) as { progress: InstallProgress | null }
  return data.progress
}

export async function uninstallExtension(id: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/extensions/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `uninstall failed: ${res.status}` }
  }
  return { ok: true, message: 'uninstalled' }
}

export async function reloadExtensionsApi(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${API_BASE}/extensions/reload`, { method: 'POST' })
    if (!res.ok) return { ok: false, message: `reload failed: ${res.status}` }
    return { ok: true, message: 'reloaded' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Model weight downloads (HF Hub → server/models/<ext_id>) ───────────────

export interface ModelStatusEntry {
  extId: string
  repoId: string
  skipPrefixes: string[]
  includePrefixes: string[]
  downloaded: boolean
  sizeBytes: number
}

export interface ModelDownloadInfo {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  status?: string
  bytesDownloaded?: number
  totalBytes?: number
  paused?: boolean
  cancelled?: boolean
  error?: string
}

/** Download state of every model extension that declares an HF repo. */
export async function listModelStatus(): Promise<ModelStatusEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/model/status`)
    if (!res.ok) return []
    const data = (await res.json()) as { models?: ModelStatusEntry[] }
    return data.models ?? []
  } catch {
    return []
  }
}

export async function pauseModelDownload(id: string): Promise<void> {
  await fetch(`${API_BASE}/model/hf-download/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
}

export async function cancelModelDownload(id: string): Promise<void> {
  await fetch(`${API_BASE}/model/hf-download/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
}

/**
 * Start an HF model download and consume its SSE stream.
 * Resolves with the terminal event when the stream ends (done / paused /
 * cancelled / error). Pause is resumable: the .part files are kept server-side
 * and the next call with the same id resumes via Range headers.
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
  if (opts.skipPrefixes?.length) params.set('skip_prefixes', JSON.stringify(opts.skipPrefixes))
  if (opts.includePrefixes?.length) params.set('include_prefixes', JSON.stringify(opts.includePrefixes))
  if (opts.token) params.set('token', opts.token)

  const res = await fetch(`${API_BASE}/model/hf-download?${params.toString()}`)
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`model download failed: ${res.status} ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let last: ModelDownloadInfo = { percent: 0, status: 'Starting…' }

  const parseSse = (chunk: string): void => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6)) as ModelDownloadInfo
          last = { ...last, ...event }
          opts.onEvent(last)
        } catch {
          /* skip malformed frames */
        }
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parseSse(decoder.decode(value, { stream: true }))
  }
  parseSse(decoder.decode())
  return last
}

/** Install an extension from an uploaded local folder (webkitdirectory input). */
export async function installExtensionLocal(files: File[], rootDir: string): Promise<{ ok: boolean; message: string }> {
  const form = new FormData()
  files.forEach((f) => form.append('files', f, f.webkitRelativePath || f.name))
  form.append('root_dir', rootDir)
  const res = await fetch(`${API_BASE}/extensions/install-local`, { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { ok: false, message: (body as { detail?: string }).detail ?? `install failed: ${res.status}` }
  }
  return { ok: true, message: 'installed' }
}

/** Install an extension from a local folder path chosen via the main-process
 *  native directory dialog (fs:selectFolder). The backend copies the tree —
 *  no renderer file IO, unlike the legacy webkitdirectory upload above. */
export async function installExtensionFromDir(folderPath: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/extensions/install-dir`, {
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

// ─── Workspace asset library ─────────────────────────────────────────────────

import type { LibraryEntry } from './pages/generate/assetLibrary'

export async function listLibrary(): Promise<LibraryEntry[]> {
  const res = await fetch(`${API_BASE}/library`)
  if (!res.ok) throw new Error(`list library failed: ${res.status}`)
  const data = (await res.json()) as { success: boolean; entries?: LibraryEntry[]; message?: string }
  if (!data.success) throw new Error(data.message ?? 'list library failed')
  return data.entries ?? []
}

// ─── Health ──────────────────────────────────────────────────────────────────

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`)
    return res.ok
  } catch {
    return false
  }
}
