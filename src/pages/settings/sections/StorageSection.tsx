/**
 * 设置页"存储"分区：缓存 / 生成产物 / 工作流的清理动作与占用展示。
 */

import { useEffect, useState } from 'react'
import { clearCache, clearGenerated, clearWorkflows, openCacheFolder } from '../../../api'
import type { RuntimeInfo } from '../../../api'
import { getRuntimeInfo } from '../../../api/system'
import { Card, PathRow, Row, Section } from '../../../components/ui'
import { useT } from '../../../i18n'
import { useAppStore } from '../../../stores/app'

export function StorageSection() {
  const modelsDir = useAppStore((s) => s.modelsDir)
  const workspaceDir = useAppStore((s) => s.workspaceDir)
  const workflowsDir = useAppStore((s) => s.workflowsDir)
  // 后端报告的实际生效目录：优先于 localStorage 副本（文档 13.2 设置契约）。
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [cacheStatus, setCacheStatus] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')
  const [genStatus, setGenStatus] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')
  const [wfStatus, setWfStatus] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle')
  const t = useT()

  useEffect(() => {
    let alive = true
    getRuntimeInfo()
      .then((info) => {
        if (alive) setRuntime(info)
      })
      .catch(() => undefined) // 后端不可达时退回 localStorage 副本
    return () => {
      alive = false
    }
  }, [])

  // 实际生效值：后端可达时以后端为准，否则退回前端 store 的本地副本。
  const effModelsDir = runtime?.modelsDir ?? modelsDir
  const effWorkspaceDir = runtime?.workspaceDir ?? workspaceDir
  const effWorkflowsDir = runtime?.workflowsDir ?? workflowsDir

  function handleClearCache(): void {
    // 会删除未被「已保存」工作流引用的上传文件（未保存的画布不在保护范围内），先确认。
    if (!window.confirm(t('settings.storage.confirmCache'))) return
    setCacheStatus('clearing')
    clearCache()
      .then(() => {
    setCacheStatus('done')
    // 2.5 秒后回到 idle，让"已清除"/"失败"的反馈自然淡出。
    setTimeout(() => setCacheStatus('idle'), 2500)
      })
      .catch(() => {
        setCacheStatus('error')
        setTimeout(() => setCacheStatus('idle'), 2500)
      })
  }

  function handleClearGenerated(): void {
    if (!window.confirm(t('settings.storage.confirmGenerated'))) return
    setGenStatus('clearing')
    clearGenerated()
      .then(() => {
        setGenStatus('done')
        setTimeout(() => setGenStatus('idle'), 2500)
      })
      .catch(() => {
        setGenStatus('error')
        setTimeout(() => setGenStatus('idle'), 2500)
      })
  }

  function handleOpenCacheFolder(): void {
    openCacheFolder().catch(() => undefined)
  }

  function handleClearWorkflows(): void {
    if (!window.confirm(t('settings.storage.confirmWorkflows'))) return
    setWfStatus('clearing')
    clearWorkflows()
      .then(() => {
        setWfStatus('done')
        setTimeout(() => setWfStatus('idle'), 2500)
      })
      .catch(() => {
        setWfStatus('error')
        setTimeout(() => setWfStatus('idle'), 2500)
      })
  }

  return (
    <Section title={t('settings.storage.title')} subtitle={t('settings.storage.subtitle')}>
      <div className="st-grid">
        <Card title={t('settings.storage.directoriesTitle')} description={t('settings.storage.effectiveNote')}>
          <PathRow label={t('settings.storage.modelsLabel')} description={t('settings.storage.modelsDesc')} value={effModelsDir} />
          <PathRow label={t('settings.storage.workspaceLabel')} description={t('settings.storage.workspaceDesc')} value={effWorkspaceDir} />
          <PathRow label={t('settings.storage.workflowsLabel')} description={t('settings.storage.workflowsDesc')} value={effWorkflowsDir} />
        </Card>
        <Card title={t('settings.storage.cacheTitle')} description={t('settings.storage.cacheDesc')}>
          <Row label={t('settings.storage.cacheFolderLabel')} description={t('settings.storage.cacheFolderDesc')}>
            <button className="st-actionbtn" onClick={handleOpenCacheFolder}>
              {t('settings.storage.openCacheFolder')}
            </button>
          </Row>
          <Row label={t('settings.storage.tempFilesLabel')} description={t('settings.storage.tempFilesDesc')}>
            <button
              onClick={handleClearCache}
              disabled={cacheStatus === 'clearing'}
              className={`st-actionbtn ${
                cacheStatus === 'done' ? 'st-actionbtn--ok' : cacheStatus === 'error' ? 'st-actionbtn--bad' : ''
              }`}
            >
              {cacheStatus === 'clearing' ? t('settings.storage.clearing') : cacheStatus === 'done' ? t('settings.storage.cleared') : cacheStatus === 'error' ? t('settings.storage.failed') : t('settings.storage.clearCache')}
            </button>
          </Row>
          <Row label={t('settings.storage.generatedLabel')} description={t('settings.storage.generatedDesc')}>
            <button
              onClick={handleClearGenerated}
              disabled={genStatus === 'clearing'}
              className={`st-actionbtn ${
                genStatus === 'done' ? 'st-actionbtn--ok' : genStatus === 'error' ? 'st-actionbtn--bad' : ''
              }`}
            >
              {genStatus === 'clearing' ? t('settings.storage.clearing') : genStatus === 'done' ? t('settings.storage.cleared') : genStatus === 'error' ? t('settings.storage.failed') : t('settings.storage.clearGenerated')}
            </button>
          </Row>
          <Row label={t('settings.storage.workflowsLabel')} description={t('settings.storage.workflowsDesc')}>
            <button
              onClick={handleClearWorkflows}
              disabled={wfStatus === 'clearing'}
              className={`st-actionbtn ${
                wfStatus === 'done' ? 'st-actionbtn--ok' : wfStatus === 'error' ? 'st-actionbtn--bad' : ''
              }`}
            >
              {wfStatus === 'clearing' ? t('settings.storage.clearing') : wfStatus === 'done' ? t('settings.storage.cleared') : wfStatus === 'error' ? t('settings.storage.failed') : t('settings.storage.clearWorkflows')}
            </button>
          </Row>
        </Card>
      </div>
    </Section>
  )
}
