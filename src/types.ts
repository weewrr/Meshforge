/**
 * 全局类型契约与节点规格表。
 *
 * 这是整个前端"蓝图"语义的单一事实来源：节点端口类型、主色、参数 schema、
 * 引脚（handle）命名规则、子图（函数）数据模型、变量/事件分发器/结构体的命名约定。
 * 画布、连线校验器与执行引擎都只从这里取规则，从而保证三处行为一致。
 *
 * 改动本文件极易波及面很广——新增节点类型时，务必同步 `NODE_SPECS`、
 * `postsMeta`（面板色例）以及执行引擎里的分派分支。
 */

import type { Node, Edge } from '@xyflow/react'

/** 引脚（端口）数据类型。`any` 可与任意类型互连，`none` 表示不承载数据（纯 exec 端口）。 */
export type PortType = 'image' | 'text' | 'mesh' | 'any' | 'none'

/** 节点携带的业务数据。`params` 存用户在该节点上填写的全部参数。 */
export interface WFNodeData extends Record<string, unknown> {
  label: string
  color: string
  params: Record<string, unknown>
}

/** 画布节点。`data` 的额外字段由 React Flow 自身维护（如 measured 尺寸）。 */
export type WFNode = Node<WFNodeData>
/** 画布连线。 */
export type WFEdge = Edge

/** 一份完整的工作流文档（列表接口只返回 `WorkflowMeta`）。 */
export interface Workflow {
  id: string
  name: string
  description: string
  /** 所属文件夹名。文件夹本身只存在于前端 localStorage，这里只是一个归属标记。 */
  folder?: string
  /** 是否被加入"收藏"，决定列表里是否置顶展示。 */
  bookmarked?: boolean
  nodes: WFNode[]
  edges: WFEdge[]
  createdAt: string
  updatedAt: string
}

/** 工作流列表项（元信息）。为节省带宽，不含 nodes/edges。 */
export interface WorkflowMeta {
  id: string
  name: string
  updatedAt: string
  folder?: string
  bookmarked?: boolean
}

/** 生成器（后端模型）的摘要信息，用于生成页的模型选择。 */
export interface GeneratorInfo {
  id: string
  display_name: string
  /** 权重是否已加载进显存（未加载时首次调用会有较长的冷启动）。 */
  is_loaded: boolean
  /** 'mesh' = 图→网格生成建模；'multiview' = 图→多视图图；'image' = 单图→单图图像处理 */
  category?: 'mesh' | 'multiview' | 'image'
  output?: PortType
}

// ─── 扩展（与 Modly 对齐）─────────────────────────────────────────────────────
// Schema 驱动的扩展节点：要么是模型生成器（图→网格），要么是网格处理工具（网格→网格）。
// 节点 UI 与执行引擎都从这份 schema 读 `params`，因此新增模型无需改前端组件。

/** 参数控件类型；决定节点参数区渲染成下拉、文本框还是数字输入。 */
export type ParamType = 'select' | 'string' | 'int' | 'float'

/** 单个参数的定义。 */
export interface ParamSchema {
  id: string
  label: string
  type: ParamType
  default: string | number
  /** `type === 'select'` 时的可选项。 */
  options?: { value: string | number; label?: string }[]
  /** 数值型参数的取值下限（仅作前端校验与滑块范围）。 */
  min?: number
  /** 数值型参数的取值上限。 */
  max?: number
  /** 悬停提示。 */
  tooltip?: string
  /** 仅当另一个参数取值命中这里列举的值时，本参数才在表单中显示。 */
  show_if?: Record<string, string | number | Array<string | number>>
}

