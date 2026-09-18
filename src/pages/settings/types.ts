/**
 * 设置页的分组类型。
 *
 * `SectionId` 是设置页内部左侧导航的分组标识，与顶层应用页面 id 互不相关——
 * 设置页本身只是导航里的一个 `settings` 入口。
 */

// 设置页左导航的分组标识（与 App 侧的页面 id 无关）。

/** 设置页左侧导航的分组标识。 */
export type SectionId = 'application' | 'storage' | 'integrations' | 'performance' | 'agent' | 'logs' | 'about'
