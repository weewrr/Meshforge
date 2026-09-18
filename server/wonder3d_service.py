"""MeshForge Wonder3D_plus 推理服务（独立进程）。

承载 ``generators/`` 中 ``wonder3d-plus`` 多视角生成器的**模型侧**。
该模型把**单张 RGB 图**转成 **6 张彩色多视角图**（category='multiview'，
输出为一张 PNG 拼图）。

权重放在这里（来自 hf.co/flamehaze1115/Wonder3D_plus，即自带 diffusers
包结构的 "plus" 权重）：:

  <model-root>/Wonder3D_plus/
      model_index.json            -> MVDiffusionImagePipeline
      unet/  vae/  image_encoder/  scheduler/  feature_extractor/
      mv_diffusion_30/            -> 随权重一起打包的自定义 UNet + pipeline 代码

``_class_name`` 是自定义的 ``MVDiffusionImagePipeline``，其 UNet 类为
``mv_diffusion_30.models.unet_mv2d_condition.UNetMV2DConditionModel``。
该包**位于权重目录内部**（且没有 ``__init__.py``），所以本服务会把权重目录
插到 ``sys.path``，并补出最小 ``__init__.py``，好让 ``diffusers`` 的
``from_pretrained`` 能解析这些类名。

接口：

  GET  /health   -> {"status":"ok","model":...,"loaded":bool}
  POST /generate -> multipart：image + steps/seed -> 一张 6 视角 PNG 拼图

pipeline 内部会用 12 行相机表 ``pipeline.camera_embedding`` 一次批量采样
12 个潜视角（6 彩色 + 6 法线）；这里固定 ``pred_type='color'``，取
``out.images[0:6]``（彩色视角）并按 2 行 x 3 列拼图。

环境变量 / 命令行：
  WONDER3D_MODEL_ROOT   Wonder3D_plus 权重的父目录（默认 D:/github/models）
  WONDER3D_MODEL        权重子目录名（默认 Wonder3D_plus）
  WONDER3D_PY           venv 的 python（供安装脚本使用）
"""
import argparse
import io
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import torch
from fastapi import File, Form, UploadFile
from fastapi import FastAPI
from fastapi.responses import Response

logger = logging.getLogger('wonder3d')

_START = time.time()
DEFAULT_STEPS = 50
DEFAULT_SEED = -1


def _model_root() -> str:
    """权重父目录；未配置时回退到本机默认路径。"""
    return os.environ.get('WONDER3D_MODEL_ROOT', r'D:\github\models').strip()


def _model_dir() -> Path:
    """该模型的权重目录（父目录 / 模型名）。"""
    name = os.environ.get('WONDER3D_MODEL', 'Wonder3D_plus').strip()
    return Path(_model_root()) / name


def _hint(*msgs: str) -> str:
    """拼接错误提示，并附上实际查找的权重根目录，便于用户定位路径问题。"""
    return '\n'.join(msgs) + f'\n[log] {Path(_model_root())}'


# 模型加载串行化：避免并发请求同时触发加载导致显存翻倍。
_MODEL_LOCK = threading.Lock()
_pipe: Optional[object] = None
# 首次加载失败的原因；后续请求直接复用，避免重复尝试昂贵的加载。
_pipe_error: Optional[str] = None


def _patch_package_imports(weights: Path) -> None:
    """让随权重打包的 ``mv_diffusion_30``（权重目录内包）可被 import。"""
    # 打包时没带 __init__.py；补出最小的空文件，让该包及其 models/pipelines
    # 子模块能按常规包的方式被解析。
    for rel in ('', 'models', 'pipelines', 'data'):
        d = weights / 'mv_diffusion_30' / rel
        if d.is_dir() and not (d / '__init__.py').is_file():
            try:
                (d / '__init__.py').write_text('', encoding='utf-8')
            except OSError as exc:  # noqa: BLE001
                # 只读挂载等情况下写不进去：记警告继续，能否 import 交给后续判定。
                logger.warning('could not create init in %s: %s', d, exc)
    # 插到最前面：确保优先加载权重目录里的同名模块，而非环境里的旧版本。
    sys.path.insert(0, str(weights))


def _load_pipeline() -> object:
    """从权重目录加载 MVDiffusionImagePipeline（fp16 + 切片省显存）。

    Returns:
        diffusers pipeline 实例；重复调用命中缓存。

    Raises:
        RuntimeError: CUDA 不可用、打包代码导入失败或 `from_pretrained` 失败。
    """
    global _pipe, _pipe_error
    with _MODEL_LOCK:
        if _pipe is not None:
            return _pipe
        if _pipe_error is not None:
            raise RuntimeError(_pipe_error)
        if not torch.cuda.is_available():
            _pipe_error = 'CUDA not available'
            raise RuntimeError(_pipe_error)

        from diffusers import DiffusionPipeline

        weights = _model_dir()
        _patch_package_imports(weights)

        try:
            # 显式 import 一次自定义类，顺便把 UNetMV2DConditionModel 注册进
            # diffusers 的类表，否则 from_pretrained 解析 _class_name 时会找不到。
            from mv_diffusion_30.pipelines.pipeline_mvdiffusion_image import (  # noqa: F401
                MVDiffusionImagePipeline,
            )
        except Exception as exc:  # noqa: BLE001
            _pipe_error = f'bundle import failed: {exc}'
            raise

        try:
            pipe = DiffusionPipeline.from_pretrained(
                str(weights),
                pipeline_class=MVDiffusionImagePipeline,
                torch_dtype=torch.float16,
                # 关闭安全检查器：该模型不含对应权重，开着反而会加载失败。
                safety_checker=None,
                requires_safety_checker=False,
            )
        except Exception as exc:  # noqa: BLE001
            _pipe_error = f'from_pretrained failed: {exc}'
            raise

        pipe = pipe.to('cuda')
        try:
            # 注意力/VAE 切片：用时间换显存，让 6GB 级显卡也能跑起来。
            pipe.enable_attention_slicing()
            pipe.enable_vae_slicing()
        except Exception as exc:  # noqa: BLE001 - slicing is best-effort
            logger.warning('enabling attention/VAE slicing failed (%s); VRAM use may be higher', exc)
        _pipe = pipe
        return pipe


