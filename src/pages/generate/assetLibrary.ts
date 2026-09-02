/**
 * Workspace asset library — 类型 + 分组/搜索/排序/折叠逻辑。
 * 语义对齐 Modly 的 assetLibraryUi：按 sourceScope（Workflows / Exports）
 * 一级分组，再按 capability（Mesh / Scene manifests…）二级分组，
 * 支持搜索、Type/Name/Date 排序与分区折叠。
 */

export type AssetCapability =
  | 'mesh'
  | 'rigged-mesh'
  | 'animation-motion'
  | 'landmarks-sidecar'
  | 'generated-world'
  | 'scene-manifest'

export type AssetEntryState = 'ready' | 'unknown-metadata' | 'unsupported' | 'unsafe'

export type AssetLibrarySourceScope = 'workflows' | 'exports'

export interface LibraryEntry {
  id: string
  workspacePath: string
  displayName: string
  sourceScope: AssetLibrarySourceScope
  capability: AssetCapability
  state: AssetEntryState
  previewKind: string
  warnings: string[]
  openable: boolean
  nonOpenableReason?: string | null
  createdAt?: string
  updatedAt?: string
  /** 静态文件 URL（/files/…），经 fullUrl() 拼接后可直接加载 */
  url: string
}

export type LibrarySortMode = 'type' | 'name' | 'date'

export interface LibraryEntryGroup {
  capability: AssetCapability
  capabilityLabel: string
  sectionKey: string
  entries: LibraryEntry[]
}

export interface LibraryScopeGroup {
  sourceScope: AssetLibrarySourceScope
  sourceScopeLabel: string
  sectionKey: string
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

export const LIBRARY_SORT_OPTIONS: readonly { value: LibrarySortMode; label: string }[] = [
  { value: 'type', label: 'Type' },
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' }
]

export function getDefaultCollapsedSectionKeys(): string[] {
  return SCOPE_SECTIONS.flatMap((scope) => [
    `scope:${scope.sourceScope}`,
    ...CAPABILITY_SECTIONS.map((c) => `capability:${scope.sourceScope}:${c.capability}`)
  ])
}

export function toggleSectionKey(currentKeys: string[], sectionKey: string): string[] {
  return currentKeys.includes(sectionKey)
    ? currentKeys.filter((k) => k !== sectionKey)
    : [...currentKeys, sectionKey]
}

export function isOpenable(entry: LibraryEntry | null | undefined): boolean {
  return Boolean(entry && entry.state === 'ready' && entry.openable)
}

export function describeOpenability(entry: LibraryEntry): string {
  if (entry.state === 'unknown-metadata') return 'Missing metadata prevents a safe open in Generate.'
  if (entry.state === 'unsupported') return 'This asset is tracked in the library but is not supported in Generate.'
  if (entry.state === 'unsafe') return 'This asset was rejected because its workspace path is unsafe.'
  if (entry.openable) return 'Ready to open this asset directly in Generate.'
  return entry.nonOpenableReason ?? 'Workspace asset is not openable.'
}

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
