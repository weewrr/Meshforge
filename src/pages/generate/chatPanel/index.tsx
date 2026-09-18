/**
 * 生成页右侧的 Agent 聊天面板。
 *
 * 这是"用自然语言驱动整个应用"的入口：把当前上下文（当前网格、工作流清单、
 * 可用扩展）打包发给后端 LLM，再把返回的**工具动作**翻译成实际副作用
 * （更新查看器网格、运行工作流、导入新建的工作流）。
 *
 * 与其它面板的区别在于它是**有状态的长会话**：消息历史、附件、待运行的工作流
 * 都留在本地，因此这里的状态量明显大于普通展示组件。
 */

import { useEffect, useRef, useState } from 'react'
import { useAppStore, type ThinkingMode } from '../../../stores/app'
import { agentChat, agentModels, getWorkflow } from '../../../api'
import { useSceneStore } from '../../../stores/scene'
import { useWorkflowsStore } from '../../../stores/workflows'
import { useWorkflowRunStore } from '../../../stores/workflowRun'
import { allExtensions } from '../../../types'
import { useT } from '../../../i18n'
import { MODELS, COLLAPSE_AFTER, type ChatMessage } from './types'
import { ProseMessage } from './ProseMessage'
import { ActionsCard } from './ActionsCard'
import { ThinkingBlock } from './ThinkingBlock'
import { WorkflowProgressCard } from './WorkflowProgressCard'

