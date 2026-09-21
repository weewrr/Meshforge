"""
生成 MeshForge README 插图（assets/diagrams/*.svg）。

所有插图都支持主题自适应：单个内联 <style> 块默认使用浅色配色，并在
`prefers-color-scheme: dark` 下切换为深色，因此在 GitHub 的两种主题里都清晰可读。
背景保持透明，让插图自然融入页面。

运行：  python scripts/gen_diagrams.py
"""

import os

# 输出目录固定在仓库的 assets/diagrams 下（相对本脚本位置解析，避免依赖 cwd）。
OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "diagrams")
)

SANS = "'Segoe UI','Helvetica Neue',Inter,Arial,sans-serif"
MONO = "'JetBrains Mono','SF Mono',Consolas,Menlo,monospace"

# 端口类型 → 配色。`any` / `none` 用中性灰，避免与具体类型抢视觉重心。
PORT_COLOR = {"image": "#38bdf8", "text": "#fbbf24", "mesh": "#a78bfa", "any": "#8b93a7",
              "none": "#8b93a7"}

# 节点面板的七个分组，按语义划分（覆盖 src/types.ts 的 NODE_SPECS 全部 35 项，
# 外加子图编辑器的 2 个内部节点 Subgraph In/Out，合计 37）。改动节点时须同步这里。
# 每项：(中文组名, 英文组名, 主题色, 该组节点标签列表, 一句话说明)
NODE_GROUPS = [
    ("输入 / 输出", "I/O", "#38bdf8",
     ["Image", "Text", "Load 3D Mesh", "Array", "Generate Mesh", "Preview", "Add to Scene"],
     "Source media in, results out"),
    ("控制流", "Flow", "#facc15",
     ["Wait", "While", "For Each", "Branch", "Sequence", "Select", "Gate", "Reroute"],
     "Loops, branching and execution order"),
    ("逻辑与运算", "Compute", "#60a5fa",
     ["Is Valid", "Is Empty", "Bool", "Math", "Compare", "Concat Text",
      "Cast", "Clamp", "Lerp", "Random"],
     "Blueprints-style pure data nodes"),
    ("变量", "Variables", "#fbbf24",
     ["Variable", "Get Variable", "Set Variable", "Make Struct", "Break Struct"],
     "Shared values across the graph"),
    ("事件分发", "Dispatchers", "#f97316",
     ["Call Dispatcher", "Bind Dispatcher"],
     "Fire and subscribe to named events"),
    ("子图与扩展", "Subgraph / Extension", "#22d3ee",
     ["Function", "Subgraph In", "Subgraph Out", "Extension"],
     "Fold graphs, plug in models"),
    ("注释", "Comment", "#38bdf8",
     ["Comment"],
     "Annotate the canvas"),
]

# 主题样式：默认浅色，prefers-color-scheme: dark 时切换为深色；
# 字体名用 __SANS__ / __MONO__ 占位符，在字符串末尾统一替换（见下方 .replace）。
STYLE = r'''  <style>
    .t1   { fill: #0d1526; }
    .t2   { fill: #4a5768; }
    .t3   { fill: #8b93a7; }
    .card { fill: #f6f8fb; stroke: rgba(15,23,42,0.10); }
    .box  { fill: #ffffff; stroke: rgba(15,23,42,0.13); }
    .soft { fill: #eef2f8; }
    .ln   { stroke: #9aa3b5; fill: #9aa3b5; }
    .lnd  { stroke: #c2cad6; fill: #c2cad6; }
    .ga   { stop-color: #2f6ee0; }
    .gb   { stop-color: #7c3aed; }

    @media (prefers-color-scheme: dark) {
      .t1   { fill: #e6e8ee; }
      .t2   { fill: #a9b1c3; }
      .t3   { fill: #6b7386; }
      .card { fill: #141922; stroke: rgba(255,255,255,0.09); }
      .box  { fill: #1a1d25; stroke: rgba(255,255,255,0.12); }
      .soft { fill: #1f2531; }
      .ln   { stroke: #4a5164; fill: #4a5164; }
      .lnd  { stroke: #333a48; fill: #333a48; }
      .ga   { stop-color: #4f8cff; }
      .gb   { stop-color: #a855f7; }
    }

    .sans { font-family: __SANS__; }
    .mono { font-family: __MONO__; }
    .a    { stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; }
  </style>'''.replace("__SANS__", SANS).replace("__MONO__", MONO)


