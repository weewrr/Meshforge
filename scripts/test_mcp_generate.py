"""End-to-end Meshforge MCP test: drive a real generation through the MCP server.

Spawns server/mcp_server.py, initializes the MCP session, submits
meshforge_generate_from_image with the given image and polls
meshforge_get_job_status until the job finishes, printing every poll result.

Usage:
  python scripts/test_mcp_generate.py <image_path> [generator_id] [extra params...]

Examples:
  python scripts/test_mcp_generate.py server/workspace/uploads/test_apple.png
  python scripts/test_mcp_generate.py some.png hunyuan3d-2-mini --steps 10 --seed 42
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / "server" / ".venv" / "Scripts" / "python.exe"
SERVER = ROOT / "server" / "mcp_server.py"


async def send(writer, obj: dict) -> None:
    writer.write((json.dumps(obj) + "\n").encode("utf-8"))
    await writer.drain()


async def reply(proc, timeout: float = 60.0) -> dict:
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
    return json.loads(line) if line else {}


def text_of(msg: dict) -> str:
    content = msg.get("result", {}).get("content", [])
    return "".join(c.get("text", "") for c in content)


async def teardown(proc) -> None:
    """Close stdin then terminate, so no unclosed-transport warnings remain."""
    if proc.stdin:
        proc.stdin.close()
        await proc.stdin.wait_closed()
    proc.kill()
    await proc.wait()


async def main() -> int:
    parser = argparse.ArgumentParser(description="Meshforge MCP end-to-end generation test")
    parser.add_argument("image_path", help="Absolute path to the input image")
    parser.add_argument("generator_id", nargs="?", default="hunyuan3d-2-mini")
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args()

    image_path = Path(args.image_path).resolve()
    if not image_path.is_file():
        print(f"!! image not found: {image_path}")
        return 1

    proc = await asyncio.create_subprocess_exec(
        str(PY), str(SERVER),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    await send(proc.stdin, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "meshforge-e2e", "version": "0.1"},
        },
    })
    print("initialize:", await reply(proc))
    await send(proc.stdin, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    gen_args = {
        "image_path": str(image_path),
        "generator_id": args.generator_id,
        "steps": args.steps,
        "seed": args.seed,
    }
    print(f"== generate: {args.generator_id} steps={args.steps} seed={args.seed} ==")
    await send(proc.stdin, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "meshforge_generate_from_image", "arguments": gen_args},
    })
    gen_text = text_of(await reply(proc))
    print(gen_text)
    match = re.search(r"job_id=([0-9a-f]+)", gen_text)
    if not match:
        print("!! could not parse job_id from response")
        await teardown(proc)
        return 1
    job_id = match.group(1)

    print(f"== polling {job_id} ==")
    deadline = asyncio.get_event_loop().time() + args.timeout
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(3)
        await send(proc.stdin, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "meshforge_get_job_status", "arguments": {"job_id": job_id}},
        })
        status_text = text_of(await reply(proc))
        print(status_text)
        if "state=succeeded" in status_text or "state=failed" in status_text or "state=cancelled" in status_text:
            await teardown(proc)
            return 0 if "state=succeeded" in status_text else 1
    print("!! timed out")
    await teardown(proc)
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
