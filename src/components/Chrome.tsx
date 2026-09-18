/**
 * 应用框架件：左侧导航栏与顶部标题栏。
 *
 * 标题栏承担两件事——品牌标识，以及**可选的实时资源监视**（CPU / 内存 /
 * 显存 / GPU 利用率）。四个监视项各自可开关，只有至少一项开启时才启动轮询，
 * 关闭时立刻停止并清空数据，避免后台白跑。
 *
 * 窗口按钮（最小化 / 最大化 / 关闭）走 `window.meshforge` 的 preload 桥；
 * 在嵌入式浏览器里该对象不存在，故一律用可选链调用。
 */

import { useEffect, useState, type ReactElement } from 'react'
import { useNavigationStore, type Page } from '../stores/navigation'
import { useAppStore } from '../stores/app'
import { useT } from '../i18n'
import { getSystemStats } from '../api'

/** 侧边栏导航项；`key` 是 i18n 键，`icon` 是内联 SVG。 */
const ITEMS: { page: Page; key: string; icon: ReactElement }[] = [
  {
    page: 'generate',
    key: 'nav.generate',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    )
  },
  {
    page: 'workflows',
    key: 'nav.workflows',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="6" height="5" rx="1" />
        <rect x="3" y="11" width="6" height="5" rx="1" />
        <rect x="3" y="19" width="6" height="2" rx="1" />
        <path d="M9 5.5h3.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9" />
        <rect x="13.5" y="3" width="7.5" height="16" rx="1" />
      </svg>
    )
  },
  {
    page: 'models',
    key: 'nav.models',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    )
  },
  {
    page: 'settings',
    key: 'nav.settings',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }
]

