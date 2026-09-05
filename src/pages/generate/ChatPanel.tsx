import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, type ThinkingMode } from '../../stores/app'
import { agentChat, agentModels, getWorkflow, type AgentAction } from '../../api'
import { useSceneStore } from '../../stores/scene'
import { useWorkflowsStore } from '../../stores/workflows'
import { useWorkflowRunStore } from '../../stores/workflowRun'
import { allExtensions } from '../../types'
import { useT } from '../../i18n'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  actions?: AgentAction[]
}

const MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'mistral:7b']
const COLLAPSE_AFTER = 4

// ─── Prose renderer — basic markdown-like ────────────────────────────────────

function ProseMessage({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/)
  return (
    <div className="gp-chat__prose">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()) || l.trim() === '')
        if (isList) {
          return (
            <ul key={i}>
              {lines.filter(Boolean).map((l, j) => (
                <li key={j}>
                  <span className="gp-chat__bullet">•</span>
                  <span>{l.replace(/^[-•*]\s/, '')}</span>
                </li>
              ))}
            </ul>
          )
        }
        return <p key={i}>{block}</p>
      })}
    </div>
  )
}

// ─── Actions card ─────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  decimate_mesh: 'Decimated mesh',
  smooth_mesh: 'Smoothed mesh',
  list_models: 'Listed models',
  unload_models: 'Unloaded models',
  get_mesh_info: 'Inspected mesh',
  get_generation_status: 'Checked generation',
  list_workflows: 'Listed workflows',
  run_workflow: 'Ran workflow',
  create_workflow: 'Created workflow'
}

