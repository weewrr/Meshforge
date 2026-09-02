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
  const res = await fetch(`${API_BASE}/generate/from-image`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`submit failed: ${res.status} ${detail}`)
  }
  return res.json()
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${API_BASE}/generate/jobs/${jobId}`)
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
