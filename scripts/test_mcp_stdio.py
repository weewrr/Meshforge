"""对 Meshforge MCP server 做 stdio 冒烟测试（不需要 MCP 客户端 SDK）。

拉起 server/mcp_server.py，手工驱动 JSON-RPC 握手：
  1. initialize
  2. notifications/initialized
  3. tools/list
  4. 若 FastAPI 后端在 :8766 可达，则再 tools/call 调
     meshforge_health 与 meshforge_list_generators。

用法：
  python scripts/test_mcp_stdio.py                 # 仅协议 + tools/list
  python scripts/test_mcp_stdio.py --call-generators   # 附带调用两个只读工具
"""

import argparse
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# MCP server 依赖后端虚拟环境（torch 等只装在那里），不能直接用系统 python。
PY = ROOT / "server" / ".venv" / "Scripts" / "python.exe"
SERVER = ROOT / "server" / "mcp_server.py"
API_BASE = "http://127.0.0.1:8766"


async def read_reply(proc: asyncio.subprocess.Process, timeout: float = 30.0) -> dict | None:
    """读一行 JSON-RPC 响应；读到 EOF 返回 None。

    Args:
        proc: 子进程句柄。
        timeout: 单行读取超时秒数。

    Returns:
        解析后的响应对象；EOF 时为 None。
    """
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
    return json.loads(line) if line else None


def backend_up() -> bool:
    """探测 :8766 上的 FastAPI 后端是否已就绪（2 秒超时，任何异常都视为未就绪）。"""
    try:
        with urllib.request.urlopen(f"{API_BASE}/health", timeout=2) as resp:  # noqa: S310
            return resp.status == 200
    except Exception:
        return False


async def main() -> int:
    """脚本主流程：拉起 MCP 子进程，逐条发送握手请求，按需调用只读工具，最后清理。"""
    parser = argparse.ArgumentParser(description="Meshforge MCP stdio smoke test")
    parser.add_argument(
        "--call-generators", action="store_true",
        help="also call meshforge_health / meshforge_list_generators (backend must be up on 8766)",
    )
    args = parser.parse_args()

    proc = await asyncio.create_subprocess_exec(
        str(PY), str(SERVER),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    writer = proc.stdin

    async def send(obj: dict) -> None:
        """写一行 JSON-RPC 到子进程 stdin（闭包复用外层 writer）。"""
        writer.write((json.dumps(obj) + "\n").encode("utf-8"))
        await writer.drain()

    print("== initialize ==")
    await send({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "meshforge-stdio-smoke", "version": "0.1"},
        },
    })
    init = await read_reply(proc)
    if not init:
        print("!! no reply to initialize"); return 1
    print(f"server: {init.get('result', {}).get('serverInfo')}  "
          f"protocol: {init.get('result', {}).get('protocolVersion')}")

    # 按 MCP 规范补一条 initialized 通知，之后的请求才会被正常受理。
    await send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    print("== tools/list ==")
    await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = await read_reply(proc)
    names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
    if not names:
        print("!! tools/list returned no tools"); return 1
    print("tools:", ", ".join(names))

    # 可选分支：后端在线时额外验证两个只读工具的返回值。
    if args.call_generators:
        up = backend_up()
        print(f"== backend on :8766 -> {'UP' if up else 'DOWN (skipping tools/call)'} ==")
        if up:
            for tool, tool_args in (
                ("meshforge_health", {}),
                ("meshforge_list_generators", {}),
            ):
                print(f"--- call {tool} ---")
                await send({
                    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": tool, "arguments": tool_args},
                })
                reply = await read_reply(proc)
                content = reply.get("result", {}).get("content", [])
                text = "".join(c.get("text", "") for c in content)
                # 文本为空时退化为打印原始 JSON（截断到 400 字符便于阅读）。
                print(text if text else json.dumps(reply, ensure_ascii=False)[:400])

    writer.close()
    await proc.wait()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
