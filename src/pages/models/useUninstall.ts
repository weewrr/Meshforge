/**
 * 扩展卸载状态与确认动作。
 *
 * 从 ModelsPage 抽出的纯逻辑 hook：打开确认弹窗会同时取消画布选中。
 */

import { useState } from 'react'
import { uninstallExtension } from '../../api'
import { useLogsStore } from '../../stores/logs'
import { toast } from '../../stores/toasts'
import { getT } from '../../i18n'
import type { Ext } from './types'

export function useUninstall(
  refresh: () => Promise<void>,
  // 与页面共享的选中状态 setter：保持原语义——只有当前选中的正是该扩展时才取消选中。
  clearSelected: (update: (id: string | null) => string | null) => void
) {
  const [uninstallTarget, setUninstallTarget] = useState<Ext | null>(null)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const log = useLogsStore((s) => s.log)

  function openUninstallModal(ext: Ext): void {
    setUninstallError(null)
    setUninstallTarget(ext)
    clearSelected((id) => (id === ext.id ? null : id))
  }

  async function handleUninstallConfirm(ext: Ext): Promise<void> {
    setUninstallBusy(true)
    setUninstallError(null)
    try {
      const result = await uninstallExtension(ext.id)
      if (!result.ok) {
        setUninstallError(result.message)
        return
      }
      log('info', getT(result.builtin ? 'models.logDisabled' : 'models.logUninstall', { msg: result.message }))
      setUninstallTarget(null)
      // 内置扩展只是停用（后端记进停用表，跨重启生效），文案不能再说"已卸载"，
      // 否则用户会以为磁盘上少了东西、又疑惑为什么能恢复。
      toast.success(getT(result.builtin ? 'models.toast.disabled' : 'models.toast.uninstalled'), { duration: 3000 })
      await refresh()
    } catch (e) {
      setUninstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setUninstallBusy(false)
    }
  }

  return {
    uninstallTarget,
    setUninstallTarget,
    uninstallBusy,
    uninstallError,
    openUninstallModal,
    handleUninstallConfirm
  }
}
