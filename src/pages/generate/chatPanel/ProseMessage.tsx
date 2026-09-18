// ─── 正文渲染器 —— 极简 markdown ──────────────────────────────────────────────
/**
 * 助手回复的正文渲染。
 *
 * 只支持最小子集：按空行切段，连续的行首 `-` / `•` / `*` 视为无序列表。
 * 刻意不引入 markdown 库——聊天回复的排版需求有限，而完整富文本渲染会带来
 * XSS 风险与包体积开销。
 */

/** 把纯文本按"段落 / 无序列表"两种块渲染。 */
export function ProseMessage({ content }: { content: string }) {
  // 以空行分段：在 markdown 里空行是最可靠的分块信号。
  const blocks = content.split(/\n\n+/)
  return (
    <div className="gp-chat__prose">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        // 整块每一行都是列表项（或空行）时才当成列表，
        // 避免把正文里恰好以短横线开头的单个句子误判成列表。
        const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()) || l.trim() === '')
        if (isList) {
          return (
            <ul key={i}>
              {lines.filter(Boolean).map((l, j) => (
                <li key={j}>
                  <span className="gp-chat__bullet">•</span>
                  <span>{l.replace(/^[-•*]\s/, '')}</span>
                </li>
              ))}
            </ul>
          )
        }
        return <p key={i}>{block}</p>
      })}
    </div>
  )
}
