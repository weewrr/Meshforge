"""MeshForge InstantMesh 推理服务（独立进程）。

承载 ``generators/`` 中 InstantMesh 生成器的**模型侧**。
与 Hunyuan 服务（在进程内常驻一条 pipeline）不同，InstantMesh 官方 CLI
（``D:/github/InstantMesh/run.py``）每次调用都会完整加载整套栈——
Zero123++ 扩散模型 + LRM 重建模型——所以本服务只是一个 HTTP 外壳：
拉起那个 CLI 子进程，再把产出的 ``.obj`` 转成 GLB 字节返回给 MeshForge。

  GET  /health   -> {"status": "ok", "model": ..., "loaded": bool}
  POST /generate -> multipart：图片文件 + seed/diffusion_steps
                    返回生成的网格（GLB 字节）

它必须运行在 *instantmesh* 那个 virtualenv 里（Python 3.11 + torch cu12x +
InstantMesh 依赖 + 编译好的 nvdiffrast CUDA 扩展），**不能**跑在轻量的
MeshForge 服务端 venv 中。典型启动方式：

  D:/github/instantmesh-venv/Scripts/python.exe instantmesh_service.py
    --model-root D:/github/models        # InstantMesh/ 权重的父目录
    --repo D:/github/InstantMesh         # run.py + configs/
    --config configs/instant-mesh-large.yaml   # 模型档位
    --port 8770                          # large
    --port 8777                          # base（低显存）

服务跑起来后，把对应生成器的 URL 环境变量指向它即可。

模型定位相关环境变量（同时暴露为命令行参数）：
  INSTANTMESH_MODEL_ROOT  权重父目录（默认 D:/github/models）
  INSTANTMESH_REPO        InstantMesh 仓库根目录（默认 D:/github/InstantMesh）
  INSTANTMESH_CONFIG      config 相对仓库的路径（默认
                          configs/instant-mesh-large.yaml；低显存档用
                          configs/instant-mesh-base.yaml）
  INSTANTMESH_PY          instantmesh venv 的 python 可执行文件（供安装脚本用）

显存说明：默认档（instant-mesh-large，flexicubes，fp32 重建 / fp16 扩散）
峰值约 11 GB —— 6 GB 显卡（如 RTX 4050）会在重建阶段 OOM。改用 *base* 档
（instant-mesh-base.yaml，端口 8777）可以压低占用，但仍需 ~≥8 GB。
官方没有提供低显存开关。
"""

import argparse
import io
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import File, Form, UploadFile
from fastapi import FastAPI
from fastapi.responses import Response

logger = logging.getLogger('instantmesh')

_START = time.time()

DEFAULT_DIFFUSION_STEPS = 30
DEFAULT_SEED = 42  # run.py default; >=0 is reproducible here


def _model_root() -> str:
    """权重父目录；未配置时回退到本机默认路径。"""
    return os.environ.get('INSTANTMESH_MODEL_ROOT', r'D:\github\models').strip()


def _repo_root() -> Path:
    """InstantMesh 仓库根目录（内含 run.py 与 configs/）。"""
    return Path(os.environ.get('INSTANTMESH_REPO', r'D:\github\InstantMesh').strip())


def _resolve_config(repo: Path) -> Path:
    """把 INSTANTMESH_CONFIG 解析成绝对路径。

    Raises:
        RuntimeError: config 文件不存在（通常是 --config 写错或仓库没拉全）。
    """
    rel = os.environ.get('INSTANTMESH_CONFIG', 'configs/instant-mesh-large.yaml').strip()
    cfg = repo / rel
    if not cfg.is_file():
        raise RuntimeError(f'config not found: {cfg}')
    return cfg


