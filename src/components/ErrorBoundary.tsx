import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLogsStore } from '../stores/logs'

export interface ErrorBoundaryFallbackProps {
  error: Error
  /** Re-render the children (useful when the failure may be transient). */
  reset: () => void
}

interface Props {
  /** Human-readable location label (e.g. 'Viewer3D'), used in the error log. */
  label?: string
  /** Custom fallback UI. Defaults to a generic centered message + retry. */
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * App-wide safety net. In React 19 an uncaught render error unmounts the whole
 * root — which is what used to blank the UI after Import → Mesh when a GLB
 * failed to parse inside Viewer3D's `useGLTF`. Wrap page/viewer subtrees with
 * this boundary so a single asset failure stays local and recoverable.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? `[${this.props.label}] ` : ''
    useLogsStore.getState().error(`${tag}${error.message || String(error)}`)
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
