/**
 * "已停用"内置扩展的列表与恢复动作。
 *
 * 与 `useUninstall` 成对：卸载内置扩展只是把它记进后端的停用表（跨重启生效、
 * 磁盘上什么都没删），因此必须有地方让用户把它们放回来——否则"卸载"就成了一道
 * 单向门。本 hook 负责拉停用列表 + 触发恢复，页面只负责渲染顶部条带。
 */

import { useState } from 'react'
import { listDisabledExtensions, restoreExtensions } from '../../api'
import { useLogsStore } from '../../stores/logs'
import { toast } from '../../stores/toasts'
import { getT } from '../../i18n'
import type { DisabledExt } from './types'

export function useRestore(
  // 与页面共享的刷新函数：恢复成功后要让卡片重新出现在列表里。
  refresh: () => Promise<void>
) {
  const [disabled, setDisabled] = useState<DisabledExt[]>([])
  const [restoring, setRestoring] = useState(false)
  const log = useLogsStore((s) => s.log)

  async function refreshDisabled(): Promise<void> {
    const items = await listDisabledExtensions()
    setDisabled(items.map((d) => ({
      id: d.id,
      name: d.display_name,
      kind: d.kind,
      category: d.category
    })))
  }

  /** 恢复若干内置扩展；空数组直接返回（"全部恢复"按钮在无停用项时不该被点到）。 */
  async function restore(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    setRestoring(true)
    try {
      const result = await restoreExtensions(ids)
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      log('info', getT('models.logRestore', { msg: (result.restored.length ? result.restored : ids).join(', ') }))
      toast.success(getT('models.toast.restored'), { duration: 2000 })
      // 顺序有意义：先刷主列表让卡片回来，再刷条带把它自己撤掉。
      await refresh()
      await refreshDisabled()
    } finally {
      setRestoring(false)
    }
  }

  return { disabled, restoring, refreshDisabled, restore }
}