def _write_local_config(cfg: Path, model_root: str, tmp: Path) -> Path:
    """写一份临时 config，把权重路径改成本地文件。

    仓库里的 config 引用的是 ``ckpts/...`` 相对路径（并且会回退到被墙的
    HF hub 下载）。这里把 ``infer_config.unet_path`` / ``model_path`` 覆写成
    ``<model_root>/InstantMesh/`` 下的绝对路径，并且**保持同名 basename**——
    因为 run.py 会用它推导 checkpoint 文件名
    （``<name>.replace('-','_')+'.ckpt'``）与输出子目录名。

    Args:
        cfg: 原始 config 路径。
        model_root: 权重父目录。
        tmp: 临时目录（改写后的 config 落在这里）。

    Returns:
        改写后的 config 路径。
    """
    import omegaconf

    cfg_c = omegaconf.OmegaConf.load(cfg)
    weights = Path(model_root) / 'InstantMesh'
    stem = cfg.stem  # e.g. instant-mesh-large
    # run.py 把 '-' 换成 '_' 后找 ckpt，这里必须沿用同一规则。
    ckpt = weights / f'{stem.replace("-", "_")}.ckpt'
    unet = weights / 'diffusion_pytorch_model.bin'
    if not ckpt.is_file():
        raise RuntimeError(f'checkpoint not found: {ckpt} (please download InstantMesh weights)')
    if not unet.is_file():
        raise RuntimeError(f'checkpoint not found: {unet} (please download InstantMesh weights)')
    if 'infer_config' not in cfg_c:
        raise RuntimeError(f'config {cfg} has no infer_config')
    cfg_c.infer_config.unet_path = str(unet)
    cfg_c.infer_config.model_path = str(ckpt)
    out = tmp / cfg.name
    omegaconf.OmegaConf.save(cfg_c, out)
    return out


def _convert_obj_to_glb(obj: Path) -> bytes:
    """读取 OBJ（若存在 .mtl 贴图则一并带上）并导出 GLB 字节。

    Args:
        obj: InstantMesh 产出的 .obj 路径。

    Returns:
        GLB 二进制的字节内容。

    Raises:
        RuntimeError: 预期的网格文件不存在（说明 run.py 没跑出结果）。
    """
    import trimesh

    obj = Path(obj)
    if not obj.is_file():
        raise RuntimeError(f'expected mesh not produced: {obj}')

    try:
        loaded = trimesh.load(str(obj), process=False)
    except Exception as exc:  # noqa: BLE001 - textured path is best-effort
        # 带贴图解析失败时退回只读几何：宁可丢贴图，也要把模型交给用户。
        logger.warning('textured load failed (%s); reloading geometry-only', exc)
        loaded = trimesh.load(str(obj), force='mesh', process=False)

    buf = io.BytesIO()
    if isinstance(loaded, trimesh.Scene):
        loaded.export(buf, file_type='glb')
    else:
        loaded.export(buf, file_type='glb')
    return buf.getvalue()


