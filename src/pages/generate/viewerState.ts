/**
 * GeneratePage 查看器区域的共享状态类型。
 */

/** 当前展开的工具栏弹层；null 表示全部收起（同一时刻至多一个展开）。 */
export type OpenPanel =
  | 'import' | 'library' | 'export' | 'smooth' | 'decimate' | 'light' | null

/** 导出格式（GLB 直下，其余走后端转换任务）。 */
export type ExportFormat = 'glb' | 'obj' | 'stl' | 'ply'
