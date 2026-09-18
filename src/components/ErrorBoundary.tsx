/**
 * 应用级错误边界。
 *
 * React 19 里未捕获的渲染错误会卸载整棵根树——此前"导入 GLB 解析失败就白屏"
 * 的根因正在于此。把页面 / 查看器子树包进边界，单个资产失败就只影响局部、
 * 可通过重试恢复。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLogsStore } from '../stores/logs'

export interface ErrorBoundaryFallbackProps {
  error: Error
  /** 重新渲染子节点（失败可能是瞬时问题时有用）。 */
  reset: () => void
}

interface Props {
  /** 人类可读的位置标签（如 'Viewer3D'），写入错误日志。 */
  label?: string
  /** 自定义兜底 UI；缺省为居中的通用提示 + 重试按钮。 */
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 应用级安全网。React 19 里未捕获的渲染错误会卸载整棵根树——
 * 这正是此前"导入 → 网格"时 GLB 在 Viewer3D 的 `useGLTF` 里解析失败
 * 导致白屏的原因。把页面 / 查看器子树包进本边界，单个资产失败就只
 * 影响局部、可通过重试恢复。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? `[${this.props.label}] ` : ''
    useLogsStore.getState().error(`${tag}${error.message || String(error)}`)
    // 同时打到控制台：主进程会转发渲染进程的 console 输出，便于在终端看到
    // 完整错误对象与组件栈，定位是哪棵子树出的问题。
    console.error(`${tag}render error:`, error, info.componentStack)
  }

  private handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback({ error, reset: this.handleReset })
    return <DefaultFallback error={error} reset={this.handleReset} />
  }
}

function DefaultFallback({ error, reset }: ErrorBoundaryFallbackProps): ReactNode {
  return (
    <div className="eb">
      <p className="eb__title">Something went wrong</p>
      <p className="eb__msg">{error.message || String(error)}</p>
      <button className="eb-btn eb-btn--primary" onClick={reset}>Try again</button>
    </div>
  )
}
