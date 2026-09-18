/**
 * 子图编辑器入口。用独立的 `ReactFlowProvider` 包一层，使子图拥有
 * 与主画布互相隔离的 React Flow 实例（各自的坐标系、选择与键盘处理）。
 */

import { ReactFlowProvider } from '@xyflow/react'
import { EditorInner } from './EditorInner'
import type { Props } from './types'

/** 重新导出子图编辑器所需的 props 类型，供外部以 `Props` 引用。 */
export type { Props }

/**
 * 子图编辑器根组件：为子图画布提供独立的 React Flow 上下文。
 *
 * @param props 来自主画布的下钻路径与各类回调（关闭 / 下钻 / 跳转）。
 */
export default function SubgraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  )
}
