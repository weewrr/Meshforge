"""MeshForge stable-zero123 推理服务（独立进程）。

承载 ``generators/`` 中 ``stable-zero123`` 多视角生成器的**模型侧**。
该模型把**单张 RGB 图**转成一批**多视角渲染图**，视角由每个视图的
elevation / azimuth 相机位姿驱动（即 Zero123 的 Stable 复刻版：SD2.1
image-variations 底模 + 相机条件模块）。输出 = 一张 PNG 网格拼图。

权重：单个 checkpoint（来自 hf.co/stabilityai/stable-zero123）：:

  <model-root>/stable-zero123/stable_zero123.ckpt   （约 8.6 GB）

服务使用 diffusers 的 ``StableZero123Pipeline``，优先走 ``from_single_file``
加载器（与官方 stable-zero123 demo 一致）。若该单文件映射对这个 checkpoint
不适用，则回退到"分别加载各组件 + 按前缀拷贝权重"的方式：

  joblib, distributed, 有时还有 model.diffusion_model.*   -> unet
  first_stage_model.*                                     -> vae
  cond_stage_model.transformer.* / image_encoder          -> CLIP 图像编码器
  cc_projection.*                                         -> 相机 MLP

接口：

  GET  /health   -> {"status":"ok","model":...,"loaded":bool}
  POST /generate -> multipart：image + steps/seed -> 一张多视角 PNG 网格

视角：默认 8 个相机（方位角 0..315 度，仰角 0）；pipeline 会把它们合成
一张平铺的网格图。

环境变量 / 命令行：
  ZERO123_MODEL_ROOT   stable-zero123 权重的父目录（默认 D:/github/models）
  ZERO123_MODEL        权重子目录名（默认 stable-zero123）
  ZERO123_PY           venv 的 python（供安装脚本使用）
"""
import argparse
import io
import logging
import os
import threading
import time
from typing import Optional

import torch
from fastapi import File, Form, UploadFile
from fastapi import FastAPI
from fastapi.responses import Response

logger = logging.getLogger('zero123')

_START = time.time()
DEFAULT_STEPS = 50
DEFAULT_SEED = -1
DEFAULT_GUIDANCE = 3.0
# 8 views around the object at zero elevation. Adjust (fewer views = less VRAM).
_NUM_VIEWS = 8
FULL_TURN_DEGREES = 360.0  # 一圈的方位角总量（用于把视图均匀铺满一周）


def _model_root() -> str:
    """权重父目录；未配置时回退到本机默认路径。"""
    return os.environ.get('ZERO123_MODEL_ROOT', r'D:\github\models').strip()


def _model_dir() -> Path:
    """该模型的权重目录（父目录 / 模型名）。"""
    name = os.environ.get('ZERO123_MODEL', 'stable-zero123').strip()
    return Path(_model_root()) / name


def _ckpt() -> Path:
    """定位 checkpoint；命名不符时退而取目录下的第一个 .ckpt。"""
    ckpt = _model_dir() / 'stable_zero123.ckpt'
    if not ckpt.is_file():
        # 若存在备选文件名则容忍使用
        found = list(_model_dir().glob('*.ckpt'))
        if found:
            ckpt = found[0]
    return ckpt


# 模型加载串行化：避免并发请求同时触发加载导致显存翻倍。
_MODEL_LOCK = threading.Lock()
_pipe: Optional[object] = None
# 首次加载失败的原因；后续请求直接复用，避免重复尝试昂贵的加载。
_pipe_error: Optional[str] = None


