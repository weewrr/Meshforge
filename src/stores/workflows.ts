import { create } from 'zustand'
import type { NodeChange, EdgeChange, Connection } from '@xyflow/react'
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow
} from '../api'
import type { WFEdge, WFNode, Workflow, WorkflowMeta } from '../types'
import { isContainerType } from '../types'
import { useLogsStore } from './logs'

function newId(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

interface Snapshot {
  nodes: WFNode[]
  edges: WFEdge[]
}

interface WorkflowsState {
  workflows: WorkflowMeta[]
  current: Workflow | null
  loaded: boolean
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  loadList: () => Promise<void>
  select: (id: string) => Promise<void>
  create: () => Promise<void>
  rename: (name: string) => void
  applyNodeChanges: (changes: NodeChange<WFNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<WFEdge>[]) => void
  connect: (connection: Connection) => void
  addNode: (node: WFNode) => void
  updateNodeData: (nodeId: string, params: Record<string, unknown>) => void
  /** Replace the whole node list. history:false → silent (used inside delete flow). */
  replaceNodes: (nodes: WFNode[], opts?: { history?: boolean }) => void
  /** Snapshot the current graph before a mutation begins (e.g. node drag start). */
  pushHistory: () => void
  undo: () => void
  redo: () => void
  duplicate: (id: string) => Promise<void>
  moveToFolder: (id: string, folder?: string) => Promise<void>
  toggleBookmark: (id: string) => Promise<void>
  reorderTab: (dragId: string, targetId: string) => void
  importWorkflow: (wf: Workflow) => Promise<void>
  save: () => Promise<void>
  remove: (id: string) => Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let listInFlight = false

// ─── Tab order (visual only; persisted locally, backend stays recency-sorted) ──
const TAB_ORDER_KEY = 'meshforge.tabOrder'

function loadTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveTabOrder(ids: string[]): void {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable — session-only order */
  }
}

/** Reorder the list to match saved tab order where ids still exist. */
function applyTabOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items
  const byId = new Map(items.map((w) => [w.id, w]))
  const next: T[] = []
  for (const id of order) {
    const wf = byId.get(id)
    if (wf) {
      next.push(wf)
      byId.delete(id)
    }
  }
  next.push(...byId.values())
  return next
}

// ─── Undo / redo history (per current workflow, capped) ─────────────────────
const past: Snapshot[] = []
const future: Snapshot[] = []
const HISTORY_MAX = 50

function scheduleAutosave(get: () => WorkflowsState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void get().save()
  }, 800)
}

