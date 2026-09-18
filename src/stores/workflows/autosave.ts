/**
 * 自动保存（去抖）。
 *
 * 拖拽节点与逐字编辑都会在极短时间内产生大量变更，每次都写后端会把请求打爆，
 * 因此统一走 800ms 去抖：只有"安静下来"之后才真正落盘。
 */

import { nowIso } from './helpers'
import type { Get, Set } from './types'

// 定时器放在模块作用域：整个应用只创建一个 store 实例，无需按实例隔离。
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 自动保存：800ms 去抖，避免拖拽/逐字编辑期间反复写后端。 */
export function createAutosave(set: Set, get: Get) {
  /** 重设去抖计时器；重复调用只会把触发时刻往后推，不会叠加多个定时器。 */
  function schedule(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void get().save()
    }, 800)
  }

  /** 标记"有改动"：刷新 updatedAt、置脏，并安排一次去抖保存。 */
  function touch(): void {
    // 没有打开的工作流时直接返回，避免把 updatedAt 写到 null 上。
    if (!get().current) return
    set((s) => ({
      current: s.current ? { ...s.current, updatedAt: nowIso() } : s.current,
      dirty: true
    }))
    schedule()
  }

  return { touch, schedule }
}

/** 自动保存能力的类型，供其它 slice 声明依赖。 */
export type Autosave = ReturnType<typeof createAutosave>
