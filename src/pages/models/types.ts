/**
 * 模型页的类型定义与常量。
 *
 * `Ext` 是扩展在 UI 层的统一视图模型（由后端 `WorkflowExtension` 归一化而来）；
 * `FILTERS` / `SORTS` / `SOURCES` 是工具栏筛选项、排序项与安装来源的本地化配置；
 * `BUILTIN_IDS` 标记内置可信扩展。
 */

import type { WorkflowExtension } from '../../types'
import { getT } from '../../i18n'

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** 扩展暴露的一个工作流节点（输入 / 输出端口）。 */
export interface ExtNode {
  /** 节点唯一标识。 */
  id: string
  /** 节点显示名。 */
  name: string
  /** 输入端口描述。 */
  input: string
  /** 输出端口描述。 */
  output: string
}

/** 扩展在 UI 层的统一视图模型。 */
export interface Ext {
  /** 扩展类别：模型（图→3D）或处理器（工作流工具）。 */
  type: 'model' | 'process'
  /** 扩展唯一标识（与后端 manifest id 对应）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 版本号；内置扩展固定为 1.0.0。 */
  version?: string
  /** 简介（本地化生成，非来自后端）。 */
  description?: string
  /** 作者。 */
  author?: string
  /** 是否来自官方 / 内置，决定"官方"筛选与可信标记。 */
  trusted: boolean
  /**
   * 是否为代码内置扩展（磁盘无目录）。内置项的卸载只是**停用**：会被记进后端的
   * 停用表，跨重启保持隐藏，并可从模型页顶部的"已停用"条带恢复；
   * 非内置（清单扩展）的卸载是真删目录。卸载弹窗据此切换说明文案。
   */
  builtin?: boolean
  /** 该扩展暴露的节点列表。 */
  nodes: ExtNode[]
  /** 是否已在服务端加载就绪。 */
  loaded: boolean
  /** 'multiview' = 生视图(图→图)模型；'mesh' 或空 = 建模(图→网格)模型。 */
  category?: string
  /** 用于下载权重的 HuggingFace 仓库（manifest 中的模型扩展）。 */
  hfRepo?: string
  /** 下载时跳过的文件前缀。 */
  hfSkipPrefixes?: string[]
  /** 下载时仅包含的文件前缀。 */
  hfIncludePrefixes?: string[]
}

/** 筛选维度：全部 / 处理器 / 模型 / 官方。 */
export type FilterId = 'all' | 'process' | 'model' | 'official'
/** 排序维度：按名称 / 按类型。 */
export type SortId = 'name' | 'type'
/** 安装来源：GitHub / HuggingFace / ModelScope。 */
export type SourceId = 'github' | 'huggingface' | 'modelscope'

/** 安装来源下拉项（文案走 i18n 键）。 */
export const SOURCES: { id: SourceId; tkey: string }[] = [
  { id: 'github', tkey: 'models.sourceGithub' },
  { id: 'huggingface', tkey: 'models.sourceHuggingFace' },
  { id: 'modelscope', tkey: 'models.sourceModelScope' }
]

/** 筛选栏选项。 */
export const FILTERS: { id: FilterId; tkey: string }[] = [
  { id: 'all', tkey: 'models.filterAll' },
  { id: 'process', tkey: 'models.filterProcess' },
  { id: 'model', tkey: 'models.filterModel' },
  { id: 'official', tkey: 'models.filterOfficial' }
]

/** 排序菜单选项。 */
export const SORTS: { id: SortId; tkey: string }[] = [
  { id: 'name', tkey: 'models.sortName' },
  { id: 'type', tkey: 'models.sortType' }
]

/** 内置扩展标识集合：这些视为官方 / 可信，且版本固定为 1.0.0。 */
export const BUILTIN_IDS = new Set([
  'hunyuan3d-2-mini',
  'mesh-repair', 'mesh-smoother', 'mesh-remesher', 'mesh-optimizer', 'mesh-exporter'
])

/** 把后端 `WorkflowExtension` 归一化为 UI 层的 `Ext` 视图模型。 */
export function toExt(e: WorkflowExtension): Ext {
  const isModel = e.kind === 'model'
  return {
    type: e.kind,
    id: e.id,
    name: e.display_name,
    // 内置扩展没有真实语义化版本，统一标为 1.0.0 以保持展示一致。
    version: BUILTIN_IDS.has(e.id) ? '1.0.0' : undefined,
    description: isModel
      ? getT('models.descGenerator')
      : getT('models.descProcessTool'),
    author: 'meshforge',
    trusted: BUILTIN_IDS.has(e.id),
    builtin: e.builtin === true,
    nodes: [{ id: e.id, name: e.display_name, input: e.input, output: e.output }],
    loaded: true,
    category: e.category,
    hfRepo: e.hfRepo,
    hfSkipPrefixes: e.hfSkipPrefixes,
    hfIncludePrefixes: e.hfIncludePrefixes
  }
}

/** 已停用（可恢复）的内置扩展——后端 `GET /extensions/disabled` 的单项视图。 */
export interface DisabledExt {
  /** 扩展 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 类别：模型生成器或网格处理工具。 */
  kind: 'model' | 'process'
  /** 更细的分类（生视图 / 图像 / 网格 / 处理）。 */
  category?: string
}
