// ─── 零依赖 i18n 门面 ─────────────────────────────────────────────────────────
/**
 * 零依赖 i18n 门面。
 *
 * 完全由字典驱动（`zh.ts` / `en.ts`）。`useT()` 是响应式版本：它订阅 app store
 * 的 locale，因此任何用到它的组件在语言切换时都会重新渲染；`getT()` 是同步版本，
 * 供非组件代码（模板字符串、日志）使用。
 */

import { useCallback } from 'react'
import { useAppStore } from '../stores/app'
import { en } from './en'
import { zh } from './zh'

/** 支持的界面语言。 */
export type Locale = 'en' | 'zh'

/** 插值变量表：把 `{name}` 这类占位符映射为实际值。 */
type Vars = Record<string, string | number>

/** 按点分路径从字典里取值（如 `workflows.ctx.delete`）；任一层缺失则返回 undefined。 */
function getPath(o: unknown, key: string): unknown {
  if (!o) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return key.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), o)
}

/** 把 `{name}` 占位符替换为 vars 里的值；未提供的占位符原样保留，便于发现漏配。 */
function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/**
 * 按语言与 key 取文案。
 *
 * 取不到当前语言的值时**回退到英文**；两者都取不到则原样返回 key——
 * 这样界面不会出现空白，缺失项在开发期一眼可见。支持 `{var}` 插值。
 *
 * @param locale 目标语言。
 * @param key 点分路径 key。
 * @param vars 插值变量。
 * @returns 文案；未命中时返回 key 本身。
 */
export function translate(locale: Locale, key: string, vars?: Vars): string {
  const dict = locale === 'zh' ? zh : en
  const v = getPath(dict, key)
  if (typeof v === 'string') return interpolate(v, vars)
  const ev = getPath(en, key)
  if (typeof ev === 'string') return interpolate(ev, vars)
  return key
}

/** 组件内使用：返回一个随语言切换而更新的翻译函数。 */
export function useT() {
  const locale = useAppStore((s) => s.locale)
  // 依赖 locale：语言变化时返回新的函数引用，触发使用方重新渲染。
  return useCallback((key: string, vars?: Vars) => translate(locale, key, vars), [locale])
}

/** 非组件代码使用：直接读当前语言，不建立订阅。 */
export function getT(key: string, vars?: Vars): string {
  return translate(useAppStore.getState().locale, key, vars)
}