/** 一个扩展（模型或网格处理工具）的完整定义。 */
export interface WorkflowExtension {
  id: string
  display_name: string
  /** 'model' = 图→网格生成器；'process' = 网格→网格处理工具。 */
  kind: 'model' | 'process'
  input: PortType
  output: PortType
  /** 更细的分类，决定节点配色与面板分组（见 `EXTENSION_CATEGORY_COLOR`）。 */
  category?: 'mesh' | 'multiview' | 'image' | 'process'
  params: ParamSchema[]
  /** 从该 HuggingFace 仓库下载模型权重（仅清单式扩展需要）。 */
  hfRepo?: string
  /** 下载权重时需要排除的路径前缀（例如示例图、文档）。 */
  hfSkipPrefixes?: string[]
  /** 只下载这些前缀下的文件；与 skip 配合可大幅缩小下载体积。 */
  hfIncludePrefixes?: string[]
}

// ─── 节点规格 ────────────────────────────────────────────────────────────────
// 节点端口类型、标签与配色的单一事实来源。画布、连线校验器与运行器都读这张表。

/**
 * 内置节点规格表：类型 → 标签 / 主色 / 输入端口列表 / 输出端口。
 *
 * 数组形式的 `inputs` 表达"多输入引脚"：下标 0 对应 handle `in`，1 对应 `in1`，依此类推。
 * 空数组表示该节点没有数据输入（常量源或纯 exec 节点）。
 */
export const NODE_SPECS: Record<
  string,
  { label: string; color: string; inputs: PortType[]; output: PortType }
> = {
  imageNode: { label: 'Image', color: '#38bdf8', inputs: [], output: 'image' },
  textNode: { label: 'Text', color: '#fbbf24', inputs: [], output: 'text' },
  meshNode: { label: 'Load 3D Mesh', color: '#a78bfa', inputs: [], output: 'mesh' },
  // 通用数组节点：内嵌可变数量图片槽（四视角生成器用它输入 front/left/back/right）。
  arrayNode: { label: 'Array', color: '#f472b6', inputs: [], output: 'any' },
  generatorNode: { label: 'Generate Mesh', color: '#34d399', inputs: ['image'], output: 'mesh' },
  previewNode: { label: 'Preview', color: '#38bdf8', inputs: ['mesh'], output: 'mesh' },
  outputNode: { label: 'Add to Scene', color: '#a78bfa', inputs: ['mesh'], output: 'none' },
  waitNode: { label: 'Wait', color: '#71717a', inputs: ['any'], output: 'any' },
  whileNode: { label: 'While', color: '#facc15', inputs: ['any'], output: 'any' },
  forEachNode: { label: 'For Each', color: '#38bdf8', inputs: ['any'], output: 'any' },
  // 蓝图控制流：Branch 按条件走两路 exec 输出；Sequence 依序触发多路 exec 输出。
  branchNode: { label: 'Branch', color: '#facc15', inputs: ['any'], output: 'none' },
  sequenceNode: { label: 'Sequence', color: '#38bdf8', inputs: ['any'], output: 'none' },
  // 蓝图风格的布局类节点。
  rerouteNode: { label: 'Reroute', color: '#94a3b8', inputs: ['any'], output: 'any' },
  commentNode: { label: 'Comment', color: '#38bdf8', inputs: [], output: 'none' },
  selectNode: { label: 'Select', color: '#38bdf8', inputs: ['any', 'any', 'any', 'any'], output: 'any' },
  // 蓝图「编程」节点：变量/判空/布尔/数值/比较/文本拼接/数据门。
  variableNode: { label: 'Variable', color: '#fbbf24', inputs: [], output: 'text' },
  isValidNode: { label: 'Is Valid', color: '#f472b6', inputs: ['any'], output: 'text' },
  isEmptyNode: { label: 'Is Empty', color: '#f472b6', inputs: ['text'], output: 'text' },
  boolNode: { label: 'Bool', color: '#fb7185', inputs: ['text', 'text', 'text', 'text'], output: 'text' },
  mathNode: { label: 'Math', color: '#60a5fa', inputs: ['text', 'text', 'text', 'text'], output: 'text' },
  compareNode: { label: 'Compare', color: '#fb7185', inputs: ['text', 'text'], output: 'text' },
  concatNode: { label: 'Concat Text', color: '#fb7185', inputs: ['text', 'text', 'text', 'text'], output: 'text' },
  gateNode: { label: 'Gate', color: '#34d399', inputs: ['any'], output: 'any' },
  // UE 标准数值节点：类型转换(Cast) / 区间钳制 / 线性插值 / 随机数。
  castNode: { label: 'Cast', color: '#c084fc', inputs: ['text'], output: 'text' },
  clampNode: { label: 'Clamp', color: '#60a5fa', inputs: ['text', 'text', 'text'], output: 'text' },
  lerpNode: { label: 'Lerp', color: '#60a5fa', inputs: ['text', 'text', 'text'], output: 'text' },
  randomNode: { label: 'Random', color: '#a3e635', inputs: ['text', 'text'], output: 'text' },
  // 变量读写（UE Blueprint 变量 Get / Set）：同一 varName 跨节点共享一份运行期值。
  variableGetNode: { label: 'Get Variable', color: '#fbbf24', inputs: [], output: 'text' },
  variableSetNode: { label: 'Set Variable', color: '#f59e0b', inputs: ['text'], output: 'text' },
  // 事件分发器（Event Dispatcher）：Call 触发时执行所有已 Bind 到同名分发器的链路。
  eventCallNode: { label: 'Call Dispatcher', color: '#f97316', inputs: [], output: 'none' },
  eventBindNode: { label: 'Bind Dispatcher', color: '#fb923c', inputs: [], output: 'none' },
  // 结构体组装 / 拆解（Make / Break Struct）。
  makeStructNode: { label: 'Make Struct', color: '#22d3ee', inputs: ['text', 'text', 'text', 'text'], output: 'text' },
  breakStructNode: { label: 'Break Struct', color: '#22d3ee', inputs: ['text'], output: 'text' },
  // 函数/子图折叠：把一组选中节点折叠为单节点，内部保存子图文档。
  subgraphNode: { label: 'Function', color: '#22d3ee', inputs: ['any', 'any', 'any', 'any'], output: 'any' },
  extensionNode: { label: 'Extension', color: '#34d399', inputs: ['any'], output: 'any' }
}