export const useWorkflowsStore = create<WorkflowsState>((set, get) => {
  function clearHistory(): void {
    past.length = 0
    future.length = 0
    set({ canUndo: false, canRedo: false })
  }

  /** Capture the pre-mutation graph. Called before structural edits and at
   *  node drag start (position drags stream too many changes to snapshot each). */
  function pushHistory(): void {
    const cur = get().current
    if (!cur) return
    past.push({ nodes: cur.nodes, edges: cur.edges })
    if (past.length > HISTORY_MAX) past.shift()
    future.length = 0
    set({ canUndo: true, canRedo: false })
  }

  function touch(): void {
    if (!get().current) return
    set((s) => ({
      current: s.current ? { ...s.current, updatedAt: nowIso() } : s.current,
      dirty: true
    }))
    scheduleAutosave(get)
  }

  return {
    workflows: [],
    current: null,
    loaded: false,
    dirty: false,
    canUndo: false,
    canRedo: false,

    loadList: async () => {
      if (listInFlight) return
      listInFlight = true
      try {
        const workflows = await listWorkflows()
        set({ workflows: applyTabOrder(workflows, loadTabOrder()), loaded: true })
        // Seed a starter workflow on first launch.
        if (workflows.length === 0) {
          await get().create()
          return
        }
        const current = get().current
        if (current && workflows.some((w) => w.id === current.id)) return
        await get().select(workflows[0].id)
      } catch (e) {
        useLogsStore.getState().error(`load workflows: ${e}`)
        set({ loaded: true })
      } finally {
        listInFlight = false
      }
    },

    select: async (id) => {
      try {
        const current = await getWorkflow(id)
        clearHistory()
        set({ current, dirty: false })
      } catch (e) {
        useLogsStore.getState().error(`select workflow: ${e}`)
      }
    },

    create: async () => {
      const wf: Workflow = {
        id: newId(),
        name: `Workflow ${get().workflows.length + 1}`,
        description: '',
        nodes: [],
        edges: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
      await saveWorkflow(wf)
      clearHistory()
      set((s) => ({
        workflows: [{ id: wf.id, name: wf.name, updatedAt: wf.updatedAt }, ...s.workflows],
        current: wf,
        dirty: false
      }))
    },

    rename: (name) => {
      if (!get().current) return
      set((s) => ({
        current: s.current ? { ...s.current, name } : s.current,
        workflows: s.workflows.map((w) => (w.id === s.current?.id ? { ...w, name } : w)),
        dirty: true
      }))
      scheduleAutosave(get)
    },

    applyNodeChanges: (changes) => {
      if (!get().current) return
      const structural = changes.some((c) => c.type === 'remove' || c.type === 'add')
      if (structural) pushHistory()
      set((s) => ({
        current: s.current
          ? { ...s.current, nodes: applyNodeChanges(changes, s.current.nodes) }
          : s.current
      }))
      if (structural || changes.some((c) => c.type === 'position')) touch()
    },

    applyEdgeChanges: (changes) => {
      if (!get().current) return
      if (changes.some((c) => c.type === 'remove')) pushHistory()
      set((s) => ({
        current: s.current
          ? { ...s.current, edges: applyEdgeChanges(changes, s.current.edges) }
          : s.current
      }))
      if (changes.some((c) => c.type === 'remove')) touch()
    },

    connect: (connection) => {
      if (!get().current) return
      pushHistory()
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              edges: addEdge({ ...connection, animated: false }, s.current.edges)
            }
          : s.current
      }))
      touch()
    },

    addNode: (node) => {
      if (!get().current) return
      pushHistory()
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              // Containers must precede their children in the array (React Flow invariant).
              nodes: isContainerType(node.type)
                ? [node, ...s.current.nodes]
                : [...s.current.nodes, node]
            }
          : s.current
      }))
      touch()
    },

    updateNodeData: (nodeId, params) => {
      if (!get().current) return
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              nodes: s.current.nodes.map((n) =>
                n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, ...params } } } : n
              )
            }
          : s.current
      }))
      touch()
    },

    pushHistory,

    replaceNodes: (nodes, opts) => {
      if (!get().current) return
      if (opts?.history !== false) pushHistory()
      set((s) => ({ current: s.current ? { ...s.current, nodes } : s.current }))
      if (opts?.history !== false) touch()
    },

    undo: () => {
      const cur = get().current
      const snap = past.pop()
      if (!cur || !snap) return
      future.push({ nodes: cur.nodes, edges: cur.edges })
      set({
        current: { ...cur, nodes: snap.nodes, edges: snap.edges },
        canUndo: past.length > 0,
        canRedo: true,
        dirty: true
      })
      scheduleAutosave(get)
    },

    redo: () => {
      const cur = get().current
      const snap = future.pop()
      if (!cur || !snap) return
      past.push({ nodes: cur.nodes, edges: cur.edges })
      set({
        current: { ...cur, nodes: snap.nodes, edges: snap.edges },
        canUndo: true,
        canRedo: future.length > 0,
        dirty: true
      })
      scheduleAutosave(get)
    },

    duplicate: async (id) => {
      let source: Workflow | null = get().current?.id === id ? get().current : null
      if (!source) source = await getWorkflow(id).catch(() => null)
      if (!source) return
      const copy: Workflow = {
        ...structuredClone(source),
        id: newId(),
        name: `${source.name || 'Untitled'} copy`,
        bookmarked: false,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
      await saveWorkflow(copy)
      set((s) => ({
        workflows: [
          { id: copy.id, name: copy.name, updatedAt: copy.updatedAt, folder: copy.folder },
          ...s.workflows
        ]
      }))
      await get().select(copy.id)
    },

    moveToFolder: async (id, folder) => {
      let wf: Workflow | null = get().current?.id === id ? get().current : null
      if (!wf) wf = await getWorkflow(id).catch(() => null)
      if (!wf || (wf.folder ?? undefined) === folder) return
      const next = { ...wf, folder, updatedAt: nowIso() }
      await saveWorkflow(next)
      if (get().current?.id === id) set({ current: next, dirty: false })
      set((s) => ({
        workflows: s.workflows.map((w) => (w.id === id ? { ...w, folder } : w))
      }))
    },

    toggleBookmark: async (id) => {
      let wf: Workflow | null = get().current?.id === id ? get().current : null
      if (!wf) wf = await getWorkflow(id).catch(() => null)
      if (!wf) return
      // Not an edit — keep updatedAt so the recency sort doesn't reshuffle.
      const next = { ...wf, bookmarked: !wf.bookmarked }
      await saveWorkflow(next)
      if (get().current?.id === id) set({ current: next, dirty: false })
      set((s) => ({
        workflows: s.workflows.map((w) => (w.id === id ? { ...w, bookmarked: next.bookmarked } : w))
      }))
    },

    reorderTab: (dragId, targetId) => {
      if (dragId === targetId) return
      const workflows = get().workflows
      if (!workflows.some((w) => w.id === dragId)) return
      const ids = workflows.map((w) => w.id).filter((id) => id !== dragId)
      const idx = ids.indexOf(targetId)
      if (idx === -1) return
      ids.splice(idx, 0, dragId)
      const byId = new Map(workflows.map((w) => [w.id, w]))
      set({ workflows: ids.map((id) => byId.get(id)!).filter(Boolean) })
      saveTabOrder(ids)
    },

    importWorkflow: async (wf) => {
      const imported: Workflow = {
        ...wf,
        id: newId(),
        name: wf.name || 'Imported',
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
      await saveWorkflow(imported)
      set((s) => ({
        workflows: [
          { id: imported.id, name: imported.name, updatedAt: imported.updatedAt, folder: imported.folder },
          ...s.workflows
        ]
      }))
      await get().select(imported.id)
    },

    save: async () => {
      const current = get().current
      if (!current) return
      try {
        await saveWorkflow(current)
        set((s) => ({
          dirty: false,
          workflows: s.workflows.map((w) =>
            w.id === current.id
              ? { ...w, name: current.name, updatedAt: current.updatedAt, folder: current.folder }
              : w
          )
        }))
      } catch (e) {
        useLogsStore.getState().error(`save workflow: ${e}`)
      }
    },

    remove: async (id) => {
      await deleteWorkflow(id).catch((e) => useLogsStore.getState().error(`delete workflow: ${e}`))
      const workflows = get().workflows.filter((w) => w.id !== id)
      set({ workflows })
      if (get().current?.id === id) {
        clearHistory()
        if (workflows.length > 0) await get().select(workflows[0].id)
        else {
          set({ current: null })
          await get().create()
        }
      }
    }
  }
})
