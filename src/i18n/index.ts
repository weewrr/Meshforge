// ─── Zero-dependency i18n facade ─────────────────────────────────────────────
// Dictionary-driven. `useT()` is reactive (subscribes to app locale) so any
// component using it re-renders when the language changes. `getT()` is the
// synchronous variant for non-component code (templates, logs).

import { useCallback } from 'react'
import { useAppStore } from '../stores/app'
import { en } from './en'
import { zh } from './zh'

export type Locale = 'en' | 'zh'

type Vars = Record<string, string | number>

function getPath(o: unknown, key: string): unknown {
  if (!o) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return key.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), o)
}

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

export function translate(locale: Locale, key: string, vars?: Vars): string {
  const dict = locale === 'zh' ? zh : en
  const v = getPath(dict, key)
  if (typeof v === 'string') return interpolate(v, vars)
  const ev = getPath(en, key)
  if (typeof ev === 'string') return interpolate(ev, vars)
  return key
}

export function useT() {
  const locale = useAppStore((s) => s.locale)
  return useCallback((key: string, vars?: Vars) => translate(locale, key, vars), [locale])
}

export function getT(key: string, vars?: Vars): string {
  return translate(useAppStore.getState().locale, key, vars)
}