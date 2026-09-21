/**
 * 外部 AI 服务模型权重下载接口（后端经 ModelScope CLI 拉取）。
 *
 * 与 `models.ts` 的 HF 下载不同：这里下载的是 Hunyuan3D / InstantMesh /
 * Stable-Zero123 等推理服务的权重，落到 MESHFORGE_SERVICES_ROOT/models 下，
 * 走 `modelscope download` 命令，后端以 SSE 流式回报其输出行。
 */

import { API_BASE, apiFetch } from './http'

/** 单个外部服务权重的下载 / 安装态。 */
export interface ModelServiceEntry {
  key: string
  label: string
  modelscopeId: string | null
  hfRef: string | null
  localDir: string
  installed: boolean
  sizeBytes: number
  root: string
}

/** `/model-services/download/status` 的响应。 */
export interface ModelDownloadsStatus {
  modelscopeAvailable: boolean
  modelscopeVersion: string | null
  services: ModelServiceEntry[]
}

/** SSE 下载事件；modelscope 输出行会随 `status` 持续到来。 */
export interface ModelDownloadServiceEvent {
  status?: string
  error?: string
  done?: boolean
}

/**
 * 拉取模型下载清单状态（含 modelscope CLI 可用性）。
 *
 * 后端不可达时返回一个可用的空骨架，避免设置页整块崩掉。
 */
export async function listModelDownloads(): Promise<ModelDownloadsStatus> {
  try {
    const res = await apiFetch(`${API_BASE}/model-services/download/status`)
    if (!res.ok) return { modelscopeAvailable: false, modelscopeVersion: null, services: [] }
    return (await res.json()) as ModelDownloadsStatus
  } catch {
    return { modelscopeAvailable: false, modelscopeVersion: null, services: [] }
  }
}

/**
 * 下载某个服务的权重并消费其 SSE 流。流以 done / error 事件收尾时 resolve。
 *
 * @param key 服务 key（见后端 model_downloads.PROFILES）。
 * @param onEvent 每次收到进度事件的回调。
 * @returns 是否成功（done）。
 */
export async function downloadModelService(
  key: string,
  onEvent: (e: ModelDownloadServiceEvent) => void
): Promise<boolean> {
  try {
    const res = await apiFetch(`${API_BASE}/model-services/download/${encodeURIComponent(key)}`, {
      method: 'POST',
      timeoutMs: 0
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`modelscope download failed: ${res.status} ${detail}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ok = false
    // 以空行（\n\n）切分 SSE 帧；半截帧留到下一块。
    const flush = (chunk: string): void => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6)) as ModelDownloadServiceEvent
            onEvent(ev)
            if (ev.error) ok = false
            if (ev.done) ok = true
          } catch {
            /* 跳过格式错误的帧 */
          }
        }
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      flush(decoder.decode(value, { stream: true }))
    }
    flush(decoder.decode())
    return ok
  } catch {
    return false
  }
}