/** 取节点规格；未登记的类型退化为"灰色、无输入、无输出"的占位规格。 */
export function nodeSpec(type: string) {
  return NODE_SPECS[type] ?? { label: type, color: '#71717a', inputs: [] as PortType[], output: 'none' as PortType }
}

// Extension 节点分「生成建模(mesh)」「生视图(multiview，图→图)」「图像处理(image，图→图)」三类。
// 生视图模型用青绿、图像处理用品红，以便在面板/工作流节点上与网格模型区分。
export const EXTENSION_CATEGORY_COLOR: Record<string, string> = {
  mesh: '#34d399',
  multiview: '#2dd4bf',
  image: '#e879f9',
  process: '#34d399'
}

/** Extension 扩展的点击/节点主色：生视图模型用青绿、图像处理用品红，其余沿用生成绿。 */
export function extensionColor(ext?: WorkflowExtension | null): string {
  return EXTENSION_CATEGORY_COLOR[ext?.category ?? 'mesh'] ?? '#34d399'
}

/** 是否为"分支起点"——循环体遍历时遇到它就停止下钻。
 *  注意命名：语法上只有 `waitNode` 承担这个角色（Wait 会暂停运行并等待用户继续）。 */
export function isBranchStarter(type?: string): boolean {
  return type === 'waitNode'
}

/** 是否为循环起点（While / For Each）。 */
export function isLoopStarter(type?: string): boolean {
  return type === 'whileNode' || type === 'forEachNode'
}

/** 是否为"容器型"节点——它的画布矩形范围定义了循环体（与 Modly 对齐）。 */
export function isContainerType(type?: string): boolean {
  return type === 'whileNode'
}

