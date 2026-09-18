/**
 * 子图编辑器可见性：一个跨组件共享的极简外部 store。
 *
 * 子图编辑器是覆盖在画布之上的第二张 React Flow 实例。两张画布都挂在 document
 * 上监听键盘，Delete / Space 会被同时触发（例如在子图里删节点会连带删主画布上
 * 的节点）。主画布据此让出键盘：编辑器打开时禁用 deleteKeyCode 与 Space 面板。
 */
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

export function setSubEditorOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): boolean {
  return open
}

/** 是否有子图编辑器正开着（主画布用来让出全局键盘快捷键）。 */
export function useSubEditorOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
