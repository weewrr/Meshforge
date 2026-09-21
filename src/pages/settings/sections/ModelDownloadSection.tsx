/**
 * 设置页"模型下载"分区：列出外部 AI 推理服务的权重卡片，可一键经 ModelScope CLI 下载。
 *
 * 顶部先探测 `modelscope` 是否可用（对应需求：列表对比检查 `modelscope -v`）；
 * 每张卡片显示服务名、说明、安装态与磁盘占用，未安装且 ModelScope 上有仓库的可点下载，
 * 下载期间以进度条 + 输入行实时反馈（后端 SSE 流式回报 modelscope 输出）。
 */

import { useEffect, useState } from 'react'
import { Card, Row, Section } from '../../../components/ui'
import {
  downloadModelService,
  listModelDownloads,
  type ModelServiceEntry,
  type ModelDownloadsStatus
} from '../../../api/modelDownloads'
import { useT } from '../../../i18n'

const EMPTY: ModelDownloadsStatus = { modelscopeAvailable: false, modelscopeVersion: null, services: [] }

/** 把字节数格式化成人类可读长度（B/KB/MB/GB/TB）。 */
function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function ModelDownloadSection() {
  const t = useT()
  const [status, setStatus] = useState<ModelDownloadsStatus>(EMPTY)
  const [loading, setLoading] = useState(true)
  // 正在下载的服务 key；同时只允许一个下载，避免 modelscope 并发写同一根目录。
  const [active, setActive] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ status?: string; error?: string } | null>(null)

  async function refresh(): Promise<void> {
    setLoading(true)
    setStatus(await listModelDownloads())
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleDownload(key: string): Promise<void> {
    setActive(key)
    setProgress(null)
    const ok = await downloadModelService(key, (ev) => setProgress(ev))
    setActive(null)
    if (ok) setProgress({ status: t('settings.modeldl.done') })
    void refresh()
  }

  return (
    <Section title={t('settings.modeldl.title')} subtitle={t('settings.modeldl.subtitle')}>
      {/* modelscope CLI 可用性（需求：列表对比检查有没有 modelscope -v） */}
      {loading ? null : status.modelscopeAvailable ? (
        <div className="st-note st-note--ok">
          {status.modelscopeVersion
            ? t('settings.modeldl.mscopeOk', { version: status.modelscopeVersion })
            : t('settings.modeldl.mscopeOkGeneric')}
        </div>
      ) : (
        <div className="st-note st-note--warn">{t('settings.modeldl.mscopeMissing')}</div>
      )}

      <div className="st-grid">
        {status.services.map((s: ModelServiceEntry) => {
          const busy = active === s.key
          return (
            <Card key={s.key} title={`${s.label}${s.installed ? ' ✓' : ''}`} description={t(`settings.modeldl.desc.${s.key}`)}>
              <Row
                label={
                  s.installed
                    ? t('settings.modeldl.installed')
                    : t('settings.modeldl.notInstalled')
                }
                description={s.sizeBytes ? `${t('settings.modeldl.size')} ${fmtBytes(s.sizeBytes)}` : String(s.localDir)}
              >
                {busy ? (
                  <span className="st-spin">{t('settings.modeldl.downloading')}</span>
                ) : s.installed ? (
                  <button className="st-actionbtn st-actionbtn--ok" disabled>
                    {t('settings.modeldl.installed')}
                  </button>
                ) : !s.modelscopeId ? (
                  <button className="st-actionbtn" disabled title={s.hfRef ?? ''}>
                    {t('settings.modeldl.downloadUnavailable')}
                  </button>
                ) : (
                  <button
                    className="st-actionbtn st-actionbtn--accent"
                    disabled={!status.modelscopeAvailable}
                    onClick={() => void handleDownload(s.key)}
                  >
                    {t('settings.modeldl.download')}
                  </button>
                )}
              </Row>
              {busy && (
                <div className="st-dlprogress">
                  <div className="st-dlprogress__track">
                    <div className="st-dlprogress__bar" />
                  </div>
                  {progress?.status && <p className="st-dlprogress__line">{progress.status}</p>}
                  {progress?.error && <p className="st-dlprogress__err">{progress.error}</p>}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </Section>
  )
}