def f(v):
    """把数值格式化为字符串并去掉多余的 ".0"（用于 SVG 坐标，例如 123.0 变成 123）。"""
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def esc(s):
    """转义 XML 特殊字符，防止标题/描述里的 `&`、`<`、`>` 破坏 SVG 结构。"""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def wrap(title, desc, w, h, body, defs=""):
    """把正文片段包进带样式的完整 SVG 骨架。

    Args:
        title: 可访问性标题，写入 aria-label / `<title>`。
        desc: 更长的描述，写入 `<desc>`（屏幕阅读器与鼠标悬浮提示）。
        w: 画布宽。
        h: 画布高。
        body: 已生成的 SVG 元素字符串，作为根节点的内容。
        defs: 额外注入 `<defs>` 的内容（各插图自定义渐变/裁剪时用）。

    Returns:
        完整 SVG 文本。
    """
    # 所有插图共用同一套渐变（#gw）与箭头 marker（#arw），保证视觉一致。
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}"
     role="img" aria-label="{esc(title)}">
  <title>{esc(title)}</title>
  <desc>{esc(desc)}</desc>
{STYLE}
  <defs>
    <linearGradient id="gw" x1="0" y1="0" x2="1" y2="1">
      <stop class="ga" offset="0"/>
      <stop class="gb" offset="1"/>
    </linearGradient>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
            orient="auto-start-reverse">
      <path d="M0 1L9 5L0 9z" class="ln" fill="currentColor"/>
    </marker>
{defs}  </defs>