// ─── 扩展查找（模块级缓存，由 api.listExtensions 填充）────────────────────────
// 扩展清单在后端启动后基本不变，因此缓存在模块作用域，
// 让节点渲染这类高频路径不必反复查询。
let extensionCache: WorkflowExtension[] = []

/** 写入扩展清单缓存（由扩展加载流程调用）。 */
export function setExtensionsCache(extensions: WorkflowExtension[]): void {
  extensionCache = extensions
}

/** 按 id 取扩展定义；id 非法或未命中时返回 undefined。 */
export function getExtensionById(id: unknown): WorkflowExtension | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return extensionCache.find((e) => e.id === id)
}

/** 取全部已缓存的扩展。 */
export function allExtensions(): WorkflowExtension[] {
  return extensionCache
}

/** 取节点的端口（动态扩展节点的端口类型来自 schema，其余查 `NODE_SPECS`）。 */
export function nodePorts(type: string | undefined, extensionId?: unknown): { inputs: PortType[]; output: PortType } {
  if (type === 'extensionNode') {
    const ext = getExtensionById(extensionId)
    if (ext) return { inputs: ext.input === 'none' ? [] : [ext.input], output: ext.output }
    // 扩展尚未加载（或 id 失效）时放宽为 any，避免节点渲染成"无可连端口"。
    return { inputs: ['any'], output: 'any' }
  }
  const spec = nodeSpec(type ?? '')
  return { inputs: spec.inputs, output: spec.output }
}

/** 判断两个端口类型能否连接：类型相同，或任一端为 `any`。`none` 一律不可连。 */
export function portCompatible(source: PortType, target: PortType): boolean {
  if (source === 'none' || target === 'none') return false
  return source === target || source === 'any' || target === 'any'
}

// 标准 handle id —— 每个节点最多一个目标 handle（"in"）与一个源 handle（"out"），
// 端口类型由 NODE_SPECS 决定。
/** 默认数据输入 handle。 */
export const IN_HANDLE = 'in'
/** 默认数据输出 handle。 */
export const OUT_HANDLE = 'out'

// ─── 端口类型色板（Unreal Blueprint 风格：引脚按数据类型统一着色）────────────
// 单一数据源，节点引脚、连线、口袋图标都从这里取色，保证全画布一致。
export const PORT_COLOR: Record<string, string> = {
  image: '#38bdf8', // 图 → 天蓝
  text: '#fb7185', // 文本 → 玫红
  mesh: '#a78bfa', // 网格 → 紫罗兰
  any: '#94a3b8', // 任意 → 灰蓝
  none: '#64748b'
}

/** 取端口颜色；未知类型按 `any` 的灰蓝处理。 */
export function portColor(type?: PortType | string): string {
  return PORT_COLOR[type ?? 'any'] ?? '#94a3b8'
}

/** 由 React Flow 的 targetHandle('in' / 'in0' / 'in1' …) 解析出下标（默认 0）。 */
export function inputIndexForHandle(handle?: string | null): number {
  if (typeof handle === 'string' && /^in\d+$/.test(handle)) return parseInt(handle.slice(2), 10)
  return 0
}

// ─── 参数引脚（Blueprint 风格：模型参数可作为引脚输入）────────────────────────
// 参数引脚 handle 形如 'p:<paramId>'，与普通数据引脚（'in'）区分。参数引脚只作
// 目标端使用，类型统一为 text（由内联控件兜底，执行时对数值型再作协调）。
/** 参数引脚 handle 前缀。 */
export const PARAM_HANDLE_PREFIX = 'p:'

/** 由参数 id 生成参数引脚的 handle。 */
export function paramHandleFor(paramId: string): string {
  return PARAM_HANDLE_PREFIX + paramId
}

/** 判断 handle 是否为参数引脚。 */
export function isParamHandle(handle?: string | null): boolean {
  return typeof handle === 'string' && handle.startsWith(PARAM_HANDLE_PREFIX)
}

