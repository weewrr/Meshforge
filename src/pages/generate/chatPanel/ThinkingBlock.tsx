/**
 * 聊天面板里的"思考中"折叠块。
 *
 * 展示模型的推理摘要；默认折叠以免刷屏，点击展开可看完整过程。
 */

import { useState } from 'react'

// ─── 思考过程折叠块 ───────────────────────────────────────────────────────────
/**
 * 模型的思考过程（reasoning）折叠展示。
 *
 * 默认收起：思考内容通常很长且属于过程性信息，展开会把最终回答挤出视野。
 */

/** 可折叠的思考过程块。 */
export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="gp-chat__thinking">
      <button className="gp-chat__thinkingbtn" onClick={() => setOpen((v) => !v)}>
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
        </svg>
        <span>Reasoning</span>
        <svg aria-hidden="true"
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={open ? 'gp-chat__caret--open' : ''}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {/* 收起时完全不挂载内容节点：思考文本可能很长，没必要留在 DOM 里。 */}
      {open && (
        <div className="gp-chat__thinkingbody">
          <p>{content}</p>
        </div>
      )}
    </div>
  )
}
