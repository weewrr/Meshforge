"""
Generate the English-README banner (assets/banners/minimal-type-1600x400.svg).

Minimal, typography-first composition: centered wordmark with a gradient
accent, a thin rule, tagline and tech stack. Two small wireframe triangles
flank the wordmark as a nod to the mesh pipeline. Self-contained SVG that
adapts to GitHub light/dark via `prefers-color-scheme: dark`.

Run:  python scripts/gen_minimal_banner.py
"""

import math
import os

W, H = 1600, 400
CX = W / 2.0
CY = 200.0
TR = 46.0  # decorative triangle radius

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "banners")
)


def f(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def tri_points(cx, cy, r, rot=0.0):
    pts = []
    for k in range(3):
        a = math.radians(rot + 90 + k * 120)
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    return pts


def tri_path(cx, cy, r, rot=0.0):
    pts = tri_points(cx, cy, r, rot)
    d = "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"
    return d


# Plain string template with __TOKENS__ (kept consistent with gen_banner.py).
TEMPLATE = r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 __W__ __H__" width="__W__" height="__H__"
     role="img" aria-label="MeshForge - local image to 3D mesh generation">
  <title>MeshForge - image to 3D mesh, forged locally</title>

  <style>
    /* default = light (GitHub light theme) */
    .bg      { fill: #fbfcfe; }
    .grid    { stroke: rgba(15,23,42,0.045); }
    .t1      { fill: #0d1526; }
    .t2      { fill: #4a5768; }
    .t3      { fill: #9aa6b8; }
    .pill    { fill: rgba(47,110,224,0.08); stroke: rgba(47,110,224,0.26); }
    .pillTxt { fill: #2f6ee0; }
    .ga      { stop-color: #2f6ee0; }
    .gb      { stop-color: #7c3aed; }
    .tri     { fill: none; stroke: rgba(15,23,42,0.30); }
    .tridot  { fill: #2f6ee0; }

    /* dark mode */
    @media (prefers-color-scheme: dark) {
      .bg      { fill: #0a0e17; }
      .grid    { stroke: rgba(255,255,255,0.05); }
      .t1      { fill: #f4f7fc; }
      .t2      { fill: #8b97ae; }
      .t3      { fill: #55607a; }
      .pill    { fill: rgba(79,140,255,0.11); stroke: rgba(79,140,255,0.34); }
      .pillTxt { fill: #7fa9ff; }
      .ga      { stop-color: #4f8cff; }
      .gb      { stop-color: #a855f7; }
      .tri     { stroke: rgba(255,255,255,0.26); }
      .tridot  { fill: #cbd9ff; }
    }

    .mono { font-family: 'JetBrains Mono', 'SF Mono', Consolas, Menlo, monospace; }
    .sans { font-family: 'Segoe UI', 'Helvetica Neue', Inter, Arial, sans-serif; }
  </style>

  <defs>
    <linearGradient id="gw" x1="0" y1="0" x2="1" y2="0">
      <stop class="ga" offset="0"/>
      <stop class="gb" offset="1"/>
    </linearGradient>
    <pattern id="bgGrid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke-width="1" class="grid"/>
    </pattern>
  </defs>

  <!-- backdrop -->
  <rect width="__W__" height="__H__" class="bg"/>
  <rect width="__W__" height="__H__" fill="url(#bgGrid)"/>

  <!-- flanking wireframe triangles -->
  <path d="__TRI_L__" class="tri" stroke-width="1.3"/>
  <path d="__TRI_LI__" class="tri" stroke-width="1" stroke-dasharray="2 6"/>
  <circle cx="__TRI_LX__" cy="__CY__" r="2.6" class="tridot"/>

  <path d="__TRI_R__" class="tri" stroke-width="1.3"/>
  <path d="__TRI_RI__" class="tri" stroke-width="1" stroke-dasharray="2 6"/>
  <circle cx="__TRI_RX__" cy="__CY__" r="2.6" class="tridot"/>

  <!-- wordmark -->
  <rect x="__PILLX__" y="104" width="252" height="30" rx="15" class="pill"/>
  <text x="__CX__" y="124" text-anchor="middle" class="mono pillTxt"
        font-size="12" letter-spacing="1.7">LOCAL-FIRST &#183; OPEN SOURCE</text>

  <text x="__CX__" y="232" text-anchor="middle" class="sans t1"
        font-size="96" font-weight="700" letter-spacing="6">MESH<tspan fill="url(#gw)">FORGE</tspan></text>
  <rect x="__RULEX__" y="258" width="220" height="4" rx="2" fill="url(#gw)"/>

  <text x="__CX__" y="306" text-anchor="middle" class="mono t2" font-size="21">image &#8594; 3D mesh &#183; node workflows</text>
  <text x="__CX__" y="350" text-anchor="middle" class="mono t3" font-size="13" letter-spacing="3">ELECTRON &#183; REACT &#183; FASTAPI &#183; THREE.JS</text>
</svg>
'''


def build():
    subs = {
        "__W__": f(W),
        "__H__": f(H),
        "__CX__": f(CX),
        "__CY__": f(CY),
        "__TRI_LX__": f(CX - 640),
        "__TRI_RX__": f(CX + 640),
        "__TRI_L__": tri_path(CX - 640, CY, TR, rot=14),
        "__TRI_R__": tri_path(CX + 640, CY, TR, rot=-14),
        "__TRI_LI__": tri_path(CX - 640, CY, TR * 0.62, rot=14),
        "__TRI_RI__": tri_path(CX + 640, CY, TR * 0.62, rot=-14),
        "__PILLX__": f(CX - 126),
        "__RULEX__": f(CX - 110),
    }
    out = TEMPLATE
    for k, v in subs.items():
        out = out.replace(k, v)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "minimal-type-1600x400.svg")
    with open(out, "w", encoding="utf-8") as fp:
        fp.write(build())
    print(f"written: {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
