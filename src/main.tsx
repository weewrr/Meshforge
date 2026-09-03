import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useLogsStore } from './stores/logs'

// Belt-and-braces: async errors (unhandled rejections) never hit React error
// boundaries. Log them so crashes that escape the boundary still show up in
// the Logs panel and the terminal (the main process forwards renderer console
// output), which is how renderer-vs-logic crashes get told apart.
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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
