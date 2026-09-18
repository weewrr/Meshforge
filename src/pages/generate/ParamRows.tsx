/**
 * 生成页里每个蓝图节点的"参数行"组件。
 *
 * 生成页不用画布，而是把节点拍平成一个个参数卡片（`ParamRow`）。本文件按节点类型
 * 提供对应的参数编辑 UI：图片/文本/网格输入、等待暂停、生成器进度。文件类节点
 * 同样走原生文件框（绕开 Chromium `<input type=file>` 崩溃）。
 */

import { useState } from 'react'
import { fullUrl, importImageByPath, importMeshByPath } from '../../api'
import { getT, useT } from '../../i18n'
import { useLogsStore } from '../../stores/logs'
import { useWorkflowRunStore } from '../../stores/workflowRun'
import type { WFNode } from '../../types'

// ─── 参数行（节点卡片） ─────────────────────────────────────────────────────

/** 参数补丁函数：把对某个节点的局部参数改动回写到工作流 store。 */
export type PatchFn = (nodeId: string, patch: Record<string, unknown>) => void

// 四视角生成器的侧视角 tag（主图/front 由 ImageParamRow 的 url 承载）。
const MV_SIDE_TAGS = ['left', 'back', 'right'] as const

/** 图片参数行：原生选择图片并写入节点（`url` / 多视角 `view_<tag>`）。`mv` 时额外渲染左/后/右三视角槽位。 */
export function ImageParamRow({ node, onPatch, mv = false }: { node: WFNode; onPatch: PatchFn; mv?: boolean }) {
  const t = useT()
  const url = String(node.data.params.url ?? '')
  const [busy, setBusy] = useState(false)
  const [busyTag, setBusyTag] = useState<string | null>(null)

  // 原生文件选择图片（Modly 对齐），与 MeshParamRow 同一套路：主进程弹框只回传绝对路径，
  // 后端经 /upload/from-path 把文件拷进 workspace/uploads，全程不碰 <input type=file>，避免渲染冻结。
  // `tag` 决定写入哪个参数槽位：'front' 为主图（url），否则为侧视角 view_<tag>。
  async function pickInto(tag: string): Promise<void> {
    if (!window.meshforge?.selectImageFile) {
      useLogsStore.getState().warn(getT('generate.log.imageDialogUnavailable'))
      return
    }
    const filePath = await window.meshforge.selectImageFile()
    if (!filePath) return
    setBusy(true)
    setBusyTag(tag)
    try {
      const { url: imported, fileName } = await importImageByPath(filePath)
      if (tag === 'front') {
        // 主图（必填）即 front 视角：同时回填 url 与 view_front，便于下游读取。
        onPatch(node.id, {
          url: imported,
          fileName,
          view_front: imported,
          view_front_name: fileName
        })
      } else {
        onPatch(node.id, { [`view_${tag}`]: imported, [`view_${tag}_name`]: fileName })
      }
      useLogsStore.getState().log('info', getT('generate.log.imageImported', { name: fileName }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useLogsStore.getState().error(getT('generate.log.imageImportFailed', { detail: msg }))
    } finally {
      setBusy(false)
      setBusyTag(null)
    }
  }

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span>{t('generate.image.label')}</span>
        {mv && <span className="gp-mv-badge">{t('generate.image.multiView')}</span>}
      </div>
      {url ? (
        <button className="gp-image" onClick={() => void pickInto('front')} disabled={busy}>
          <img src={fullUrl(url)} alt="" />
          <span className="gp-image__change">{busy ? t('generate.common.uploading') : t('generate.common.change')}</span>
          {mv && <span className="gp-image__corner">{t('generate.image.front')}</span>}
        </button>
      ) : (
        <button className="gp-image gp-image--empty" onClick={() => void pickInto('front')} disabled={busy}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>{busy ? t('generate.common.uploading') : t('generate.image.browse')}</span>
        </button>
      )}
      {mv && (
        <div className="gp-mv">
          {MV_SIDE_TAGS.map((tag) => {
            const vurl = String(node.data.params[`view_${tag}`] ?? '')
            const picking = busy && busyTag === tag
            return (
              <button
                key={tag}
                className={`gp-mv-slot ${vurl ? '' : 'gp-mv-slot--empty'}`}
                onClick={() => void pickInto(tag)}
                disabled={busy}
              >
                {vurl ? <img src={fullUrl(vurl)} alt="" /> : (
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                )}
                <span className="gp-mv-slot__label">
                  {picking ? t('generate.common.uploading') : t(`generate.image.${tag}`)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 文本参数行：内联文本框编辑节点的 `text` 参数。 */
export function TextParamRow({ node, onPatch }: { node: WFNode; onPatch: PatchFn }) {
  const t = useT()
  const text = String(node.data.params.text ?? '')
  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
          <path d="M17 6.1H3M21 12.1H3M15.1 18H3" />
        </svg>
        <span>{t('generate.text.label')}</span>
      </div>
      <textarea
        className="gp-textarea"
        value={text}
        rows={3}
        placeholder={t('generate.text.placeholder')}
        onChange={(e) => onPatch(node.id, { text: e.target.value })}
      />
    </div>
  )
}

/** 网格参数行：原生选择 3D 网格文件写入节点，或切换到"使用当前模型"模式。 */
export function MeshParamRow({ node, onPatch }: { node: WFNode; onPatch: PatchFn }) {
  const t = useT()
  const url = String(node.data.params.url ?? '')
  const fileName = String(node.data.params.fileName ?? '')
  const [busy, setBusy] = useState(false)

  // 原生文件选择网格（Modly 对齐）：主进程弹框只回传绝对路径，后端经
  // /optimize/import-by-path 提供/转换文件。不碰 <input type=file>，避免渲染冻结（与工具栏导入一致）。
  async function pickFromDisk(): Promise<void> {
    if (!window.meshforge?.selectMeshFile) {
      useLogsStore.getState().warn(getT('generate.log.meshDialogUnavailable'))
      return
    }
    const filePath = await window.meshforge.selectMeshFile()
    if (!filePath) return
    setBusy(true)
    try {
      const { url: imported } = await importMeshByPath(filePath)
      const name = filePath.split(/[\\/]/).pop() ?? filePath
      onPatch(node.id, { url: imported, fileName: name })
      useLogsStore.getState().log('info', getT('generate.log.meshImported', { name }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useLogsStore.getState().error(getT('generate.log.meshImportFailed', { detail: msg }))
    } finally {
      setBusy(false)
    }
  }

  const source = String(node.data.params.source ?? 'file') === 'current' ? 'current' : 'file'

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <span>{t('generate.mesh.label')}</span>
      </div>

      {/* 开关：使用当前模型而非从文件导入 */}
      <button
        className={`gp-toggle ${source === 'current' ? 'gp-toggle--on' : ''}`}
        onClick={() => onPatch(node.id, { source: source === 'current' ? 'file' : 'current' })}
      >
        <span className="gp-toggle__knob" />
        <span className="gp-toggle__text">{t('generate.mesh.useCurrent')}</span>
      </button>

      {source === 'file' ? (
        <>
          {url ? (
            <button className="gp-file" onClick={() => void pickFromDisk()} disabled={busy}>
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="gp-file__name">{fileName}</span>
              <span className="gp-file__change">{busy ? '…' : t('generate.common.change')}</span>
            </button>
          ) : (
            <button className="gp-file gp-file--empty" onClick={() => void pickFromDisk()} disabled={busy}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>{busy ? t('generate.common.importing') : t('generate.mesh.browse')}</span>
            </button>
          )}
        </>
      ) : (
        <div className="gp-file__hint">{t('generate.mesh.useCurrentHint')}</div>
      )}
    </div>
  )
}

/** 等待参数行：运行到 Wait 节点停下时，显示「继续」按钮以恢复执行流。 */
export function WaitParamRow({ nodeId }: { nodeId: string }) {
  const t = useT()
  const nodeState = useWorkflowRunStore((s) => s.nodeStates[nodeId])
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const waiting = nodeState === 'waiting'

  return (
    <div className="gp-row__body">
      <div className="gp-row__label">
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
        <span>{t('generate.wait.label')}</span>
      </div>
      {waiting ? (
        <button className="gp-continue" onClick={continueRun}>
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {t('generate.wait.continue')}
        </button>
      ) : (
        <p className="gp-hint">{t('generate.wait.hint')}</p>
      )}
    </div>
  )
}

/** 生成器参数行：展示生成器的名称/类型与目标模型，运行时显示进度百分比。 */
export function GeneratorParamRow({ node }: { node: WFNode }) {
  const t = useT()
  const nodeState = useWorkflowRunStore((s) => s.nodeStates[node.id])
  const progress = useWorkflowRunStore((s) => s.nodeProgress[node.id] ?? 0)
  const generatorId = String(node.data.params.generatorId ?? '')

  return (
    <div className="gp-row__body">
      <div className="gp-ext">
        <div className="gp-ext__info">
          <p className="gp-ext__name">{node.data.label}</p>
          <div className="gp-ext__types">
            <span style={{ color: '#38bdf8' }}>{t('generate.param.typeImage')}</span>
            <svg aria-hidden="true" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
            <span style={{ color: '#a78bfa' }}>{t('generate.param.typeMesh')}</span>
          </div>
        </div>
        {generatorId && <span className="gp-ext__id">{generatorId}</span>}
      </div>
      {nodeState === 'running' && (
        <div className="gp-gen__progress">
          <div className="gp-gen__bar"><div className="gp-gen__fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="gp-gen__pct">{Math.round(progress * 100)}%</span>
        </div>
      )}
    </div>
  )
}
