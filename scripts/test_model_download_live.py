#!/usr/bin/env python3
"""联网冒烟：真实跑一次模型下载的 SSE 流（只下 README.md，不拉整仓权重）。

验证的是后端 `/model-services/download/{key}` 背后那条链路：
modelscope CLI 探测 → 子进程拉起 → 输出转 SSE → banner 过滤 → done 事件 → 落盘。

做法：把 `hunyuan3d-2` 档案临时改成只下 `README.md`（约 9.5 KB）、落点指向临时
目录，再完整消费 `_modelscope_download_stream`。因此**不会**污染真实 models 根，
也不会下载数 GB 权重。

用法：
    server/.venv/Scripts/python.exe scripts/test_model_download_live.py

前置：本机可访问 ModelScope（需要网络），且已安装 modelscope
（`pip install -r server/requirements.txt`）。
"""

import asyncio
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'server'))

import model_downloads as md  # noqa: E402
import routers.model_downloads as rmd  # noqa: E402


async def main() -> int:
    """跑通一次下载并打印逐条 SSE 事件；返回进程退出码。"""
    tmp = Path(tempfile.mkdtemp(prefix='mf_e2e_models_'))
    md.MODELS_ROOT = tmp
    rmd.MODELS_ROOT = tmp

    # 只取 README.md，避免拉整个权重仓库。
    md._PROFILES['hunyuan3d-2'] = md.ModelProfile(
        key='hunyuan3d-2',
        label='Hunyuan3D-2',
        local_rel='Hunyuan3D-2',
        modelscope_id='Tencent-Hunyuan/Hunyuan3D-2',
        files=('README.md',),
    )

    print(f'临时 models 根：{tmp}')
    print(f'modelscope 版本：{md.modelscope_version()}')
    print('--- SSE 事件流 ---')

    events = 0
    saw_banner = False
    done = False
    async for frame in rmd._modelscope_download_stream('hunyuan3d-2'):
        line = frame.strip()
        print('SSE>', line[:180])
        events += 1
        # banner 一旦漏进 SSE，前端进度区就会刷出一大块 ASCII art。
        if ".-')" in line or 'OO )' in line:
            saw_banner = True
        if '"done"' in line:
            done = True
            break
        if '"error"' in line:
            print('!!! 出现 error 事件')
            break

    files = [p for p in tmp.rglob('*') if p.is_file()]
    print('--- 结果 ---')
    print(f'事件数            : {events}')
    print(f'banner 泄漏到前端 : {saw_banner}')
    print(f'done 事件         : {done}')
    for f in files:
        print(f'落盘              : {f.relative_to(tmp)}  {f.stat().st_size} B')

    ok = done and not saw_banner and bool(files)
    print(f'判定              : {"PASS" if ok else "FAIL"}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
