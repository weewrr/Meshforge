// ─── Graph slice：节点 / 连线变更，可撤销的结构性编辑 ─────────────────────────
/**
 * 工作流"图结构"相关的状态与动作切片。
 *
 * 覆盖节点/连线的增删改、连线建立、子图文档的嵌套编辑、函数实例化与复制，
 * 以及撤销栈的显式入口。所有结构性改动都会先 `history.push()` 再落状态，
 * 保证一次操作对应一步撤销。
 */

import { addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import {
  SUBGRAPH_REF_PARAM,
  getSubgraphDoc,
  isContainerType,
  nodeSpec,
  subgraphRefOf,
  type SubgraphDoc,
  type WFNode
} from '../../types'
import { newId, syncFunctionInstances } from './helpers'
import type { Get, Set, SliceDeps, WorkflowsState } from './types'

/** 本 slice 负责的动作集合。从 `WorkflowsState` 里拣选出来，保证类型始终同步。 */
export type GraphActions = Pick<
  WorkflowsState,
  | 'applyNodeChanges'
  | 'applyEdgeChanges'
  | 'connect'
  | 'addNode'
  | 'updateNodeData'
  | 'updateNodeDataAt'
  | 'updateSubgraphNodeData'
  | 'replaceSubgraphGraph'
  | 'renameSubgraph'
  | 'renameSubgraphAt'
  | 'instantiateFunction'
  | 'duplicateNodes'
  | 'pushHistory'
  | 'markDirty'
  | 'replaceNodes'
  | 'replaceGraph'
>

/** 创建图结构 slice。 */
export function createGraphSlice(set: Set, get: Get, deps: SliceDeps): GraphActions {
  const { history, autosave } = deps

  return {
    applyNodeChanges: (changes) => {
      if (!get().current) return
      // 增删节点是可撤销的结构性改动，因此要入历史栈。
      const structural = changes.some((c) => c.type === 'remove' || c.type === 'add')
      // 尺寸变更只在 NodeResizer 真正拖拽时带 `resizing`（加载/首帧测量不带），
      // 用它区分"用户改了大小"与"React Flow 量了一遍"，只对前者安排自动保存。
      const resized = changes.some((c) => c.type === 'dimensions' && c.resizing !== undefined)
      if (structural) history.push()
      set((s) => ({
        current: s.current
          ? { ...s.current, nodes: applyNodeChanges(changes, s.current.nodes) }
          : s.current
      }))
      // 位置变更（拖拽 / 方向键微调）是逐帧触发的，这里刻意不标记脏：否则每一帧都会重写
      // updatedAt 并重置自动保存定时器。改为在交互结束时由 Canvas 调一次 markDirty()。
      if (structural || resized) autosave.touch()
    },

    applyEdgeChanges: (changes) => {
      if (!get().current) return
      // 只有删除连线需要入栈；其余（如选中态）不是可撤销改动。
      if (changes.some((c) => c.type === 'remove')) history.push()
      set((s) => ({
        current: s.current
          ? { ...s.current, edges: applyEdgeChanges(changes, s.current.edges) }
          : s.current
      }))
      if (changes.some((c) => c.type === 'remove')) autosave.touch()
    },

    connect: (connection) => {
      if (!get().current) return
      history.push()
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              // animated: false —— 新建连线默认不动画，只有执行中的连线才开动画。
              edges: addEdge({ ...connection, animated: false }, s.current.edges)
            }
          : s.current
      }))
      autosave.touch()
    },

    addNode: (node) => {
      if (!get().current) return
      history.push()
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              // 容器必须排在它的子节点之前（React Flow 的数组顺序约束）。
              nodes: isContainerType(node.type)
                ? [node, ...s.current.nodes]
                : [...s.current.nodes, node]
            }
          : s.current
      }))
      autosave.touch()
    },

    updateNodeData: (nodeId, params) => {
      if (!get().current) return
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              // 浅合并 params：只覆盖传入的键，其余参数保持原值。
              nodes: s.current.nodes.map((n) =>
                n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, ...params } } } : n
              )
            }
          : s.current
      }))
      autosave.touch()
    },

    /** 更新工作流里某个节点特定字段（node.data 顶层字段，用于改写子图文档整体）。 */
    updateNodeDataAt: (nodeId, patch) => {
      if (!get().current) return
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              nodes: s.current.nodes.map((n) =>
                n.id === nodeId
                  ? { ...n, data: { ...n.data, ...patch } as Record<string, unknown> & typeof n.data }
                  : n
              )
            }
          : s.current
      }))
      autosave.touch()
    },

    /** 在 subgraphNode 的子图文档里就地更新某个内部节点(含嵌套子图递归查找)。
     *  属于文本级参数编辑（如函数改名），不单独入撤销栈，避免逐字入栈。 */
    updateSubgraphNodeData: (functionId, innerId, patch) => {
      if (!get().current) return
      // 递归下钻：子图可以嵌套子图，因此要逐层找目标节点。
      const setIn = (doc: SubgraphDoc): boolean => {
        for (let i = 0; i < doc.nodes.length; i++) {
          const n = doc.nodes[i]
          if (n.id === innerId) {
            doc.nodes[i] = { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
            return true
          }
          const sub = n.data?.params?.subgraph as SubgraphDoc | undefined
          if (sub && setIn(sub)) return true
        }
        return false
      }
      set((s) => {
        if (!s.current) return s
        const nodes = s.current.nodes.map((f) => {
          if (f.id !== functionId) return f
          const doc = f.data?.params?.subgraph as SubgraphDoc | undefined
          if (!doc) return f
          // 先浅拷贝一层再改：避免就地修改 store 里现有的对象，
          // 否则 zustand 的引用比较会失效、UI 不重渲染。
          const clone: SubgraphDoc = { ...doc, nodes: doc.nodes.map((cn) => ({ ...cn })), edges: doc.edges.map((ce) => ({ ...ce })) }
          if (!setIn(clone)) return f
          return { ...f, data: { ...f.data, params: { ...f.data.params, subgraph: clone } } }
        })
        // 同步到共享同一函数体的其它实例。
        return { current: { ...s.current, nodes: syncFunctionInstances(nodes, functionId) } }
      })
      autosave.touch()
    },

    replaceSubgraphGraph: (path, nodes, edges, outputs, inputs) => {
      if (!get().current) return
      history.push()
      const rootId = path[0]
      // 按 path 逐层下钻，只在最末端那一层替换 nodes/edges。
      const changeAt = (doc: SubgraphDoc, idx: number): SubgraphDoc => {
        if (idx === path.length - 1) {
          const next = { ...doc, nodes, edges }
          // 挂点由子图编辑器规范化后传入；省略时保留原值。
          if (outputs) next.outputs = outputs
          if (inputs) next.inputs = inputs
          // 兼容旧字段 out：始终与 outputs[0] 保持一致。
          next.out = next.outputs[0] ?? next.out
          return next
        }
        const nextId = path[idx + 1]
        return {
          ...doc,
          nodes: doc.nodes.map((n) =>
            n.id === nextId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    params: { ...n.data.params, subgraph: changeAt(n.data.params?.subgraph as SubgraphDoc, idx + 1) }
                  }
                }
              : n
          )
        }
      }
      set((s) => {
        if (!s.current) return s
        const next = s.current.nodes.map((n) => {
          if (n.id !== rootId) return n
          const doc = n.data?.params?.subgraph as SubgraphDoc | undefined
          if (!doc) return n
          return { ...n, data: { ...n.data, params: { ...n.data.params, subgraph: changeAt(doc, 0) } } }
        })
        return { current: { ...s.current, nodes: syncFunctionInstances(next, rootId) } }
      })
      autosave.touch()
    },

    renameSubgraph: (nodeId, label) => {
      if (!get().current) return
      set((s) => {
        if (!s.current) return s
        const marked = s.current.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, params: { ...n.data.params, subgraphLabel: label } } }
            : n
        )
        return { current: { ...s.current, nodes: syncFunctionInstances(marked, nodeId) } }
      })
      autosave.touch()
    },

    renameSubgraphAt: (path, label) => {
      if (!get().current || path.length === 0) return
      // 只有一层：直接改名根节点；多层则落到子图文档里的内部节点。
      if (path.length === 1) {
        get().renameSubgraph(path[0], label)
        return
      }
      get().updateSubgraphNodeData(path[0], path[path.length - 1], { subgraphLabel: label })
    },

    instantiateFunction: (masterId, position) => {
      const cur = get().current
      if (!cur) return
      const master = cur.nodes.find((n) => n.id === masterId)
      if (!master || master.type !== 'subgraphNode') return
      const doc = getSubgraphDoc({ data: { params: (master.data?.params ?? {}) as Record<string, unknown> } })
      if (!doc) return
      const ref = subgraphRefOf(master)
      const id = newId()
      const node: WFNode = {
        id,
        type: 'subgraphNode',
        // 未指定位置时错开一点落点，避免与主本完全重叠。
        position: position ?? { x: master.position.x + 260, y: master.position.y + 60 },
        initialWidth: 200,
        initialHeight: 90,
        data: {
          label: master.data.label,
          color: nodeSpec('subgraphNode').color,
          params: {
            // 新实例共享同一函数体：后续任意一处编辑都会同步到彼此。
            subgraph: structuredClone(doc),
            subgraphLabel: String(master.data.params?.subgraphLabel ?? master.data.label ?? 'Function'),
            // 同一个 ref 是"共享函数体"的标识，必须在所有实例间保持一致。
            [SUBGRAPH_REF_PARAM]: ref
          }
        }
      }
      history.push()
      set((s) => ({ current: s.current ? { ...s.current, nodes: [...s.current.nodes, node] } : s.current }))
      autosave.touch()
    },

    duplicateNodes: (ids) => {
      const cur = get().current
      if (!cur) return
      const idSet = new Set(ids)
      // 旧 id → 新 id 的映射表，使副本之间的内部连线重新指向副本。
      const rename = new Map<string, string>()
      const cloneOf = (id: string): string => {
        let mid = rename.get(id)
        if (!mid) {
          mid = newId()
          rename.set(id, mid)
        }
        return mid
      }
      const clones = cur.nodes
        .filter((n) => idSet.has(n.id))
        .map((n) => {
          const parent = n.parentId ? cur.nodes.find((p) => p.id === n.parentId) : undefined
          // 父级（容器 / 注释框）也一起被复制 → 重定向到副本；否则让副本"脱离"父级，
          // 用绝对坐标落到画布上，避免副本寄生在原注释框里（或被折叠态连累而隐藏）。
          const keepParent = !!n.parentId && idSet.has(n.parentId)
          // 归属父副本的子节点沿用原相对坐标：父副本自身已经整体 +30 平移过，
          // 这里若再加偏移会把副本内的父子间距拉大（原来会叠加成 +60）。
          const position = keepParent
            ? n.position
            : {
                // 脱离父级时先把相对坐标换算成绝对坐标，再统一 +30 错开。
                x: (parent ? parent.position.x + n.position.x : n.position.x) + 30,
                y: (parent ? parent.position.y + n.position.y : n.position.y) + 30
              }
          const cloned: WFNode = {
            ...structuredClone(n),
            id: cloneOf(n.id),
            position,
            // 副本一律可见：避免继承原节点的隐藏状态（例如原父容器处于折叠态）。
            hidden: false
          }
          if (keepParent) return { ...cloned, parentId: cloneOf(n.parentId!) }
          // 脱离父级时必须一并去掉 parentId 与 extent，
          // 否则 React Flow 会把节点继续约束在原父级坐标系里。
          const { parentId: _p, extent: _e, ...rest } = cloned
          return rest as WFNode
        })
      if (clones.length === 0) return
      // 只复制"两端都在选中集合内"的连线，避免副本连到原图节点上。
      const clonedEdges = cur.edges
        .filter((e) => idSet.has(e.source) && idSet.has(e.target))
        .map((e) => ({
          ...structuredClone(e),
          id: `e-${newId()}`,
          source: cloneOf(e.source),
          target: cloneOf(e.target)
        }))
      history.push()
      set((s) => ({
        current: s.current
          ? {
              ...s.current,
              nodes: [...s.current.nodes, ...clones],
              edges: [...s.current.edges, ...clonedEdges]
            }
          : s.current
      }))
      autosave.touch()
    },

    pushHistory: () => history.push(),
    markDirty: () => autosave.touch(),

    replaceNodes: (nodes, opts) => {
      if (!get().current) return
      // history: false 用于删除流程内部——外层已经记过一次，不必重复入栈。
      if (opts?.history !== false) history.push()
      set((s) => ({ current: s.current ? { ...s.current, nodes } : s.current }))
      if (opts?.history !== false) autosave.touch()
    },

    replaceGraph: (nodes, edges, opts) => {
      if (!get().current) return
      if (opts?.history !== false) history.push()
      // 节点与连线在同一次 set 里替换：保证折叠/展开这类操作是一步撤销。
      set((s) => ({
        current: s.current ? { ...s.current, nodes, edges } : s.current
      }))
      if (opts?.history !== false) autosave.touch()
    }
  }
}
