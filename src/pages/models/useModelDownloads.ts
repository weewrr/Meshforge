/**
 * 模型权重下载状态与动作（HF 托管权重的 下载 / 暂停 / 续传 / 取消）。
 *
 * 从 ModelsPage 抽出的纯逻辑 hook：SSE 下载流、状态表与日志都收在这里。
 */

import { useState } from 'react'
import {
  cancelModelDownload,
  listModelStatus,
  pauseModelDownload,
  startModelDownload,
  type ModelDownloadInfo
} from '../../api'
import { useLogsStore } from '../../stores/logs'
import { toast } from '../../stores/toasts'
import { useAppStore } from '../../stores/app'
import { getT } from '../../i18n'
import type { Ext } from './types'

export function useModelDownloads() {
  const hfToken = useAppStore((s) => s.hfToken)
  const [modelStatus, setModelStatus] = useState<Record<string, { downloaded: boolean; sizeBytes: number }>>({})
  const [downloading, setDownloading] = useState<Record<string, ModelDownloadInfo>>({})
  const log = useLogsStore((s) => s.log)

  async function refreshModelStatus(): Promise<void> {
    const list = await listModelStatus()
    setModelStatus(
      Object.fromEntries(list.map((m) => [m.extId, { downloaded: m.downloaded, sizeBytes: m.sizeBytes }]))
    )
  }

  // ── Model weight download (start / pause / resume / cancel) ────────────

  async function handleDownload(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    const id = ext.id
    setDownloading((prev) => ({ ...prev, [id]: { percent: 0, status: 'Starting…' } }))
    try {
      const last = await startModelDownload({
        id,
        repoId: ext.hfRepo,
        skipPrefixes: ext.hfSkipPrefixes,
        includePrefixes: ext.hfIncludePrefixes,
        token: hfToken || undefined,
        onEvent: (e) => setDownloading((prev) => ({ ...prev, [id]: e }))
      })
      if (last.cancelled) {
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
      } else if (last.error) {
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
        log('error', getT('models.logDownloadFailed', { err: last.error }))
        toast.error(getT('models.toast.downloadFail'))
      } else if (!last.paused) {
        // 完成
        setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
        log('info', getT('models.logDownloaded', { name: ext.name }))
        toast.success(getT('models.toast.downloaded', { name: ext.name }), { duration: 3000 })
      }
      // 暂停 → 保留该条目让 UI 显示"已暂停"；续传会重新走这里。
      await refreshModelStatus()
    } catch (e) {
      setDownloading((prev) => { const next = { ...prev }; delete next[id]; return next })
      log('error', getT('models.logDownloadError', { err: e instanceof Error ? e.message : String(e) }))
      toast.error(getT('models.toast.downloadFail'))
    }
  }

  async function handlePause(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    await pauseModelDownload(ext.id).catch(() => undefined)
    setDownloading((prev) => {
      const cur = prev[ext.id]
      return cur ? { ...prev, [ext.id]: { ...cur, paused: true } } : prev
    })
  }

  function handleResume(ext: Ext): void {
    // .part files are kept server-side; a fresh stream resumes via Range.
    void handleDownload(ext)
  }

  async function handleCancel(ext: Ext): Promise<void> {
    if (!ext.hfRepo) return
    await cancelModelDownload(ext.id).catch(() => undefined)
    setDownloading((prev) => { const next = { ...prev }; delete next[ext.id]; return next })
    await refreshModelStatus()
  }

  return {
    modelStatus,
    downloading,
    refreshModelStatus,
    handleDownload,
    handlePause,
    handleResume,
    handleCancel
  }
}
