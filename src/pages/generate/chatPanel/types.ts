/**
 * 聊天面板的共享类型与常量。
 */

import type { AgentAction } from '../../../api'

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 一条聊天消息。 */
export interface ChatMessage {
  /** 稳定 id：既作 React key，也用于后续定位单条消息（重试/删除）。 */
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 模型的思考过程，仅 assistant 消息可能有；由 ThinkingBlock 独立折叠展示。 */
  thinking?: string
  /** 用户上传的参考图（data URL）：既便于直接渲染，也能随消息一起回传给后端。 */
  imageDataUrls?: string[]
  /** 本轮实际执行过的工具动作，由 ActionsCard 渲染。 */
  actions?: AgentAction[]
}

/** 本地 Ollama 场景下的推荐模型列表；云端 provider 的模型清单由后端返回。 */
export const MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'mistral:7b']
/** 消息内容超过这么多行就折叠，避免长回复把输入框挤出可视区。 */
export const COLLAPSE_AFTER = 4
