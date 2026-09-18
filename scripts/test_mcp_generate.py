"""Meshforge MCP 端到端测试：通过 MCP 服务器驱动一次真实的模型生成。

拉起 server/mcp_server.py，初始化 MCP 会话，提交 meshforge_generate_from_image，
并轮询 meshforge_get_job_status 直到任务结束，打印每次轮询结果。

前提：已构建并启动过一次应用（从而 server/.venv 存在、所需模型已下载）。

用法：
  python scripts/test_mcp_generate.py <image_path> [generator_id] [extra params...]

示例：
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
# MCP server 依赖后端虚拟环境（torch 等只装在那里），因此不能直接用系统 python。
PY = ROOT / "server" / ".venv" / "Scripts" / "python.exe"
SERVER = ROOT / "server" / "mcp_server.py"


async def send(writer, obj: dict) -> None:
    """向 MCP 子进程 stdin 写一行 JSON-RPC（末尾补换行作为帧分隔）。"""
    writer.write((json.dumps(obj) + "\n").encode("utf-8"))
    await writer.drain()


async def reply(proc, timeout: float = 60.0) -> dict:
    """读一行 JSON-RPC 响应。

    默认 60 秒超时——模型相关的调用可能很久（生成阶段由工具自己异步返回
    job_id，所以这里等待的主要是握手与轻量调用）。

    Args:
        proc: 子进程句柄。
        timeout: 单行读取的超时秒数。

    Returns:
        解析后的响应对象；读到 EOF 时返回空字典。
    """
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
    return json.loads(line) if line else {}


def text_of(msg: dict) -> str:
    """从 MCP 响应的 content 数组里拼出纯文本（忽略非 text 类型的内容块）。"""
    content = msg.get("result", {}).get("content", [])
    return "".join(c.get("text", "") for c in content)


async def teardown(proc) -> None:
    """先关 stdin 再终止进程，避免留下 unclosed-transport 警告。"""
    # 关键顺序：先 close+wait_closed 让 asyncio 传输层正常收尾，再 kill。
    if proc.stdin:
        proc.stdin.close()
        await proc.stdin.wait_closed()
    proc.kill()
    await proc.wait()


async def main() -> int:
    """脚本主流程：解析参数、拉起 MCP 子进程、走完 generate→poll 全流程并清理。"""
    parser = argparse.ArgumentParser(description="Meshforge MCP end-to-end generation test")
    parser.add_argument("image_path", help="Absolute path to the input image")
    parser.add_argument("generator_id", nargs="?", default="hunyuan3d-2-mini")
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--guidance", type=float, default=None)
    # octree 档次与生成器支持的取值对齐；384 在 6GB 显卡上有 OOM 风险。
    parser.add_argument("--octree", type=int, default=None, choices=(256, 320, 384))
    parser.add_argument("--no-remove-base", action="store_true", help="keep the support disc")
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

    # MCP 握手：initialize → notifications/initialized。
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

    # 只把用户显式给出的可选参数塞进 arguments，避免覆盖工具侧默认值。
    gen_args = {
        "image_path": str(image_path),
        "generator_id": args.generator_id,
        "steps": args.steps,
        "seed": args.seed,
    }
    if args.guidance is not None:
        gen_args["guidance"] = args.guidance
    if args.octree is not None:
        gen_args["octree"] = args.octree
    if args.no_remove_base:
        gen_args["remove_base"] = False
    print(f"== generate: {args.generator_id} steps={args.steps} seed={args.seed} ==")
    await send(proc.stdin, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "meshforge_generate_from_image", "arguments": gen_args},
    })
    gen_text = text_of(await reply(proc))
    print(gen_text)
    # 工具返回的自由文本里带 `job_id=<hex>`，用正则抠出来。
    match = re.search(r"job_id=([0-9a-f]+)", gen_text)
    if not match:
        print("!! could not parse job_id from response")
        await teardown(proc)
        return 1
    job_id = match.group(1)

    print(f"== polling {job_id} ==")
    # 轮询直到超时或终态；3 秒间隔足以覆盖生成进度的更新频率。
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
