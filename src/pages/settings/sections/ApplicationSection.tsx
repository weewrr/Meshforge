/**
 * 设置页 · 应用分区。
 *
 * 管理界面表现相关偏好：标题栏的硬件监控指示开关、主题、字体（Atkinson 像素字体）、
 * UI 缩放，以及界面语言。所有改动通过 `useAppStore.patch` 即时落盘。
 */

import { Card, Row, Section, SegmentedControl, Toggle } from '../../../components/ui'
import { useT, type Locale } from '../../../i18n'
import { useAppStore } from '../../../stores/app'

/** 设置页"应用"分区：界面外观与语言偏好。 */
export function ApplicationSection() {
  const showCpu = useAppStore((s) => s.showCpu)
  const showRam = useAppStore((s) => s.showRam)
  const showVram = useAppStore((s) => s.showVram)
  const showGpu = useAppStore((s) => s.showGpu)
  const locale = useAppStore((s) => s.locale)
  const useAtkinsonFont = useAppStore((s) => s.useAtkinsonFont)
  const uiScale = useAppStore((s) => s.uiScale)
  const theme = useAppStore((s) => s.theme)
  const patch = useAppStore((s) => s.patch)
  const t = useT()

  return (
    <Section title={t('settings.application.title')} subtitle={t('settings.application.subtitle')}>
      <div className="st-grid">
        <Card className="st-card--full" title={t('settings.application.metricsIndicator')} description={t('settings.application.metricsIndicatorDesc')}>
          <Row label={t('settings.application.metricCpu')} description={t('settings.application.metricCpuDesc')}>
            <Toggle value={showCpu} onChange={(v) => patch({ showCpu: v })} />
          </Row>
          <Row label={t('settings.application.metricRam')} description={t('settings.application.metricRamDesc')}>
            <Toggle value={showRam} onChange={(v) => patch({ showRam: v })} />
          </Row>
          <Row label={t('settings.application.metricVram')} description={t('settings.application.metricVramDesc')}>
            <Toggle value={showVram} onChange={(v) => patch({ showVram: v })} />
          </Row>
          <Row label={t('settings.application.metricGpu')} description={t('settings.application.metricGpuDesc')}>
            <Toggle value={showGpu} onChange={(v) => patch({ showGpu: v })} />
          </Row>
        </Card>
        <Card title={t('settings.accessibility.themeTitle')} description={t('settings.accessibility.themeDesc')}>
          <Row label={t('settings.accessibility.themeLabel')} description={t('settings.accessibility.themeRowDesc')}>
            <SegmentedControl
              ariaLabel={t('settings.accessibility.themeAria')}
              value={theme}
              onChange={(v) => patch({ theme: v })}
              options={[
                { value: 'dark', label: t('settings.accessibility.themeDark') },
                { value: 'light', label: t('settings.accessibility.themeLight') }
              ]}
            />
          </Row>
        </Card>
        <Card title={t('settings.accessibility.fontTitle')} description={t('settings.accessibility.fontDesc')}>
          <Row
            label={t('settings.accessibility.atkinsonLabel')}
            description={t('settings.accessibility.atkinsonDesc')}
          >
            <Toggle value={useAtkinsonFont} onChange={(v) => patch({ useAtkinsonFont: v })} />
          </Row>
        </Card>
        <Card title={t('settings.accessibility.scaleTitle')} description={t('settings.accessibility.scaleDesc')}>
          <Row label={t('settings.accessibility.scaleLabel')} description={t('settings.accessibility.scaleRowDesc')}>
            <SegmentedControl
              ariaLabel={t('settings.accessibility.scaleAria')}
              value={uiScale}
              onChange={(v) => patch({ uiScale: v })}
              options={[
                { value: 'small', label: t('settings.accessibility.sizeSmall') },
                { value: 'medium', label: t('settings.accessibility.sizeMedium') },
                { value: 'large', label: t('settings.accessibility.sizeLarge') },
                { value: 'very-large', label: t('settings.accessibility.sizeVeryLarge') }
              ]}
            />
          </Row>
        </Card>
        <Card title={t('settings.application.interface')}>
          <Row label={t('lang.label')} description={t('lang.description')}>
            <SegmentedControl
              options={[
                { value: 'en', label: t('lang.english') },
                { value: 'zh', label: t('lang.chinese') }
              ]}
              value={locale}
              onChange={(v) => patch({ locale: v as Locale })}
            />
          </Row>
        </Card>
      </div>
    </Section>
  )
}
