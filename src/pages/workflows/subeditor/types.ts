/**
 * 子图编辑器对外 props。
 *
 * `path` 记录从根画布到当前子图层的 subgraph 节点 id 序列，
 * 据此决定编辑器里展示哪一层子图，以及下钻 / 回退的层级。
 */

export interface Props {
  /** 从根画布到当前子图层级的 subgraph 节点 id 序列（长度为 0 表示停留在主画布）。 */
  path: string[]
  /** 关闭子图编辑器，回到主画布。 */
  onClose: () => void
  /** 再下钻一层：进入 `innerSubgraphId` 指向的子图。 */
  onDescend: (innerSubgraphId: string) => void
  /** 跳到路径的某一层（空数组 = 退回主画布）。跳转前会先落盘当前草稿。 */
  onJump?: (path: string[]) => void
}
