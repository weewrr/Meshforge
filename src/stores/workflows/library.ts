// ─── Library slice：工作流列表 CRUD、标签页、打开 / 保存 / 删除 ───────────────
/**
 * 工作流"库"相关的状态与动作切片。
 *
 * 负责列表加载、选中、新建、重命名、复制、文件夹归类、书签、标签排序、导入、
 * 保存与删除——即所有"围绕工作流文档本身"的操作；图结构编辑在 `graph.ts` 里。
 */

import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow } from '../../api'
import type { Workflow } from '../../types'
import { getT } from '../../i18n'
import { useLogsStore } from '../logs'
import { toast } from '../toasts'
import { newId, nowIso } from './helpers'
import {
  applyTabOrder,
  clearLastWorkflowId,
  loadLastWorkflowId,
  loadTabOrder,
  saveLastWorkflowId,
  saveTabOrder
} from './storage'
import type { Get, Set, SliceDeps, WorkflowsState } from './types'

/** 本 slice 负责的动作集合。从 `WorkflowsState` 里拣选出来，保证类型始终同步。 */
export type LibraryActions = Pick<
  WorkflowsState,
  | 'loadList'
  | 'select'
  | 'create'
  | 'rename'
  | 'duplicate'
  | 'moveToFolder'
  | 'toggleBookmark'
  | 'reorderTab'
  | 'importWorkflow'
  | 'save'
  | 'remove'
>