/** 从参数引脚 handle 反解参数 id；非参数引脚返回 null。 */
export function paramIdFromHandle(handle?: string | null): string | null {
  if (typeof handle === 'string' && isParamHandle(handle)) return handle.slice(PARAM_HANDLE_PREFIX.length)
  return null
}

/** 参数引脚统一使用的端口类型（数值型也在执行时从文本协调为数字）。 */
export function paramPortType(): PortType {
  return 'text'
}

// ─── 执行引脚（Unreal Blueprint exec 引脚）────────────────────────────────────
// 控制/流程节点（循环/遍历/等待等）带白色 exec 输入/输出引脚，表达"执行顺序"，
// 与数据引脚（image/text/mesh…）分离：数据边传值，exec 边传执行信号。UE 中
// exec 边以白色粗线绘制，是蓝图"一眼可辨"的核心特征。
/** 默认 exec 输入 handle。 */
export const EXEC_IN_HANDLE = 'exec-in'
/** 默认 exec 输出 handle。 */
export const EXEC_OUT_HANDLE = 'exec-out'
/** Branch 的两路执行输出：true / false。 */
export const EXEC_TRUE_HANDLE = 'exec-true'
/** Branch 的 false 分支执行输出。 */
export const EXEC_FALSE_HANDLE = 'exec-false'

/** 判断 handle 是否属于 exec 引脚族（统一以 `exec-` 前缀命名）。 */
export function isExecHandle(handle?: string | null): boolean {
  return typeof handle === 'string' && handle.startsWith('exec-')
}

/** 是否为 exec 输入引脚。 */
export function isExecIn(handle?: string | null): boolean {
  return handle === EXEC_IN_HANDLE
}

/** 判定是否为"执行输出"句柄：Branch 的 exec-true/false、Sequence 的 exec-0… 等。 */
export function isExecOut(handle?: string | null): boolean {
  return typeof handle === 'string' && handle.startsWith('exec-') && handle !== EXEC_IN_HANDLE
}

/** 一条边是否为 exec（执行流）边——任一端连接了 exec 引脚。 */
export function isExecEdge(sourceHandle?: string | null, targetHandle?: string | null): boolean {
  return isExecHandle(sourceHandle) || isExecHandle(targetHandle)
}

/** 这些是真正的"流程/执行"节点：拥有白色 exec 引脚，用于表达执行顺序。 */
export function isExecNode(type?: string): boolean {
  return (
    type === 'whileNode' ||
    type === 'forEachNode' ||
    type === 'waitNode' ||
    type === 'branchNode' ||
    type === 'sequenceNode' ||
    // 变量写入 / 事件分发：与 UE 一致，携带 exec 进/出引脚参与执行流。
    type === 'variableSetNode' ||
    type === 'eventCallNode' ||
    type === 'eventBindNode'
  )
}

// ─── 函数/子图折叠（Collapse to Function）数据模型 ───────────────────────────
// subgraphNode 把一组选中节点折叠为单节点。运行时把它当作"内联展开"执行：
// 外部输入值经脚本读取到 subgraph 文档的输入挂点上，内部数据 DAG 跑完后把
// 主输出（out.refId）写回本节点，供外部下游消费。

/** subgraph 内部专用的"输入挂点"占位节点类型（折叠时插入，不参与画布渲染/执行）。 */
export const SUBGRAPH_INPUT_NODE = 'subgraphInputNode'
/** subgraph 内部专用的"输出挂点"占位节点类型（Exit 节点，编辑器内可见可连线）。 */
export const SUBGRAPH_OUTPUT_NODE = 'subgraphOutputNode'

/** 子图的一个输入挂点：描述"这个输入从外面接到内部哪个节点的哪个引脚"。 */
export interface SubgraphInput {
  /** 内部输入挂点节点 id（subgraphInputNode），执行时把外部输入写到这里。 */
  refId: string
  /** 该值原本要喂给哪个内部节点。 */
  targetId: string
  targetHandle: string | null
  type: PortType
  /** 输入引脚显示名（可在子图编辑器里重命名；缺省用 in0 / in1…）。 */
  label?: string
  /** 折叠前外部数据源节点（展开时用于还原连线）。 */
  srcId: string
  srcHandle?: string | null
}

