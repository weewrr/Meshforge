/**
 * 设置页"性能"分区：资源监视开关与渲染相关偏好。
 */

import { useEffect, useState } from 'react'
import { Card, Row, Section, Select, Toggle } from '../../../components/ui'
import { useT } from '../../../i18n'
import { useAppStore } from '../../../stores/app'
import { getRuntimeInfo, type GpuDetectInfo } from '../../../api/system'

/**
 * 设置页 · 性能。
 *
 * 设备与显存相关的一组开关：推理设备、半精度、显存上限、并行 worker 数。
 * 这些值会随每次请求透传给后端各推理服务。
 */

/** 性能区块。所有项都直接写回 app store（会立即持久化）。 */
export function PerformanceSection() {
  const gpuDevice = useAppStore((s) => s.gpuDevice)
  const fp16 = useAppStore((s) => s.fp16)
  const vramLimit = useAppStore((s) => s.vramLimit)
  const parallelWorkers = useAppStore((s) => s.parallelWorkers)
  const patch = useAppStore((s) => s.patch)
  const t = useT()
  // GPU 静态探测结果（后端进程内缓存，一次拉取即可）。
  const [gpuInfo, setGpuInfo] = useState<GpuDetectInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    getRuntimeInfo()
      .then((info) => {
        if (!cancelled) setGpuInfo(info.gpu ?? null)
      })
      .catch(() => {
        /* 后端不可达时静默：探测行整体不显示 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Section title={t('settings.performance.title')} subtitle={t('settings.performance.subtitle')}>
      {/* 契约透明（文档 13.2）：这些开关目前只写 localStorage，后端尚未接线。
          明确告知用户"改动暂不影响推理"，避免误以为已生效。 */}
      <p className="st-sectionhint">{t('settings.storage.notWiredNote')}</p>
      <div className="st-grid">
        <Card title={t('settings.performance.deviceTitle')} description={t('settings.performance.deviceDesc')}>
          <Row label={t('settings.performance.gpuLabel')} description={t('settings.performance.gpuDesc')}>
            {/* 设备选项含 Apple 的 mps 与两块 CUDA 卡，覆盖本机常见的三种后端。 */}
            <Select
              ariaLabel={t('settings.performance.gpuAria')}
              value={gpuDevice}
              onChange={(v) => patch({ gpuDevice: v })}
              options={[
                { value: 'auto', label: t('settings.performance.devAuto') },
                { value: 'mps', label: t('settings.performance.devMps') },
                { value: 'cuda0', label: t('settings.performance.devCuda0') },
                { value: 'cuda1', label: t('settings.performance.devCuda1') },
                { value: 'cpu', label: t('settings.performance.devCpu') }
              ]}
            />
          </Row>
          {/* GPU 自动探测（优化文档 6.3）：告诉用户 auto 档实际会落在哪，
              无 N 卡时明确提示降级 CPU，避免"选了 GPU 却莫名变慢"的困惑。 */}
          {gpuInfo && (
            <p className="st-sectionhint">
              {gpuInfo.cudaAvailable
                ? t('settings.performance.gpuDetected', {
                    count: gpuInfo.count,
                    names: gpuInfo.names.join(', ')
                  })
                : t('settings.performance.gpuNotDetected')}
            </p>
          )}
          <Row label={t('settings.performance.fp16Label')} description={t('settings.performance.fp16Desc')}>
            {/* 半精度：显存减半但可能影响精度，因此交给用户决定。 */}
            <Toggle value={fp16} onChange={(v) => patch({ fp16: v })} />
          </Row>
        </Card>
        <Card title={t('settings.performance.memoryTitle')} description={t('settings.performance.memoryDesc')}>
          <Row label={t('settings.performance.vramLabel')} description={t('settings.performance.vramDesc')}>
            {/* '0' 表示不限；其余为 GB 上限，超出时后端会拒绝或串行化任务。 */}
            <Select
              ariaLabel={t('settings.performance.vramAria')}
              value={vramLimit}
              onChange={(v) => patch({ vramLimit: v })}
              options={[
                { value: '4', label: t('settings.performance.gb4') },
                { value: '6', label: t('settings.performance.gb6') },
                { value: '8', label: t('settings.performance.gb8') },
                { value: '12', label: t('settings.performance.gb12') },
                { value: '0', label: t('settings.performance.noLimit') }
              ]}
            />
          </Row>
          <Row label={t('settings.performance.workersLabel')} description={t('settings.performance.workersDesc')}>
            {/* 并行 worker 会成倍占用显存，因此默认 1；显存充裕时才建议调高。 */}
            <Select
              ariaLabel={t('settings.performance.workersAria')}
              value={parallelWorkers}
              onChange={(v) => patch({ parallelWorkers: v })}
              options={[
                { value: '1', label: t('settings.performance.workersDefault') },
                { value: '2', label: t('settings.performance.workers2') },
                { value: '4', label: t('settings.performance.workers4') }
              ]}
            />
          </Row>
        </Card>
      </div>
    </Section>
  )
}
