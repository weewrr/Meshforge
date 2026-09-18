/**
 * 工作区资产库：类型定义 + 分组/搜索/排序/折叠逻辑。
 *
 * 语义对齐 Modly 的 assetLibraryUi：先按 `sourceScope`（Workflows / Exports）
 * 做一级分区，再按 `capability`（Mesh / 场景清单…）做二级分组，并支持搜索、
 * Type/Name/Date 排序与分区折叠。纯函数、无副作用，便于 `LibraryPanel` 复用。
 */

/** 资产能力类型：决定它在资产库里的二级分组归类。 */
export type AssetCapability =
  | 'mesh'
  | 'rigged-mesh'
  | 'animation-motion'
  | 'landmarks-sidecar'
  | 'generated-world'
  | 'scene-manifest'
/** 资产就绪状态：决定它能否在生成页直接打开。 */
export type AssetEntryState = 'ready' | 'unknown-metadata' | 'unsupported' | 'unsafe'

/** 一级分区来源：工作流产物还是导出文件。 */
export type AssetLibrarySourceScope = 'workflows' | 'exports'

/** 资产库里的一条资产记录。 */
export interface LibraryEntry {
  /** 资产唯一 id。 */
  id: string
  /** 工作区内的相对路径。 */
  workspacePath: string
  /** 展示名（用于列表与搜索匹配）。 */
  displayName: string
  /** 一级分区来源（Workflows / Exports）。 */
  sourceScope: AssetLibrarySourceScope
  /** 资产能力类型（二级分组归类）。 */
  capability: AssetCapability
  /** 就绪状态。 */
  state: AssetEntryState
  /** 预览类型标识（缩略图渲染用）。 */
  previewKind: string
  /** 打开前给出的警告信息列表。 */
  warnings: string[]
  /** 是否可在生成页直接打开。 */
  openable: boolean
  /** 不可打开时的原因（可选）。 */
  nonOpenableReason?: string | null
  /** 创建时间（ISO 字符串，可选）。 */
  createdAt?: string
  /** 更新时间（ISO 字符串，可选）。 */
  updatedAt?: string
  /** 静态文件 URL（`/files/…`），经 `fullUrl()` 拼接后可直接加载 */
  url: string
}

/** 资产排序方式：按类型 / 名称 / 时间。 */
export type LibrarySortMode = 'type' | 'name' | 'date'

/** 二级分组（按 capability 聚合的一批资产）。 */
export interface LibraryEntryGroup {
  /** 该组的能力类型。 */
  capability: AssetCapability
  /** 能力类型的中文/英文标签。 */
  capabilityLabel: string
  /** 折叠用的分区键（`capability:<scope>:<capability>`）。 */
  sectionKey: string
  /** 组内资产列表（已排序）。 */
  entries: LibraryEntry[]
}

/** 一级分组（按 sourceScope 聚合的一批二级分组）。 */
export interface LibraryScopeGroup {
  /** 该组的来源分区。 */
  sourceScope: AssetLibrarySourceScope
  /** 来源分区标签。 */
  sourceScopeLabel: string
  /** 折叠用的分区键（`scope:<scope>`）。 */
  sectionKey: string
  /** 二级分组列表。 */
  entryGroups: LibraryEntryGroup[]
}

const CAPABILITY_SECTIONS: readonly { capability: AssetCapability; label: string }[] = [
  { capability: 'mesh', label: 'Mesh' },
  { capability: 'rigged-mesh', label: 'Rigged mesh' },
  { capability: 'animation-motion', label: 'Animations/motions' },
  { capability: 'landmarks-sidecar', label: 'Landmarks sidecars' },
  { capability: 'generated-world', label: 'Generated worlds' },
  { capability: 'scene-manifest', label: 'Scene manifests' }
]

const SCOPE_SECTIONS: readonly { sourceScope: AssetLibrarySourceScope; label: string }[] = [
  { sourceScope: 'workflows', label: 'Workflows' },
  { sourceScope: 'exports', label: 'Exports' }
]

const CAPABILITY_ORDER = new Map(CAPABILITY_SECTIONS.map((s, i) => [s.capability, i]))

/** 排序下拉选项：供 UI 渲染排序模式选择器。 */
export const LIBRARY_SORT_OPTIONS: readonly { value: LibrarySortMode; label: string }[] = [
  { value: 'type', label: 'Type' },
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' }
]

/** 默认折叠的分区键集合：初次打开时把所有 scope 与 capability 分区都收起。 */
export function getDefaultCollapsedSectionKeys(): string[] {
  return SCOPE_SECTIONS.flatMap((scope) => [
    `scope:${scope.sourceScope}`,
    ...CAPABILITY_SECTIONS.map((c) => `capability:${scope.sourceScope}:${c.capability}`)
  ])
}

