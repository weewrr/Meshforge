/**
 * 焦点圈定 hook（模态框无障碍）。
 *
 * 容器挂载时把焦点移入第一个可聚焦元素，Tab 循环被限制在容器内；卸载时把
 * 焦点归还给打开模态框前所在的元素，避免键盘用户"丢失"位置。
 */

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    // offsetParent 为 null 说明元素被隐藏（display:none 等），应跳过；
    // 但当前已聚焦的元素即使不可见也保留，避免焦点丢失。
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * 弹窗焦点管理:
 * - 激活时初始聚焦到 autofocus 元素(否则第一个可聚焦元素)
 * - Tab / Shift+Tab 在容器内循环,焦点逃逸时拉回
 * - Escape 触发 onClose
 * - 停用时恢复焦点到打开前的元素
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
  onClose?: () => void
): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return

    const prev = document.activeElement as HTMLElement | null

    const items = getFocusable(el)
    const auto = el.querySelector<HTMLElement>('[autofocus]')
    ;(auto ?? items[0])?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
        return
      }
      if (e.key !== 'Tab') return
      const list = getFocusable(el)
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      const inside = el.contains(document.activeElement)
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [active, onClose])

  return ref
}
