// 引脚「+」快加节点：节点组件与主画布之间的桥梁。
//
// 节点（NodeShell）里的数据引脚旁边有一颗小「+」，点击后要打开主画布的
// 节点面板、并预置一条"连接意向"，让选中节点后自动落到端口旁并接上线。
// 节点组件与画布是不同的模块，中间通过一个模块级回调接驳：主画布在挂载
// 时用 setPinAddHandler 注册处理器，节点点击时调 requestPinAdd。

export type PinAddIntent = {
  nodeId: string
  handleType: 'source' | 'target'
  handleId: string | null
  clientX: number
  clientY: number
}

type Handler = (intent: PinAddIntent) => void

let handler: Handler | null = null

export function setPinAddHandler(fn: Handler | null): void {
  handler = fn
}

export function requestPinAdd(intent: PinAddIntent): void {
  handler?.(intent)
}