/** 子图的一个输出挂点：描述"内部哪个节点的值要暴露成外面的输出"。 */
export interface SubgraphOutput {
  /** 子图内"输出挂点"（Exit）节点 id；子图内部一条边以它为 target 输送该输出。 */
  refId: string
  type: PortType
  /** 输出引脚显示名（可在子图编辑器里重命名；缺省用 out0 / out1…）。 */
  label?: string
  /** 折叠前外部目标节点（展开时用于还原连线）。 */
  toId: string
  toHandle: string | null
  /** 在折叠节点上对应的输出引脚下标（0 → 'out'，1+ → 'out1'…）。 */
  index: number
}

/** 一份子图（函数）文档，存在 `subgraphNode.data.params.subgraph` 里。 */
export interface SubgraphDoc {
  nodes: WFNode[]
  edges: WFEdge[]
  inputs: SubgraphInput[]
  /** 多输出挂点（v1 折叠时生成的单输出仍可用 out 读取）。 */
  outputs: SubgraphOutput[]
  /** 向后兼容：第一个输出（outputs[0]）。 */
  out: SubgraphOutput | null
}

/** 从节点上取出子图文档；结构非法时返回 null，并对旧版文档做 `out` → `outputs` 回填。 */
export function getSubgraphDoc(node: { data?: { params?: Record<string, unknown> } }): SubgraphDoc | null {
  const doc = node?.data?.params?.subgraph as SubgraphDoc | undefined
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.nodes)) return null
  // 兼容旧文档：无 outputs 时由 out 回填。
  if (!Array.isArray(doc.outputs)) {
    doc.outputs = doc.out ? [doc.out] : []
  }
  return doc
}

// ─── 函数复用（同一函数被多处引用）─────────────────────────────────────────────
// 多个 subgraphNode 可以共享同一个函数体：它们的 params.subgraphRef 指向同一个
// 主节点 id，编辑任意一个实例都会把新文档同步到共享该 ref 的其它实例上。
/** 存放"共享函数体引用键"的参数名。 */
export const SUBGRAPH_REF_PARAM = 'subgraphRef'

/** 取某个函数节点的共享引用键（缺省时该节点自身即主实例）。 */
export function subgraphRefOf(node: { id: string; data?: { params?: Record<string, unknown> } }): string {
  const ref = node?.data?.params?.[SUBGRAPH_REF_PARAM]
  return typeof ref === 'string' && ref ? ref : node.id
}

/** subgraphNode 上第 index 个输入引脚的 handle id（0 → 'in'，1+ → 'in1'…）。 */
export function subgraphInHandle(index: number): string {
  return index === 0 ? IN_HANDLE : `in${index}`
}

/** subgraphNode 上第 index 个输出引脚的 handle id（0 → 'out'，1+ → 'out1'…）。 */
export function subgraphOutHandle(index: number): string {
  return index === 0 ? OUT_HANDLE : `out${index}`
}

/** ForEach / While 暴露的"当前迭代下标"数据输出 handle。 */
export const ITER_INDEX_HANDLE = 'idx'

/** 输入挂点 / 输出挂点在子图内部的默认显示名。 */
export function subgraphPinLabel(kind: 'in' | 'out', index: number): string {
  return `${kind === 'in' ? 'in' : 'out'}${index}`
}

// ─── 变量 / 事件分发器 / 结构体（UE 标准语义补充）─────────────────────────────
// 三者都靠"名字"配对同名节点：变量用 varName 跨节点读写，事件分发器用
// dispatcher 把 Call 与 Bind 配对，结构体用 fields 描述字段顺序。