/** 左侧导航栏：按 `navigation` store 的当前页高亮。 */
export function Sidebar() {
  const page = useNavigationStore((s) => s.page)
  const go = useNavigationStore((s) => s.go)
  const t = useT()

  return (
    <nav className="sidebar" aria-label={t('titlebar.app')}>
      {ITEMS.map((item) => {
        const label = t(item.key)
        return (
          <button
            key={item.page}
            title={label}
            className={`sidebar__item ${page === item.page ? 'sidebar__item--active' : ''}`}
            onClick={() => go(item.page)}
          >
            <span className="sidebar__icon">{item.icon}</span>
            <span className="sidebar__label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** 品牌标识：等轴测蓝图立方体，青色墨迹渐变 + 深色棱线。 */
function BrandMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="mf-brand-grad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="1" stopColor="#0891b2" />
        </linearGradient>
      </defs>
      <path d="M12 2.6l8.4 4.85v9.1L12 21.4l-8.4-4.85v-9.1L12 2.6z" fill="url(#mf-brand-grad)" />
      <path d="M12 2.6v9.35m0 0l8.4-4.5M12 11.95L3.6 7.45" stroke="#090d15" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

/** 标题栏用的资源快照（与 `api/system.ts` 的 `SystemStats` 同构）。 */
interface SystemStats {
  /** CPU 占用百分比；取不到为 `null`。 */
  cpuPercent: number | null
  /** 内存占用（字节）与百分比。 */
  memory: { total: number | null; used: number | null; percent: number | null }
  /** 显存与 GPU 利用率；无可用 GPU 时为 `null`。 */
  gpu: { vramTotal: number | null; vramUsed: number | null; vramPercent: number | null; util: number | null } | null
}

/** 把字节数格式化为 GB 文本；取不到时显示破折号而不是 0。 */
function fmtGB(bytes: number | null | undefined): string {
  return bytes == null || Number.isNaN(bytes) ? '—' : (bytes / 1024 ** 3).toFixed(1)
}

/** 按占用率返回进度条/数值的配色类名：正常 → 警告 → 告急。 */
function utilLevel(pct: number): { bar: string; text: string } {
  if (pct >= 90) return { bar: 'titlebar__bar--high', text: 'titlebar__val--high' }
  if (pct >= 75) return { bar: 'titlebar__bar--warn', text: 'titlebar__val--warn' }
  return { bar: 'titlebar__bar--ok', text: '' }
}

/** 标题栏里的单个紧凑监控条（标签 + 进度条 + 数值 + 可选补充）。 */
function Metric({
  label,
  value,
  pct,
  title,
  extra
}: {
  label: string
  value: string
  pct: number | null
  title: string
  extra?: string
}) {
  const lvl = utilLevel(pct ?? 0)
  return (
    <div className="titlebar__metric" title={title}>
      <span className="titlebar__mlabel">{label}</span>
      <span className="titlebar__mbar">
        <span
          className={`titlebar__mfill ${lvl.bar}`}
          // 夹到 0~100：偶发的采样抖动可能给出越界值，会让进度条溢出容器。
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </span>
      <span className={`titlebar__mvalue ${lvl.text}`}>{value}</span>
      {extra ? <span className="titlebar__mextra">{extra}</span> : null}
    </div>
  )
}

/** 顶部标题栏：品牌 + 可选资源监控 + 窗口控制按钮。 */
export function TitleBar() {
  const showCpu = useAppStore((s) => s.showCpu)
  const showRam = useAppStore((s) => s.showRam)
  const showVram = useAppStore((s) => s.showVram)
  const showGpu = useAppStore((s) => s.showGpu)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const t = useT()

  // 只要任一监控项开启，就轮询后端资源指标。该读取在嵌入式浏览器与
  // Electron 中通用（不依赖 preload）。
  // 退避（优化文档 6.2）：连续失败（后端崩溃/重启中）时把轮询从 2s 逐步
  // 降频到 10s，成功后复位——避免后端离线期间每 2s 白打一次 401/超时请求。
  const anyMetric = showCpu || showRam || showVram || showGpu
  useEffect(() => {
    if (!anyMetric) {
      setStats(null)
      return
    }
    let active = true
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const intervalMs = () => (failures === 0 ? 2000 : Math.min(2000 * failures, 10000))
    const schedule = () => {
      if (!active) return
      timer = setTimeout(run, intervalMs())
    }
    const run = () => {
      getSystemStats()
        .then((next) => {
          if (!active) return
          failures = 0
          setStats(next)
        })
        // 静默失败：后端短暂不可达时保留上一次的读数，比清空更不易误导；
        // 失败计数递增触发退避。
        .catch(() => {
          if (active) failures += 1
        })
        .finally(schedule)
    }
    run()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [anyMetric])

  const mem = stats?.memory
  const gpu = stats?.gpu
  const memPct = mem?.percent ?? 0
  const vramPct = gpu?.vramPercent ?? 0

  return (
    <div className="titlebar">
      <span className="titlebar__brand">
        <BrandMark />
        <span className="titlebar__app">{t('titlebar.app')}</span>
      </span>
      {anyMetric && stats && (
        <div className="titlebar__metrics">
          {showCpu && (
            <Metric
              label={t('titlebar.metrics.cpu')}
              value={stats.cpuPercent == null ? '—' : `${Math.round(stats.cpuPercent)}%`}
              pct={stats.cpuPercent}
              title={t('titlebar.metrics.cpuTitle')}
            />
          )}
          {showRam && (
            <Metric
              label={t('titlebar.metrics.ram')}
              value={`${fmtGB(mem?.used)}/${fmtGB(mem?.total)}`}
              pct={memPct}
              title={t('titlebar.metrics.ramTitle', {
                used: fmtGB(mem?.used),
                total: fmtGB(mem?.total)
              })}
            />
          )}
          {showVram && gpu && (
            <Metric
              label={t('titlebar.metrics.vram')}
              value={`${fmtGB(gpu.vramUsed)}/${fmtGB(gpu.vramTotal)}`}
              pct={vramPct}
              title={t('titlebar.metrics.vramTitle', {
                used: fmtGB(gpu.vramUsed),
                total: fmtGB(gpu.vramTotal)
              })}
            />
          )}
          {showGpu && gpu && (
            <Metric
              label={t('titlebar.metrics.gpu')}
              value={gpu.util == null ? '—' : `${Math.round(gpu.util)}%`}
              pct={gpu.util}
              title={t('titlebar.metrics.gpuTitle')}
            />
          )}
        </div>
      )}
      <div className="titlebar__spacer" />
      <button
        className="titlebar__btn"
        title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}
        onClick={() => void window.meshforge?.winMin()}
      >
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
          <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className="titlebar__btn"
        title={t('titlebar.maximize')} aria-label={t('titlebar.maximize')}
        onClick={() => void window.meshforge?.winMax()}
      >
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="titlebar__btn titlebar__btn--close" title={t('titlebar.close')} aria-label={t('titlebar.close')} onClick={() => void window.meshforge?.winClose()}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
