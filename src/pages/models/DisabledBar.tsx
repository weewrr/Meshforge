/**
 * "已停用"内置扩展条带。
 *
 * 内置扩展（代码注册、磁盘上无目录）的"卸载"只是**停用**：后端把 id 记进
 * `disabled-extensions.json` 以保证跨重启保持隐藏。这条带子承担两件事：
 *
 * 1. 讲清"发生了什么"——否则用户会以为扩展被删掉了、又疑惑为什么还能恢复；
 * 2. 给出把扩展放回来的入口——否则"卸载"就成了一道单向门。
 *
 * 从 ModelsPage 抽出的展示组件（与 Toolbar / ExtensionList 同级别），
 * 数据与动作由页面传入。
 */

import { useT } from '../../i18n'
import type { DisabledExt } from './types'

interface DisabledBarProps {
  /** 被停用的内置扩展；为空时组件自身不渲染任何东西。 */
  items: DisabledExt[]
  /** 恢复请求进行中（禁用按钮，避免连点）。 */
  busy: boolean
  /** 触发恢复；可一次传多个 id（"全部恢复"）。 */
  onRestore: (ids: string[]) => void
}

export function DisabledBar({ items, busy, onRestore }: DisabledBarProps) {
  const t = useT()
  if (items.length === 0) return null

  return (
    <div className="ex-disabled">
      <div className="ex-disabled__head">
        <span className="ex-disabled__title">
          {t('models.disabledTitle', { n: items.length })}
        </span>
        <span className="ex-disabled__hint">{t('models.disabledHint')}</span>
      </div>
      <div className="ex-disabled__items">
        {items.map((d) => (
          <button
            key={d.id}
            type="button"
            className="ex-disabled__chip"
            disabled={busy}
            title={t('models.restoreTitle', { name: d.name })}
            onClick={() => onRestore([d.id])}
          >
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            <span className="ex-disabled__name">{d.name}</span>
            <span className="ex-disabled__action">{t('models.restore')}</span>
          </button>
        ))}
        {items.length > 1 && (
          <button
            type="button"
            className="ex-disabled__all"
            disabled={busy}
            onClick={() => onRestore(items.map((d) => d.id))}
          >
            {t('models.restoreAll')}
          </button>
        )}
      </div>
    </div>
  )
}
