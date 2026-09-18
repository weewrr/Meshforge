/**
 * 模型页顶部的扩展安装进度横幅。
 *
 * 轮询 `installExtensionStatus` 把后端的阶段（下载 / 解包 / 校验 / 落位）
 * 渲染成进度环 + 文案；无进行中的安装时整个横幅不渲染。
 */

import type { InstallProgress } from '../../api'
import { useT } from '../../i18n'

// ─── Install progress banner ──────────────────────────────────────────────────

export function InstallProgressBar({ progress }: { progress: InstallProgress }) {
  const t = useT()
  const { step, percent, message } = progress
  return (
    <div className="ex-install">
      <div className="ex-install__row">
        <span className="ex-install__label">
          {step === 'downloading' && t('models.downloading', { pct: percent ?? 0 })}
          {step === 'extracting' && t('models.extracting')}
          {step === 'validating' && t('models.validating')}
          {step === 'setting_up' && (message || t('models.settingUp'))}
          {step === 'done' && t('models.installedDone')}
          {step === 'error' && t('models.installFailed')}
        </span>
        {step === 'setting_up' && <span className="ex-install__hint">{t('models.mayTakeAFewMinutes')}</span>}
      </div>
      <div className={`ex-install__bar ${step === 'setting_up' ? 'ex-install__bar--indet' : ''}`}>
        <div
          className="ex-install__fill"
          // 下载阶段用真实百分比；解压/校验无确定进度，恒显 50%；完成/失败占满。
          style={{ width: step === 'downloading' ? `${percent ?? 0}%` : step === 'extracting' || step === 'validating' ? '50%' : '100%' }}
        />
      </div>
      {step === 'error' && message && <p className="ex-install__err">{message}</p>}
    </div>
  )
}
