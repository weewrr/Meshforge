"""MeshForge MVDream 推理服务（独立进程）。

承载 ``generators/`` 中 ``mvdream`` 多视角生成器的**模型侧**。
MVDream 是**文生多视角**模型：给定一段文本提示词，直接渲染出同一物体的
**4 个一致视角**（无需输入图片）。输出 = 一张 2x2 排布的 4 视角 PNG 图。

权重（来自 MVDream HF 仓库 / ModelScope 打包）：:

  <model-root>/MVDream/sd-v1.5-4view.pt        （SD1.5 底模，约 4.3 GB）
  <model-root>/MVDream/sd-v2.1-base-4view.pt   （SD2.1 底模，约 5.2 GB，默认）

运行时代码即 MVDream 官方仓库（https://github.com/ByteDance/MVDream），
在其 venv 里用 ``pip install -e .`` 装成 ``mvdream`` 包。这里登记的是
``sd-v2.1-base-4view`` 这一档模型配置。

接口：

  GET  /health   -> {"status":"ok","model":...,"loaded":bool}
  POST /generate -> multipart *text* 表单（prompt + steps + seed，无文件）
                    -> 一张 4 视角 PNG 图

环境变量 / 命令行：
  MVDREAM_MODEL_ROOT   权重父目录（默认 D:/github/models）
  MVDREAM_MODEL        权重子目录名（默认 MVDream）
  MVDREAM_PY           venv 的 python（供安装脚本使用）
"""
import argparse
import io
import logging
import os
import threading
import time
from typing import Optional

import torch
from fastapi import Form
from fastapi import FastAPI
from fastapi.responses import Response

logger = logging.getLogger('mvdream')

_START = time.time()
DEFAULT_STEPS = 30
DEFAULT_SEED = -1
DEFAULT_GUIDANCE = 7.5
_NUM_VIEWS = 4
IMAGE_SIZE = 256    # 训练/推理分辨率
VAE_DOWNSCALE = 8   # VAE 潜空间下采样倍数（256 -> 32）


def _model_root() -> str:
    """权重父目录；未配置时回退到本机默认路径。"""
    return os.environ.get('MVDREAM_MODEL_ROOT', r'D:\github\models').strip()


def _model_dir() -> Path:
    """该模型的权重目录（父目录 / 模型名）。"""
    name = os.environ.get('MVDREAM_MODEL', 'MVDream').strip()
    return Path(_model_root()) / name


def _ckpt() -> Path:
    """定位 checkpoint 文件；命名不符时退而取目录下的第一个 .pt。

    这样用户在 HF 上换用其他 4view 权重时无需改代码。
    """
    ckpt = _model_dir() / 'sd-v2.1-base-4view.pt'
    if not ckpt.is_file():
        found = list(_model_dir().glob('*.pt'))
        if found:
            ckpt = found[0]
    return ckpt


# 模型加载串行化：避免多个请求同时触发加载，把显存打爆。
_MODEL_LOCK = threading.Lock()
_model: Optional[object] = None
_sampler: Optional[object] = None
# 记录首次加载失败的原因，后续请求直接复用该错误，避免反复重试昂贵的加载流程。
_model_error: Optional[str] = None


def _load_model() -> tuple:
    """构建 MVDream 扩散模型 + DDIM 采样器（fp16）。

    Returns:
        `(model, sampler)` 二元组；重复调用会命中缓存直接返回。

    Raises:
        RuntimeError: CUDA 不可用 / 权重缺失 / 依赖导入或建模失败。
    """
    global _model, _sampler, _model_error
    with _MODEL_LOCK:
        if _model is not None and _sampler is not None:
            return _model, _sampler
        # 已失败过就直接抛同一个错误：加载很贵，不做无意义的重复尝试。
        if _model_error is not None:
            raise RuntimeError(_model_error)
        if not torch.cuda.is_available():
            _model_error = 'CUDA not available'
            raise RuntimeError(_model_error)
        ckpt = _ckpt()
        if not ckpt.is_file():
            _model_error = f'checkpoint not found: {ckpt}'
            raise RuntimeError(_model_error)

        try:
            from mvdream.model_zoo import build_model
            from mvdream.ldm.models.diffusion.ddim import DDIMSampler
        except Exception as exc:  # noqa: BLE001
            # 失败信息里带上修复路径，用户可直接照做。
            _model_error = (
                f'mvdream package import failed ({exc}). Clone ByteDance/MVDream '
                f'to D:/github/MVDream and set up the environment (see README deployment section).')
            raise RuntimeError(_model_error)

        try:
            # strict=False：允许权重与配置存在少量不匹配（不同打包来源常见）。
            model = build_model('sd-v2.1-base-4view', ckpt_path=str(ckpt),
                                device='cuda', strict=False)
        except Exception as exc:  # noqa: BLE001
            _model_error = f'build_model failed (wrong model config?): {exc}'
            raise RuntimeError(_model_error)

        # fp16 推理：显存占用减半，这类扩散模型在 N 卡上精度损失可忽略。
        model = model.half() if hasattr(model, 'half') else model
        model.eval()
        sampler = DDIMSampler(model)
        try:
            sampler.to('cuda')
        except Exception as exc:  # noqa: BLE001 - non-fatal: sampler keeps its current device
            logger.warning('sampler.to(cuda) failed (%s); continuing on current device', exc)
        _model, _sampler = model, sampler
        return model, sampler