/** Agent 聊天面板。 */
export default function ChatPanel() {
  const t = useT()
  const defaultModel = useAppStore((s) => s.defaultModel)
  const defaultThinking = useAppStore((s) => s.defaultThinking)
  const agentProvider = useAppStore((s) => s.agentProvider)
  const agentBaseUrl = useAppStore((s) => s.agentBaseUrl)
  const agentApiKey = useAppStore((s) => s.agentApiKey)
  const ollamaUrl = useAppStore((s) => s.ollamaUrl)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // 未配置默认模型时退回到内置推荐列表的第一个。
  const [model, setModel] = useState(defaultModel || MODELS[0])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  /** 已交给工作流运行器、正在等待结果的工作流；完成后会向 Agent 发一条后续消息。 */
  const [pendingWorkflow, setPendingWorkflow] = useState<{ id: string; name: string } | null>(null)
  /** 待发送的图片附件（data URL）。 */
  const [attachments, setAttachments] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(defaultThinking)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  // 镜像一份最新消息到 ref：下面的"工作流完成"副作用需要在回调里读到最新历史，
  // 但又不该把 messages 加进依赖（否则每来一条消息都会重新挂监听）。
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  // 场景 / 工作流 store
  const meshUrl = useSceneStore((s) => s.meshUrl)
  const meshStats = useSceneStore((s) => s.meshStats)
  const pushMeshUrl = useSceneStore((s) => s.pushMeshUrl)
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const workflows = useWorkflowsStore((s) => s.workflows)
  const importWorkflow = useWorkflowsStore((s) => s.importWorkflow)
  const run = useWorkflowRunStore((s) => s.run)
  const runState = useWorkflowRunStore((s) => s.runState)

  // 点击面板外部时收起模型下拉。
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  // 监听工作流跑完 → 主动向 Agent 发一条"后续该做什么"的消息。
  useEffect(() => {
    if (!pendingWorkflow) return
    // 只在终态才处理；running/paused/idle 都不是"结束"。
    if (runState !== 'succeeded' && runState !== 'failed' && runState !== 'cancelled') return

    const wf = pendingWorkflow
    // 立即清空：这个副作用只应对一次终态转换生效。
    setPendingWorkflow(null)

    if (runState === 'failed') {
      // 失败时只追加一条系统提示，不再调用 LLM（没有可汇报的产物）。
      setMessages((prev) => [...prev, {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        content: `The workflow '${wf.name}' failed.`
      }])
      return
    }
    // 用户主动取消：静默处理，不打扰。
    if (runState === 'cancelled') return

    const outputUrl = useSceneStore.getState().meshUrl
    const completionCtx = `Workflow '${wf.name}' just completed.${outputUrl ? ` Output mesh: ${outputUrl}` : ''} Ask the user what they'd like to do next.`
    void callAgent(messagesRef.current, { workflowCompletion: completionCtx })
    // 依赖刻意只放 runState / pendingWorkflow：本效果由"运行态转换"驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on run-state transition
  }, [runState, pendingWorkflow])

  // 新消息、加载态变化或出现进度卡片时，把视图滚到底部。
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading, pendingWorkflow])

  /** 组装发给后端 LLM 的上下文：当前网格、工作流清单、可用扩展。 */
  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    if (meshUrl) ctx.currentMeshPath = meshUrl
    if (meshStats?.triangles) ctx.meshTriangles = meshStats.triangles
    // 只带 id + 名字，够 LLM 选择要跑哪个工作流，避免上下文过长。
    if (workflows.length > 0) ctx.workflows = workflows.map((w) => ({ id: w.id, name: w.name }))
    const extensions = allExtensions()
    if (extensions.length > 0) {
      ctx.extensions = extensions.map((e) => ({ id: e.id, display_name: e.display_name, input: e.input, output: e.output }))
    }
    return ctx
  }

  /** 发送一轮对话并把返回的动作落实到各 store。 */
  async function callAgent(msgs: ChatMessage[], extraContext: Record<string, unknown> = {}) {
    setIsLoading(true)
    setError(null)
    try {
      const context = { ...buildContext(), ...extraContext }

      // 把本地消息结构转换成后端 API 的入参形状；
      // 同时把 data URL 的 `data:image/png;base64,` 前缀剥掉，只留纯 base64 负载。
      const apiMessages = msgs.map((m) => {
        const entry: { role: string; content: string; images?: string[] } = {
          role: m.role,
          content: m.content
        }
        if (m.imageDataUrls?.length) {
          entry.images = m.imageDataUrls.map((url) => url.split(',')[1])
        }
        return entry
      })
      // 工作流完成提示以一条 [System] 用户消息的形式注入，而不是塞进 context——
      // 这样它会成为对话历史的一部分，模型在后续轮次也能看到。
      if (extraContext.workflowCompletion) {
        apiMessages.push({ role: 'user', content: `[System] ${extraContext.workflowCompletion}` })
        // 已经从 context 挪进消息里，删掉避免重复传给后端。
        delete context.workflowCompletion
      }

      const data = await agentChat(apiMessages, {
        provider: agentProvider,
        ollamaUrl,
        baseUrl: agentBaseUrl,
        apiKey: agentApiKey,
        model,
        context,
        thinking: thinkingMode
      })

      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.message,
        // 空字符串归一成 undefined，方便下游用真值判断。
        thinking: data.thinking ?? undefined,
        actions: data.actions?.length ? data.actions : undefined
      }])

      // 取"最近一条带图的用户消息"的图片作为本次工作流的输入覆盖。
      const latestImageDataUrl = [...msgs].reverse()
        .find((m) => m.role === 'user' && m.imageDataUrls?.length)
        ?.imageDataUrls?.[0]
      const overrideImageData = latestImageDataUrl ? latestImageDataUrl.split(',')[1] : undefined

      // 逐个落实模型给出的工具动作。
      for (const action of data.actions ?? []) {
        if (action.payload?.type === 'mesh_update' && action.payload.url) {
          // 网格更新：压入查看器历史（因此可用 ActionsCard 的 Undo 回滚）。
          pushMeshUrl(action.payload.url)
        }
        if (action.payload?.type === 'run_workflow' && action.payload.workflow_id) {
          const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
          if (wf) {
            // 列表项只有元信息，执行需要完整文档，因此再拉一次。
            const full = await getWorkflow(wf.id)
            const overrideFile = overrideImageData ? dataUrlToFile(overrideImageData) : null
            void run(full, overrideFile)
            // 记下待运行项，等运行终态时回头通知 Agent。
            setPendingWorkflow({ id: wf.id, name: wf.name })
          }
        }
        if (action.payload?.type === 'create_workflow' && action.payload.workflow) {
          const draft = action.payload.workflow as { name: string; description: string; nodes: unknown[]; edges: unknown[] }
          const wf = {
            id: crypto.randomUUID(),
            ...draft,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
          await importWorkflow(wf as Parameters<typeof importWorkflow>[0])
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // 连接类错误换成可操作的提示（"后端没起来"），其余原样展示。
      setError(msg.includes('fetch') ? 'Cannot reach Meshforge API. Is the backend running?' : msg)
    } finally {
      setIsLoading(false)
    }
  }

  /** 把纯 base64 负载还原成 `File`，用于作为工作流的图片输入。 */
  function dataUrlToFile(base64: string, name = 'input.png', mime = 'image/png'): File {
    const binary = atob(base64)
    // 必须逐字节转成 Uint8Array：直接把 atob 的结果交给 File 会按 UTF-8 解释而损坏二进制。
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name, { type: mime })
  }

  /** 拉取当前 provider 下的可用模型清单，填充模型下拉。 */
  async function fetchOllamaModels() {
    // Ollama 场景下"地址"存在 ollamaUrl 而非 agentBaseUrl。
    const base = agentProvider === 'openai' ? agentBaseUrl : ollamaUrl
    const models = await agentModels(agentProvider, agentBaseUrl, agentApiKey, base)
    setOllamaModels(models)
  }

  // 用命令式方式创建文件选择器：通过 React 提交一个隐藏的 <input type="file">
  // 会让部分 Electron 版本的渲染进程卡死，因此改为按需临时建一个。
  function openImagePicker(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      handleFiles(files)
    }
    input.click()
  }

  /** 把选中的文件读成 data URL 加入附件列表；非图片直接忽略。 */
  function handleFiles(files: File[]) {
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        setAttachments((prev) => [...prev, dataUrl])
      }
      reader.readAsDataURL(file)
    })
  }

  /** 拖入时高亮并阻止浏览器默认的"打开文件"行为。 */
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  /** 只有真正离开面板（而非进入子元素）才取消高亮。 */
  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  /** 松手时把拖入的文件当作图片附件处理。 */
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  /** 让输入框随内容长高，上限 160px 之后转为内部滚动。 */
  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    // 先置 auto 才能拿到真实 scrollHeight（否则高度只增不减）。
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  /** 发送当前输入：先落一条用户消息，再发起请求。 */
  async function handleSend() {
    const text = input.trim()
    // 工作流运行中禁止并发发问，避免上下文与运行态互相打架。
    if (!text || isLoading || pendingWorkflow) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      // 仅在真有附件时才带该字段，保持消息对象干净。
      ...(attachments.length ? { imageDataUrls: [...attachments] } : {})
    }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setAttachments([])
    // 清空输入后手动把高度复位（onChange 不会再触发）。
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await callAgent(nextMessages)
  }

  // 历史折叠：超过 COLLAPSE_AFTER 条时默认只显示最后几条。
  const collapsed = !showAll && messages.length > COLLAPSE_AFTER
  const hidden = collapsed ? messages.length - COLLAPSE_AFTER : 0
  const visible = collapsed ? messages.slice(-COLLAPSE_AFTER) : messages

  return (
    <div
      className="gp-chat"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="gp-chat__dropoverlay">
          <p>{t('generate.chat.dropImage')}</p>
        </div>
      )}

      {/* Messages */}
      <div className="gp-chat__scroll">
        {messages.length === 0 && (
          <div className="gp-chat__empty">
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
            </svg>
            <p>{t('generate.chat.emptyHint')}</p>
          </div>
        )}

        {/* Previous messages pill */}
        {collapsed && (
          <button className="gp-chat__showall" onClick={() => setShowAll(true)}>
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {hidden} previous message{hidden > 1 ? 's' : ''}
          </button>
        )}

        {/* Message list */}
        <div className="gp-chat__list">
          {visible.map((msg) => (
            <div key={msg.id}>
              {/* 用户消息：附件图在上、文字气泡在下；助手消息：思考块 → 正文 → 动作卡片。 */}
              {msg.role === 'user' ? (
                <div className="gp-chat__msg gp-chat__msg--user">
                  {msg.imageDataUrls && msg.imageDataUrls.length > 0 && (
                    <div className="gp-chat__attachments">
                      {msg.imageDataUrls.map((url, i) => (
                        <img key={i} src={url} alt="" />
                      ))}
                    </div>
                  )}
                  <div className="gp-chat__bubble gp-chat__bubble--user">{msg.content}</div>
                </div>
              ) : (
                <div className="gp-chat__msg gp-chat__msg--assistant">
                  {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                  <ProseMessage content={msg.content} />
                  {msg.actions && msg.actions.length > 0 && (
                    // 传入 undoMesh：动作卡片里的撤销按钮直接回滚查看器网格。
                    <ActionsCard actions={msg.actions} onUndo={undoMesh} />
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Workflow progress card — visible while agent waits for workflow */}
          {pendingWorkflow && <WorkflowProgressCard name={pendingWorkflow.name} />}

          {/* Loading indicator：三点动画，逐个错开延迟做出波动感。 */}
          {isLoading && (
            <div className="gp-chat__loading">
              {[0, 1, 2].map((i) => (
                <span key={i} style={{ animationDelay: `${i * 130}ms` }} />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="gp-chat__error">
              <p>{error}</p>
            </div>
          )}

          {/* 滚动锚点：始终位于列表末尾，用于 scrollIntoView。 */}
          <div ref={endRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="gp-chat__inputbar">
        <div className="gp-chat__box">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="gp-chat__attachments">
              {attachments.map((url, i) => (
                <div key={i} className="gp-chat__attachment">
                  <img src={url} alt="" />
                  <button
                    // 按下标剔除该项（附件只在本次输入内有效，无重排风险）。
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove"
                    aria-label="Remove"
                  >
                    <svg aria-hidden="true" width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            // 从 1 行起，随内容长高（见 adjustHeight）。
            rows={1}
            placeholder="Ask Meshforge…"
            spellCheck={false}
            onChange={(e) => { setInput(e.target.value); adjustHeight() }}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行。
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
            }}
          />
          <div className="gp-chat__boxfoot">
            <div className="gp-chat__boxtools">
              <button title="Attach image" aria-label="Attach image" onClick={openImagePicker} className="gp-chat__toolbtn">
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </button>
              <button
                title={`Thinking: ${thinkingMode}`}
                aria-label={`Thinking: ${thinkingMode}`}
                // 三态循环：auto → on → off → auto。
                onClick={() => setThinkingMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'))}
                className={`gp-chat__toolbtn ${thinkingMode === 'on' ? 'gp-chat__toolbtn--think' : ''}`}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
                  {/* 关闭态在图标上划一道斜线。 */}
                  {thinkingMode === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="2" />}
                </svg>
              </button>
              <div className="gp-chat__modelpick" ref={modelPickerRef}>
                <button
                  // 展开时才去拉模型清单（懒加载），收起则不必请求。
                  onClick={() => { setShowModelPicker((v) => !v); if (!showModelPicker) void fetchOllamaModels() }}
                >
                  {model}
                  <svg aria-hidden="true" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {showModelPicker && (
                  <div className="gp-chat__modellist">
                    {ollamaModels.length === 0 ? (
                      <p className="gp-chat__modelempty">{t('generate.chat.noModels')}</p>
                    ) : (
                      ollamaModels.map((m) => (
                        <button key={m} onClick={() => { setModel(m); setShowModelPicker(false) }}>
                          {m}
                          {/* 当前选中项打勾。 */}
                          {m === model && (
                            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* 空输入或加载中禁用发送。 */}
            <button className="gp-chat__send" onClick={() => void handleSend()} disabled={!input.trim() || isLoading}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
        <p className="gp-chat__hint">Shift+Enter for new line</p>
      </div>
    </div>
  )
}
