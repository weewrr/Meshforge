/**
 * Blueprint 风格画布节点组件集合（原 `nodes.tsx` 按职责拆分）。
 *
 * 这个文件是统一出口：从各职责子模块重导出全部节点组件，并把它们的
 * 字符串 `type` 汇总成 React Flow 的 `nodeTypes` 映射。画布只认这个映射，
 * 新增一类节点时须同时补 `export` 与 `nodeTypes` 两处，否则画布渲染不出节点。
 */

import { ImageNode, TextNode, MeshNode, ArrayNode, GeneratorNode, PreviewNode, OutputNode } from './io'
import { RerouteNode, SelectNode, BranchNode, SequenceNode, VariableNode, WaitNode, WhileNode, ForEachNode, GateNode } from './flow'
import { CommentNode } from './comment'
import { ExtensionNode } from './extension'
import {
  IsValidNode,
  IsEmptyNode,
  BoolNode,
  MathNode,
  CompareNode,
  ConcatNode,
  CastNode,
  ClampNode,
  LerpNode,
  RandomNode
} from './compute'
import {
  VariableGetNode,
  VariableSetNode,
  EventCallNode,
  EventBindNode,
  MakeStructNode,
  BreakStructNode
} from './variables'
import { SubgraphNode, SubgraphInputNode, SubgraphOutputNode } from './subgraph'

// ─── 公共 API（子图编辑器等外部模块引用）─────────────────────────────────────
export { SubgraphPatchContext, SubgraphOpsContext, type SubgraphOps } from './primitives'

// ─── 全部节点组件（保持原 nodes.tsx 的导出面）───────────────────────────────
export { ImageNode, TextNode, MeshNode, ArrayNode, GeneratorNode, PreviewNode, OutputNode } from './io'
export { RerouteNode, SelectNode, BranchNode, SequenceNode, VariableNode, WaitNode, WhileNode, ForEachNode, GateNode } from './flow'
export { CommentNode } from './comment'
export { ExtensionNode } from './extension'
export {
  IsValidNode,
  IsEmptyNode,
  BoolNode,
  MathNode,
  CompareNode,
  ConcatNode,
  CastNode,
  ClampNode,
  LerpNode,
  RandomNode
} from './compute'
export {
  VariableGetNode,
  VariableSetNode,
  EventCallNode,
  EventBindNode,
  MakeStructNode,
  BreakStructNode
} from './variables'
export { SubgraphNode, SubgraphInputNode, SubgraphOutputNode } from './subgraph'

/** React Flow 节点类型注册表：蓝图 `type` 字符串 → 对应节点组件。画布据此渲染。 */
export const nodeTypes = {
  imageNode: ImageNode,
  textNode: TextNode,
  arrayNode: ArrayNode,
  meshNode: MeshNode,
  generatorNode: GeneratorNode,
  previewNode: PreviewNode,
  outputNode: OutputNode,
  waitNode: WaitNode,
  branchNode: BranchNode,
  sequenceNode: SequenceNode,
  whileNode: WhileNode,
  forEachNode: ForEachNode,
  extensionNode: ExtensionNode,
  rerouteNode: RerouteNode,
  commentNode: CommentNode,
  selectNode: SelectNode,
  variableNode: VariableNode,
  isValidNode: IsValidNode,
  isEmptyNode: IsEmptyNode,
  boolNode: BoolNode,
  mathNode: MathNode,
  compareNode: CompareNode,
  concatNode: ConcatNode,
  castNode: CastNode,
  clampNode: ClampNode,
  lerpNode: LerpNode,
  randomNode: RandomNode,
  gateNode: GateNode,
  variableGetNode: VariableGetNode,
  variableSetNode: VariableSetNode,
  eventCallNode: EventCallNode,
  eventBindNode: EventBindNode,
  makeStructNode: MakeStructNode,
  breakStructNode: BreakStructNode,
  subgraphNode: SubgraphNode,
  subgraphInputNode: SubgraphInputNode,
  subgraphOutputNode: SubgraphOutputNode
}
