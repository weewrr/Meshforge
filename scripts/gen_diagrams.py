"""
Generate the MeshForge README diagrams (assets/diagrams/*.svg).

All diagrams are theme-aware: a single embedded <style> block holds a light
palette by default and swaps to a dark one under `prefers-color-scheme: dark`,
so they read correctly on GitHub in either theme. Backgrounds are left
transparent so the diagrams blend into the page.

Run:  python scripts/gen_diagrams.py
"""

import os

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "diagrams")
)

SANS = "'Segoe UI','Helvetica Neue',Inter,Arial,sans-serif"
MONO = "'JetBrains Mono','SF Mono',Consolas,Menlo,monospace"

# Node specs mirrored from src/types.ts (NODE_SPECS)
NODES = [
    ("Image",         "#38bdf8", [],       "image", "Pick the source photo"),
    ("Text",          "#fbbf24", [],       "text",  "Prompt or extra parameters"),
    ("Load 3D Mesh",  "#a78bfa", [],       "mesh",  "Import an existing mesh"),
    ("Generate Mesh", "#34d399", ["image"], "mesh",  "Run the generator model"),
    ("Preview",       "#38bdf8", ["mesh"], "mesh",  "Inspect in the 3D viewport"),
    ("Add to Scene",  "#a78bfa", ["mesh"], "none",  "Hand the result to the scene"),
    ("Wait",          "#71717a", ["any"],  "any",   "Pause between steps"),
    ("While",         "#f59e0b", ["any"],  "any",   "Loop while a condition holds"),
    ("For Each",      "#38bdf8", ["any"],  "any",   "Iterate over a list"),
]

PORT_COLOR = {"image": "#38bdf8", "text": "#fbbf24", "mesh": "#a78bfa", "any": "#8b93a7",
              "none": "#8b93a7"}

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
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def wrap(title, desc, w, h, body, defs=""):
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
    return f'<text x="{f(x)}" y="{f(y)}" class="mono {color}" font-size="{size}">{esc(text)}</text>'


# --------------------------------------------------------------------------- #
# 1. Node palette
# --------------------------------------------------------------------------- #

