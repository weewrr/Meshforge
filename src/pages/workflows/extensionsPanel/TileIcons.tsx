/**
 * 面板磁贴用的单色 SVG 图标集合。
 *
 * 全部用 `currentColor` 描边，跟随磁贴的 `color` 换色；`glyph` 字符串即此处的键，
 * `items.ts` 里每个条目通过 `glyph` 取对应图标，`tiles.tsx` 渲染时按 key 索引。
 */

import type { ReactElement } from 'react'

/** 字形名 → 单色 SVG 图标的映射表。 */
export const TILE_ICONS: Record<string, ReactElement> = {
  image: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  text: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M4 7V5h16v2M12 5v14M9 19h6" />
    </svg>
  ),
  array: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  mesh: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  ),
  generate: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
    </svg>
  ),
  output: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  preview: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  wait: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  loop: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  forEach: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  comment: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  ),
  variable: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M8 16V8l4 8 4-8v8" /><path d="M16 11h4M8 11H4" />
    </svg>
  ),
  check: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  emptylogic: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="5" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" />
      <path d="M7 8h10M7 17h6" />
    </svg>
  ),
  bool: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="8" cy="12" r="4" /><circle cx="16" cy="12" r="4" />
    </svg>
  ),
  math: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M5 18L9 6" /><path d="M13 6h6M16 3v6" /><path d="M4 13h5M4 17h5" />
    </svg>
  ),
  compare: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M6 5v14M6 19l-3-3M6 19l3-3" /><path d="M18 19V5M18 5l-3 3M18 5l3 3" />
    </svg>
  ),
  concat: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M7 17V7M7 17H4M7 17h3" /><path d="M13 8h8M13 12h8M13 16h5" />
    </svg>
  ),
  gate: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 8l-8-5-8 5 8 5 8-5z" /><path d="M4 13l8 5 8-5" /><path d="M4 18l8 5 8-5" />
    </svg>
  ),
  branch: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v8a4 4 0 0 0 4 4h4l-2-2M16 17l2-2" /><path d="M8 3V1.5M8 21v-6" />
    </svg>
  ),
  sequence: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 5h12M8 12h12M8 19h12" /><circle cx="4" cy="5" r="1.4" /><circle cx="4" cy="12" r="1.4" /><circle cx="4" cy="19" r="1.4" />
    </svg>
  ),
  reroute: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M4 12h13l-3.5-3.5M4 12l11 9.5 3.5-3.5L15 14.5" />
    </svg>
  ),
  select: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14M9 8l3-3 3 3M9 16l3 3 3-3" />
    </svg>
  ),
  function: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
      <circle cx="18" cy="17" r="3" />
    </svg>
  ),
  cast: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h9M9 4l4 4-4 4" /><path d="M20 16h-9M15 12l-4 4 4 4" />
    </svg>
  ),
  clamp: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M5 5v14M19 5v14M5 12h14" />
    </svg>
  ),
  lerp: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M4 19L20 5" /><circle cx="4" cy="19" r="2" /><circle cx="20" cy="5" r="2" />
    </svg>
  ),
  random: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.2" /><circle cx="15.5" cy="15.5" r="1.2" />
      <circle cx="15.5" cy="8.5" r="1.2" /><circle cx="8.5" cy="15.5" r="1.2" />
    </svg>
  ),
  getvar: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="10" cy="7" rx="6" ry="3" /><path d="M4 7v10c0 1.7 2.7 3 6 3 1.2 0 2.3-.2 3.2-.5" />
      <path d="M16 15h5M18.5 12.5L21 15l-2.5 2.5" />
    </svg>
  ),
  setvar: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="10" cy="7" rx="6" ry="3" /><path d="M4 7v10c0 1.7 2.7 3 6 3 1.2 0 2.3-.2 3.2-.5" />
      <path d="M16 12.5h5M18.5 15L21 12.5 18.5 10" />
    </svg>
  ),
  bindEvent: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 12h6" /><path d="M8 7a5 5 0 0 0 0 10" /><path d="M16 7a5 5 0 0 1 0 10" />
    </svg>
  ),
  callEvent: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l2.4 3.6L18 4.2l-.6 3.6 3.6.6-2.4 3 2.4 3-3.6.6.6 3.6-3.6-1.4L12 22l-2.4-3.6L6 19.8l.6-3.6L3 15.6l2.4-3L3 9.6l3.6-.6L6 5.4l3.6 1.4L12 2z" />
    </svg>
  ),
  makeStruct: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h7M4 12h7M4 18h7" /><path d="M14 12h7M18 9l3 3-3 3" />
    </svg>
  ),
  breakStruct: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h7M8 9l3 3-3 3" /><path d="M14 6h7M14 12h7M14 18h7" />
    </svg>
  )
}