app = FastAPI(title='MeshForge InstantMesh inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    """GET /health — 健康检查。

    用 config 的 stem 作为"模型名"上报；config 读不到时退回固定名，
    但仍返回 ok（服务本身是活的，模型在每次请求时才加载）。
    """
    try:
        cfg = _resolve_config(_repo_root())
        model = cfg.stem
    except Exception:  # noqa: BLE001
        model = 'InstantMesh'
    return {'status': 'ok', 'model': model, 'loaded': True, 'uptime_s': int(time.time() - _START)}


@app.post('/generate')
async def generate(
    image: UploadFile = File(...),
    seed: int = Form(DEFAULT_SEED),
    diffusion_steps: int = Form(None),
    export_texmap: int = Form(0),
    rembg: int = Form(0),
) -> Response:
    """POST /generate — 单图生网格，返回 `model/gltf-binary`（GLB）。

    Args:
        image: 输入图片（multipart 上传）。
        seed: 随机种子（默认 42，可复现）。
        diffusion_steps: 扩散步数；非正数时用默认值。
        export_texmap: 非 0 时额外导出贴图。
        rembg: 预留参数；当前恒传 `--no_rembg`，不做背景移除。
    """
    model_root = _model_root()
    repo = _repo_root()
    # 提前把"环境没装好"这类问题挡在子进程之外，给出可读的错误。
    if not repo.is_dir():
        return Response(f'INSTANTMESH_REPO not found: {repo}', status_code=500)
    if not (repo / 'run.py').is_file():
        return Response(f'run.py not found under {repo}', status_code=500)

    steps = int(diffusion_steps if diffusion_steps and diffusion_steps > 0 else DEFAULT_DIFFUSION_STEPS)

    # 整个请求生命周期都在临时目录里工作：输入图、改写后的 config、输出网格
    # 全部随之自动清理，不污染仓库目录。
    with tempfile.TemporaryDirectory(prefix='im_') as tmpd:
        tmp = Path(tmpd)

        # 保留上传文件的原始后缀（run.py 会按后缀判断读图方式），无后缀时按 png。
        suffix = Path(image.filename or 'input.png').suffix or '.png'
        src = tmp / f'input{suffix}'
        src.write_bytes(await image.read())

        try:
            cfg = _resolve_config(repo)
            local_cfg = _write_local_config(cfg, model_root, tmp)
        except Exception as exc:  # noqa: BLE001
            return Response(f'config error: {exc}', status_code=500)

        out = tmp / 'out'
        out.mkdir(parents=True, exist_ok=True)
        cmd = [
            str(repo / 'run.py'),
            str(local_cfg),
            str(src),
            '--output_path', str(out),
            '--diffusion_steps', str(steps),
            '--seed', str(seed),
            '--no_rembg',
        ]
        if int(export_texmap) != 0:
            cmd.append('--export_texmap')

        logger.info('running: %s', ' '.join(cmd))
        try:
            proc = subprocess.run(
                cmd,
                # cwd 设为仓库根：config 里有相对路径依赖。
                cwd=str(repo),
                capture_output=True,
                text=True,
                # 30 分钟上限：首次加载权重 + 重建可能较慢，但不应无限挂住。
                timeout=1800,
            )
        except Exception as exc:  # noqa: BLE001
            return Response(f'failed to launch runner: {exc}', status_code=500)

        if proc.returncode != 0:
            # 只回传最后 4000 字符：足够定位报错，又不会把整个 traceback 塞进响应。
            tail = (proc.stderr or '')[-4000:] or (proc.stdout or '')[-4000:]
            return Response(f'InstantMesh run failed (rc={proc.returncode}):\n{tail}', status_code=500)

        stem = cfg.stem
        # 输出布局由 run.py 决定：out/<config-stem>/meshes/input.obj
        obj = out / stem / 'meshes' / 'input.obj'
        try:
            payload = _convert_obj_to_glb(obj)
        except Exception as exc:  # noqa: BLE001 - clean error
            return Response(f'mesh conversion failed: {exc}', status_code=500)

    if not payload:
        return Response('empty mesh produced', status_code=500)
    return Response(content=payload, media_type='model/gltf-binary')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('INSTANTMESH_MODEL_ROOT', ''),
                        help='parent dir of the InstantMesh weights folder')
    parser.add_argument('--repo', default=os.environ.get('INSTANTMESH_REPO', ''),
                        help='InstantMesh repo root (run.py + configs/)')
    parser.add_argument('--config', default=os.environ.get('INSTANTMESH_CONFIG', ''),
                        help='model config relative to the repo, e.g. '
                             'configs/instant-mesh-large.yaml (default) or '
                             'configs/instant-mesh-base.yaml (low-VRAM)')
    parser.add_argument('--port', type=int, default=8770)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--preload', action='store_true',
                        help='accepted for parity; InstantMesh loads per request')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='[instantmesh] %(levelname)s: %(message)s')

    # 命令行参数优先写回环境变量，后续 _model_root()/_repo_root() 统一从这里读。
    if args.model_root:
        os.environ['INSTANTMESH_MODEL_ROOT'] = args.model_root
    if args.repo:
        os.environ['INSTANTMESH_REPO'] = args.repo
    if args.config:
        os.environ['INSTANTMESH_CONFIG'] = args.config
    if not os.environ.get('INSTANTMESH_MODEL_ROOT'):
        logger.error('--model-root is required (e.g. D:/github/models)')
        raise SystemExit(2)

    import uvicorn

    logger.info('weights root: %s', os.environ.get('INSTANTMESH_MODEL_ROOT'))
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