def node_palette():
    cw, ch, gap = 440, 118, 20
    cols, rows = 3, 3
    x0, y0 = 40, 40
    w = x0 * 2 + cw * cols + gap * (cols - 1)
    h = y0 * 2 + ch * rows + gap * (rows - 1)

    out = []
    for i, (label, color, inputs, output, hint) in enumerate(NODES):
        cx = x0 + (i % cols) * (cw + gap)
        cy = y0 + (i // cols) * (ch + gap)

        out.append(
            f'  <rect x="{f(cx)}" y="{f(cy)}" width="{cw}" height="{ch}" rx="12" class="card"/>'
        )
        # colour swatch + name
        out.append(f'  <rect x="{f(cx + 20)}" y="{f(cy + 24)}" width="12" height="12" rx="3" fill="{color}"/>')
        out.append(
            f'  <text x="{f(cx + 44)}" y="{f(cy + 36)}" class="sans t1" font-size="19" font-weight="600">{esc(label)}</text>'
        )
        out.append(f'  <text x="{f(cx + 20)}" y="{f(cy + 62)}" class="sans t3" font-size="14">{esc(hint)}</text>')

        # port pills
        px = cx + 20
        py = cy + 78
        if inputs:
            for p in inputs:
                pc = PORT_COLOR[p]
                pw = len(p) * 8 + 22
                out.append(
                    f'  <rect x="{f(px)}" y="{f(py)}" width="{pw}" height="24" rx="12" fill="none" '
                    f'stroke="{pc}" stroke-opacity="0.45"/>'
                )
                out.append(
                    f'  <text x="{f(px + pw / 2)}" y="{f(py + 16)}" text-anchor="middle" class="mono" '
                    f'font-size="11.5" fill="{pc}">{esc(p)}</text>'
                )
                px += pw + 8
            # arrow between in and out (only when both are present)
            if output and output != "none":
                out.append(
                    f'  <path d="M{f(px + 2)} {f(py + 12)}h14" class="ln a" marker-end="url(#arw)"/>'
                )
                px += 26
        if output and output != "none":
            pc = PORT_COLOR[output]
            pw = len(output) * 8 + 22
            out.append(
                f'  <rect x="{f(px)}" y="{f(py)}" width="{pw}" height="24" rx="12" fill="{pc}" fill-opacity="0.14" '
                f'stroke="{pc}" stroke-opacity="0.55"/>'
            )
            out.append(
                f'  <text x="{f(px + pw / 2)}" y="{f(py + 16)}" text-anchor="middle" class="mono" '
                f'font-size="11.5" fill="{pc}">{esc(output)}</text>'
            )

    return wrap(
        "MeshForge node types",
        "The nine built-in node types with their port types: Image, Text, Load 3D Mesh, "
        "Generate Mesh, Preview, Add to Scene, Wait, While and For Each.",
        w, h, "\n".join(out),
    )


# --------------------------------------------------------------------------- #
# 2. Pipeline
# --------------------------------------------------------------------------- #

PIPELINE = [
    ("Image", "drop in a photo", "#38bdf8", "img"),
    ("Text", "optional prompt", "#fbbf24", "txt"),
    ("Generate Mesh", "local inference", "#34d399", "gear"),
    ("Preview", "inspect & tweak", "#38bdf8", "grid"),
    ("Export", "OBJ · STL · PLY · GLB", "#a78bfa", "down"),
]


def _glyph(kind, cx, cy, color):
    """Small 32x32 icon centred on (cx, cy)."""
    s = 0.72
    g = {
        "img": 'M4 7h24v18H4z' ,
        "txt": '',
        "gear": '',
        "grid": '',
        "down": '',
    }
    if kind == "img":
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<rect x="4" y="7" width="24" height="18" rx="3" fill="none" stroke="{color}" stroke-width="2.4"/>'
            f'<circle cx="12" cy="14" r="3" fill="{color}"/>'
            f'<path d="M7 22l7-7 5 5 4-3 5 5" fill="none" stroke="{color}" stroke-width="2.4" '
            f'stroke-linecap="round" stroke-linejoin="round"/></g>'
        )
    if kind == "txt":
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<path d="M6 8h20M16 8v20" fill="none" stroke="{color}" stroke-width="2.6" stroke-linecap="round"/>'
            f'<path d="M10 24h12" fill="none" stroke="{color}" stroke-width="2.2" stroke-linecap="round"/></g>'
        )
    if kind == "gear":
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<circle cx="16" cy="16" r="4.6" fill="none" stroke="{color}" stroke-width="2.4"/>'
            f'<path d="M16 3.5v4M16 24.5v4M3.5 16h4M24.5 16h4M7.2 7.2l2.9 2.9M21.9 21.9l2.9 2.9'
            f'M24.8 7.2l-2.9 2.9M10.1 21.9l-2.9 2.9" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linecap="round"/></g>'
        )
    if kind == "grid":
        return (
            f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
            f'<path d="M16 4l11 6.5v11L16 28 5 21.5v-11z" fill="none" stroke="{color}" stroke-width="2.3"/>'
            f'<path d="M5 10.5L16 17l11-6.5M16 17v11" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round"/></g>'
        )
    return (
        f'<g transform="translate({f(cx - 16)} {f(cy - 16)}) scale({s})">'
        f'<path d="M16 5v16" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/>'
        f'<path d="M10 15l6 6 6-6" fill="none" stroke="{color}" stroke-width="2.4" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="M6 27h20" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/></g>'
    )


