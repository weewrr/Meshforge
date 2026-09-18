/**
 * 扩展详情抽屉。
 *
 * 点击扩展卡片后从右侧滑出，展示元数据（标识 / 加载状态 / 节点端口）以及
 * 权重下载控制（`NodeInstallControl`），底部提供卸载入口。用焦点陷阱保证
 * 弹层内的键盘可用性。
 */

import type { ModelDownloadInfo } from '../../api'
import { useT } from '../../i18n'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { NodeInstallControl } from './NodeInstallControl'
import type { Ext } from './types'
import { CUBE_ICON, IMAGE_ICON, IMGFILTER_ICON, IOBadge, SPARK_ICON, StatusBadge, TypePill } from './ui'

// ─── 详情抽屉 ────────────────────────────────────────────────────────────────

/** 扩展详情抽屉：展示元信息与权重下载控制，并提供卸载入口。 */
export function ExtensionDrawer({ ext, dl, installed, disabled, onClose, onUninstall, onInstall, onPause, onResume, onCancel }: {
  /** 当前展示的扩展。 */
  ext: Ext
  /** 该扩展的模型权重下载进度（无则为 `undefined`）。 */
  dl: ModelDownloadInfo | undefined
  /** 权重是否已下载完成。 */
  installed: boolean
  /** 是否禁用所有操作（如正在安装其它扩展时）。 */
  disabled?: boolean
  /** 关闭抽屉。 */
  onClose: () => void
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
  const trapRef = useFocusTrap(true, onClose)

  return (
    <>
      <div className="ex-drawer__overlay" onClick={onClose} />
      <aside ref={trapRef} role="dialog" aria-modal="true" aria-label={ext.name} className="ex-drawer">
        <div className="ex-drawer__head">
          <button onClick={onClose} title={t('models.close')} aria-label={t('models.close')} className="ex-drawer__close">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
          <div className="ex-drawer__titlewrap">
            <div className={`ex-drawer__icon ${isImage ? 'ex-card__icon--image' : isView ? 'ex-card__icon--view' : isModel ? 'ex-card__icon--model' : ''}`}>
              {isImage ? IMGFILTER_ICON : isView ? IMAGE_ICON : isModel ? SPARK_ICON : CUBE_ICON}
            </div>
            <div>
              <h3 className="ex-drawer__name">{ext.name}</h3>
              <div className="ex-drawer__metarow">
                <TypePill type={ext.type} category={ext.category} />
                {ext.version && <span className="ex-card__version">v{ext.version}</span>}
                {ext.author && <span className="ex-drawer__author">{t('models.byAuthor', { author: ext.author })}</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="ex-drawer__body">
          <p className="ex-drawer__desc">{ext.description?.trim() || '—'}</p>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.identifier')}</p>
            <code className="ex-drawer__code">{ext.id}</code>
          </div>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.status')}</p>
            <StatusBadge tone={ext.loaded ? 'green' : 'amber'}>
              {ext.loaded ? t('models.loadedOnServer') : t('models.registeredNotLoaded')}
            </StatusBadge>
          </div>

          <div className="ex-drawer__field">
            <p className="ex-drawer__fieldlabel">{t('models.nodes')}</p>
            <div className="ex-drawer__nodes">
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
          </div>

          <div className="ex-drawer__danger">
            <button className="ex-drawer__uninstall" onClick={() => onUninstall(ext)}>
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
              {t('models.uninstall')}
                </button>
          </div>
        </div>
      </aside>
    </>
  )
}
