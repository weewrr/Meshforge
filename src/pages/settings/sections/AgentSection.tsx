/**
 * 设置页 · 内置 Agent（聊天面板）配置。
 *
 * 分两组：模型（provider / 地址 / API Key / 模型名）与思考模式。
 * 其中"测试连接"会真的去拉一次模型清单，因此它同时也是校验地址与密钥是否可用的手段。
 *
 * 一个关键约定：本组件对输入使用**草稿状态**（`*Draft`），只有点"保存"才写回
 * app store——否则用户每敲一个字符都会触发一次落盘与 UI 重套用。
 */

import { useEffect, useState } from 'react'
import { agentModels } from '../../../api'
import { useT } from '../../../i18n'
import { useAppStore, type AgentProvider, type ThinkingMode } from '../../../stores/app'

/** Agent 配置区块。 */
export function AgentSection() {
  const agentProvider = useAppStore((s) => s.agentProvider)
  const agentBaseUrl = useAppStore((s) => s.agentBaseUrl)
  const agentApiKey = useAppStore((s) => s.agentApiKey)
  const ollamaUrl = useAppStore((s) => s.ollamaUrl)
  const defaultModel = useAppStore((s) => s.defaultModel)
  const defaultThinking = useAppStore((s) => s.defaultThinking)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  // 草稿状态：与 store 里的值解耦，点"保存"时才提交。
  const [providerDraft, setProviderDraft] = useState<AgentProvider>(agentProvider)
  // 两种 provider 共用同一个地址输入框：openai 对应 agentBaseUrl，ollama 对应 ollamaUrl。
  const [baseUrlDraft, setBaseUrlDraft] = useState(agentBaseUrl || ollamaUrl)
  const [apiKeyDraft, setApiKeyDraft] = useState(agentApiKey)
  const [showKey, setShowKey] = useState(false)
  const [modelDraft, setModelDraft] = useState(defaultModel)
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)

  // 外部值变化（例如另一处改了设置）时同步回草稿，避免出现"显示的是旧值"。
  useEffect(() => setProviderDraft(agentProvider), [agentProvider])
  useEffect(() => setBaseUrlDraft(agentBaseUrl || ollamaUrl), [agentBaseUrl, ollamaUrl])
  useEffect(() => setApiKeyDraft(agentApiKey), [agentApiKey])
  useEffect(() => setModelDraft(defaultModel), [defaultModel])

  const isOpenai = providerDraft === 'openai'

  /** 真实发起一次模型清单请求；同时充当"连接测试"。 */
  async function handleTestConnection(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    // ollama 没有独立的"OpenAI 兼容 base_url"概念，因此两个参数传同一个值。
    const found = await agentModels(providerDraft, baseUrlDraft.trim(), apiKeyDraft.trim(), baseUrlDraft.trim())
    setModels(found)
    // 能拉到任意模型即视为连接成功。
    setTestResult(found.length > 0 ? 'ok' : 'error')
    setTesting(false)
  }

  /** 把草稿写回设置，并顺带刷新一次模型清单。 */
  function handleSave(): void {
    if (isOpenai) {
      patch({
        agentProvider: 'openai',
        agentBaseUrl: baseUrlDraft.trim(),
        agentApiKey: apiKeyDraft.trim(),
        defaultModel: modelDraft.trim()
      })
    } else {
      patch({
        agentProvider: 'ollama',
        // 留空则回退到本机默认端口，避免存下一个空地址导致后续请求失败。
        ollamaUrl: baseUrlDraft.trim() || 'http://localhost:11434',
        defaultModel: modelDraft.trim()
      })
    }
    // 保存后立刻测一次，让用户马上看到这套配置是否可用。
    void handleTestConnection()
  }

  /** 思考模式选项；`key` 用于拼 i18n key（含对应的 `*Desc` 说明）。 */
  const THINKING_OPTIONS: { value: ThinkingMode; key: string }[] = [
    { value: 'auto', key: 'thinkAuto' },
    { value: 'on', key: 'thinkOn' },
    { value: 'off', key: 'thinkOff' }
  ]

  return (
    <div className="st-agent">
      <div>
        <h2 className="st-agent__title">{t('settings.agent.title')}</h2>
        <p className="st-agent__subtitle">{t('settings.agent.subtitle')}</p>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">{t('settings.agent.groupModel')}</h3>
        <label className="st-agent__label">{t('settings.agent.providerLabel')}</label>
        <div className="st-agent__radios st-agent__provider">
          {(
            [
              { value: 'openai', key: 'providerOpenai' },
              { value: 'ollama', key: 'providerOllama' }
            ] as { value: AgentProvider; key: string }[]
          ).map((opt) => (
            <label key={opt.value} className="st-agent__radio">
              <input
                type="radio"
                name="provider"
                value={opt.value}
                checked={providerDraft === opt.value}
                onChange={() => setProviderDraft(opt.value)}
              />
              <div>
                <p className="st-agent__radiolabel">{t(`settings.agent.${opt.key}`)}</p>
                <p className="st-agent__hint">{t(`settings.agent.${opt.key}Desc`)}</p>
              </div>
            </label>
          ))}
        </div>

        <label className="st-agent__label">
          {/* 两种 provider 对"地址"的称呼不同，这里跟着切换标签。 */}
          {isOpenai ? t('settings.agent.baseUrlLabel') : t('settings.agent.urlLabel')}
        </label>
        <div className="st-agent__urlrow">
          <input
            value={baseUrlDraft}
            // 改动地址即作废上一次测试结果，避免展示过期结论。
            onChange={(e) => { setBaseUrlDraft(e.target.value); setTestResult(null) }}
            placeholder={isOpenai ? 'https://api.example.com/v1' : 'http://localhost:11434'}
          />
          <button onClick={() => void handleTestConnection()} disabled={testing}>
            {testing ? t('settings.agent.testing') : t('settings.agent.test')}
          </button>
        </div>
        <p className="st-agent__hint">
          {isOpenai ? t('settings.agent.baseUrlHint') : t('settings.agent.urlHint')}
        </p>

        {/* API Key 只有 OpenAI 兼容端点需要；本地 Ollama 无需鉴权。 */}
        {isOpenai && (
          <>
            <label className="st-agent__label">{t('settings.agent.apiKeyLabel')}</label>
            <div className="st-agent__urlrow">
              <input
                className="st-token__field"
                // 默认以密码形式掩盖，由"眼睛"按钮切换为明文。
                type={showKey ? 'text' : 'password'}
                value={apiKeyDraft}
                onChange={(e) => { setApiKeyDraft(e.target.value); setTestResult(null) }}
                placeholder={t('settings.agent.apiKeyPlaceholder')}
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? t('settings.agent.hideKey') : t('settings.agent.showKey')}
                className="st-token__eye st-agent__urlrow-btn"
              >
                {showKey ? (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p className="st-agent__hint">{t('settings.agent.apiKeyHint')}</p>
          </>
        )}

        {/* 测试结果三态提示：未测 / 成功（附模型数）/ 失败。 */}
        {testResult === null && <p className="st-agent__hint">{t('settings.agent.testHint')}</p>}
        {testResult === 'ok' && (
          <p className="st-agent__hint st-agent__hint--ok">{t('settings.agent.connOk', { count: models.length })}</p>
        )}
        {testResult === 'error' && <p className="st-agent__hint st-agent__hint--bad">{t('settings.agent.connErr')}</p>}

        <label className="st-agent__label">{t('settings.agent.modelLabel')}</label>
        {/* 拉到了模型清单就用下拉（避免拼错名字）；否则退化成自由输入，
            让用户可以先手填模型名再测试。 */}
        {models.length > 0 ? (
          <select value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} className="st-agent__select">
            <option value="" disabled>{t('settings.agent.modelPlaceholder')}</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder={t('settings.agent.modelPlaceholder')}
            className="st-agent__input"
          />
        )}
        <p className="st-agent__hint">{t('settings.agent.modelHint')}</p>

        <button onClick={handleSave} className="st-agent__save">{t('settings.agent.save')}</button>
      </div>

      <div className="st-agent__group">
        <h3 className="st-agent__grouptitle">{t('settings.agent.groupThinking')}</h3>
        <label className="st-agent__label">{t('settings.agent.modeLabel')}</label>
        <div className="st-agent__radios">
          {/* 思考模式无需草稿：单选即生效，没有"输错"的风险。 */}
          {THINKING_OPTIONS.map((opt) => (
            <label key={opt.value} className="st-agent__radio">
              <input
                type="radio"
                name="thinking"
                value={opt.value}
                checked={defaultThinking === opt.value}
                onChange={() => patch({ defaultThinking: opt.value })}
              />
              <div>
                <p className="st-agent__radiolabel">{t(`settings.agent.${opt.key}`)}</p>
                <p className="st-agent__hint">{t(`settings.agent.${opt.key}Desc`)}</p>
              </div>
            </label>
          ))}
        </div>
        <p className="st-agent__hint">{t('settings.agent.modeHint')}</p>
      </div>
    </div>
  )
}