/** 创建工作流库 slice。 */
export function createLibrarySlice(set: Set, get: Get, deps: SliceDeps): LibraryActions {
  const { history, autosave } = deps
  // 防重入标志：列表加载会被多处触发（挂载、切页、手动刷新），
  // 并发拉取会互相覆盖结果，甚至重复播种示例工作流。
  let listInFlight = false

  return {
    loadList: async () => {
      if (listInFlight) return
      listInFlight = true
      try {
        const workflows = await listWorkflows()
        // 按本地保存的标签顺序重排（后端只负责按最近修改排序）。
        set({ workflows: applyTabOrder(workflows, loadTabOrder()), loaded: true })
        // 首次启动时播种一个示例工作流，避免用户面对完全空白的界面。
        if (workflows.length === 0) {
          await get().create()
          return
        }
        const current = get().current
        // 已经打开的工作流仍然存在则保持不动（例如手动刷新列表的场景）。
        if (current && workflows.some((w) => w.id === current.id)) return
        // 崩溃恢复：优先恢复到重载前打开的那个工作流。
        const savedId = loadLastWorkflowId()
        if (savedId && workflows.some((w) => w.id === savedId)) {
          await get().select(savedId)
          return
        }
        // 兜底：选列表里第一个（即最近修改的那个）。
        await get().select(workflows[0].id)
      } catch (e) {
        useLogsStore.getState().error(`load workflows: ${e}`)
        // 失败也要置 loaded，否则界面会永远停在加载骨架屏。
        set({ loaded: true })
      } finally {
        // 无论成功失败都要解除防重入锁。
        listInFlight = false
      }
    },

    select: async (id) => {
      try {
        const current = await getWorkflow(id)
        // 切换工作流前必须清空撤销栈：历史只对"当前工作流"有效。
        history.clear()
        set({ current, dirty: false })
        // 记下最后打开的工作流，供下次启动 / 崩溃重载后恢复。
        saveLastWorkflowId(id)
      } catch (e) {
        useLogsStore.getState().error(`select workflow: ${e}`)
      }
    },

    create: async () => {
      const wf: Workflow = {
        id: newId(),
        // 用"现有数量 + 1"命名，够用且无需查询后端。
        name: `Workflow ${get().workflows.length + 1}`,
        description: '',
        nodes: [],
        edges: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
      await saveWorkflow(wf)
      history.clear()
      // 新工作流置顶（列表按最近修改排序），并立即选中。
      set((s) => ({
        workflows: [{ id: wf.id, name: wf.name, updatedAt: wf.updatedAt }, ...s.workflows],
        current: wf,
        dirty: false
      }))
      toast.success(getT('workflows.toast.created'), { duration: 2000 })
    },

    rename: (name) => {
      if (!get().current) return
      // 同时改 current 与列表行：列表是独立数组，不会跟着 current 变。
      set((s) => ({
        current: s.current ? { ...s.current, name } : s.current,
        workflows: s.workflows.map((w) => (w.id === s.current?.id ? { ...w, name } : w)),
        dirty: true
      }))
      autosave.schedule()
    },

    duplicate: async (id) => {
      // 优先复用内存里的当前工作流，避免多打一次接口。
      let source: Workflow | null = get().current?.id === id ? get().current : null
      if (!source) source = await getWorkflow(id).catch(() => null)
      if (!source) return
      const copy: Workflow = {
        // 深拷贝：节点/边数组必须与源相互独立，否则编辑副本会连带改动原件。
        ...structuredClone(source),
        id: newId(),
        name: `${source.name || 'Untitled'} copy`,
        // 副本不继承书签——否则复制一次就多一个置顶项，反而干扰列表。
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
      // 复制后直接切过去，符合"复制一份继续改"的使用习惯。
      await get().select(copy.id)
      toast.success(getT('workflows.toast.duplicated'), { duration: 2000 })
    },

    moveToFolder: async (id, folder) => {
      let wf: Workflow | null = get().current?.id === id ? get().current : null
      if (!wf) wf = await getWorkflow(id).catch(() => null)
      // 目标文件夹与现状相同则不做任何事，避免无谓的写盘与 updatedAt 漂移。
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
      // 书签不算"编辑"：刻意不动 updatedAt，免得按最近修改排序时列表发生重排。
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
      // 先把被拖项摘出来，再插到目标项原本的位置之前。
      const ids = workflows.map((w) => w.id).filter((id) => id !== dragId)
      const idx = ids.indexOf(targetId)
      if (idx === -1) return
      ids.splice(idx, 0, dragId)
      const byId = new Map(workflows.map((w) => [w.id, w]))
      set({ workflows: ids.map((id) => byId.get(id)!).filter(Boolean) })
      // 顺序只存在于本地（后端不关心），因此直接落 localStorage。
      saveTabOrder(ids)
    },

    importWorkflow: async (wf) => {
      const imported: Workflow = {
        ...wf,
        // 重新分配 id：避免导入的工作流与已存在的同 id 文档互相覆盖。
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
        // 保存成功后同步列表行（名字/时间/文件夹可能都变了），并清掉脏标记。
        set((s) => ({
          dirty: false,
          workflows: s.workflows.map((w) =>
            w.id === current.id
              ? { ...w, name: current.name, updatedAt: current.updatedAt, folder: current.folder }
              : w
          )
        }))
      } catch (e) {
        // 保存失败不抛给调用方（自动保存是后台行为），只记日志 + 弹一次 toast，
        // 让用户知道"刚才的改动可能没存上"。
        useLogsStore.getState().error(`save workflow: ${e}`)
        toast.error(getT('workflows.toast.saveFail'))
      }
    },

    remove: async (id) => {
      await deleteWorkflow(id).catch((e) => useLogsStore.getState().error(`delete workflow: ${e}`))
      const workflows = get().workflows.filter((w) => w.id !== id)
      set({ workflows })
      // 若崩溃恢复指向的正是被删的工作流，清掉该记录，否则下次启动会试图恢复一个不存在的文档。
      if (loadLastWorkflowId() === id) clearLastWorkflowId()
      if (get().current?.id === id) {
        history.clear()
        // 删掉当前打开的工作流后：还有别的就切过去，否则新建一个空工作流，
        // 避免应用停留在"没有当前工作流"的状态。
        if (workflows.length > 0) await get().select(workflows[0].id)
        else {
          set({ current: null })
          await get().create()
        }
      }
    }
  }
}
