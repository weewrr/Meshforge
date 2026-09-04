"""Smoke-test the Meshforge MCP server over stdio (no MCP client SDK needed).

Spawns server/mcp_server.py and drives the JSON-RPC handshake by hand:
  1. initialize
  2. notifications/initialized
  3. tools/list
  4. If the FastAPI backend is reachable on :8766: tools/call for
     meshforge_health and meshforge_list_generators.

Usage:
  python scripts/test_mcp_stdio.py                 # protocol + tools/list only
  python scripts/test_mcp_stdio.py --call-generators   # also exercise the two read-only tools
"""

import argparse
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / "server" / ".venv" / "Scripts" / "python.exe"
SERVER = ROOT / "server" / "mcp_server.py"
API_BASE = "http://127.0.0.1:8766"


async def read_reply(proc: asyncio.subprocess.Process, timeout: float = 30.0) -> dict | None:
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
    return json.loads(line) if line else None


def backend_up() -> bool:
    try:
        with urllib.request.urlopen(f"{API_BASE}/health", timeout=2) as resp:  # noqa: S310
            return resp.status == 200
    except Exception:
        return False


async def main() -> int:
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

    await send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    print("== tools/list ==")
    await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = await read_reply(proc)
    names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
    if not names:
        print("!! tools/list returned no tools"); return 1
    print("tools:", ", ".join(names))

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
                print(text if text else json.dumps(reply, ensure_ascii=False)[:400])

    writer.close()
    await proc.wait()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