def _prep_input(data: bytes) -> object:
    """解码图片 → 居中裁成正方形 → 缩放到 256x256。

    Args:
        data: 上传图片的原始字节。

    Returns:
        PIL Image（RGB，256x256）。
    """
    import io as _io

    from PIL import Image

    img = Image.open(_io.BytesIO(data)).convert('RGB')
    w, h = img.size
    # 先按短边居中裁切，避免直接 resize 造成长宽比失真。
    s = min(w, h)
    left = (w - s) // 2
    top = (h - s) // 2
    img = img.crop((left, top, left + s, top + s))
    return img.resize((256, 256), Image.LANCZOS)


def _tile(images) -> bytes:
    """把 N 张 PIL 图拼成 3 列、行数按需的 PNG 拼图。

    返回值为 PNG 字节。拼接顺序为行主序，便于前端按固定网格切回单视角。
    """
    from PIL import Image

    n = len(images)
    cols = 3
    # 向上取整：n 不是 3 的整数倍时最后一行留白，不会越界。
    rows = (n + cols - 1) // cols
    cw, ch = images[0].size
    sheet = Image.new('RGB', (cols * cw, rows * ch), (255, 255, 255))
    for i, im in enumerate(images):
        sheet.paste(im, ((i % cols) * cw, (i // cols) * ch))
    buf = io.BytesIO()
    sheet.save(buf, format='PNG')
    return buf.getvalue()


app = FastAPI(title='MeshForge Wonder3D_plus inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    """GET /health — 健康检查；同时回传模型是否已加载与最近一次加载错误。"""
    loaded = _pipe is not None
    return {
        'status': 'ok',
        'model': _model_dir().name,
        'loaded': loaded,
        'error': _pipe_error,
        'uptime_s': int(time.time() - _START),
    }


@app.post('/generate')
async def generate(
    image: UploadFile = File(...),
    steps: int = Form(DEFAULT_STEPS),
    seed: int = Form(DEFAULT_SEED),
) -> Response:
    """POST /generate — 单图生 6 视角，返回 2x3 的 `image/png` 拼图。

    Args:
        image: 输入图片（multipart 上传）。
        steps: 采样步数；非正数时回退到 `DEFAULT_STEPS`。
        seed: 随机种子；负值表示不固定。
    """
    # 先把"模型加载"这一步单独 try：这样错误信息能附带路径提示，方便排障。
    try:
        pipe = _load_pipeline()
    except Exception as exc:  # noqa: BLE001 - surface clean error
        logger.error('load failed: %s', exc)
        return Response(f'pipeline load failed: {exc}\n{_hint()}', status_code=500)

    n_steps = int(steps if steps and steps > 0 else DEFAULT_STEPS)
    gen = None
    # seed >= 0 才建生成器；负值交给 diffusers 自己随机，保证"每次都不同"。
    if int(seed) >= 0:
        gen = torch.Generator(device='cuda').manual_seed(int(seed))

    data = await image.read()
    try:
        img = _prep_input(data)
    except Exception as exc:  # noqa: BLE001
        # 图片损坏/格式不支持属于客户端问题，用 400 区分于服务端 500。
        return Response(f'bad input image: {exc}', status_code=400)

    logger.info('generate steps=%s seed=%s', n_steps, seed)
    try:
        out = pipe(
            img,
            num_inference_steps=n_steps,
            guidance_scale=7.5,
            generator=gen,
            output_type='pil',
        )
        imgs = list(out.images)
        # 12 latent views decoded; camera rows 0-5 are the color views.
        color = imgs[:6]
        payload = _tile(color)
    except Exception as exc:  # noqa: BLE001
        logger.error('generate failed: %s', exc)
        return Response(f'generate failed: {exc}', status_code=500)

    if not payload:
        return Response('empty output produced', status_code=500)
    return Response(content=payload, media_type='image/png')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('WONDER3D_MODEL_ROOT', ''),
                        help='parent dir of the Wonder3D_plus weights folder')
    parser.add_argument('--model', default=os.environ.get('WONDER3D_MODEL', ''),
                        help='weights subdir name (default Wonder3D_plus)')
    parser.add_argument('--port', type=int, default=8782)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--preload', action='store_true',
                        help='load the model at startup instead of on first request')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='[wonder3d] %(levelname)s: %(message)s')
    # 命令行参数优先写回环境变量，后续 _model_root()/_model_dir() 统一从这里读。
    if args.model_root:
        os.environ['WONDER3D_MODEL_ROOT'] = args.model_root
    if args.model:
        os.environ['WONDER3D_MODEL'] = args.model
    if not os.environ.get('WONDER3D_MODEL_ROOT'):
        logger.error('--model-root is required (e.g. D:/github/models)')
        raise SystemExit(2)

    if args.preload:
        try:
            _load_pipeline()
            logger.info('pipeline preloaded')
        except Exception as exc:  # noqa: BLE001
            # 预加载失败不退出：进程仍可提供 /health 供前端探测。
            logger.error('preload failed: %s', exc)

    import uvicorn

    logger.info('weights dir: %s', _model_dir())
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