def _fallback_load(ckpt: Path, dtype) -> object:
    """由各子组件 + 手工 state dict 组装 StableZero123Pipeline。

    这是 ``from_single_file`` 失败时的兜底路径：先按公开仓库拉取同源组件
    （vae / image encoder / unet / scheduler），再把 checkpoint 里对应前缀的
    权重灌进去。

    Args:
        ckpt: checkpoint 文件路径。
        dtype: 目标精度（此处传入 fp16）。

    Returns:
        组装好的 StableZero123Pipeline。
    """
    from diffusers import (
        AutoencoderKL,
        DDIMScheduler,
        StableZero123Pipeline,
        UNet2DConditionModel,
    )
    from diffusers.loaders import SingleFileLoader  # noqa: F401
    from transformers import (
        CLIPImageProcessor,
        CLIPVisionModelWithProjection,
    )

    # 先整份读进内存：该 ckpt 约 8.6GB，用 cpu 做 map_location 可避免显存峰值。
    sd = torch.load(ckpt, map_location='cpu')
    if 'state_dict' in sd:
        sd = sd['state_dict']

    def keys(prefix: str):
        """取出并剥掉指定前缀下的所有键值（用于局部 load_state_dict）。"""
        return {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}

    # VAE
    vae = AutoencoderKL.from_pretrained(
        'stabilityai/sd-vae-ft-mean', torch_dtype=dtype)
    vae.load_state_dict(keys('first_stage_model.'))
    # 图像编码器 + CC 投影 MLP
    img_enc = CLIPVisionModelWithProjection.from_pretrained(
        'openai/clip-vit-large-patch14', torch_dtype=dtype)
    # strict=False：checkpoint 只带视觉塔部分，文本塔等键缺失属正常。
    img_enc.load_state_dict(keys('cond_stage_model.transformer.vision_model.'), strict=False)
    cc_proj_state = keys('cc_projection.')
    # UNet
    unet = UNet2DConditionModel.from_pretrained(
        'stabilityai/stable-diffusion-2-1-base', subfolder='unet',
        torch_dtype=dtype, use_safetensors=False)
    # 同为宽松加载：ckpt 可能含 EMA / 优化器状态等无关键。
    unet.load_state_dict(keys('model.diffusion_model.'), strict=False)

    pipe = StableZero123Pipeline(
        vae=vae,
        image_encoder=img_enc,
        unet=unet,
        scheduler=DDIMScheduler.from_pretrained(
            'stabilityai/stable-diffusion-2-1-base', subfolder='scheduler',
            torch_dtype=dtype),
        feature_extractor=CLIPImageProcessor.from_pretrained(
            'stabilityai/sd-image-variations-diffusers', subfolder='feature_extractor'),
        requires_safety_checker=False,
        safety_checker=None,
        # 相机条件维度：CLIP 的 1024 维 + 6 维相机位姿 → 投影到 768 维 cross-attn。
        cc_projection=torch.nn.Linear(1024 + 6, 768, dtype=dtype),
    )
    _safe_load_unexpected(pipe.cc_projection, cc_proj_state)
    return pipe


def _safe_load_unexpected(module, state) -> None:
    """即使 state dict 含有额外/不匹配的键，也照常加载并只记警告。"""
    missing, unexpected = module.load_state_dict(state, strict=False)
    # 只打印前 10 条：键可能很多，避免日志被刷屏。
    if missing:
        logger.warning('cc_projection missing keys: %s', missing[:10])
    if unexpected:
        # 形状 (N, 1024+6) → 该 Linear 期望输出 768（投影到交叉注意力维度），
        # 容忍输入维度为 (1024+6) 的权重核。
        logger.warning('cc_projection unexpected keys: %s', list(unexpected)[:10])


