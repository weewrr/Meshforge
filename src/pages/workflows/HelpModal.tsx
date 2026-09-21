/**
 * 工作流编辑器的快捷键 / 交互帮助弹窗。
 *
 * 以"按键 — 说明"两列表格呈现画布的全部快捷键与交互方式，
 * 点击遮罩或"知道了"按钮即可关闭。
 */

import { useT } from '../../i18n'

/** 工作流编辑器快捷键 / 交互帮助弹窗。 */
export default function HelpModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const rows: [string, string][] = [
    ['Space + Drag', t('workflows.help.pan')],
    ['Double-click', t('workflows.help.openPanel')],
    ['Ctrl + Z / Ctrl + Y', t('workflows.help.undoRedo')],
    ['Ctrl + T', t('workflows.help.newWorkflow')],
    ['Ctrl + W', t('workflows.help.closeTab')],
    ['Ctrl + Tab', t('workflows.help.switchTab')],
    ['Delete', t('workflows.help.deleteNode')],
    ['Alt + Click edge', t('workflows.help.interruptEdge')],
    ['F', t('workflows.help.frameSelection')],
    ['C', t('workflows.help.commentGroup')],
    ['Alt + Connect', t('workflows.help.altReconnect')],
    ['Pin +', t('workflows.help.pinAdd')],
    ['Drag', t('workflows.help.drag')],
    ['Connect', t('workflows.help.connect')],
    ['Wait node', t('workflows.help.waitNode')]
  ]
  return (
    <div
      className="wf-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="wf-modal__card wf-modal__card--wide">
        <p className="wf-modal__title">{t('workflows.help.title')}</p>
        <div className="wf-help">
          {rows.map(([key, desc]) => (
            <div key={key} className="wf-help__row">
              <span className="wf-help__key">{key}</span>
              <span className="wf-help__desc">{desc}</span>
            </div>
          ))}
        </div>
        <div className="wf-modal__actions">
          <button className="primary" onClick={onClose}>
            {t('workflows.help.gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}
