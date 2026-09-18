/**
 * 与后端 Agent（聊天面板）的对话接口。
 *
 * 把用户在 ChatPanel 里发的消息、附件图片与上下文打包成 `/agent/chat`
 * 请求，由后端 LLM 规划出一组工具动作（生成、改工作流等）后返回；
 * `agentModels` 则用于填充模型下拉框，失败时静默返回空数组。
 */

import { API_BASE, apiFetch } from './http'

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

export interface AgentChatOpts {
  provider: string
  ollamaUrl: string
  baseUrl: string
  apiKey: string
  model: string
  context: Record<string, unknown>
  thinking: string
}

export async function agentChat(
  messages: { role: string; content: string; images?: string[] }[],
  opts: AgentChatOpts
): Promise<AgentChatResult> {
  const res = await apiFetch(`${API_BASE}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      provider: opts.provider,
      ollama_url: opts.ollamaUrl,
      base_url: opts.baseUrl,
      api_key: opts.apiKey,
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

export async function agentModels(
  provider: string,
  baseUrl: string,
  apiKey: string,
  ollamaUrl: string
): Promise<string[]> {
  const params = new URLSearchParams({
    provider,
    base_url: baseUrl,
    api_key: apiKey,
    ollama_url: ollamaUrl
  })
  try {
    const res = await apiFetch(`${API_BASE}/agent/models?${params.toString()}`)
    if (!res.ok) return []
    const data = (await res.json()) as { models: string[] }
    return data.models ?? []
  } catch {
    // 任意异常一律降级为空数组，避免下拉框渲染中断。
    return []
  }
}