def _run(prompt: str, steps: int, seed: int, guidance: float) -> bytes:
    """执行一次 4 视角采样并把结果拼成 2x2 图。

    Args:
        prompt: 文本提示词（已 strip）。
        steps: 采样步数。
        seed: 随机种子；负值表示不固定（每次结果不同）。
        guidance: 无条件引导强度（classifier-free guidance scale）。

    Returns:
        PNG 图片的字节内容。
    """
    model, sampler = _load_model()
    from mvdream.camera_utils import get_camera
    from mvdream.ldm.util import fix_random_seeds
    import numpy as np
    from PIL import Image

    device = 'cuda'
    # 潜空间尺寸：256 / 8 = 32，batch 维就是视角数。
    shape = [_NUM_VIEWS, IMAGE_SIZE // VAE_DOWNSCALE, IMAGE_SIZE // VAE_DOWNSCALE]
    uc = model.get_learned_unconditional_conditioning().to(device)
    c = model.get_learned_conditioning([prompt]).to(device)
    # 相机参数决定"绕物体一圈"的 4 个固定方位角，是 4 视角一致性的关键。
    camera = get_camera(_NUM_VIEWS).to(device)

    # fix_random_seeds 上下文管理器负责设置/恢复全局随机状态，保证可复现。
    with fix_random_seeds(seed):
        samples, _ = sampler.sample(
            S=steps,
            conditioning=uc,
            batch_size=_NUM_VIEWS,
            shape=shape,
            x_T=None if seed < 0 else None,
            verbose=False,
            unconditional_guidance_scale=guidance,
            conditioning_crossattn=c,
            cond_camera=camera,
        )

    imgs = model.latent_to_image(samples.float())  # np uint8 (B,H,W,3), 0..255
    imgs = np.asarray(imgs)
    rows = 2
    cols = _NUM_VIEWS // rows
    h, w = imgs.shape[1], imgs.shape[2]
    # 先铺一张白底画布，再按行主序把 4 个视角贴进 2x2 网格。
    sheet = Image.new('RGB', (cols * w, rows * h), (255, 255, 255))
    for i in range(_NUM_VIEWS):
        r, cc = divmod(i, cols)
        sheet.paste(Image.fromarray(imgs[i]), (cc * w, r * h))
    buf = io.BytesIO()
    sheet.save(buf, format='PNG')
    return buf.getvalue()


app = FastAPI(title='MeshForge MVDream inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    """GET /health — 健康检查；同时回传是否已加载模型与最近一次加载错误。"""
    return {
        'status': 'ok',
        'model': _model_dir().name,
        'loaded': _model is not None,
        'error': _model_error,
        'uptime_s': int(time.time() - _START),
    }


@app.post('/generate')
async def generate(
    prompt: str = Form(...),
    steps: int = Form(DEFAULT_STEPS),
    seed: int = Form(DEFAULT_SEED),
) -> Response:
    """POST /generate — 文生 4 视角图，返回 `image/png`。

    Args:
        prompt: 文本提示词（必填）。
        steps: 采样步数；非正数时回退到 `DEFAULT_STEPS`。
        seed: 随机种子；-1 表示每次都不同。
    """
    n_steps = int(steps if steps and steps > 0 else DEFAULT_STEPS)
    prompt = prompt.strip()
    if not prompt:
        return Response('prompt is required', status_code=400)

    # 只记前 60 字符：提示词可能很长，避免日志被刷屏。
    logger.info('generate prompt=%r steps=%s seed=%s', prompt[:60], n_steps, seed)
    try:
        payload = _run(prompt, n_steps, int(seed), DEFAULT_GUIDANCE)
    except Exception as exc:  # noqa: BLE001
        # 推理异常（OOM / 权重问题）统一转成 500 并把原因带回响应体。
        logger.error('generate failed: %s', exc)
        return Response(f'generate failed: {exc}', status_code=500)

    if not payload:
        return Response('empty output produced', status_code=500)
    return Response(content=payload, media_type='image/png')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('MVDREAM_MODEL_ROOT', ''),
                        help='parent dir of the MVDream weights folder')
    parser.add_argument('--model', default=os.environ.get('MVDREAM_MODEL', ''),
                        help='weights subdir name (default MVDream)')
    parser.add_argument('--port', type=int, default=8780)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--preload', action='store_true',
                        help='load the model at startup instead of on first request')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='[mvdream] %(levelname)s: %(message)s')
    # 命令行参数优先写回环境变量，后续 _model_root()/_model_dir() 统一从这里读。
    if args.model_root:
        os.environ['MVDREAM_MODEL_ROOT'] = args.model_root
    if args.model:
        os.environ['MVDREAM_MODEL'] = args.model
    if not os.environ.get('MVDREAM_MODEL_ROOT'):
        logger.error('--model-root is required (e.g. D:/github/models)')
        raise SystemExit(2)

    if args.preload:
        try:
            _load_model()
            logger.info('model preloaded')
        except Exception as exc:  # noqa: BLE001
            # 预加载失败不退出：留待首个请求再报错，进程仍可提供 /health。
            logger.error('preload failed: %s', exc)

    import uvicorn

    logger.info('checkpoint: %s', _ckpt())
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
