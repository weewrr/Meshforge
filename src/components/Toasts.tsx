/**
 * 全局提示条渲染组件：订阅 `useToasts`，把 store 里的 toast 渲染为右上角堆栈。
 *
 * 样式类用本仓库 `t-*` 前缀，见 src/styles/shell.css 中的对应规则。
 * 放在应用外壳（Chrome/AppShell）里，覆盖所有页面。
 */

import { dismiss, useToasts, type ToastKind } from '../stores/toasts'

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
  success: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  ),
  error: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  ),
  warning: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3 2 20h20L12 3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="17" x2="12" y2="17.5" />
    </svg>
  ),
  info: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" />
    </svg>
  )
}

export function Toasts() {
  const toasts = useToasts()
  if (toasts.length === 0) return null

  return (
    <div className="t-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`t-toast t-toast--${t.kind}`} role="alert">
          <span className="t-toast__icon">{KIND_ICON[t.kind]}</span>
          <span className="t-toast__msg">{t.message}</span>
          {t.action && (
            <button className="t-toast__action" onClick={t.action.onClick}>
              {t.action.label}
            </button>
          )}
          <button
            className="t-toast__close"
            aria-label="关闭"
            title="关闭"
            onClick={() => dismiss(t.id)}
          >
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}