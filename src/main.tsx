/**
 * 渲染进程入口：挂载 React 根节点并引入全局样式。
 *
 * 这里同时注册全局未捕获错误 → 日志 store，保证"白屏之前"的异常也留有现场。
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initApiBase } from './api/http'
import './index.css'
import { useLogsStore } from './stores/logs'

// 双保险：异步错误（未处理的 Promise 拒绝）永远不会触达 React 错误边界。
// 把它们记录下来，使逃出边界的崩溃也能出现在"日志"面板与终端
//（主进程会转发渲染进程的 console 输出），据此区分渲染层与逻辑层崩溃。
window.addEventListener('error', (e) => {
  const err = e.error
  const msg = err instanceof Error ? err.message : String(err ?? e.message ?? 'unknown error')
  useLogsStore.getState().error(`[window] ${msg}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  const msg = reason instanceof Error ? reason.message : String(reason ?? 'unknown rejection')
  useLogsStore.getState().error(`[unhandledrejection] ${msg}`)
})

// 首帧前从主进程取后端实际端口（8766 被占时主进程已自动改选），并写入
// API_BASE——此后所有 API 模块的 import 引用都指向正确地址（文档 12.3）。
void initApiBase().finally(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
