"""
Generate the MeshForge README banner (assets/banners/banner-1600x400.svg).

The banner is a self-contained SVG that adapts to GitHub's light/dark theme via
an embedded <style> block with a `prefers-color-scheme: dark` media query.

Concept: a sphere whose left half is a pixel grid (the input image) and right
half is a triangle mesh (the generated 3D surface), split by a glowing forge
seam. Wordmark and tech-stack on the left.

Run:  python scripts/gen_banner.py
"""

import math
import os

W, H = 1600, 400

# sphere geometry
CX, CY, R = 1235.0, 200.0, 132.0
EDGE = 26.0
HH = EDGE * math.sqrt(3) / 2.0

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "banners")
)


def f(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def triangle_mesh_lines():
    x0, x1 = CX - R - 30, CX + R + 30
    y0, y1 = CY - R - 30, CY + R + 30
    out = []
    # horizontal family
    y = CY - math.ceil((CY - y0) / HH) * HH
    while y <= y1:
        out.append(f'<line x1="{f(x0)}" y1="{f(y)}" x2="{f(x1)}" y2="{f(y)}"/>')
        y += HH
    # two diagonal families (±60 degrees)
    for ang in (60.0, -60.0):
        a = math.radians(ang)
        ux, uy = math.cos(a), math.sin(a)
        nx, ny = -uy, ux
        kmax = int((R + 40) / HH) + 1
        for k in range(-kmax, kmax + 1):
            px, py = CX + k * HH * nx, CY + k * HH * ny
            out.append(
                f'<line x1="{f(px - 420 * ux)}" y1="{f(py - 420 * uy)}" '
                f'x2="{f(px + 420 * ux)}" y2="{f(py + 420 * uy)}"/>'
            )
    return out


def mesh_vertices():
    verts = []
    for i in range(-9, 10):
        y = CY + i * HH
        for j in range(-9, 10):
            x = CX + j * EDGE + (abs(i) % 2) * (EDGE / 2)
            verts.append((x, y))
    return verts


def sparks():
    picked, seen = [], []
    for (x, y) in sorted(mesh_vertices(), key=lambda p: (p[0], p[1])):
        d = math.hypot(x - CX, y - CY)
        if not (0.42 * R < d < 0.9 * R):
            continue
        if x < CX + 0.12 * R:
            continue
        if any(abs(x - sx) < EDGE * 1.4 and abs(y - sy) < HH * 1.6 for sx, sy in seen):
            continue
        seen.append((x, y))
        picked.append((x, y))
        if len(picked) >= 6:
            break
    return picked


# Plain string template. CSS braces stay literal (no f-string escaping).
# Placeholders use double-underscore tokens; we .replace() them in build().
TEMPLATE = r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 __W__ __H__" width="__W__" height="__H__"
     role="img" aria-label="MeshForge - local image to 3D mesh generation">
  <title>MeshForge - image to 3D mesh, forged locally</title>

  <style>
    /* default = light (GitHub light theme) */
    .bg        { fill: #fbfcfe; }
    .grid      { stroke: rgba(15,23,42,0.045); }
    .s0        { stop-color: #f3f7fd; }
    .s1        { stop-color: #b4c3d8; }
    .rim       { stroke: rgba(15,23,42,0.32); }
    .scan      { stroke: rgba(15,23,42,0.18); }
    .orbit     { stroke: rgba(15,23,42,0.24); }
    .dot       { fill: #6f829e; }
    .ga        { stop-color: #2f6ee0; }
    .gb        { stop-color: #7c3aed; }
    .gl        { stop-color: rgba(47,110,224,0.30); }
    .t1        { fill: #0d1526; }
    .t2        { fill: #4a5768; }
    .t3        { fill: #9aa6b8; }
    .pill      { fill: rgba(47,110,224,0.08); stroke: rgba(47,110,224,0.26); }
    .pillTxt   { fill: #2f6ee0; }
    .spark     { fill: #2f6ee0; }

    /* dark mode */
    @media (prefers-color-scheme: dark) {
      .bg      { fill: #0a0e17; }
      .grid    { stroke: rgba(255,255,255,0.05); }
      .s0      { stop-color: #182238; }
      .s1      { stop-color: #0a0e17; }
      .rim     { stroke: rgba(255,255,255,0.16); }
      .scan    { stroke: rgba(255,255,255,0.10); }
      .orbit   { stroke: rgba(255,255,255,0.13); }
      .dot     { fill: #7d90b6; }
      .ga      { stop-color: #4f8cff; }
      .gb      { stop-color: #a855f7; }
      .gl      { stop-color: rgba(120,160,255,0.42); }
      .t1      { fill: #f4f7fc; }
      .t2      { fill: #8b97ae; }
      .t3      { fill: #55607a; }
      .pill    { fill: rgba(79,140,255,0.11); stroke: rgba(79,140,255,0.34); }
      .pillTxt { fill: #7fa9ff; }
      .spark   { fill: #cbd9ff; }
    }

    .wire line, .wire circle, .wire path {
      fill: none; stroke: url(#gw); stroke-width: 1.3; stroke-linecap: round; opacity: 1;
    }
    .mono { font-family: 'JetBrains Mono', 'SF Mono', Consolas, Menlo, monospace; }
    .sans { font-family: 'Segoe UI', 'Helvetica Neue', Inter, Arial, sans-serif; }
  </style>

  <defs>
    <linearGradient id="gw" x1="0" y1="0" x2="1" y2="1">
      <stop class="ga" offset="0"/>
      <stop class="gb" offset="1"/>
    </linearGradient>
    <radialGradient id="sph" cx="0.38" cy="0.32" r="0.85">
      <stop class="s0" offset="0"/>
      <stop class="s1" offset="1"/>
    </radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop class="ga" offset="0" stop-opacity=".16"/>
      <stop class="gl" offset="1" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".05"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".18"/>
    </linearGradient>
    <pattern id="bgGrid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke-width="1" class="grid"/>
    </pattern>
    <pattern id="pixels" width="9" height="9" patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width="2.1" height="2.1" rx="0.6" class="dot"/>
    </pattern>
    <clipPath id="clipSphere">
      <circle cx="__CX__" cy="__CY__" r="__R__"/>
    </clipPath>
    <clipPath id="clipMesh">
      <rect x="__CX__" y="__BOXY__" width="__BOXRW__" height="__BOXH__"/>
    </clipPath>
  </defs>

  <!-- backdrop -->
  <rect width="__W__" height="__H__" class="bg"/>
  <rect width="__W__" height="__H__" fill="url(#bgGrid)"/>
  <ellipse cx="__CX__" cy="__CY__" rx="360" ry="250" fill="url(#halo)"/>

  <!-- sphere: image (left) becoming mesh (right) -->
  <circle cx="__CX__" cy="__CY__" r="__R__" fill="url(#sph)"/>
  <g clip-path="url(#clipSphere)">
    <rect x="__BOXX__" y="__BOXY__" width="__BOXRW__" height="__BOXH__" fill="url(#pixels)"/>
    <g class="wire" clip-path="url(#clipMesh)">
__MESH__
    </g>
__SPARKS__
    <rect x="__BOXX__" y="__BOXY__" width="__BOXW__" height="__BOXH__" fill="url(#shade)"/>
  </g>

  <!-- forge seam + glow -->
  <ellipse cx="__CX__" cy="__CY__" rx="34" ry="__RSH__" fill="url(#halo)"/>
  <line x1="__CX__" y1="__SEAMT__" x2="__CX__" y2="__SEAMB__"
        stroke="url(#gw)" stroke-width="2.4" stroke-linecap="round"/>

  <!-- contour -->
  <circle cx="__CX__" cy="__CY__" r="__R__" fill="none" stroke-width="1.3" class="rim"/>
  <circle cx="__CX__" cy="__CY__" r="__RS__" fill="none" stroke-width="1"
          stroke-dasharray="3 9" class="scan"/>
  <ellipse cx="__CX__" cy="__CY__" rx="__RO1RX__" ry="52" fill="none" stroke-width="1"
           class="orbit" transform="rotate(-17 __CX__ __CY__)"/>
  <ellipse cx="__CX__" cy="__CY__" rx="__RO2RX__" ry="40" fill="none" stroke-width="1"
           stroke-dasharray="2 8" class="orbit" transform="rotate(14 __CX__ __CY__)"/>

  <!-- wordmark -->
  <rect x="82" y="88" width="252" height="30" rx="15" class="pill"/>
  <text x="208" y="108" text-anchor="middle" class="mono pillTxt"
        font-size="12" letter-spacing="1.7">LOCAL-FIRST &#183; OPEN SOURCE</text>

  <text x="80" y="196" class="sans t1" font-size="86" font-weight="700">Mesh<tspan fill="url(#gw)">Forge</tspan></text>
  <rect x="84" y="216" width="196" height="4" rx="2" fill="url(#gw)"/>
  <text x="80" y="262" class="mono t2" font-size="22">image &#8594; 3D mesh &#183; node workflows</text>
  <text x="80" y="326" class="mono t3" font-size="14" letter-spacing="3">ELECTRON &#183; REACT &#183; FASTAPI &#183; THREE.JS</text>
</svg>
'''


def build():
    box_x = CX - R - 30
    box_y = CY - R - 30
    box_w = 2 * R + 60
    box_h = 2 * R + 60
    mesh_rw = R + 30

    mesh = "\n".join("      " + ln for ln in triangle_mesh_lines())
    spk = "\n".join(
        f'      <circle cx="{f(x)}" cy="{f(y)}" r="3.2" class="spark"/>'
        for x, y in sparks()
    )

    subs = {
        "__W__": f(W),
        "__H__": f(H),
        "__CX__": f(CX),
        "__CY__": f(CY),
        "__R__": f(R),
        "__RS__": f(R + 20),
        "__RSH__": f(R + 26),
        "__SEAMT__": f(CY - R - 14),
        "__SEAMB__": f(CY + R + 14),
        "__RO1RX__": f(R + 48),
        "__RO2RX__": f(R + 30),
        "__BOXX__": f(box_x),
        "__BOXY__": f(box_y),
        "__BOXW__": f(box_w),
        "__BOXH__": f(box_h),
        "__BOXRW__": f(mesh_rw),
        "__MESH__": mesh,
        "__SPARKS__": spk,
    }
    out = TEMPLATE
    for k, v in subs.items():
        out = out.replace(k, v)
    return out


def main():
    out = os.path.join(OUT_DIR, "banner-1600x400.svg")
    with open(out, "w", encoding="utf-8") as fp:
        fp.write(build())
    print(f"written: {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
