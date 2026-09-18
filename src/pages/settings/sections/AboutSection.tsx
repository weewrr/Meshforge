/**
 * 设置页"关于"分区：应用信息、版本与开源致谢。
 */

import { useEffect, useState } from 'react'
import { health } from '../../../api'
import { Card, LinkButton, Row, Section } from '../../../components/ui'
import { useT } from '../../../i18n'

/**
 * 设置页 · 关于。
 *
 * 只做两件事：展示版本号与仓库链接，以及探活后端并把结果反映到"后端状态"一行。
 */

/** 应用版本号；发版时与 `package.json` 一起更新。 */
const APP_VERSION = '0.1.0'
/** 项目仓库地址；文档与许可证链接都由它派生。 */
const REPO_URL = 'https://github.com/weewrr/Meshforge'

/** 关于区块。 */
export function AboutSection() {
  // null = 探测中：用来区分"还没查"与"查完是离线"两种状态。
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  const t = useT()

  useEffect(() => {
    // 空依赖：只在挂载时探一次，避免每次渲染都去打后端。
    void health().then(setBackendOk)
  }, [])

  return (
    <Section title={t('settings.about.title')} subtitle={t('settings.about.subtitle')}>
      <div className="st-grid">
        <Card>
          <Row label={t('settings.about.appLabel')} description={t('settings.about.appDesc')}>
            {/* 版本号缺失时显示破折号，而不是渲染成 "vnull"。 */}
            <span className="st-mono">{APP_VERSION ? `v${APP_VERSION}` : '—'}</span>
          </Row>
          <Row label={t('settings.about.backendLabel')} description={t('settings.about.backendDesc')}>
            {/* 三种状态各自配色：探测中不着色，在线为 ok，离线为 bad。 */}
            <span className={`st-mono ${backendOk === true ? 'st-mono--ok' : backendOk === false ? 'st-mono--bad' : ''}`}>
              {backendOk === null ? t('settings.about.checking') : backendOk ? t('settings.about.online') : t('settings.about.offline')}
            </span>
          </Row>
          <Row label={t('settings.about.docsLabel')} description={t('settings.about.docsDesc')}>
            <LinkButton label={t('settings.about.open')} href={`${REPO_URL}#readme`} />
          </Row>
        </Card>
        <Card>
          <Row label={t('settings.about.githubLabel')} description={t('settings.about.githubDesc')}>
            <LinkButton label={t('settings.about.open')} href={REPO_URL} />
          </Row>
          <Row label={t('settings.about.licensesLabel')} description={t('settings.about.licensesDesc')}>
            <LinkButton label={t('settings.about.view')} href={`${REPO_URL}/blob/main/LICENSE`} />
          </Row>
        </Card>
      </div>
    </Section>
  )
}