def _load_pipeline() -> object:
    """加载 StableZero123Pipeline（优先单文件加载，失败则走手工兜底）。

    Returns:
        diffusers pipeline 实例；重复调用命中缓存。

    Raises:
        RuntimeError: CUDA 不可用或权重缺失。
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
        ckpt = _ckpt()
        if not ckpt.is_file():
            _pipe_error = f'checkpoint not found: {ckpt}'
            raise RuntimeError(_pipe_error)

        from diffusers import StableZero123Pipeline

        dtype = torch.float16
        try:
            pipe = StableZero123Pipeline.from_single_file(
                str(ckpt), torch_dtype=dtype,
                requires_safety_checker=False, safety_checker=None,
            )
        except Exception as exc:  # noqa: BLE001 - try manual fallback
            # 单文件映射依赖 diffusers 内置的键名表，版本不同可能对不上。
            logger.warning('from_single_file failed (%s); trying manual split', exc)
            pipe = _fallback_load(ckpt, dtype)

        pipe = pipe.to('cuda')
        try:
            # 注意力/VAE 切片：用时间换显存，压低峰值占用。
            pipe.enable_attention_slicing()
            pipe.enable_vae_slicing()
        except Exception as exc:  # noqa: BLE001 - slicing is best-effort
            logger.warning('enabling attention/VAE slicing failed (%s); VRAM use may be higher', exc)
        _pipe = pipe
        return pipe


def _center_crop_resize(data: bytes, size: int = 512):
    """居中裁成正方形再缩放到 ``size``（官方 demo 的预处理方式）。

    Args:
        data: 上传图片的原始字节。
        size: 目标边长，默认 512。

    Returns:
        PIL Image（RGB，size x size）。
    """
    from PIL import Image

    img = Image.open(io.BytesIO(data)).convert('RGB')
    w, h = img.size
    # 按短边居中裁切，避免非等比缩放导致相机位姿语义失真。
    s = min(w, h)
    left = (w - s) // 2
    top = (h - s) // 2
    img = img.crop((left, top, left + s, top + s))
    return img.resize((size, size), Image.LANCZOS)


app = FastAPI(title='MeshForge stable-zero123 inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    """GET /health — 健康检查；同时回传模型是否已加载与最近一次加载错误。"""
    return {
        'status': 'ok',
        'model': _model_dir().name,
        'loaded': _pipe is not None,
        'error': _pipe_error,
        'uptime_s': int(time.time() - _START),
    }


@app.post('/generate')
async def generate(
    image: UploadFile = File(...),
    steps: int = Form(DEFAULT_STEPS),
    seed: int = Form(DEFAULT_SEED),
) -> Response:
    """POST /generate — 单图生多视角，返回 `image/png` 网格拼图。

    Args:
        image: 输入图片（multipart 上传）。
        steps: 采样步数；非正数时回退到 `DEFAULT_STEPS`。
        seed: 随机种子；负值表示不固定。
    """
    try:
        pipe = _load_pipeline()
    except Exception as exc:  # noqa: BLE001
        logger.error('load failed: %s', exc)
        return Response(f'pipeline load failed: {exc}', status_code=500)

    n_steps = int(steps if steps and steps > 0 else DEFAULT_STEPS)
    gen = None
    # seed >= 0 才建生成器；负值交给 diffusers 自己随机。
    if int(seed) >= 0:
        gen = torch.Generator(device='cuda').manual_seed(int(seed))

    data = await image.read()
    try:
        img = _center_crop_resize(data)
    except Exception as exc:  # noqa: BLE001
        return Response(f'bad input image: {exc}', status_code=400)

    # 相机位姿：仰角全 0（水平绕圈），方位角按 360/N 均匀分布铺满一周。
    n = _NUM_VIEWS
    elevations = [0.0] * n
    azimuths = [(FULL_TURN_DEGREES / n) * i for i in range(n)]

    logger.info('generate views=%d steps=%s seed=%s', n, n_steps, seed)
    try:
        out = pipe(
            img,
            elevation=torch.tensor(elevations),
            azimuth=torch.tensor(azimuths),
            num_images_per_prompt=n,
            num_inference_steps=n_steps,
            guidance_scale=DEFAULT_GUIDANCE,
            generator=gen,
        )
        payload = out.images[0]  # single tiled grid image (PIL)
    except Exception as exc:  # noqa: BLE001
        logger.error('generate failed: %s', exc)
        return Response(f'generate failed: {exc}', status_code=500)

    if payload is None:
        return Response('empty output produced', status_code=500)
    buf = io.BytesIO()
    payload.save(buf, format='PNG')
    return Response(content=buf.getvalue(), media_type='image/png')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('ZERO123_MODEL_ROOT', ''),
                        help='parent dir of the stable-zero123 weights folder')
    parser.add_argument('--model', default=os.environ.get('ZERO123_MODEL', ''),
                        help='weights subdir name (default stable-zero123)')
    parser.add_argument('--port', type=int, default=8781)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--preload', action='store_true',
                        help='load the model at startup instead of on first request')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='[zero123] %(levelname)s: %(message)s')
    # 命令行参数优先写回环境变量，后续 _model_root()/_model_dir() 统一从这里读。
    if args.model_root:
        os.environ['ZERO123_MODEL_ROOT'] = args.model_root
    if args.model:
        os.environ['ZERO123_MODEL'] = args.model
    if not os.environ.get('ZERO123_MODEL_ROOT'):
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

    logger.info('checkpoint: %s', _ckpt())
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