{body}
</svg>
'''


def tag(x, y, text, size=12, color="t2"):
    """绘制一段等宽字体的标签文本（带 esc 转义）。"""
    return f'<text x="{f(x)}" y="{f(y)}" class="mono {color}" font-size="{size}">{esc(text)}</text>'


# --------------------------------------------------------------------------- #
# 1. 节点面板
# --------------------------------------------------------------------------- #

def node_palette():
    """插图 1：七个节点分组及其包含的节点。

    不再逐个罗列节点卡片（37 种会让插图过于庞大），改为按分组概览：
    每组一张卡列出该组全部节点名，读者一眼看清体系结构，细节查 README 表格。
    """
    cw = 740          # 卡宽
    gap_col = 60      # 列间距
    gap_row = 22      # 行间距
    x0, y0 = 30, 92   # 左右边距 / 顶部留白（给标题）
    pill_h = 30       # 节点药丸高
    pill_gap = 8      # 药丸间距
    pad = 24          # 卡内左右内边距
    head = 76         # 卡内标题区高度

    # 先把每组算成「卡高 + 药丸明细」，再贪心分到左右两列，让两列高度尽量接近。
    def layout_group(name_cn, name_en, color, nodes, hint):
        """算出单组的卡高与每个药丸的 (text, x, y) 偏移，返回 (卡高, 药丸列表)。"""
        avail = cw - pad * 2
        rows, cur_x, cur = [], 0.0, []
        for n in nodes:
            # 药丸宽度：等宽字约 7.6px/字符，再留 24px 内边距。
            w = len(n) * 7.6 + 24
            if cur and cur_x + w > avail:
                rows.append(cur)
                cur, cur_x = [], 0.0
            cur.append((n, cur_x, w))
            cur_x += w + pill_gap
        if cur:
            rows.append(cur)
        pills = []
        for r, row in enumerate(rows):
            for text, px, _w in row:
                pills.append((text, px, r * (pill_h + pill_gap)))
        return head + len(rows) * (pill_h + pill_gap) + pad - pill_gap + 16, pills

    cards = [layout_group(*g) for g in NODE_GROUPS]

    # 贪心装箱：依次塞进当前较矮的那一列（首组分给左列）。
    cols = [[], []]
    heights = [0.0, 0.0]
    for i, g in enumerate(NODE_GROUPS):
        card_h = cards[i][0]
        c = 0 if heights[0] <= heights[1] else 1
        cols[c].append((i, g, cards[i], heights[c]))
        heights[c] += card_h + gap_row

    col_h = max(heights) - gap_row
    h = y0 + col_h + 34

    out = [
        f'  <text x="30" y="42" class="sans t1" font-size="25" font-weight="600">'
        f'Thirty-seven node types, seven groups</text>',
        f'  <text x="30" y="70" class="sans t3" font-size="15.5">'
        f'Every node declares typed ports — the canvas only accepts edges whose port types match.</text>',
    ]

    for ci, column in enumerate(cols):
        cx = x0 + ci * (cw + gap_col)
        for idx, (gi, g, (card_h, pills), cy_off) in enumerate(column):
            name_cn, name_en, color, nodes, hint = g
            cy = y0 + cy_off
            out.append(f'  <rect x="{f(cx)}" y="{f(cy)}" width="{cw}" height="{f(card_h)}" rx="14" class="card"/>')
            # 左侧竖向强调条：比整块着色克制，又能按组区分。
            out.append(f'  <rect x="{f(cx)}" y="{f(cy)}" width="5" height="{f(card_h)}" rx="2.5" fill="{color}"/>')
            out.append(
                f'  <text x="{f(cx + pad + 8)}" y="{f(cy + 34)}" class="sans t1" font-size="19" '
                f'font-weight="600">{esc(name_en)}</text>'
            )
            out.append(
                f'  <text x="{f(cx + pad + 8)}" y="{f(cy + 57)}" class="sans t3" font-size="13.5">'
                f'{esc(hint)}</text>'
            )
            # 右上角计数徽标
            out.append(
                f'  <rect x="{f(cx + cw - 52)}" y="{f(cy + 20)}" width="32" height="22" rx="11" '
                f'fill="{color}" fill-opacity="0.15"/>'
            )
            out.append(
                f'  <text x="{f(cx + cw - 36)}" y="{f(cy + 35)}" text-anchor="middle" class="mono" '
                f'font-size="12.5" fill="{color}">{len(nodes)}</text>'
            )
            for text, px, py in pills:
                w = len(text) * 7.6 + 24
                x = cx + pad + px
                y = cy + head + py
                out.append(
                    f'  <rect x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{pill_h}" rx="15" '
                    f'fill="{color}" fill-opacity="0.11" stroke="{color}" stroke-opacity="0.34"/>'
                )
                out.append(
                    f'  <text x="{f(x + w / 2)}" y="{f(y + 20)}" text-anchor="middle" class="mono t1" '
                    f'font-size="13">{esc(text)}</text>'
                )

    return wrap(
        "MeshForge node types",
        "Thirty-seven built-in node types in seven groups: I/O, flow control, compute, variables, "
        "event dispatchers, subgraph/extension and comment.",
        x0 * 2 + cw * 2 + gap_col, h, "\n".join(out),
    )


# --------------------------------------------------------------------------- #
# 2. 生成流水线
# --------------------------------------------------------------------------- #

# 流水线各步：标题 · 副标题 · 主题色 · 图标种类（供 _glyph 分派）
PIPELINE = [
    ("Image", "drop in a photo", "#38bdf8", "img"),
    ("Text", "optional prompt", "#fbbf24", "txt"),
    ("Generate Mesh", "local inference", "#34d399", "gear"),
    ("Preview", "inspect & tweak", "#38bdf8", "grid"),
    ("Export", "OBJ · STL · PLY · GLB", "#a78bfa", "down"),
]


def _glyph(kind, cx, cy, color):
    """以 (cx, cy) 为中心的 32×32 线框图标。"""
    # 统一缩放系数，让图标视觉大小与卡片留白协调。
    s = 0.72
    # 各图标的路径骨架（本函数的查表表；实际绘制写在下面按 kind 分支里）
    g = {
        "img": 'M4 7h24v18H4z' ,
        "txt": '',
        "gear": '',
        "grid": '',
        "down": '',
    }
    if kind == "img":
        # 相框 + 太阳 + 山峦折线
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<rect x="4" y="7" width="24" height="18" rx="3" fill="none" stroke="{color}" stroke-width="2.4"/>'
            f'<circle cx="12" cy="14" r="3" fill="{color}"/>'
            f'<path d="M7 22l7-7 5 5 4-3 5 5" fill="none" stroke="{color}" stroke-width="2.4" '
            f'stroke-linecap="round" stroke-linejoin="round"/></g>'
        )
    if kind == "txt":
        # 大写字母 T，代表 Prompt/文本
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<path d="M6 8h20M16 8v20" fill="none" stroke="{color}" stroke-width="2.6" stroke-linecap="round"/>'
            f'<path d="M10 24h12" fill="none" stroke="{color}" stroke-width="2.2" stroke-linecap="round"/></g>'
        )
    if kind == "gear":
        # 齿轮：中心圆 + 八根辐条（对角两根为斜线）
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<circle cx="16" cy="16" r="4.6" fill="none" stroke="{color}" stroke-width="2.4"/>'
            f'<path d="M16 3.5v4M16 24.5v4M3.5 16h4M24.5 16h4M7.2 7.2l2.9 2.9M21.9 21.9l2.9 2.9'
            f'M24.8 7.2l-2.9 2.9M10.1 21.9l-2.9 2.9" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linecap="round"/></g>'
        )
    if kind == "grid":
        # 等轴测立方体，代表 3D 视口
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<path d="M16 4l11 6.5v11L16 28 5 21.5v-11z" fill="none" stroke="{color}" stroke-width="2.3"/>'
            f'<path d="M5 10.5L16 17l11-6.5M16 17v11" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round"/></g>'
        )
    # 兜底：向下箭头 + 底横线，代表导出/下载
    return (
        f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
        f'<path d="M16 5v16" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/>'
        f'<path d="M10 15l6 6 6-6" fill="none" stroke="{color}" stroke-width="2.4" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="M6 27h20" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/></g>'
    )


def pipeline():
    """插图 2：一次完整的生成流水线（Image → … → Export）。"""
    cw, ch, gap = 262, 148, 52
    n = len(PIPELINE)
    x0, y0 = 46, 70
    # 高度固定 300（下方留白用于容纳标题与投影效果）。
    w = x0 * 2 + cw * n + gap * (n - 1)
    h = 300

    out = []
    for i, (title, sub, color, kind) in enumerate(PIPELINE):
        cx = x0 + i * (cw + gap)
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="{ch}" rx="14" class="card"/>')
        # 卡片顶部的彩色条，用主题色区分步骤类别。
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="4" rx="2" fill="{color}"/>')
        out.append(_glyph(kind, cx + 42, y0 + 56, color))
        out.append(
            f'  <text x="{f(cx + 76)}" y="{f(y0 + 58)}" class="sans t1" font-size="20" font-weight="600">{esc(title)}</text>'
        )
        out.append(f'  <text x="{f(cx + 76)}" y="{f(y0 + 82)}" class="sans t3" font-size="14.5">{esc(sub)}</text>')
        out.append(
            f'  <text x="{f(cx + 22)}" y="{f(y0 + 122)}" class="mono t3" font-size="13">step {i + 1}</text>'
        )
        # 相邻卡片之间画箭头；gap-20 让箭头两端都留出间距。
        if i < n - 1:
            ax = cx + cw + 10
            out.append(
                f'  <path d="M{f(ax)} {f(y0 + ch / 2)}h{f(gap - 20)}" class="ln a" marker-end="url(#arw)"/>'
            )

    # 标题用 insert(0,...) 提到最前，避免影响上面按序绘制的层级。
    out.insert(0, f'  <text x="46" y="42" class="sans t2" font-size="17" font-weight="600">'
                  f'One run, end to end</text>')
    return wrap(
        "MeshForge generation pipeline",
        "Image and Text inputs feed the generator, the result is previewed in the 3D viewport "
        "and exported as OBJ, STL, PLY or GLB.",
        w, h, "\n".join(out),
    )


# --------------------------------------------------------------------------- #
# 3. 运行时架构
# --------------------------------------------------------------------------- #

def runtime():
    """插图 3：三进程运行时架构（Electron 主进程 / 渲染进程 / Python 后端）。"""
    w, h = 1600, 600
    bw, bh = 380, 316
    y0 = 120

    # 三列：x 坐标 · 标题 · 强调色 · 内部条目（名称 · 说明）
    cols = [
        (60, "Electron main", "#4f8cff", [
            ("BrowserWindow", "frameless shell, native menus"),
            ("python-bridge.ts", "spawn · health · watchdog"),
            ("IPC bridge", "dialogs, file paths, RAM"),
        ]),
        (610, "Renderer · React", "#a855f7", [
            ("Pages", "Generate / Workflows / Models"),
            ("Node canvas", "React Flow graph editor"),
            ("3D viewer", "Three.js + grid floor"),
        ]),
        (1160, "Python · FastAPI :8766+", "#34d399", [
            ("Routers", "workflows / generate / process"),
            ("Generator registry", "built-ins + installed extensions"),
            ("Workspace", "workflows/ · extensions/ · models/"),
        ]),
    ]

    out = [
        f'  <text x="60" y="56" class="sans t1" font-size="26" font-weight="600">Everything runs on your machine</text>',
        f'  <text x="60" y="86" class="sans t3" font-size="16">'
        f'Electron ships the UI, a local Python backend does the work — nothing leaves localhost.</text>',
    ]

    for x, title, accent, items in cols:
        out.append(f'  <rect x="{x}" y="{y0}" width="{bw}" height="{bh}" rx="16" class="card"/>')
        # 左侧竖向强调条，替代整块着色，保持卡片清爽。
        out.append(f'  <rect x="{x}" y="{y0}" width="5" height="{bh}" rx="2.5" fill="{accent}"/>')
        out.append(
            f'  <text x="{x + 28}" y="{y0 + 44}" class="sans t1" font-size="21" font-weight="600">{esc(title)}</text>'
        )
        yy = y0 + 84
        for name, desc in items:
            out.append(f'  <rect x="{x + 28}" y="{yy}" width="{bw - 56}" height="62" rx="10" class="box"/>')
            out.append(f'  <circle cx="{x + 50}" cy="{yy + 31}" r="4.5" fill="{accent}"/>')
            out.append(
                f'  <text x="{x + 68}" y="{yy + 26}" class="mono t1" font-size="14.5">{esc(name)}</text>'
            )
            out.append(
                f'  <text x="{x + 68}" y="{yy + 46}" class="sans t3" font-size="13.5">{esc(desc)}</text>'
            )
            # 每个条目高 62、步进 74 → 条目之间留 12px 间隙。
            yy += 74

    # 列间连线（IPC / fetch·SSE）
    def harrow(x1, x2, y, label, dashed=False):
        """画一条带标签的水平箭头；dashed=True 时改为虚线（表示非直连通道）。"""
        d = ' stroke-dasharray="6 6"' if dashed else ''
        return [
            f'  <path d="M{x1} {y}h{x2 - x1}" class="ln a" marker-end="url(#arw)"{d}/>',
            f'  <text x="{f((x1 + x2) / 2)}" y="{y - 14}" text-anchor="middle" class="mono t3" '
            f'font-size="13">{esc(label)}</text>',
        ]

    out += harrow(440, 610, y0 + 96, "IPC")
    out += harrow(990, 1160, y0 + 96, "fetch / SSE")
    # 主进程 → 后端（从卡片下方绕行的一条曲线）
    # 用三次贝塞尔在两列底部绕一个大弧，避免穿过中间的渲染进程卡片。
    out.append(
        f'  <path d="M250 {y0 + bh}C250 {y0 + bh + 110} 1350 {y0 + bh + 110} 1350 {y0 + bh}" '
        f'class="ln a" marker-end="url(#arw)" stroke-dasharray="6 6"/>'
    )
    out.append(
        f'  <text x="800" y="{y0 + bh + 104}" text-anchor="middle" class="mono t3" font-size="13">'
        f'spawn uvicorn · health poll · auto-restart on crash</text>'
    )

    return wrap(
        "MeshForge runtime architecture",
        "Electron main process spawns and watches a local Python FastAPI backend (port 8766 or the "
        "next free one); the React renderer talks to it over HTTP, SSE and IPC.",
        w, h, "\n".join(out),
    )


# ─────────────────────────────────────────────────────────────────────────── #
# 4. 扩展来源
# ─────────────────────────────────────────────────────────────────────────── #

def _source_icon(kind, cx, cy, color):
    """按来源类型绘制一个圆形图标（GitHub / Hugging Face / ModelScope）。"""
    if kind == "github":
        # 简化版 Git 分支图：三个节点 + 折线连边
        return (
            f'<g transform="translate({f(cx - 22)} {f(cy - 22)})">'
            f'<circle cx="22" cy="22" r="20" fill="none" stroke="{color}" stroke-width="2"/>'
            f'<circle cx="11" cy="12" r="3.4" fill="{color}"/>'
            f'<circle cx="11" cy="32" r="3.4" fill="{color}"/>'
            f'<circle cx="33" cy="22" r="3.4" fill="{color}"/>'
            f'<path d="M11 15.4v13.2M14 12h7a5 5 0 0 1 5 5v5" fill="none" stroke="{color}" '
            f'stroke-width="2" stroke-linecap="round"/></g>'
        )
    if kind == "hf":
        # 一张笑脸，代表 Hugging Face
        return (
            f'<g transform="translate({f(cx - 22)} {f(cy - 22)})">'
            f'<circle cx="22" cy="22" r="20" fill="none" stroke="{color}" stroke-width="2"/>'
            f'<circle cx="15" cy="18" r="2.6" fill="{color}"/>'
            f'<circle cx="29" cy="18" r="2.6" fill="{color}"/>'
            f'<path d="M13 27a9 9 0 0 0 18 0" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linecap="round"/></g>'
        )
    # 兜底（ModelScope）：立方体线框
    return (
        f'<g transform="translate({f(cx - 22)} {f(cy - 22)})">'
        f'<circle cx="22" cy="22" r="20" fill="none" stroke="{color}" stroke-width="2"/>'
        f'<path d="M22 10l10 5.5v11L22 32 12 26.5v-11z" fill="none" stroke="{color}" stroke-width="2"/>'
        f'<path d="M12 15.5L22 21l10-5.5M22 21v11" fill="none" stroke="{color}" stroke-width="1.8" '
        f'stroke-linecap="round" stroke-linejoin="round"/></g>'
    )


def extensions():
    """插图 4：扩展安装的三种来源（GitHub / Hugging Face / ModelScope）。"""
    cw, ch, gap = 420, 214, 40
    x0, y0 = 46, 56
    n = 3
    w = x0 * 2 + cw * n + gap * (n - 1)
    h = 356

    # 三张卡片：显示名 · 图标种类 · 主题色 · 示例 URL 文本
    srcs = [
        ("GitHub", "github", "#8b93a7", "github.com/user/repo"),
        ("Hugging Face", "hf", "#f59e0b", "huggingface.co/user/model"),
        ("ModelScope", "ms", "#4f8cff", "modelscope.cn/models/user/model"),
    ]

    out = [
        f'  <text x="46" y="34" class="sans t1" font-size="20" font-weight="600">'
        f'Install from three sources</text>'
    ]
    for i, (name, kind, color, example) in enumerate(srcs):
        cx = x0 + i * (cw + gap)
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="{ch}" rx="14" class="card"/>')
        out.append(_source_icon(kind, cx + 52, y0 + 58, color))
        out.append(
            f'  <text x="{f(cx + 92)}" y="{f(y0 + 54)}" class="sans t1" font-size="20" font-weight="600">{esc(name)}</text>'
        )
        out.append(
            f'  <text x="{f(cx + 92)}" y="{f(y0 + 78)}" class="mono t3" font-size="12.5">{esc(example)}</text>'
        )
        # 分隔线：上半是来源与示例，下半是安装行为的三个要点。
        out.append(f'  <line x1="{f(cx + 24)}" y1="{f(y0 + 108)}" x2="{f(cx + cw - 24)}" y2="{f(y0 + 108)}" class="lnd"/>')
        out.append(f'  <text x="{f(cx + 24)}" y="{f(y0 + 136)}" class="sans t2" font-size="14">'
                   f'URL resolves to a file tree</text>')
        out.append(f'  <text x="{f(cx + 24)}" y="{f(y0 + 160)}" class="sans t2" font-size="14">'
                   f'Streamed into .staging/ first</text>')
        out.append(f'  <text x="{f(cx + 24)}" y="{f(y0 + 184)}" class="sans t2" font-size="14">'
                   f'Rolls back if validation fails</text>')
        if i < n - 1:
            out.append(
                f'  <path d="M{f(cx + cw + 12)} {f(y0 + ch / 2)}h{f(gap - 24)}" class="lnd a"/>'
            )

    # 底部两行说明：居中与画布底部保留 46 / 20 px 边距。
    out.append(
        f'  <text x="{f(w / 2)}" y="{f(h - 46)}" text-anchor="middle" class="sans t2" font-size="15.5">'
        f'manifest.json + entrypoint are validated before the package is moved into '
        f'<tspan class="mono">extensions/&lt;id&gt;</tspan></text>'
    )
    out.append(
        f'  <text x="{f(w / 2)}" y="{f(h - 20)}" text-anchor="middle" class="sans t3" font-size="14">'
        f'A local folder works too — pick it with a native directory dialog.</text>'
    )

    return wrap(
        "MeshForge extension install sources",
        "Extensions can be installed from GitHub, Hugging Face or ModelScope, or from a local folder.",
        w, h, "\n".join(out),
    )


# ─────────────────────────────────────────────────────────────────────────── #
# 5. 生成器分类
# ─────────────────────────────────────────────────────────────────────────── #

# 四大分类，与 server/generators/registry.py 的 `category` 字段和
# src/types.ts 的 EXTENSION_CATEGORY_COLOR 一致（改一处须同步另两处）。
# 每项：(分类键, 显示名, 主题色, 输入 → 输出, 说明, 具体模型列表)
GENERATOR_CATEGORIES = [
    ("mesh", "mesh", "#34d399", "image → mesh",
     "Image to a textured 3D mesh — the core of MeshForge.",
     ["Hunyuan3D 2 mini", "Hunyuan3D 2 turbo", "Hunyuan3D 2 50-step",
      "Hunyuan3D 2 MV turbo", "Hunyuan3D 2 MV fast", "Hunyuan3D 2 MV 50-step",
      "InstantMesh large", "InstantMesh base"]),
    ("multiview", "multiview", "#2dd4bf", "image / text → PNG sheet",
     "One image (or a prompt) to a multi-view contact sheet.",
     ["MVDream (text)", "Stable Zero123", "Wonder3D Plus"]),
    ("image", "image", "#e879f9", "image → image",
     "Image-to-image utilities: matting, upscaling, depth, line art.",
     ["RMBG-2.0", "BiRefNet", "Real-ESRGAN x2", "Depth-Anything-V2",
      "MoGe", "M-LSD", "CodeFormer", "Universal Matting"]),
    ("process", "process", "#34d399", "mesh → mesh",
     "CPU mesh cleanup and conversion, powered by trimesh + numpy.",
     ["mesh-repair", "mesh-smoother", "mesh-remesher", "mesh-optimizer",
      "mesh-exporter"]),
]


def generator_categories():
    """插图 5：四大生成器分类及其输出类型。"""
    cw, gap = 372, 36
    x0, y0 = 30, 112
    n = len(GENERATOR_CATEGORIES)
    w = x0 * 2 + cw * n + gap * (n - 1)
    # 高度按模型最多的那一类推算（本文件里 image 类 8 项），避免硬编码后加模型就溢出。
    list_top, row_h = 224, 24
    h = y0 + list_top + max(len(c[5]) for c in GENERATOR_CATEGORIES) * row_h + 34
    pad = 24

    out = [
        f'  <text x="30" y="42" class="sans t1" font-size="25" font-weight="600">'
        f'Four generator categories</text>',
        f'  <text x="30" y="70" class="sans t3" font-size="15.5">'
        f'Each generator declares a category; the Models page groups by it and the palette colors '
        f'nodes accordingly.</text>',
    ]

    for i, (key, name, color, flow, hint, models) in enumerate(GENERATOR_CATEGORIES):
        cx = x0 + i * (cw + gap)
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="{f(h - y0 - 34)}" rx="16" class="card"/>')
        # 顶部彩色条：与工作流画布上该类节点的颜色一致。
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="4" rx="2" fill="{color}"/>')

        out.append(
            f'  <text x="{f(cx + pad)}" y="{f(y0 + 42)}" class="sans t1" font-size="20" '
            f'font-weight="600">{esc(name)}</text>'
        )
        out.append(
            f'  <rect x="{f(cx + pad)}" y="{f(y0 + 56)}" width="{f(len(models) * 7.6 + 24)}" height="22" '
            f'rx="11" fill="{color}" fill-opacity="0.14"/>'
        )
        out.append(
            f'  <text x="{f(cx + pad + (len(models) * 7.6 + 24) / 2)}" y="{f(y0 + 71)}" '
            f'text-anchor="middle" class="mono" font-size="11.5" fill="{color}">{len(models)} models</text>'
        )

        # 输入 → 输出 流程标签
        out.append(
            f'  <text x="{f(cx + pad)}" y="{f(y0 + 104)}" class="mono t2" font-size="13">'
            f'{esc(flow)}</text>'
        )
        # 说明文字：卡宽有限，手工折行（每行约 42 个西文字符）。
        for j, line in enumerate(_wrap_text(hint, 44)):
            out.append(
                f'  <text x="{f(cx + pad)}" y="{f(y0 + 130 + j * 19)}" class="sans t3" '
                f'font-size="13.5">{esc(line)}</text>'
            )

        out.append(
            f'  <line x1="{f(cx + pad)}" y1="{f(y0 + 196)}" x2="{f(cx + cw - pad)}" y2="{f(y0 + 196)}" '
            f'class="lnd"/>'
        )
        yy = y0 + list_top
        for m in models:
            out.append(f'  <circle cx="{f(cx + pad + 4)}" cy="{f(yy - 4)}" r="3" fill="{color}"/>')
            out.append(
                f'  <text x="{f(cx + pad + 16)}" y="{f(yy)}" class="sans t2" font-size="13.5">'
                f'{esc(m)}</text>'
            )
            yy += row_h

    return wrap(
        "MeshForge generator categories",
        "Four generator categories: mesh (image to mesh), multiview (image to PNG contact sheet), "
        "image (image to image utilities) and process (mesh to mesh cleanup).",
        w, h, "\n".join(out),
    )


def _wrap_text(text, limit):
    """按最大字符数折行，返回行列表（用于 SVG 里的说明文字）。"""
    words, lines, cur = text.split(), [], ""
    for wd in words:
        if cur and len(cur) + 1 + len(wd) > limit:
            lines.append(cur)
            cur = wd
        else:
            cur = f"{cur} {wd}".strip()
    if cur:
        lines.append(cur)
    return lines


def main():
    """入口：依次生成五张插图并写出到 OUT_DIR，打印每张的体积。"""
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in (
        ("node-palette.svg", node_palette),
        ("pipeline.svg", pipeline),
        ("runtime-architecture.svg", runtime),
        ("extension-sources.svg", extensions),
        ("generator-categories.svg", generator_categories),
    ):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(fn())
        print(f"written: {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