/** 变量名参数键（variableGetNode / variableSetNode 共用）。 */
export const VAR_NAME_PARAM = 'varName'
/** 事件分发器名参数键（eventCallNode / eventBindNode 共用）。 */
export const DISPATCHER_PARAM = 'dispatcher'
/** 结构体字段名参数键（逗号分隔，makeStructNode / breakStructNode 共用）。 */
export const STRUCT_FIELDS_PARAM = 'fields'

/** 节点参数里某个字符串键的值（trim 后）。 */
function paramText(node: { data?: { params?: Record<string, unknown> } }, key: string): string {
  return String(node?.data?.params?.[key] ?? '').trim()
}

/** 从工作流节点里汇总已声明的变量名（由 Set 节点定义，保持出现顺序）。 */
export function declaredVariables(
  nodes: Array<{ type?: string; data?: { params?: Record<string, unknown> } }>
): string[] {
  const out: string[] = []
  for (const n of nodes) {
    // 只由 Set 节点"声明"变量，Get 节点视为引用。
    if (n.type !== 'variableSetNode') continue
    const v = paramText(n, VAR_NAME_PARAM)
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 从工作流节点里汇总事件分发器名（Call / Bind 节点的并集）。 */
export function declaredDispatchers(
  nodes: Array<{ type?: string; data?: { params?: Record<string, unknown> } }>
): string[] {
  const out: string[] = []
  for (const n of nodes) {
    // Call 与 Bind 都能"引入"一个分发器名，因此两者都收集。
    if (n.type !== 'eventCallNode' && n.type !== 'eventBindNode') continue
    const v = paramText(n, DISPATCHER_PARAM)
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 结构体字段名列表（逗号分隔 → 数组；为空时给出 4 个占位字段）。 */
export function structFields(raw: unknown): string[] {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // 无有效字段时给 4 个占位，保证 Make/Break 节点总有可连的引脚。
  return list.length > 0 ? list : ['a', 'b', 'c', 'd']
}

/** Break 结构体第 index 个字段的输出 handle（总是 `out${i}`，0 起）。 */
export function structOutHandle(index: number): string {
  return `out${index}`
}

/** Make 结构体把所有输入按字段顺序编成一段可解析文本（`字段=值` 用 `;` 连接）。 */
export function packStruct(fields: string[], values: Array<string | undefined>): string {
  return fields.map((f, i) => `${f}=${values[i] ?? ''}`).join(';')
}

/** Break 结构体：从 Make 产出的文本里取第 index 个字段的值。 */
export function unpackStruct(raw: string, fields: string[], index: number): string {
  const key = fields[index]
  if (key === undefined) return ''
  for (const seg of String(raw ?? '').split(';')) {
    const eq = seg.indexOf('=')
    // 跳过没有 `=` 的片段（例如用户手填的裸值）。
    if (eq < 0) continue
    if (seg.slice(0, eq).trim() === key) return seg.slice(eq + 1)
  }
  // 兼容裸值序列（没有 `k=v` 形态时按位置取值）。
  return String(raw ?? '').split(';')[index] ?? ''
}

/** 目标节点上某个 handle 期望的数据类型（多输入节点按 handle 下标取对应输入类型）。 */
export function targetInputType(node: { type?: string; data?: { extensionId?: unknown } }, handle?: string | null): PortType {
  // 参数引脚统一为 text（连线着色与校验一致）。
  if (isParamHandle(handle)) return paramPortType()
  const inps = nodePorts(node?.type, node?.data?.extensionId).inputs
  if (inps.length === 0) return 'none'
  // 下标越界时收敛到最后一个端口，避免接入多余连线时报错。
  const idx = Math.min(inputIndexForHandle(handle), inps.length - 1)
  return inps[idx] ?? 'any'
}

/** 节点是否支持/可参与（数据透传类控制节点在 mini 画布与执行里做特殊处理）。 */
export function isPassthroughType(type?: string): boolean {
  return type === 'rerouteNode' || type === 'selectNode'
}
