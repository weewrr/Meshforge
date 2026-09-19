"""Meshforge 的 MCP Server。

把 Meshforge 的图片转 3D 流水线作为 MCP 工具暴露给外部智能体
（Claude Desktop、Codex CLI、Cursor 等），基于 FastMCP SDK 实现。

需要 Meshforge 的 FastAPI 后端已在 :8766 上运行——可启动 Meshforge 桌面应用，
或手动运行：

    cd server && .venv\\Scripts\\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8766

真正的（GPU）生成走 :8767 上的 Hunyuan3D-2-mini 推理服务
（搭建方式见 README 部署章节）。

先在后端 venv 里安装可选的 MCP 依赖：

    server/.venv/Scripts/python.exe -m pip install -r server/requirements-mcp.txt

Claude Desktop 配置（~/.config/claude/claude_desktop_config.json）：

    {
      "mcpServers": {
        "meshforge": {
          "command": "C:/Users/HELLOWORLD/Desktop/oss/meshforge/server/.venv/Scripts/python.exe",
          "args": ["C:/Users/HELLOWORLD/Desktop/oss/meshforge/server/mcp_server.py"]
        }
      }
    }

Codex CLI（config.toml）：

    [mcp_servers.meshforge]
    command = "C:/Users/HELLOWORLD/Desktop/oss/meshforge/server/.venv/Scripts/python.exe"
    args = ["C:/Users/HELLOWORLD/Desktop/oss/meshforge/server/mcp_server.py"]
"""

import json
import mimetypes
import os
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field

# mcp 2.x 把 FastMCP 改名为 MCPServer；保留回退分支，使 1.x 与 2.x 都能跑。
try:
    from mcp.server.mcpserver import MCPServer as _MCP  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - mcp 1.x
    from mcp.server.fastmcp import FastMCP as _MCP  # type: ignore[no-redef]

# 端口跟随桌面应用实际使用的端口（MESHFORGE_API_PORT）；独立运行时默认 8766。
API_BASE = f"http://127.0.0.1:{os.environ.get('MESHFORGE_API_PORT') or 8766}"

# 与 server/config.py 同一规则：MESHFORGE_DATA_DIR 指向数据目录时，
# workspace（及其模型产物）也搬了过去。
_DATA_ROOT = Path(os.environ.get("MESHFORGE_DATA_DIR") or Path(__file__).resolve().parent)

# /files/<job_id>/model.glb 实际落在 <数据目录>/workspace/<job_id>/model.glb。
WORKSPACE_DIR = _DATA_ROOT / "workspace"

