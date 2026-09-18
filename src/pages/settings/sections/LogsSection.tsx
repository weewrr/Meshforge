/**
 * 设置页"日志"分区：展示内存日志缓冲、按级别过滤与一键清空。
 */

import { useCallback, useState } from 'react'
import { useT } from '../../../i18n'
import { useLogsStore } from '../../../stores/logs'

/**
 * 设置页 · 日志。
 *
 * 把全局日志缓冲按级别分成三个标签页展示（错误 / 运行时 / 应用），
 * 并支持一键复制当前标签页的全部内容，便于直接贴进 issue。
 */

/** 标签页定义。`levels` 决定该标签页展示哪些日志级别。 */
const LOG_TABS = [
  { id: 'errors', key: 'tabErrors', levels: ['error'] },
  { id: 'runtime', key: 'tabRuntime', levels: ['info'] },
  { id: 'app', key: 'tabApp', levels: ['warn'] }
] as const

/** 标签页 id 的联合类型，由 `LOG_TABS` 推导，避免手写与定义脱节。 */
type LogTabId = (typeof LOG_TABS)[number]['id']

/** 日志区块。 */
export function LogsSection() {
  const logs = useLogsStore((s) => s.logs)
  const [activeTab, setActiveTab] = useState<LogTabId>('errors')
  const [copied, setCopied] = useState(false)
  const t = useT()

  // 断言非空：activeTab 只可能取自 LOG_TABS 里的 id，find 必然命中。
  const tab = LOG_TABS.find((tab) => tab.id === activeTab)!
  // 先倒序（最新在最上），再按当前标签页的级别过滤。
  const entries = [...logs].reverse().filter((l) => (tab.levels as readonly string[]).includes(l.level))

  // 固定用 en-GB + 24 小时制：避免不同系统的区域设置导致时间格式不一致，
  // 这样用户复制的日志在不同机器上可读性一致。
  const content = entries
    .map((e) => `[${new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })}] ${e.level.toUpperCase()} ${e.message}`)
    .join('\n')

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      // 2 秒后把按钮文案恢复，作为"已复制"的轻提示。
      setTimeout(() => setCopied(false), 2000)
    })
  }, [content])

  return (
    <div className="st-logs">
      <div>
        <h2 className="st-logs__title">{t('settings.logs.title')}</h2>
        <p className="st-agent__subtitle">{t('settings.logs.subtitle')}</p>
      </div>

      <div className="st-logs__tabs">
        {LOG_TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            onClick={() => setActiveTab(tabDef.id)}
            className={`st-logs__tab ${activeTab === tabDef.id ? 'st-logs__tab--active' : ''}`}
          >
            {t(`settings.logs.${tabDef.key}`)}
          </button>
        ))}
        <div className="st-logs__tabactions">
          <button className="st-logs__refresh" title={t('settings.logs.refreshTitle')}>
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {t('settings.logs.refresh')}
          </button>
          {/* 无内容时禁用复制，避免把空串写进剪贴板覆盖掉用户原有的内容。 */}
          <button onClick={handleCopy} disabled={!content} className="st-logs__copy">
            {copied ? t('settings.logs.copied') : t('settings.logs.copyAll')}
          </button>
        </div>
      </div>

      {content ? (
        <pre className="st-logs__body">{content}</pre>
      ) : (
        <div className="st-logs__empty">{t('settings.logs.empty', { file: tab.id })}</div>
      )}
    </div>
  )
}
