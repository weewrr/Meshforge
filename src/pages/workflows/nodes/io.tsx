/**
 * 蓝图的基础 I/O 节点：图片、文本、3D 网格、图片数组、生成器、预览与最终输出。
 *
 * 这些是工作流的数据入口与出口——`image`/`text`/`mesh` 提供素材，
 * `array` 批量收集多张图，`generator` 指向具体生成器，`output` 标志产物出口。
 * 文件类节点复用 `primitives` 里的原生选择按钮（绕过 Chromium 文件框崩溃）。
 */

import { useState } from 'react'
import { type NodeProps, type Node } from '@xyflow/react'
import type { WFNodeData } from '../../../types'
import { useLogsStore } from '../../../stores/logs'
import { fullUrl, importImageByPath } from '../../../api'
import { useT } from '../../../i18n'
import { ImageFileButton, MeshFileButton, NodeShell, useParam } from './primitives'

// ─── Node components ──────────────────────────────────────────────────────────

/** 图片输入节点：通过原生文件选择导入一张图片，作为 `image` 类型数据输出。 */
export function ImageNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="imageNode" label={data.label}>
      <ImageFileButton
        nodeId={id}
        label={t('workflows.nodes.selectImage')}
        current={String(data.params.fileName ?? '')}
        url={String(data.params.url ?? '')}
      />
    </NodeShell>
  )
}

/** 文本输入节点：内联输入一段文本，作为 `text` 类型数据输出（可接任意文本/参数引脚）。 */
export function TextNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="textNode" label={data.label}>
      <input
        className="wf-input"
        type="text"
        defaultValue={String(data.params.text ?? '')}
        onChange={(e) => setParam('text', e.target.value)}
      />
    </NodeShell>
  )
}

/** 3D 网格输入节点：通过原生文件选择导入一个网格文件，作为 `mesh` 类型数据输出。 */
export function MeshNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="meshNode" label={data.label}>
      <MeshFileButton nodeId={id} label={t('workflows.nodes.selectMeshFile')} current={String(data.params.fileName ?? '')} />
    </NodeShell>
  )
}

/** 图片数组节点：批量管理多张图片（逐张导入/替换/删除），输出图片集合供遍历使用。 */
export function ArrayNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  const setParam = useParam(id)
  const items = (Array.isArray(data.params.items) ? data.params.items : []) as Array<{
    id: string
    url: string
    fileName: string
  }>
  const [busyKey, setBusyKey] = useState<string | null>(null)

  async function importInto(key: string): Promise<void> {
    if (!window.meshforge?.selectImageFile) {
      useLogsStore.getState().warn('[arrayNode] native file dialog unavailable (browser-only run)')
      return
    }
    const filePath = await window.meshforge.selectImageFile()
    if (!filePath) return
    setBusyKey(key)
    try {
      const { url, fileName } = await importImageByPath(filePath)
      // `__new__` 是"新增一张"的哨兵 key：走这里追加一项，否则按 key 原地替换既有项。
      if (key === '__new__') {
        setParam('items', [...items, { id: crypto.randomUUID(), url, fileName }])
      } else {
        setParam('items', items.map((it) => (it.id === key ? { ...it, url, fileName } : it)))
      }
      useLogsStore.getState().log('info', `[arrayNode] imported ${fileName}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useLogsStore.getState().error(`[arrayNode] import failed: ${msg}`)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <NodeShell id={id} type="arrayNode" label={data.label}>
      {items.length > 0 && (
        <div className="wf-array">
          {items.map((it, i) => (
            <div key={it.id} className="wf-array__item">
              <button
                className={`wf-array__thumb ${it.url ? '' : 'wf-array__thumb--placeholder'}`}
                onClick={() => void importInto(it.id)}
                disabled={busyKey === it.id}
                title={it.fileName}
              >
                {it.url ? <img src={fullUrl(it.url)} alt="" /> : <span>＋</span>}
              </button>
              <div className="wf-array__meta">
                <span className="wf-array__idx">{i}</span>
                <span className="wf-array__name">{busyKey === it.id ? t('workflows.nodes.importing') : it.fileName || '—'}</span>
              </div>
              <button
                className="wf-array__remove nodrag"
                onClick={() => setParam('items', items.filter((x) => x.id !== it.id))}
                title={t('workflows.nodes.remove')}
                aria-label={t('workflows.nodes.remove')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="wf-upload__btn" disabled={busyKey === '__new__'} onClick={() => void importInto('__new__')}>
        {busyKey === '__new__' ? t('workflows.nodes.importing') : t('workflows.nodes.addImage')}
      </button>
    </NodeShell>
  )
}

/** 生成器节点：填写一个 `generatorId`，指向实际执行图像/模型生成的扩展或生成器。 */
export function GeneratorNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const setParam = useParam(id)
  return (
    <NodeShell id={id} type="generatorNode" label={data.label}>
      <input
        className="wf-input"
        type="text"
        defaultValue={String(data.params.generatorId ?? '')}
        onChange={(e) => setParam('generatorId', e.target.value)}
      />
    </NodeShell>
  )
}

/** 预览节点：标记工作流中"在此展示结果"的位置，供运行时把产物渲染到预览面板。 */
export function PreviewNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="previewNode" label={data.label}>
      <span className="wf-hint">{t('workflows.nodes.previewHint')}</span>
    </NodeShell>
  )
}

/** 输出节点：工作流的最终产物出口，连接它即把对应数据作为本次运行的产出。 */
export function OutputNode({ id, data }: NodeProps<Node<WFNodeData>>) {
  const t = useT()
  return (
    <NodeShell id={id} type="outputNode" label={data.label}>
      <span className="wf-hint">{t('workflows.nodes.outputHint')}</span>
    </NodeShell>
  )
}
