/**
 * 查看器网格动作：导入（原生对话框）、导出（GLB 直下 / 其他走转换任务）、
 * 减面 / 平滑占位、释放显存。
 *
 * 从 GeneratePage 抽出的纯逻辑 hook；importing / decimating / smoothing /
 * exporting / unloadStatus 五个忙碌态一并收在这里。
 */

import { useState } from 'react'
import { fullUrl, getJob, importMeshByPath, processMesh } from '../../api'
import { getT } from '../../i18n'
import { useLogsStore } from '../../stores/logs'
import { useSceneStore } from '../../stores/scene'
import { toast } from '../../stores/toasts'
import type { ExportFormat, OpenPanel } from './viewerState'

export function useMeshActions(
  meshUrl: string | null,
  pushMeshUrl: (url: string) => void,
  setOpenPanel: (p: OpenPanel) => void
) {
  const [importing, setImporting] = useState(false)
  const [decimating, setDecimating] = useState(false)
  const [smoothing, setSmoothing] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [unloadStatus, setUnloadStatus] = useState<'idle' | 'done'>('idle')

  /** 清空查看器里的模型与历史，释放显存；按钮文案会短暂变成"已释放"。 */
  function handleUnloadAll(): void {
    useSceneStore.setState({
      meshUrl: null,
      meshSelected: false,
      meshStats: null,
      gizmoMode: null,
      meshHistory: [],
      historyIndex: -1
    })
    setUnloadStatus('done')
    toast.info(getT('generate.toast.unloaded'))
    setTimeout(() => setUnloadStatus('idle'), 2000)
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    if (!meshUrl) return
    if (format === 'glb') {
      // GLB 是查看器的原生格式 —— 直接下载已加载的文件即可，无需后端转换。
      const a = document.createElement('a')
      a.href = meshUrl
      a.download = `meshforge-${Date.now()}.glb`
      a.click()
      toast.success(getT('generate.log.exportSaved', { format }), { duration: 2500 })
      return
    }
    // obj / stl / ply → mesh-exporter 任务（trimesh 后端，走 /process/mesh）
    if (exporting) return
    setExporting(format)
    try {
      const { job_id } = await processMesh(meshUrl, 'mesh-exporter', { format })
      let status = await getJob(job_id)
      // 最多轮询 60 次 × 500ms = 30s：格式转换通常很快，超时则视为失败。
      for (let i = 0; i < 60 && (status.state === 'pending' || status.state === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 500))
        status = await getJob(job_id)
      }
      if (status.state !== 'succeeded' || !status.result_url) {
        useLogsStore.getState().error(getT('generate.log.exportError', { format, detail: status.error || status.state }))
        toast.error(getT('generate.log.exportError', { format, detail: status.error || status.state }))
        return
      }
      const a = document.createElement('a')
      a.href = fullUrl(status.result_url)
      a.download = `meshforge-${Date.now()}.${format}`
      a.click()
      useLogsStore.getState().info(getT('generate.log.exportSaved', { format }))
      toast.success(getT('generate.log.exportSaved', { format }), { duration: 2500 })
    } catch (e) {
      useLogsStore.getState().error(getT('generate.log.exportError', { format, detail: e instanceof Error ? e.message : String(e) }))
      toast.error(getT('generate.log.exportError', { format, detail: e instanceof Error ? e.message : String(e) }))
    } finally {
      setExporting(null)
    }
  }

  // 通过 Electron 主进程导入网格（原生对话框 → 文件系统路径 → 后端直接提供该文件）。
  // 对齐 modly 的做法：完全绕开 Chromium 的 <input type=file>（已知会卡死本机
  // 渲染进程），也避免把文件字节流经渲染进程搬运。
  async function handleImportMesh(): Promise<void> {
    if (!window.meshforge?.selectMeshFile) {
      useLogsStore.getState().warn(getT('generate.log.importNativeUnavailable'))
      return
    }
    const filePath = await window.meshforge.selectMeshFile()
    if (!filePath) return
    setOpenPanel(null)
    setImporting(true)
    useLogsStore.getState().info(getT('generate.log.importPicked', { file: filePath }))
    try {
      const { url } = await importMeshByPath(filePath)
      pushMeshUrl(fullUrl(url))
      useLogsStore.getState().info(getT('generate.log.importPushed', { url: fullUrl(url) }))
      toast.success(getT('generate.toast.importOk'))
    } catch (e) {
      useLogsStore.getState().error(getT('generate.log.importFailed', { detail: e instanceof Error ? e.message : String(e) }))
      toast.error(getT('generate.toast.importFail'))
    } finally {
      setImporting(false)
    }
  }

  /** 减面：后端尚未接通，这里只做短暂的忙碌态并提示"暂不可用"。 */
  function handleDecimate(targetFaces: number): void {
    setDecimating(true)
    setTimeout(() => {
      setDecimating(false)
      useLogsStore.getState().error(getT('generate.log.decimateUnavailable', { target: targetFaces }))
      toast.warning(getT('generate.toast.decimateUnavailable'))
    }, 500)
  }

  /** 平滑：同减面，占位实现。 */
  function handleSmooth(iterations: number): void {
    setSmoothing(true)
    setTimeout(() => {
      setSmoothing(false)
      useLogsStore.getState().error(getT('generate.log.smoothUnavailable', { iterations }))
      toast.warning(getT('generate.toast.smoothUnavailable'))
    }, 500)
  }

  return {
    importing,
    decimating,
    smoothing,
    exporting,
    unloadStatus,
    handleUnloadAll,
    handleImportMesh,
    handleExport,
    handleDecimate,
    handleSmooth
  }
}
