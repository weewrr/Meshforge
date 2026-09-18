/**
 * 扩展面板的条目数据：内置节点与逻辑节点两组清单。
 *
 * 每个条目带 `dragPayload`（拖拽时写入 dataTransfer）、i18n 键、配色与字形，
 * 供 `tiles.tsx` 渲染成可拖入画布的磁贴。
 */

import type { PanelItem } from './types'

/** 内置 / 媒体类节点（图片、文本、网格、生成器等）的面板条目。 */
export const BUILTIN_ITEMS: PanelItem[] = [
  { dragPayload: 'builtin:imageNode', labelKey: 'workflows.palette.imageLabel', color: '#38bdf8', glyph: 'image' },
  { dragPayload: 'builtin:textNode', labelKey: 'workflows.palette.textLabel', color: '#fb7185', glyph: 'text' },
  { dragPayload: 'builtin:arrayNode', labelKey: 'workflows.palette.arrayLabel', color: '#f472b6', glyph: 'array' },
  { dragPayload: 'builtin:meshNode', labelKey: 'workflows.palette.meshLabel', color: '#a78bfa', glyph: 'mesh' },
  { dragPayload: 'builtin:generatorNode', labelKey: 'workflows.palette.generateLabel', color: '#34d399', glyph: 'generate' },
  { dragPayload: 'builtin:outputNode', labelKey: 'workflows.palette.outputLabel', color: '#a78bfa', glyph: 'output' },
  { dragPayload: 'builtin:previewNode', labelKey: 'workflows.palette.previewLabel', color: '#38bdf8', glyph: 'preview' },
  { dragPayload: 'builtin:commentNode', labelKey: 'workflows.palette.commentLabel', color: '#38bdf8', glyph: 'comment' }
]

/** 编程/逻辑节点：变量、判空、布尔、数值、比较、文本拼接、数据门、控制流。 */
export const LOGIC_ITEMS: PanelItem[] = [
  { dragPayload: 'builtin:variableNode', labelKey: 'workflows.palette.variableLabel', color: '#fbbf24', glyph: 'variable' },
  { dragPayload: 'builtin:isValidNode', labelKey: 'workflows.palette.isValidLabel', color: '#f472b6', glyph: 'check' },
  { dragPayload: 'builtin:isEmptyNode', labelKey: 'workflows.palette.isEmptyLabel', color: '#f472b6', glyph: 'emptylogic' },
  { dragPayload: 'builtin:boolNode', labelKey: 'workflows.palette.boolLabel', color: '#fb7185', glyph: 'bool' },
  { dragPayload: 'builtin:mathNode', labelKey: 'workflows.palette.mathLabel', color: '#60a5fa', glyph: 'math' },
  { dragPayload: 'builtin:compareNode', labelKey: 'workflows.palette.compareLabel', color: '#fb7185', glyph: 'compare' },
  { dragPayload: 'builtin:concatNode', labelKey: 'workflows.palette.concatLabel', color: '#fb7185', glyph: 'concat' },
  { dragPayload: 'builtin:castNode', labelKey: 'workflows.palette.castLabel', color: '#c084fc', glyph: 'cast' },
  { dragPayload: 'builtin:clampNode', labelKey: 'workflows.palette.clampLabel', color: '#60a5fa', glyph: 'clamp' },
  { dragPayload: 'builtin:lerpNode', labelKey: 'workflows.palette.lerpLabel', color: '#60a5fa', glyph: 'lerp' },
  { dragPayload: 'builtin:randomNode', labelKey: 'workflows.palette.randomLabel', color: '#a3e635', glyph: 'random' },
  { dragPayload: 'builtin:gateNode', labelKey: 'workflows.palette.gateLabel', color: '#34d399', glyph: 'gate' },
  { dragPayload: 'builtin:variableGetNode', labelKey: 'workflows.palette.varGetLabel', color: '#fbbf24', glyph: 'getvar' },
  { dragPayload: 'builtin:variableSetNode', labelKey: 'workflows.palette.varSetLabel', color: '#f59e0b', glyph: 'setvar' },
  { dragPayload: 'builtin:eventBindNode', labelKey: 'workflows.palette.eventBindLabel', color: '#fb923c', glyph: 'bindEvent' },
  { dragPayload: 'builtin:eventCallNode', labelKey: 'workflows.palette.eventCallLabel', color: '#f97316', glyph: 'callEvent' },
  { dragPayload: 'builtin:makeStructNode', labelKey: 'workflows.palette.makeStructLabel', color: '#22d3ee', glyph: 'makeStruct' },
  { dragPayload: 'builtin:breakStructNode', labelKey: 'workflows.palette.breakStructLabel', color: '#22d3ee', glyph: 'breakStruct' },
  { dragPayload: 'builtin:waitNode', labelKey: 'workflows.palette.waitLabel', color: '#71717a', glyph: 'wait' },
  { dragPayload: 'builtin:branchNode', labelKey: 'workflows.palette.branchLabel', color: '#facc15', glyph: 'branch' },
  { dragPayload: 'builtin:sequenceNode', labelKey: 'workflows.palette.sequenceLabel', color: '#38bdf8', glyph: 'sequence' },
  { dragPayload: 'builtin:whileNode', labelKey: 'workflows.palette.whileLabel', color: '#facc15', glyph: 'loop' },
  { dragPayload: 'builtin:forEachNode', labelKey: 'workflows.palette.forEachLabel', color: '#38bdf8', glyph: 'forEach' },
  { dragPayload: 'builtin:rerouteNode', labelKey: 'workflows.palette.rerouteLabel', color: '#94a3b8', glyph: 'reroute' },
  { dragPayload: 'builtin:selectNode', labelKey: 'workflows.palette.selectLabel', color: '#38bdf8', glyph: 'select' }
]

/** 单色 SVG 磁贴图标（currentColor → 可随主题换色，统一描边）。 */
