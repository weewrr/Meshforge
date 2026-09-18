/**
 * 工作流画布左侧的节点面板。
 *
 * 分七个分组展示可拖拽元素：函数（当前工作流里已有的子图函数）、基础、逻辑，
 * 以及四类后端模型（生成建模 / 生视图 / 图像处理 / 网格工具）。
 * 拖拽负载统一是 `extension:<id>`（模型）或节点类型字符串（内置），由画布侧解析成新节点。
 * 面板宽度可拖拽调整，上下限见 `PANEL_MIN` / `PANEL_MAX`。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { listExtensions } from '../../../api'
import { extensionColor } from '../../../types'
import type { WorkflowExtension } from '../../../types'
import { useWorkflowsStore } from '../../../stores/workflows'
import { collectFunctions } from '../subgraphUtils'
import { useT } from '../../../i18n'
import { BUILTIN_ITEMS, LOGIC_ITEMS } from './items'
import { PanelTile, FunctionTile } from './tiles'
import { portColor, portLabel } from './portMeta'
import type { PanelItem } from './types'

/** 面板最小宽度（px）。 */
const PANEL_MIN = 200
/** 面板最大宽度（px）。 */
const PANEL_MAX = 480

/** 节点面板。`onOpenFunction` 由画布传入，用于从函数磁贴直接打开子图编辑器。 */
export default function ExtensionsPanel({ onOpenFunction }: { onOpenFunction?: (path: string[]) => void }) {
  const t = useT()
  const [extensions, setExtensions] = useState<WorkflowExtension[]>([])
  const [search, setSearch] = useState('')
  const [width, setWidth] = useState(300)
  // 拖拽调宽用 ref 而非 state：mousemove 期间不该触发重渲染，
  // 只有宽度本身（width state）变化时才需要渲染。
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  // 只订阅 current.nodes，避免 store 的其它字段变化也引发面板重渲染。
  const currentNodes = useWorkflowsStore((s) => s.current?.nodes)

  useEffect(() => {
    // 拉取失败就保持空列表：面板依然可用，只是四个模型分组为空。
    listExtensions().then(setExtensions).catch(() => undefined)
  }, [])

  const functions = useMemo(() => collectFunctions(currentNodes ?? []), [currentNodes])
  // 函数按名称过滤（大小写不敏感）；搜索框为空则全部保留。
  const shownFunctions = functions.filter((f) => !search.trim() || f.label.toLowerCase().includes(search.trim().toLowerCase()))

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      // 面板在右侧、向左拖应变更宽，因此用 startX - clientX。
      const delta = startX.current - e.clientX
      setWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW.current + delta)))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    // 监听挂在 document 上：鼠标拖出面板范围后仍能继续跟随。
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const query = search.trim().toLowerCase()
  // 内置/逻辑条目：标签优先取 i18n key，其次取字面 label。
  const builtinItems = BUILTIN_ITEMS.filter((n) => {
    const labelText = (n.labelKey ? t(n.labelKey) : n.label ?? '').toLowerCase()
    return !query || labelText.includes(query)
  })
  const logicItems = LOGIC_ITEMS.filter((n) => {
    const labelText = (n.labelKey ? t(n.labelKey) : n.label ?? '').toLowerCase()
    return !query || labelText.includes(query)
  })
  // 生成建模模型（图→网格）：沿用生成绿。
  const meshModelItems = useMemo(
    () =>
      extensions
        // 排除 multiview / image 两类，它们各自有独立分组与配色。
        .filter(
          (e) => e.kind === 'model' && e.category !== 'multiview' && e.category !== 'image' && (!query || e.display_name.toLowerCase().includes(query))
        )
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: extensionColor(e),
          glyph: 'generate'
        })),
    [extensions, query]
  )
  // 生视图模型（图→多视图图，category='multiview'）：全新青绿配色 + 图片图标。
  const multiviewModelItems = useMemo(
    () =>
      extensions
        .filter(
          (e) => e.kind === 'model' && e.category === 'multiview' && (!query || e.display_name.toLowerCase().includes(query))
        )
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: extensionColor(e),
          glyph: 'image'
        })),
    [extensions, query]
  )
  // 图像处理模型（单图→单图，category='image'）：品红配色 + 滤镜图标。
  const imageModelItems = useMemo(
    () =>
      extensions
        .filter(
          (e) => e.kind === 'model' && e.category === 'image' && (!query || e.display_name.toLowerCase().includes(query))
        )
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: extensionColor(e),
          glyph: 'image'
        })),
    [extensions, query]
  )
  // 网格处理工具（process 类扩展）：紫灰配色 + 网格图标。
  const processItems = useMemo(
    () =>
      extensions
        .filter((e) => e.kind === 'process' && (!query || e.display_name.toLowerCase().includes(query)))
        .map<PanelItem>((e) => ({
          dragPayload: `extension:${e.id}`,
          label: e.display_name,
          color: extensionColor(e),
          glyph: 'mesh'
        })),
    [extensions, query]
  )

  return (
    <div className="wf-panel" style={{ width }}>
      <div
        className="wf-panel__resizer"
        onMouseDown={(e) => {
          dragging.current = true
          startX.current = e.clientX
          startW.current = width
          // 拖拽期间把光标锁成 col-resize，并阻止选中文本。
          document.body.style.cursor = 'col-resize'
          e.preventDefault()
        }}
      />
      <div className="wf-panel__inner">
        <div className="wf-panel__header">
          <h2>{t('workflows.panel.title')}</h2>
          <p>{t('workflows.panel.dragToCanvas')}</p>
        </div>
        <input
          className="wf-panel__search"
          type="text"
          placeholder={t('workflows.panel.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupFunctions')}
            <span className="wf-panel__count">{shownFunctions.length}</span>
          </div>
          {shownFunctions.length > 0 ? (
            <div className="wf-panel__grid">
              {shownFunctions.map((fn) => (
                <FunctionTile key={fn.id} fn={fn} onOpen={onOpenFunction} />
              ))}
            </div>
          ) : (
            <p className="wf-panel__empty">{t('workflows.panel.fnEmpty')}</p>
          )}
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">{t('workflows.panel.groupBasic')}</div>
          <div className="wf-panel__grid">
            {builtinItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupLogic')}
            <span className="wf-panel__count">{logicItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {logicItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupGenerators')}
            <span className="wf-panel__count">{meshModelItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {meshModelItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupMultiview')}
            <span className="wf-panel__count">{multiviewModelItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {multiviewModelItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupImageModels')}
            <span className="wf-panel__count">{imageModelItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {imageModelItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__group">
          <div className="wf-panel__group-title">
            {t('workflows.panel.groupMeshTools')}
            <span className="wf-panel__count">{processItems.length}</span>
          </div>
          <div className="wf-panel__grid">
            {processItems.map((item) => (
              <PanelTile key={item.dragPayload} item={item} />
            ))}
          </div>
        </div>

        <div className="wf-panel__legend">
          {/* 端口类型色例：与画布上引脚颜色一一对应，帮助用户预期可连接性。 */}
          {(['image', 'text', 'mesh', 'any'] as const).map((pt) => (
            <span key={pt} className="wf-panel__legend-item">
              <i style={{ background: portColor(pt) }} />
              {t(portLabel(pt))}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
