/**
 * 生成任务的提交与轮询接口。
 *
 * 一次"生成"是**异步长任务**：`submitImage` 把图片与参数交给后端并立刻拿到
 * `job_id`，随后由前端按固定间隔调 `getJob` 轮询状态，直到进入终态
 * （`succeeded` / `failed` / `cancelled`）。用户中途放弃时调 `cancelJob`。
 *
 * 提交与查询都在 catch 里**重新包装错误信息**，把请求方法、URL 与关键入参
 * 一起带进 message——这两个调用是"点了没反应"类问题的高发点，带上上下文
 * 能让终端日志直接定位，不必再复现。
 */

import { API_BASE, apiFetch } from './http'

// ─── 生成任务 ─────────────────────────────────────────────────────────────────

/** 任务状态机；`pending`/`running` 为非终态，其余三个为终态。 */
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 后端返回的任务状态快照。 */
export interface JobStatus {
  /** 任务 id。 */
  job_id: string
  /** 当前状态。 */
  state: JobState
  /** 进度 0~100。 */
  progress: number
  /** 面向用户的进度描述。 */
  message: string
  /** 成功时的产物 URL（相对路径，前端需经 `fullUrl` 补全）。 */
  result_url: string | null
  /** 失败时的错误信息。 */
  error: string | null
}

/**
 * 以图片提交一次生成任务。
 *
 * @param image 主输入图。
 * @param generatorId 生成器 id（如 `hunyuan3d-2-mini`）。
 * @param params 生成器参数，透传给后端。
 * @param views 多视图模型的四向辅图（仅多视图生成器需要）。
 * @returns 新任务的 `job_id`。
 */
export async function submitImage(
  image: File,
  generatorId: string,
  params: Record<string, unknown> = {},
  views: Partial<Record<'front' | 'left' | 'back' | 'right', File>> = {}
): Promise<{ job_id: string }> {
  const form = new FormData()
  form.append('image', image)
  form.append('generator_id', generatorId)
  // 只追加用户真正提供的视图（缺视图的模型不需要空占位）。
  for (const tag of ['front', 'left', 'back', 'right'] as const) {
    const v = views[tag]
    if (v) form.append(tag, v)
  }
  // generatorId 已单独作为表单字段发送，从参数里剔除以免后端重复处理。
  const passthrough = { ...params }
  delete passthrough.generatorId
  form.append('params_json', JSON.stringify(passthrough))
  let res: Response
  try {
    res = await apiFetch(`${API_BASE}/generate/from-image`, {
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

/**
 * 查询任务状态。
 *
 * @param jobId 任务 id。
 * @returns 该任务的最新状态快照。
 */
export async function getJob(jobId: string): Promise<JobStatus> {
  let res: Response
  try {
    res = await apiFetch(`${API_BASE}/generate/jobs/${jobId}`)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`getJob: ${why} (GET ${API_BASE}/generate/jobs/${jobId})`)
  }
  if (!res.ok) throw new Error(`job status failed: ${res.status}`)
  return res.json()
}

/**
 * 取消一个正在进行的生成任务（fire-and-forget，请求失败也无副作用）。
 *
 * @param jobId 要取消的任务 id。
 */
export async function cancelJob(jobId: string): Promise<void> {
  await apiFetch(`${API_BASE}/generate/jobs/${jobId}/cancel`, { method: 'POST' })
}
