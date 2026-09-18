/**
 * 单个模型条目的权重下载控制。
 *
 * 集中处理下载 / 暂停 / 取消 / 续传四种动作与对应按钮态，是 SSE 进度事件
 * 在 UI 上的落点。
 */

import type { ModelDownloadInfo } from '../../api'
import { useT } from '../../i18n'
import { CHECK_ICON, DOWNLOAD_ICON, PAUSE_ICON, PLAY_ICON, X_ICON } from './ui'

// ─── Per-extension weight download control ──────────────────────────────────
// 仅为声明了 HF 仓库的模型扩展显示。结构对应 Modly 的
// NodeInstallControl：安装 → 进度条 + 暂停/取消 → 已安装。

export function NodeInstallControl({
  dl,
  installed,
  disabled,
  onInstall,
  onPause,
  onResume,
  onCancel
}: {
  dl: ModelDownloadInfo | undefined
  installed: boolean
  disabled?: boolean
  onInstall: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const t = useT()
  if (installed) {
    return (
      <span className="ex-dl ex-dl--installed">
        {CHECK_ICON}
        {t('models.installed')}
        {/* <span className="ex-dl__size">{sizeLabel}</span> */}
      </span>
    )
  }

  if (dl) {
    const paused = dl.paused ?? false
    // 把百分比夹到 0~100，避免后端返回的异常值撑爆进度条。
    const pct = Math.max(0, Math.min(100, dl.percent ?? 0))
    return (
      <span className="ex-dl">
        <span className="ex-dl__progress">
          <span className="ex-dl__bar">
            <span
              className={`ex-dl__fill ${paused ? 'ex-dl__fill--paused' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className={`ex-dl__pct ${paused ? 'ex-dl__pct--paused' : ''}`}>
            {paused ? t('models.paused') : `${pct}%`}
          </span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (paused) onResume()
            else onPause()
          }}
          title={paused ? t('models.resumeDownload') : t('models.pauseDownload')}
          aria-label={paused ? t('models.resumeDownload') : t('models.pauseDownload')}
          className="ex-dl__btn"
        >
          {paused ? PLAY_ICON : PAUSE_ICON}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel() }}
          title={t('models.cancelDownload')}
          aria-label={t('models.cancelDownload')}
          className="ex-dl__btn ex-dl__btn--danger"
        >
          {X_ICON}
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onInstall() }}
      disabled={disabled}
      className="ex-dl__install"
    >
      {DOWNLOAD_ICON}
      {t('models.install')}
    </button>
  )
}
