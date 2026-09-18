/**
 * 设置页"集成"分区：扩展安装来源与外部工具的接入配置。
 */

import { useEffect, useState } from 'react'
import { Card, Row, Section } from '../../../components/ui'
import { useT } from '../../../i18n'
import { useAppStore } from '../../../stores/app'

export function IntegrationsSection() {
  const savedToken = useAppStore((s) => s.hfToken)
  const patch = useAppStore((s) => s.patch)
  const [token, setToken] = useState(savedToken)
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const t = useT()

  useEffect(() => setToken(savedToken), [savedToken])

  function save(value: string): void {
    setStatus('saving')
    patch({ hfToken: value })
    setStatus('saved')
    // 2.5 秒后回到 idle，让"已保存"反馈自然淡出。
    setTimeout(() => setStatus('idle'), 2500)
  }

  function handleClear(): void {
    setToken('')
    save('')
  }

  return (
    <Section title={t('settings.integrations.title')} subtitle={t('settings.integrations.subtitle')}>
      <div className="st-grid">
        <Card
          title={t('settings.integrations.hfTitle')}
          description={t('settings.integrations.hfDesc')}
        >
          <Row label={t('settings.integrations.accessTokenLabel')} description={t('settings.integrations.accessTokenDesc')}>
            <div className="st-token">
              <div className="st-token__field">
                <input
                  type={visible ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setStatus('idle') }}
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && save(token.trim())}
                  placeholder={t('settings.integrations.tokenPlaceholder')}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  title={visible ? t('settings.integrations.hideToken') : t('settings.integrations.showToken')}
                  aria-label={visible ? t('settings.integrations.hideToken') : t('settings.integrations.showToken')}
                  className="st-token__eye"
                >
                  {visible ? (
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
              {token && (
                <button onClick={handleClear} title={t('settings.integrations.removeToken')} aria-label={t('settings.integrations.removeToken')} className="st-token__clear">
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => save(token.trim())}
                disabled={status === 'saving' || !token.trim()}
                className={`st-actionbtn st-actionbtn--accent ${
                  status === 'saved' ? 'st-actionbtn--ok' : status === 'error' ? 'st-actionbtn--bad' : ''
                }`}
              >
                {status === 'saving' ? t('settings.integrations.saving') : status === 'saved' ? t('settings.integrations.saved') : status === 'error' ? t('settings.integrations.failed') : t('settings.integrations.save')}
              </button>
            </div>
          </Row>
        </Card>
      </div>
    </Section>
  )
}
