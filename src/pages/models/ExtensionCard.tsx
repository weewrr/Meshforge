/**
 * 扩展卡片。
 *
 * 扩展列表中的最小单元：展示图标、名称、类型标签、版本 / 作者 / 官方标记、
 * 简介与节点端口，并在声明了 HuggingFace 仓库时挂上权重下载控制。整张卡片
 * 可点击打开详情抽屉（键盘可达）。
 */

import type { ModelDownloadInfo } from '../../api'
import { useT } from '../../i18n'
import { NodeInstallControl } from './NodeInstallControl'
import type { Ext } from './types'
import { CUBE_ICON, IMAGE_ICON, IMGFILTER_ICON, IOBadge, SHIELD_ICON, SPARK_ICON, StatusBadge, TypePill } from './ui'

// ─── 扩展卡片 ────────────────────────────────────────────────────────────────

/** 扩展列表中的一张卡片。 */
export function ExtensionCard({ ext, dl, installed, disabled, onOpen, onUninstall: _onUninstall, onInstall, onPause, onResume, onCancel }: {
  /** 要展示的扩展。 */
  ext: Ext
  /** 该扩展的权重下载进度（无则为 `undefined`）。 */
  dl: ModelDownloadInfo | undefined
  /** 权重是否已下载完成。 */
  installed: boolean
  /** 是否禁用所有操作（如正在安装其它扩展时）。 */
  disabled?: boolean
  /** 点击卡片打开详情抽屉。 */
  onOpen: (ext: Ext) => void
  /** 请求卸载该扩展。 */
  onUninstall: (ext: Ext) => void
  /** 开始下载权重。 */
  onInstall: (ext: Ext) => void
  /** 暂停下载。 */
  onPause: (ext: Ext) => void
  /** 继续下载。 */
  onResume: (ext: Ext) => void
  /** 取消下载。 */
  onCancel: (ext: Ext) => void
}) {
  const t = useT()
  const isModel = ext.type === 'model'
  const isView = isModel && ext.category === 'multiview'
  const isImage = isModel && ext.category === 'image'

  const status = ext.loaded
    ? { tone: 'green' as const, text: isModel ? t('models.statusAllNodesReady') : t('models.statusReady') }
    : { tone: 'amber' as const, text: t('models.statusNotLoaded') }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(ext)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(ext) } }}
      aria-label={t('models.openDetails', { name: ext.name })}
      className="ex-card"
    >
      <div className="ex-card__head">
        <div className={`ex-card__icon ${isImage ? 'ex-card__icon--image' : isView ? 'ex-card__icon--view' : isModel ? 'ex-card__icon--model' : ''}`}>
          {isImage ? IMGFILTER_ICON : isView ? IMAGE_ICON : isModel ? SPARK_ICON : CUBE_ICON}
        </div>
        <div className="ex-card__titlewrap">
          <div className="ex-card__titlerow">
            <span className="ex-card__name">{ext.name}</span>
            <TypePill type={ext.type} category={ext.category} />
          </div>
          <div className="ex-card__meta">
            {ext.version && <span className="ex-card__version">v{ext.version}</span>}
            {ext.version && ext.author && <span className="ex-card__sep">·</span>}
            {ext.author && <span>{ext.author}</span>}
            {ext.trusted && (
              <>
                <span className="ex-card__sep">·</span>
                <span className="ex-card__official">
                  {SHIELD_ICON}
                  {t('models.official')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="ex-card__desc">{ext.description?.trim() || '—'}</p>

      {ext.nodes.length > 0 && (
        <div className="ex-card__nodes">
          {ext.nodes.map((node) => (
            <div key={node.id} className="ex-card__node">
              <div className="ex-card__nodetext">
                <span className="ex-card__nodename">{node.name}</span>
                <IOBadge node={node} />
              </div>
              {ext.hfRepo && (
                <div className="ex-card__nodefoot">
                  <NodeInstallControl
                    dl={dl}
                    installed={installed}
                    disabled={disabled}
                    onInstall={() => onInstall(ext)}
                    onPause={() => onPause(ext)}
                    onResume={() => onResume(ext)}
                    onCancel={() => onCancel(ext)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="ex-card__foot">
        <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
      </div>
    </div>
  )
}
