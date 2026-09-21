/**
 * 设置页骨架：左侧分区导航 + 右侧当前分区。
 *
 * 分区清单集中在 nav.tsx，这里只负责选中态与懒渲染——切换分区不重建
 * 其他分区的组件，滚动态与表单态得以保留。
 */

import { useState } from 'react'
import { useT } from '../../i18n'
import type { SectionId } from './types'
import { SECTIONS } from './nav'
import { ApplicationSection } from './sections/ApplicationSection'
import { StorageSection } from './sections/StorageSection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { ModelDownloadSection } from './sections/ModelDownloadSection'
import { PerformanceSection } from './sections/PerformanceSection'
import { AgentSection } from './sections/AgentSection'
import { LogsSection } from './sections/LogsSection'
import { AboutSection } from './sections/AboutSection'

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>('application')
  const t = useT()

  return (
    <div className="st">
      {/* Left nav */}
      <nav className="st-nav">
        <p className="st-nav__title">{t('nav.settings')}</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`st-nav__item ${section === s.id ? 'st-nav__item--active' : ''}`}
          >
            <span className={`st-nav__icon ${section === s.id ? 'st-nav__icon--active' : ''}`}>{s.icon}</span>
            {t(s.key)}
          </button>
        ))}
      </nav>

      {/* 内容区 */}
      <div className="st-content">
        <div className="st-inner">
          {section === 'application' && <ApplicationSection />}
          {section === 'storage' && <StorageSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'performance' && <PerformanceSection />}
          {section === 'modeldl' && <ModelDownloadSection />}
          {section === 'agent' && <AgentSection />}
          {section === 'logs' && <LogsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}
