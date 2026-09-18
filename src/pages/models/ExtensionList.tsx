/**
 * ModelsPage 扩展列表：四个分组（处理器 / 网格模型 / 视图模型 / 图像模型）
 * 与"非分组"的平铺列表两种渲染模式。
 *
 * 从 ModelsPage 抽出的展示组件——分组数据与卡片回调由页面传入。
 */

import type { Ext } from './types'
import type { ModelDownloadInfo } from '../../api'
import { CUBE_ICON, IMAGE_ICON, IMGFILTER_ICON, SPARK_ICON } from './ui'
import { ExtensionCard } from './ExtensionCard'
import { useT } from '../../i18n'

/** ExtensionCard 的回调束：四个分组与抽屉共用同一套动作签名。 */
export interface CardActions {
  onOpen: (e: Ext) => void
  onUninstall: (e: Ext) => void
  onInstall: (e: Ext) => void
  onPause: (e: Ext) => void
  onResume: (e: Ext) => void
  onCancel: (e: Ext) => void
}

interface ExtensionListProps {
  grouped: boolean
  processList: Ext[]
  meshModelList: Ext[]
  viewModelList: Ext[]
  imageModelList: Ext[]
  flatList: Ext[]
  downloading: Record<string, ModelDownloadInfo>
  modelStatus: Record<string, { downloaded: boolean; sizeBytes: number }>
  isInstalling: boolean
  actions: CardActions
}

export function ExtensionList(props: ExtensionListProps) {
  const {
    grouped, processList, meshModelList, viewModelList, imageModelList, flatList,
    downloading, modelStatus, isInstalling, actions
  } = props
  const t = useT()

  function groupSection(
    key: 'process' | 'mesh' | 'view' | 'image',
    list: Ext[],
    spaced: boolean,
    icon: React.ReactNode,
    titleKey: string,
    iconClass: string
  ) {
    if (list.length === 0) return null
    return (
      <section className={`ex-group ${spaced ? 'ex-group--spaced' : ''}`} data-group={key}>
        <div className="ex-group__head">
          <span className={`ex-group__icon ${iconClass}`}>{icon}</span>
          <h2 className="ex-group__title">{t(titleKey)}</h2>
          <span className="ex-group__count">{list.length}</span>
          <span className="ex-group__line" />
        </div>
        <div className="ex-grid">
          {list.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              dl={downloading[ext.id]}
              installed={!!modelStatus[ext.id]?.downloaded}
              disabled={isInstalling}
              {...actions}
            />
          ))}
        </div>
      </section>
    )
  }

  if (!grouped) {
    return (
      <div className="ex-grid">
        {flatList.map((ext) => (
          <ExtensionCard
            key={ext.id}
            ext={ext}
            dl={downloading[ext.id]}
            installed={!!modelStatus[ext.id]?.downloaded}
            disabled={isInstalling}
            {...actions}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      {groupSection('process', processList, false, CUBE_ICON, 'models.groupProcessors', 'ex-group__icon--process')}
      {groupSection('mesh', meshModelList, processList.length > 0, SPARK_ICON, 'models.groupMeshModels', 'ex-group__icon--model')}
      {groupSection(
        'view',
        viewModelList,
        processList.length > 0 || meshModelList.length > 0,
        IMAGE_ICON,
        'models.groupViewModels',
        'ex-group__icon--view'
      )}
      {groupSection(
        'image',
        imageModelList,
        processList.length > 0 || meshModelList.length > 0 || viewModelList.length > 0,
        IMGFILTER_ICON,
        'models.groupImageModels',
        'ex-group__icon--image'
      )}
    </>
  )
}
