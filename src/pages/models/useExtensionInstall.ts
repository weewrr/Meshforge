/**
 * 扩展安装状态与动作（GitHub / HuggingFace / ModelScope URL 安装、
 * 本地目录安装、重新扫描、进度轮询）。
 *
 * 从 ModelsPage 抽出的纯逻辑 hook：页面组件只消费状态与回调。
 */

import { useEffect, useRef, useState } from 'react'
import {
  installExtension,
  installExtensionFromDir,
  installExtensionStatus,
  reloadExtensionsApi,
  type InstallProgress
} from '../../api'
import { useLogsStore } from '../../stores/logs'
import { getT } from '../../i18n'
import type { SourceId } from './types'

export function useExtensionInstall(refresh: () => Promise<void>) {
  const [source, setSource] = useState<SourceId>('github')
  const [showGHForm, setShowGHForm] = useState(false)
  const [ghUrl, setGhUrl] = useState('')
  const [ghErr, setGhErr] = useState<string | null>(null)
  const [ghOk, setGhOk] = useState(false)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const installPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const log = useLogsStore((s) => s.log)

  const isInstalling =
    installProgress !== null && installProgress.step !== 'done' && installProgress.step !== 'error'

  // ── Poll install progress while an install is running ────────────────────
  useEffect(() => {
    if (!isInstalling) {
      if (installPollRef.current) {
        clearInterval(installPollRef.current)
        installPollRef.current = null
      }
      return
    }
    installPollRef.current = setInterval(async () => {
      const progress = await installExtensionStatus().catch(() => null)
      if (progress) setInstallProgress(progress)
      if (progress && (progress.step === 'done' || progress.step === 'error')) {
        if (progress.step === 'done') setGhOk(true)
        if (progress.step === 'error') setGhErr(progress.message ?? getT('models.installFailed'))
        setTimeout(() => { setGhOk(false); setShowGHForm(false); setGhUrl('') }, 1600)
        await refresh()
      }
    }, 500)
    return () => {
      if (installPollRef.current) { clearInterval(installPollRef.current); installPollRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInstalling])

  // ── GitHub extension install ────────────────────────────────────────────

  async function handleGHInstall(): Promise<void> {
    const url = ghUrl.trim()
    if (!url) { setGhErr(getT('models.errGhUrlRequired')); return }
    const expects: Record<SourceId, { host: (box: string) => boolean; err: string }> = {
      github: { host: (u: string) => u.includes('github.com'), err: getT('models.errNotGitHub') },
      huggingface: { host: (u: string) => u.includes('huggingface.co') || u.includes('hf.co'), err: getT('models.errNotHuggingFace') },
      modelscope: { host: (u: string) => u.includes('modelscope.cn'), err: getT('models.errNotModelScope') }
    }
    if (!expects[source].host(url)) { setGhErr(expects[source].err); return }
    setGhErr(null)
    setGhOk(false)
    try {
      const result = await installExtension(url)
      if (!result.ok) { setGhErr(result.message); return }
      log('info', getT('models.logInstall', { msg: result.message }))
      setInstallProgress({ step: 'downloading', percent: 0 })
    } catch (e) {
      setGhErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Local folder install (native directory dialog) ───────────────────────

  async function handleLocalInstall(): Promise<void> {
    // 旧的 webkitdirectory <input type=file> 会冻住/搞崩这台机器的
    // 渲染进程（与网格/图片选择器同一根因）。现在改由主进程
    // 打开原生目录对话框，后端负责拷贝整棵目录树。
    const picker = window.meshforge?.selectFolder
    if (!picker) {
      setGhErr(getT('models.errNativePicker'))
      return
    }
    const folder = await picker()
    if (!folder) return
    setGhErr(null)
    try {
      const result = await installExtensionFromDir(folder)
      if (!result.ok) { setGhErr(result.message); return }
      log('info', getT('models.logInstallLocal', { msg: result.message }))
      setGhOk(true)
      setTimeout(() => setGhOk(false), 1600) // 1.6 秒后收起本地安装成功提示
      await refresh()
    } catch (e) {
      setGhErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Reload (re-scan server extensions dir) ──────────────────────────────

  async function handleReload(): Promise<void> {
    const result = await reloadExtensionsApi()
    if (!result.ok) log('warn', getT('models.logReload', { msg: result.message }))
    await refresh()
  }

  function toggleGHForm(): void {
    setShowGHForm((v) => !v)
    setGhErr(null)
    setGhOk(false)
  }

  return {
    source,
    setSource,
    showGHForm,
    toggleGHForm,
    ghUrl,
    setGhUrl,
    ghErr,
    setGhErr,
    ghOk,
    setGhOk,
    installProgress,
    isInstalling,
    handleGHInstall,
    handleLocalInstall,
    handleReload
  }
}