def pipeline():
    cw, ch, gap = 262, 148, 52
    n = len(PIPELINE)
    x0, y0 = 46, 70
    w = x0 * 2 + cw * n + gap * (n - 1)
    h = 300

    out = []
    for i, (title, sub, color, kind) in enumerate(PIPELINE):
        cx = x0 + i * (cw + gap)
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="{ch}" rx="14" class="card"/>')
        out.append(f'  <rect x="{f(cx)}" y="{f(y0)}" width="{cw}" height="4" rx="2" fill="{color}"/>')
        out.append(_glyph(kind, cx + 42, y0 + 56, color))
        out.append(
            f'  <text x="{f(cx + 76)}" y="{f(y0 + 58)}" class="sans t1" font-size="20" font-weight="600">{esc(title)}</text>'
        )
        out.append(f'  <text x="{f(cx + 76)}" y="{f(y0 + 82)}" class="sans t3" font-size="14.5">{esc(sub)}</text>')
        out.append(
            f'  <text x="{f(cx + 22)}" y="{f(y0 + 122)}" class="mono t3" font-size="13">step {i + 1}</text>'
        )
        if i < n - 1:
            ax = cx + cw + 10
            out.append(
                f'  <path d="M{f(ax)} {f(y0 + ch / 2)}h{f(gap - 20)}" class="ln a" marker-end="url(#arw)"/>'
            )

    out.insert(0, f'  <text x="46" y="42" class="sans t2" font-size="17" font-weight="600">'
                  f'One run, end to end</text>')
    return wrap(
        "MeshForge generation pipeline",
        "Image and Text inputs feed the generator, the result is previewed in the 3D viewport "
        "and exported as OBJ, STL, PLY or GLB.",
        w, h, "\n".join(out),
    )


# --------------------------------------------------------------------------- #
# 3. Runtime architecture
# --------------------------------------------------------------------------- #

def runtime():
    w, h = 1600, 600
    bw, bh = 380, 316
    y0 = 120

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
        (1160, "Python · FastAPI :8766", "#34d399", [
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
            yy += 74

    # arrows
    def harrow(x1, x2, y, label, dashed=False):
        d = ' stroke-dasharray="6 6"' if dashed else ''
        return [
            f'  <path d="M{x1} {y}h{x2 - x1}" class="ln a" marker-end="url(#arw)"{d}/>',
            f'  <text x="{f((x1 + x2) / 2)}" y="{y - 14}" text-anchor="middle" class="mono t3" '
            f'font-size="13">{esc(label)}</text>',
        ]

    out += harrow(440, 610, y0 + 96, "IPC")
    out += harrow(990, 1160, y0 + 96, "fetch / SSE")
    # main → backend (curved under the boxes)
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
        "Electron main process spawns and watches a local Python FastAPI backend on port 8766; "
        "the React renderer talks to it over HTTP, SSE and IPC.",
        w, h, "\n".join(out),
    )


# --------------------------------------------------------------------------- #
# 4. Extension sources
# --------------------------------------------------------------------------- #

def _source_icon(kind, cx, cy, color):
    if kind == "github":
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
        return (
            f'<g transform="translate({f(cx - 22)} {f(cy - 22)})">'
            f'<circle cx="22" cy="22" r="20" fill="none" stroke="{color}" stroke-width="2"/>'
            f'<circle cx="15" cy="18" r="2.6" fill="{color}"/>'
            f'<circle cx="29" cy="18" r="2.6" fill="{color}"/>'
            f'<path d="M13 27a9 9 0 0 0 18 0" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linecap="round"/></g>'
        )
    return (
        f'<g transform="translate({f(cx - 22)} {f(cy - 22)})">'
        f'<circle cx="22" cy="22" r="20" fill="none" stroke="{color}" stroke-width="2"/>'
        f'<path d="M22 10l10 5.5v11L22 32 12 26.5v-11z" fill="none" stroke="{color}" stroke-width="2"/>'
        f'<path d="M12 15.5L22 21l10-5.5M22 21v11" fill="none" stroke="{color}" stroke-width="1.8" '
        f'stroke-linecap="round" stroke-linejoin="round"/></g>'
    )


def extensions():
    cw, ch, gap = 420, 214, 40
    x0, y0 = 46, 56
    n = 3
    w = x0 * 2 + cw * n + gap * (n - 1)
    h = 356

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


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in (
        ("node-palette.svg", node_palette),
        ("pipeline.svg", pipeline),
        ("runtime-architecture.svg", runtime),
        ("extension-sources.svg", extensions),
    ):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(fn())
        print(f"written: {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
