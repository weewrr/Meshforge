/**
 * 应用外壳：标题栏 + 侧边栏 + 路由分派，以及两处崩溃兜底。
 *
 * 四个页面都经 `lazy` 懒加载——three.js 与 React Flow 是体积最大的两个依赖，
 * 静态 import 会让首屏解析体积翻倍。`ErrorBoundary` 与崩溃恢复横幅共同保证
 * "单个资源解析失败"或"渲染进程被系统回收"不会表现为白屏或静默回到首页。
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import ErrorBoundary, { type ErrorBoundaryFallbackProps } from './components/ErrorBoundary'
import { Sidebar, TitleBar } from './components/Chrome'
import { Toasts } from './components/Toasts'
import { useT } from './i18n'
import { useAppStore } from './stores/app'
import { useLogsStore } from './stores/logs'
import { useNavigationStore } from './stores/navigation'

// 路由级代码分割：three.js（GeneratePage 内的 Viewer3D）与 React Flow
// （WorkflowsPage）是最大的两个依赖，懒加载让首屏解析保持轻量，
// 并把它们各自拆成独立 chunk。
const GeneratePage = lazy(() => import('./pages/GeneratePage'))
const ModelsPage = lazy(() => import('./pages/ModelsPage'))
const SettingsPage = lazy(() => import('./pages/settings'))
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage'))

/** 顶层崩溃时替换整个界面的兜底页（带"重载"与"重试"两个出口）。 */
function AppCrash({ error, reset }: ErrorBoundaryFallbackProps) {
  const t = useT()
  return (
    <div className="eb-app">
      <svg className="eb-app__icon" aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <p className="eb-app__title">{t('app.crashTitle')}</p>
      <p className="eb-app__msg">{error.message || String(error)}</p>
      <div className="eb-app__actions">
        <button className="eb-btn eb-btn--primary" onClick={() => window.location.reload()}>{t('app.reload')}</button>
        <button className="eb-btn" onClick={reset}>{t('app.retry')}</button>
      </div>
    </div>
  )
}

/** 应用根组件：按 `navigation` store 的当前页渲染对应页面。 */
export default function App() {
  const page = useNavigationStore((s) => s.page)
  const [crash, setCrash] = useState<{ reason: string; at: number } | null>(null)
  const t = useT()

  // store 在模块初始化时就已套用持久化的 UI 属性（主题/字号/缩放），
  // 但在 localStorage 晚于模块求值才就绪的环境里（例如内嵌浏览器），
  // 那一次会读到默认值。这里在 React 启动后再套用一次，
  // 保证 <html> 上的类名始终与已水合的 store 一致。
  useEffect(() => {
    useAppStore.getState().applyUi()
  }, [])

  // 崩溃恢复横幅：主进程在 render-process-gone / unresponsive 后会自动重载
  // 渲染进程，并把原因暂存下来。挂载时**只问一次**（一次性读取，主进程读完即清），
  // 拿到就展示——否则重载会看起来像"莫名其妙跳回了首页"。
  // 导航状态与打开的工作流标签页由别处的 localStorage 恢复，
  // 因此这条横幅同时也提示"刚才发生过一次恢复"。
  useEffect(() => {
    let cancelled = false
    void window.meshforge
      ?.getLastCrash()
      .then((last) => {
        if (cancelled || !last) return
        // 过期保护：若窗口在自动重载前就被关闭、之后很久才重新打开，
        // 则忽略这条陈旧的崩溃记录。
        if (Date.now() - last.at > 60_000) return
        setCrash(last)
        useLogsStore.getState().error(`[crash-recovery] ${last.reason}`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      {crash && (
        <div role="status" className="eb-banner">
          <svg className="eb-banner__icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="eb-banner__msg">
            {t('app.banner')}
            <span style={{ opacity: 0.75 }}> ({crash.reason})</span>
          </span>
          <button
            onClick={() => setCrash(null)}
            className="eb-banner__dismiss"
            aria-label={t('app.dismiss')}
          >
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <div className="app__body">
        <Sidebar />
        <div className="app__content">
          <ErrorBoundary label="App" fallback={(props) => <AppCrash {...props} />}>
            <Suspense fallback={<div className="app__loading" aria-hidden="true" />}>
              {page === 'workflows' && <WorkflowsPage />}
              {page === 'generate' && <GeneratePage />}
              {page === 'models' && <ModelsPage />}
              {page === 'settings' && <SettingsPage />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
      <Toasts />
    </div>
  )
}