# 与 server/main.py 同一规则：后端把生效的 API token 持久化在数据目录的
# .api-token（workspace 之外，不会被 /files 静态挂载公开）。本机同用户进程
# 读取它即可通过认证。
def _load_api_token() -> str:
    try:
        return (_DATA_ROOT / ".api-token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


_API_TOKEN = _load_api_token()

# 与 server/routers/generate.py 里的 ALLOWED_IMAGE_EXTS 保持同一份白名单。
ALLOWED_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"}

mcp = _MCP("meshforge")

ImagePath = Annotated[str, Field(description="Absolute path to the input image on disk (png/jpg/jpeg/webp/gif/bmp/avif).")]


async def _request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response:
    """统一的请求辅助函数：把连接/HTTP 错误转换为可读的报错信息。"""
    # 后端启用了本地 API token 认证；自动附上 Authorization 头。
    headers = dict(kwargs.pop("headers", None) or {})
    if _API_TOKEN:
        headers.setdefault("Authorization", f"Bearer {_API_TOKEN}")
    kwargs["headers"] = headers
    try:
        r = await client.request(method, url, **kwargs)
        r.raise_for_status()
        return r
    except httpx.ConnectError as exc:
        raise RuntimeError(
            f"Cannot connect to the Meshforge backend at {API_BASE}. "
            "Start the Meshforge desktop app (or run uvicorn main:app on :8766) and retry."
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Meshforge API error {exc.response.status_code}: {exc.response.text[:300]}"
        ) from exc


def _result_url_to_local_path(result_url: str) -> str:
    """Map a served /files/... URL back to the absolute file path on disk."""
    if not result_url or not result_url.startswith("/files/"):
        return ""
    candidate = (WORKSPACE_DIR / result_url[len("/files/"):]).resolve()
    return str(candidate) if candidate.is_file() else ""


@mcp.tool()
async def meshforge_health() -> str:
    """Check whether the Meshforge backend is reachable and healthy. Call this first to diagnose connection problems."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await _request(client, "GET", f"{API_BASE}/health")
        data = r.json()
    return f"Backend healthy: {data.get('status')} ({data.get('app')}) at {API_BASE}"


@mcp.tool()
async def meshforge_list_generators() -> str:
    """List the 3D generators registered in Meshforge (hunyuan3d-2-mini for GPU generation), their load state and accepted parameters."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await _request(client, "GET", f"{API_BASE}/generators")
        generators = r.json()
    if not generators:
        return "No generators registered."
    lines = []
    for g in generators:
        params = ", ".join(
            f"{p['id']}={p.get('default', '?')}" for p in (g.get("params") or [])
        ) or "none"
        lines.append(
            f"- {g['id']} ({g.get('display_name', g['id'])}), loaded={g.get('is_loaded', False)}, "
            f"{g.get('kind', '?')}: {g.get('input', '?')}->{g.get('output', '?')}, params: {params}"
        )
    return "\n".join(lines)


@mcp.tool()
async def meshforge_generate_from_image(
    image_path: ImagePath,
    generator_id: Annotated[
        str,
        Field(
            description=(
                "Generator to use. Built-in: hunyuan3d-2-mini (real GPU generation, "
                "needs the :8767 inference service)."
            )
        ),
    ] = "hunyuan3d-2-mini",
    steps: Annotated[int, Field(description="Hunyuan sampling steps.", ge=5, le=100)] | None = None,
    guidance: Annotated[float, Field(description="Hunyuan guidance strength. 4-7 is the sweet spot.", ge=1.0, le=10.0)] | None = None,
    octree: Annotated[
        Literal[256, 320, 384] | None,
        Field(description="Volumetric reconstruction resolution. 320 recommended on 6 GB VRAM; 384 risks OOM."),
    ] = None,
    seed: Annotated[int, Field(description="Random seed; -1 for random, fixed seed reproduces a result.", ge=-1)] | None = None,
    remove_base: Annotated[bool, Field(description="Remove the support disc hallucinated under the object.")] | None = None,
) -> str:
    """Generate a 3D mesh from a 2D image file. Submits a background job and returns a job_id — poll meshforge_get_job_status until it succeeds or fails."""
    path = Path(image_path)
    if not path.is_file():
        return f"Image file not found: {image_path}"
    ext = path.suffix.lstrip(".").lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        return f"Unsupported image format '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_IMAGE_EXTS))}"

    params: dict[str, object] = {}
    for key in ("steps", "guidance", "octree", "seed"):
        value = locals().get(key)
        if value is not None:
            params[key] = value
    if remove_base is not None:
        params["remove_base"] = 1 if remove_base else 0

    mime = mimetypes.guess_type(image_path)[0] or "image/png"
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await _request(
            client,
            "POST",
            f"{API_BASE}/generate/from-image",
            files={"image": (path.name, path.read_bytes(), mime)},
            data={"generator_id": generator_id, "params_json": json.dumps(params)},
        )
        job_id = r.json()["job_id"]
    return (
        f"Generation started. job_id={job_id}, generator={generator_id}\n"
        "Poll meshforge_get_job_status with that job_id until state is succeeded or failed."
    )


@mcp.tool()
async def meshforge_get_job_status(job_id: Annotated[str, Field(description="Job ID returned by meshforge_generate_from_image.")]) -> str:
    """Poll the status of a generation job (state: pending/running/succeeded/failed/cancelled). On success it reports the served URL and the absolute path of the resulting .glb on disk."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await _request(client, "GET", f"{API_BASE}/generate/jobs/{job_id}")
        s = r.json()
    parts = [f"state={s.get('state')}", f"progress={s.get('progress', 0):.0%}"]
    if s.get("message"):
        parts.append(f"message={s['message']}")
    if s.get("result_url"):
        parts.append(f"url={s['result_url']}")
        local = _result_url_to_local_path(s["result_url"])
        if local:
            parts.append(f"file={local}")
    if s.get("error"):
        parts.append(f"error={s['error']}")
    return " | ".join(parts)


@mcp.tool()
async def meshforge_cancel_job(job_id: Annotated[str, Field(description="Job ID to cancel.")]) -> str:
    """请求协作式取消一个正在运行的生成任务。"""
    async with httpx.AsyncClient(timeout=10.0) as client:
        await _request(client, "POST", f"{API_BASE}/generate/jobs/{job_id}/cancel")
    return f"Cancellation requested for job {job_id}."


@mcp.tool()
async def meshforge_import_mesh(path: Annotated[str, Field(description="Absolute path to the mesh file on disk (.glb/.obj/.stl/.ply).")]) -> str:
    """Import an existing mesh file from disk so the Meshforge viewer/library can load it. Non-GLB formats are converted to GLB on the backend."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await _request(client, "POST", f"{API_BASE}/optimize/import-by-path", json={"path": path})
        data = r.json()
    return f"Mesh imported. URL: {data.get('url', '')}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