function ActionsCard({ actions, onUndo }: { actions: AgentAction[]; onUndo?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const meshActions = actions.filter((a) => a.payload?.type === 'mesh_update')
  const canUndo = meshActions.length > 0 && !!onUndo

  return (
    <div className="gp-chat__actions">
      <div className="gp-chat__actionshead">
        <span className="gp-chat__actionslabel">
          {actions.length} action{actions.length > 1 ? 's' : ''} performed
        </span>
        <div className="gp-chat__actionstools">
          {canUndo && (
            <button className="gp-chat__actionsundo" onClick={onUndo} title="Undo">
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 2.28-5.93" />
              </svg>
              Undo
            </button>
          )}
          <button className="gp-chat__actionscaret" onClick={() => setExpanded((v) => !v)} title="Expand">
            <svg aria-hidden="true"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={expanded ? 'gp-chat__caret--open' : ''}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>
      {expanded && (
        <div className="gp-chat__actionsbody">
          {actions.map((a, i) => (
            <div key={i} className="gp-chat__actionrow">
              <span className="gp-chat__actionname">{TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, ' ')}</span>
              {a.payload?.type === 'mesh_update' && a.payload.face_count && (
                <span className="gp-chat__actionfaces">{String(a.payload.face_count)} faces</span>
              )}
              {a.payload?.type === 'run_workflow' && (
                <span className="gp-chat__actionwf">{a.payload.workflow_name}</span>
              )}
              {a.payload?.type === 'create_workflow' && a.payload.workflow && (
                <span className="gp-chat__actionwf">{a.payload.workflow.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Thinking block ───────────────────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="gp-chat__thinking">
      <button className="gp-chat__thinkingbtn" onClick={() => setOpen((v) => !v)}>
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
        </svg>
        <span>Reasoning</span>
        <svg aria-hidden="true"
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={open ? 'gp-chat__caret--open' : ''}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="gp-chat__thinkingbody">
          <p>{content}</p>
        </div>
      )}
    </div>
  )
}

// ─── Workflow progress card ────────────────────────────────────────────────────

function WorkflowProgressCard({ name }: { name: string }) {
  const runState = useWorkflowRunStore((s) => s.runState)
  const nodeStates = useWorkflowRunStore((s) => s.nodeStates)
  const nodeProgress = useWorkflowRunStore((s) => s.nodeProgress)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)

  const pct = useMemo(() => {
    const values = Object.values(nodeProgress)
    if (values.length === 0) return 0
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100)
  }, [nodeProgress])

  const done = useMemo(() => Object.values(nodeStates).filter((s) => s === 'succeeded').length, [nodeStates])
  const total = useMemo(() => Object.keys(nodeStates).length, [nodeStates])

  return (
    <div className="gp-chat__wfcard">
      <div className="gp-chat__wfhead">
        <div className="gp-chat__wfname">
          <span className="gp-chat__wfdot" />
          <span>{name}</span>
        </div>
        <span className="gp-chat__wfpct">{pct}%</span>
      </div>
      <div className="gp-chat__wfbar">
        <div className="gp-chat__wffill" style={{ width: `${pct}%` }} />
      </div>
      {total > 0 && (
        <p className="gp-chat__wfstep">
          {done}/{total} nodes · {activeNodeId ? 'running…' : runState === 'succeeded' ? 'completed' : runState}
        </p>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ChatPanel() {
  const t = useT()
  const defaultModel = useAppStore((s) => s.defaultModel)
  const defaultThinking = useAppStore((s) => s.defaultThinking)
  const ollamaUrl = useAppStore((s) => s.ollamaUrl)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [model, setModel] = useState(defaultModel || MODELS[0])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [pendingWorkflow, setPendingWorkflow] = useState<{ id: string; name: string } | null>(null)
  const [attachments, setAttachments] = useState<string[]>([]) // data URLs
  const [isDragging, setIsDragging] = useState(false)
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(defaultThinking)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  // Scene / workflow stores
  const meshUrl = useSceneStore((s) => s.meshUrl)
  const meshStats = useSceneStore((s) => s.meshStats)
  const pushMeshUrl = useSceneStore((s) => s.pushMeshUrl)
  const undoMesh = useSceneStore((s) => s.undoMesh)
  const workflows = useWorkflowsStore((s) => s.workflows)
  const importWorkflow = useWorkflowsStore((s) => s.importWorkflow)
  const run = useWorkflowRunStore((s) => s.run)
  const runState = useWorkflowRunStore((s) => s.runState)

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  // Watch workflow completion → send follow-up to agent
  useEffect(() => {
    if (!pendingWorkflow) return
    if (runState !== 'succeeded' && runState !== 'failed' && runState !== 'cancelled') return

    const wf = pendingWorkflow
    setPendingWorkflow(null)

    if (runState === 'failed') {
      setMessages((prev) => [...prev, {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        content: `The workflow '${wf.name}' failed.`
      }])
      return
    }
    if (runState === 'cancelled') return

    const outputUrl = useSceneStore.getState().meshUrl
    const completionCtx = `Workflow '${wf.name}' just completed.${outputUrl ? ` Output mesh: ${outputUrl}` : ''} Ask the user what they'd like to do next.`
    void callAgent(messagesRef.current, { workflowCompletion: completionCtx })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on run-state transition
  }, [runState, pendingWorkflow])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading, pendingWorkflow])

  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    if (meshUrl) ctx.currentMeshPath = meshUrl
    if (meshStats?.triangles) ctx.meshTriangles = meshStats.triangles
    if (workflows.length > 0) ctx.workflows = workflows.map((w) => ({ id: w.id, name: w.name }))
    const extensions = allExtensions()
    if (extensions.length > 0) {
      ctx.extensions = extensions.map((e) => ({ id: e.id, display_name: e.display_name, input: e.input, output: e.output }))
    }
    return ctx
  }

  async function callAgent(msgs: ChatMessage[], extraContext: Record<string, unknown> = {}) {
    setIsLoading(true)
    setError(null)
    try {
      const context = { ...buildContext(), ...extraContext }

      // Inject workflow completion as a system hint if present
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
      if (extraContext.workflowCompletion) {
        apiMessages.push({ role: 'user', content: `[System] ${extraContext.workflowCompletion}` })
        delete context.workflowCompletion
      }

      const data = await agentChat(apiMessages, {
        ollamaUrl,
        model,
        context,
        thinking: thinkingMode
      })

      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.message,
        thinking: data.thinking ?? undefined,
        actions: data.actions?.length ? data.actions : undefined
      }])

      // Extract base64 from the most recent user message that had an image attached
      const latestImageDataUrl = [...msgs].reverse()
        .find((m) => m.role === 'user' && m.imageDataUrls?.length)
        ?.imageDataUrls?.[0]
      const overrideImageData = latestImageDataUrl ? latestImageDataUrl.split(',')[1] : undefined

      for (const action of data.actions ?? []) {
        if (action.payload?.type === 'mesh_update' && action.payload.url) {
          pushMeshUrl(action.payload.url)
        }
        if (action.payload?.type === 'run_workflow' && action.payload.workflow_id) {
          const wf = workflows.find((w) => w.id === action.payload!.workflow_id)
          if (wf) {
            const full = await getWorkflow(wf.id)
            const overrideFile = overrideImageData ? dataUrlToFile(overrideImageData) : null
            void run(full, overrideFile)
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
      setError(msg.includes('fetch') ? 'Cannot reach Meshforge API. Is the backend running?' : msg)
    } finally {
      setIsLoading(false)
    }
  }

  function dataUrlToFile(base64: string, name = 'input.png', mime = 'image/png'): File {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name, { type: mime })
  }

  async function fetchOllamaModels() {
    const models = await agentModels(ollamaUrl)
    setOllamaModels(models)
  }

  // Imperative file input — committing a hidden <input type="file"> through React
  // freezes the renderer on some Electron builds. Create it on demand instead.
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

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || isLoading || pendingWorkflow) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      ...(attachments.length ? { imageDataUrls: [...attachments] } : {})
    }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await callAgent(nextMessages)
  }

  // Collapsed history
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
                    <ActionsCard actions={msg.actions} onUndo={undoMesh} />
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Workflow progress card — visible while agent waits for workflow */}
          {pendingWorkflow && <WorkflowProgressCard name={pendingWorkflow.name} />}

          {/* Loading indicator */}
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
            rows={1}
            placeholder="Ask Meshforge…"
            spellCheck={false}
            onChange={(e) => { setInput(e.target.value); adjustHeight() }}
            onKeyDown={(e) => {
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
                onClick={() => setThinkingMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'))}
                className={`gp-chat__toolbtn ${thinkingMode === 'on' ? 'gp-chat__toolbtn--think' : ''}`}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
                  {thinkingMode === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="2" />}
                </svg>
              </button>
              <div className="gp-chat__modelpick" ref={modelPickerRef}>
                <button
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
