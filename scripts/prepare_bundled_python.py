#!/usr/bin/env python3
"""准备随包分发的自包含 Python 运行时（打包前置步骤）。

背景：打包态由 `electron/main/python-bridge.ts` 拉起后端，但
`electron-builder.yml` 刻意排除了开发机的 `server/.venv`（它绑定本机
miniconda 路径、且不自带 `python3xx.dll`，换机器必然失效）。因此需要在
`server/.runtime/` 里放一份**可移植**的解释器 + 后端依赖，让安装包在没有
Python 的用户机器上也能直接跑起来（含 `modelscope` 下载 CLI）。

做四件事：
  1. 下载官方 embeddable Python（Windows amd64）并解包到 `server/.runtime/python`；
  2. 改写 `python3xx._pth` 解除 `import site` 注释，让 site-packages 生效；
  3. 引导安装 pip；
  4. 按 `server/requirements.txt` 安装后端依赖（含 modelscope）。

产物 `server/.runtime/` 已被 `.gitignore` 排除，由 electron-builder 的
extraResources 随包携带；`python-bridge` 会优先使用其中的解释器，
`model_downloads._modelscope_cli()` 则通过 `sys.prefix/Scripts/modelscope.exe` 命中。

用法：
    server/.venv/Scripts/python.exe scripts/prepare_bundled_python.py
    server/.venv/Scripts/python.exe scripts/prepare_bundled_python.py --force
    server/.venv/Scripts/python.exe scripts/prepare_bundled_python.py --version 3.13.12
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = REPO_ROOT / 'server'
RUNTIME_DIR = SERVER_DIR / '.runtime'
PYTHON_DIR = RUNTIME_DIR / 'python'
REQUIREMENTS = SERVER_DIR / 'requirements.txt'

# 与后端 venv 保持同一小版本线（3.13.x），保证 wheel 兼容。
DEFAULT_VERSION = '3.13.12'

# 国内镜像优先，python.org 兜底。
_EMBED_URLS = (
    'https://mirrors.huaweicloud.com/python/{v}/python-{v}-embed-amd64.zip',
    'https://www.python.org/ftp/python/{v}/python-{v}-embed-amd64.zip',
)
_GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'
_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'


def _download(url: str, dest: Path) -> bool:
    """下载 url 到 dest；成功返回 True，失败打印原因并返回 False。"""
    print(f'    ↓ {url}')
    try:
        with urllib.request.urlopen(url, timeout=180) as resp, dest.open('wb') as fh:
            shutil.copyfileobj(resp, fh)
    except Exception as exc:  # noqa: BLE001 - 换镜像重试，需吞掉所有网络异常
        print(f'      ✗ {type(exc).__name__}: {exc}')
        return False
    return True


def _download_embeddable(version: str, dest: Path) -> None:
    """按镜像顺序尝试下载 embeddable 包，全部失败则抛错。"""
    for tpl in _EMBED_URLS:
        if _download(tpl.format(v=version), dest):
            return
    raise SystemExit(f'无法下载 Python {version} embeddable 包，请检查网络或改用 --version 指定其他版本。')


def _unblock_site_packages() -> None:
    """把 `Lib\\site-packages` 写进 ._pth 并解除 `import site` 注释。

    embeddable 发行版默认隔离 site，pip 装出来的包不会被 import。
    """
    pth_files = list(PYTHON_DIR.glob('python*._pth'))
    if not pth_files:
        raise SystemExit(f'未找到 ._pth 文件，{PYTHON_DIR} 可能不是有效的 embeddable 布局。')
    pth = pth_files[0]
    lines = [ln for ln in pth.read_text(encoding='utf-8').splitlines() if ln.strip() != '#import site']
    for required in ('Lib\\site-packages', 'import site'):
        if required not in lines:
            lines.append(required)
    pth.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'    ✓ {pth.name} 已放开 site-packages')


def _run(cmd: list[str], **kw) -> None:
    """跑一条外部命令，失败即抛错（准备工作不能静默半成品）。"""
    print(f'    $ {" ".join(cmd)}')
    subprocess.run(cmd, check=True, **kw)


def main() -> int:
    ap = argparse.ArgumentParser(description='准备随包分发的自包含 Python 运行时')
    ap.add_argument('--version', default=DEFAULT_VERSION, help=f'Python 版本（默认 {DEFAULT_VERSION}）')
    ap.add_argument('--force', action='store_true', help='已存在时也重新准备')
    args = ap.parse_args()

    py_exe = PYTHON_DIR / 'python.exe'

    if py_exe.is_file() and not args.force:
        print(f'运行时已存在：{PYTHON_DIR}\n如需重建请加 --force。')
        return 0

    if RUNTIME_DIR.exists():
        print(f'清理旧运行时：{RUNTIME_DIR}')
        shutil.rmtree(RUNTIME_DIR)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    print(f'\n[1/4] 下载并解包 Python {args.version} embeddable')
    zip_path = RUNTIME_DIR / 'python-embed.zip'
    _download_embeddable(args.version, zip_path)
    PYTHON_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(PYTHON_DIR)
    zip_path.unlink()
    print(f'    ✓ 解包到 {PYTHON_DIR}')

    print('\n[2/4] 放开 import site')
    _unblock_site_packages()

    if not py_exe.is_file():
        raise SystemExit(f'解包后未找到解释器：{py_exe}')

    print('\n[3/4] 引导安装 pip')
    get_pip = RUNTIME_DIR / 'get-pip.py'
    if not _download(_GET_PIP_URL, get_pip):
        raise SystemExit('无法下载 get-pip.py，请检查网络。')
    _run([str(py_exe), str(get_pip), '--no-warn-script-location', '-i', _PIP_INDEX])
    get_pip.unlink()

    print('\n[4/4] 安装后端依赖（含 modelscope）')
    _run([
        str(py_exe), '-m', 'pip', 'install',
        '--no-warn-script-location',
        '-r', str(REQUIREMENTS),
        '-i', _PIP_INDEX,
    ])

    print('\n冒烟检查')
    _run([str(py_exe), '-c', 'import fastapi, uvicorn, pydantic, modelscope; print("runtime ok:", modelscope.__version__)'])

    modelscope_exe = PYTHON_DIR / 'Scripts' / 'modelscope.exe'
    if modelscope_exe.is_file():
        print(f'    ✓ modelscope CLI: {modelscope_exe}')
    else:
        print(f'    ! 未找到 {modelscope_exe}，下载按钮在打包态可能不可用。')

    print(f'\n完成：{PYTHON_DIR}')
    print('下一步：npm run build && npm run pack  （electron-builder 会带上 server/.runtime）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