/** 折叠/展开某个分区：键已存在则移除，否则加入当前折叠键集合。 */
export function toggleSectionKey(currentKeys: string[], sectionKey: string): string[] {
  return currentKeys.includes(sectionKey)
    ? currentKeys.filter((k) => k !== sectionKey)
    : [...currentKeys, sectionKey]
}

/** 判断资产是否可在生成页直接打开：须状态为 `ready` 且 `openable` 为真。 */
export function isOpenable(entry: LibraryEntry | null | undefined): boolean {
  return Boolean(entry && entry.state === 'ready' && entry.openable)
}

/** 给出资产"能否打开"的可读说明，用于列表项上的 tooltip 文案。 */
export function describeOpenability(entry: LibraryEntry): string {
  if (entry.state === 'unknown-metadata') return 'Missing metadata prevents a safe open in Generate.'
  if (entry.state === 'unsupported') return 'This asset is tracked in the library but is not supported in Generate.'
  if (entry.state === 'unsafe') return 'This asset was rejected because its workspace path is unsafe.'
  if (entry.openable) return 'Ready to open this asset directly in Generate.'
  return entry.nonOpenableReason ?? 'Workspace asset is not openable.'
}

/**
 * 把资产列表按 scope/capability 两级分组，并应用搜索与排序。
 *
 * 无搜索词时整组展示；有搜索词时，只有匹配（scope 名、capability 名或条目
 * 自身字段命中）的二级分组才保留。排序为 `type` 时按 capability 固定顺序，
 * 否则按名称/时间排后再按能力顺序稳定化。
 *
 * @param entries 待组织的资产列表。
 * @param searchQuery 搜索关键字（忽略大小写与首尾空白）。
 * @param sortMode 排序方式。
 * @returns 已分组、过滤、排序后的一级分组数组。
 */
export function filterScopeGroups(
  entries: LibraryEntry[],
  searchQuery: string,
  sortMode: LibrarySortMode
): LibraryScopeGroup[] {
  const needle = searchQuery.trim().toLocaleLowerCase()
  return SCOPE_SECTIONS
    .map((scopeSection) => {
      const scopeEntries = entries.filter((e) => e.sourceScope === scopeSection.sourceScope)
      const scopeMatches = needle.length > 0 && matches(scopeSection.label, needle)

      const entryGroups = CAPABILITY_SECTIONS
        .map((capabilitySection) => {
          const capabilityEntries = scopeEntries.filter((e) => e.capability === capabilitySection.capability)
          if (capabilityEntries.length === 0) return null
          const capabilityMatches =
            scopeMatches || (needle.length > 0 && matches(capabilitySection.label, needle))
          const visible = !needle || capabilityMatches
            ? capabilityEntries
            : capabilityEntries.filter((e) => matchesEntry(e, needle))
          if (visible.length === 0) return null
          return {
            capability: capabilitySection.capability,
            capabilityLabel: capabilitySection.label,
            sectionKey: `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
            entries: sortEntries(visible, sortMode)
          }
        })
        .filter((g): g is LibraryEntryGroup => g !== null)

      const sortedGroups = sortMode === 'type'
        ? entryGroups
        : [...entryGroups].sort((l, r) => compareEntries(l.entries[0], r.entries[0], sortMode)
            // 能力顺序表里查不到的（理论上不该出现）兜底排到最后。
            || (CAPABILITY_ORDER.get(l.capability) ?? Number.MAX_SAFE_INTEGER)
              - (CAPABILITY_ORDER.get(r.capability) ?? Number.MAX_SAFE_INTEGER))

      if (sortedGroups.length === 0) return null
      return {
        sourceScope: scopeSection.sourceScope,
        sourceScopeLabel: scopeSection.label,
        sectionKey: `scope:${scopeSection.sourceScope}`,
        entryGroups: sortedGroups
      }
    })
    .filter((g): g is LibraryScopeGroup => g !== null)
}

function sortEntries(entries: LibraryEntry[], sortMode: LibrarySortMode): LibraryEntry[] {
  return [...entries].sort((l, r) => compareEntries(l, r, sortMode))
}

function compareEntries(left: LibraryEntry, right: LibraryEntry, sortMode: LibrarySortMode): number {
  if (sortMode === 'date') {
    const lt = parseTimestamp(left.updatedAt) ?? parseTimestamp(left.createdAt)
    const rt = parseTimestamp(right.updatedAt) ?? parseTimestamp(right.createdAt)
    if (lt !== null && rt !== null && lt !== rt) return rt - lt
    if (lt !== null && rt === null) return -1
    if (lt === null && rt !== null) return 1
  }
  return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
    || left.workspacePath.localeCompare(right.workspacePath, undefined, { sensitivity: 'base' })
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function matchesEntry(entry: LibraryEntry, needle: string): boolean {
  return [entry.displayName, entry.workspacePath, entry.capability, entry.sourceScope]
    .some((v) => matches(v, needle))
}

function matches(value: string, needle: string): boolean {
  return value.toLocaleLowerCase().includes(needle)
}
