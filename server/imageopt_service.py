"""MeshForge 图像预处理推理服务（imageopt_service.py）

给这批「单图 → 单图」图像处理模型共用一个推理服务，后端／适配器保持零 PyTorch
依赖：``server/generators/imageopt.py`` 的 ImageOptGenerator 通过 multipart POST
把「工具名 + 输入图 + 参数」送到本服务的 ``/generate``，得到处理后的 PNG 字节。

  GET  /health                 → 存活探测（适配器自动拉起时用）
  POST /generate               → multipart：tool(必填) + image(文件) + 各工具参数

支持的 ``tool``（对应 ImageOptimization/ 下的已下载权重；除标注外均为最强原版）：

  rmbg       RMBG-2.0           最强通用抠图      model.safetensors (BiRefNet v2)
  birefnet   BiRefNet           通用抠图          model.safetensors
  codeformer CodeFormer         人像修复          codeformer.pth (需 basicsr/facexlib)
  esrgan     Real-ESRGAN x2     图像超分(2x)      pytorch_model.pt (RRDBNet)
  matting    universal-matting  人像 BSHM Matting tf_graph.pb (需 TensorFlow)
  depth      Depth-Anything-V2  单目深度图        depth_anything_v2_vitl.safetensors
  moge       MoGe               深度+法线          geometry_estimation/moge_*_vitl_fp16.safetensors
  mlsd       M-LSD-tiny         直线检测          mlsd_fp16.tflite (LiteRT/TFLite)

依赖策略：重依赖模型（CodeFormer/basicsr、TensorFlow、MoGe、BiRefNet 官方包、
depth-anything-v2 官方包）无法在 setup 里保证一次装全，因此**遇缺依赖返回明确的中文
错误提示**，不崩溃；轻依赖模型（ESRGAN/RRDBNet 纯 torch、M-LSD tflite）在本文件内
直接实现推理。所有模型按 tool 惰性加载，仅当真正被调用时才占用显存。

6GB 显存提示：本服务默认 fp32；6GB 卡建议在调用时给深度/超分类模型传 low_vram=1，
用半精度/更低分辨率（见 README 部署章节的显存说明）。

用法：由后端按需拉起（本文件是 HTTP 服务，不是命令行入口）
CLI：python imageopt_service.py --model-root D:\\github\\models --model ImageOptimization --port 8783
"""

import argparse
import io
import os
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import PIL.Image
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

# 权重根目录：读环境变量便于换盘；注意变量名是 IMAGOOPT（历史拼写，勿改）。
MODEL_ROOT = Path(os.environ.get('IMAGOOPT_MODEL_ROOT', r'D:\github\models')) / 'ImageOptimization'

# ─── 图像常量 ────────────────────────────────────────────────────────────────
# I/O 约定：入参与回传都是 uint8 图（0..255），模型内部走 float（0..1）。
# UINT8_MAX 用于"裁剪到合法像素范围"这类整数场景；PIXEL_MAX 是其浮点孪生，
# 用在归一化（/ PIXEL_MAX）与反归一化（* PIXEL_MAX）的浮点算式里。
UINT8_MAX = 255
PIXEL_MAX = 255.0
RGB_CHANNELS = 3                # 彩色通道数（网络输入 / 输出）
ESRGAN_UPSCALE = 2              # Real-ESRGAN x2 上采样倍数
ESRGAN_UPSCALE_CHANNELS = ESRGAN_UPSCALE ** 2  # PixelShuffle 需要倍数²个通道
RRDB_RESIDUAL_SCALE = 0.2       # RRDB 残差缩放系数（ESRGAN 原论文取值，抑制梯度爆炸）
NORMALIZE_EPS = 1e-8            # 归一化时防止除零
DEPTH_INFER_SIZE = 518          # Depth-Anything-V2 原生推理边长
NORMAL_RANGE = 0.5              # 法线由 [-1,1] 映射到 [0,1] 的缩放 / 偏移
MLSD_INPUT_SIZE = 512           # M-LSD 固定输入边长
MLSD_SCORE_MIN_CHANNELS = 4     # 判定"分数图"输出所需的最小通道数
MLSD_SCORE_TENSOR_NDIM = 4      # 分数图应为 4D 张量（N,H,W,C）
MLSD_SCORE_THRESHOLD = 0.5      # 线段响应判为命中的分数阈值
MLSD_OVERLAY_ALPHA = 0.5        # 线段高亮与原图的叠加比例

# ─── 基础工具 ────────────────────────────────────────────────────────────────

def _torch():
    """惰性拿到 torch；未安装直接抛中文提示。

    Returns:
        `(torch, torch.nn, torch.nn.functional)` 三元组。

    Raises:
        HTTPException: 环境里没有可用的 torch（附安装脚本指引）。
    """
    try:
        import torch
        import torch.nn as nn
        import torch.nn.functional as F  # noqa: F401
        return torch, nn, F
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f'PyTorch 未就绪（{type(exc).__name__}: {exc}）。请先按 README 部署章节'
                   '安装 CUDA 版 torch。',
        )

def _pil2rgb(img: PIL.Image.Image) -> np.ndarray:
    """把 PIL 图转成 float32 的 HWC 数组（通道按 RGB / RGBA 原样保留）。"""
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGB')
    return np.asarray(img).astype(np.float32)

def _save_png(arr: np.ndarray) -> bytes:
    """把 HxWx3 / HxWx4 (uint8/float 0..255) 存为 PNG 字节。"""
    a = np.clip(arr, 0, UINT8_MAX).astype(np.uint8)
    buf = io.BytesIO()
    PIL.Image.fromarray(a).save(buf, format='PNG')
    return buf.getvalue()

def _missing(msg: str) -> HTTPException:
    """构造一个 500 错误：用于表达"依赖缺失 / 权重缺失"这类环境问题。"""
    return HTTPException(status_code=500, detail=msg)

# ─── 工具实现 ────────────────────────────────────────────────────────────────

# ESRGAN (Real-ESRGAN x2, RRDB 主干) ── 纯 torch，本文件内实现。
def _build_esrgan(weight_dir: Path):
    """构建 Real-ESRGAN x2（RRDBNet）并返回其 predict 闭包。

    Args:
        weight_dir: 该工具的权重目录（内含 pytorch_model.pt）。

    Returns:
        `predict(img: np.ndarray, params: dict) -> np.ndarray` 函数。
    """
    torch, nn, _ = _torch()
    # RRDBNet x2 的结构超参：64 特征通道 / 23 个 RRDB / 32 生长通道 / 2x 上采样。
    nf, nb, gc, up = 64, 23, 32, 2

    def make_layer(block, num, **kw):
        """把同一个 block 重复 num 次串成 Sequential。"""
        layers = [block(**kw) for _ in range(num)]
        return nn.Sequential(*layers)

    class ResidualDenseBlock_5C(nn.Module):
        """5 层密集连接的残差块（ESRGAN 原论文的 RDB）。"""

        def __init__(self, nf, gc):
            super().__init__()
            # 密集连接：第 n 层输入通道 = nf + (n-1)*gc（前 n-1 层输出全部拼接进来）。
            # 这里的 3 / 4 就是层索引本身，提成具名常量只会比表达式更难读，故内联保留。
            # 末尾三个参数 3, 1, 1 = kernel 3x3 / stride 1 / padding 1（保持分辨率）。
            self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
            self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
            self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
            self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
            self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)
        def forward(self, x):
            x1 = self.lrelu(self.conv1(x))
            x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
            x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
            x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
            # 密集块整体乘缩放系数后再加回输入（残差），避免深层堆叠梯度爆炸。
            return self.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * RRDB_RESIDUAL_SCALE + x

    class RRDB(nn.Module):
        """Residual-in-Residual Dense Block：3 个 RDB 串联后再残差相加。"""

        def __init__(self, nf, gc):
            super().__init__()
            self.rdb1 = ResidualDenseBlock_5C(nf, gc)
            self.rdb2 = ResidualDenseBlock_5C(nf, gc)
            self.rdb3 = ResidualDenseBlock_5C(nf, gc)
        def forward(self, x):
            return self.rdb3(self.rdb2(self.rdb1(x))) * RRDB_RESIDUAL_SCALE + x

    class RRDBNet(nn.Module):
        """Real-ESRGAN 主干：浅层卷积 → 23×RRDB → 残差 → PixelShuffle 上采样。"""

        def __init__(self):
            super().__init__()
            self.conv_first = nn.Conv2d(RGB_CHANNELS, nf, 3, 1, 1)
            self.body = make_layer(RRDB, nb, nf=nf, gc=gc)
            self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_last = nn.Conv2d(nf, RGB_CHANNELS, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)
            # PixelShuffle 把通道维的 r² 个值重排成 r×r 空间块，实现无损放大。
            self.upsampler = nn.Sequential(
                nn.Conv2d(nf, nf * ESRGAN_UPSCALE_CHANNELS, 3, 1, 1),
                nn.PixelShuffle(ESRGAN_UPSCALE),
            )
        def forward(self, x):
            fea = self.conv_first(x)
            out = self.body(fea)
            # 全局残差：把浅层特征加回来，保留高频细节。
            out = self.conv_body(out) + fea
            out = self.upsampler(out)
            return self.conv_last(self.lrelu(self.conv_hr(out)))

    model = RRDBNet()
    ckpt = torch.load(str(weight_dir / 'pytorch_model.pt'), map_location='cpu')
    sd = ckpt.get('state_dict', ckpt) if isinstance(ckpt, dict) else ckpt
    # 容忍常见的包络前缀。
    for prefix in ('params_ema.', 'student.', 'model.', 'ptmodel.', ''):
        if not prefix:
            break
        try:
            model.load_state_dict({k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}, strict=True)
            break
        except Exception:
            continue
    else:
        try:
            model.load_state_dict(sd, strict=False)
        except Exception as exc:
            raise _missing(f'Real-ESRGAN 权重无法加载（state dict 与 RRDBNet x2 架构不匹配: {exc}）。'
                           '如权重键名特殊，请参考 README 部署章节调整加载逻辑。')
    model.eval()

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    model.to(dev)

    def predict(img: np.ndarray, params: dict) -> np.ndarray:
        """HWC uint8/float 图 → 放大 up 倍的 HWC float 图。"""
        mod_scale = up
        h, w = img.shape[:2]
        # 先把边长裁到 up 的整数倍：PixelShuffle 不支持非整数倍切分。
        h, w = h - h % mod_scale, w - w % mod_scale
        img = img[:h, :w]
        # HWC → NCHW，并归一化到 0..1。
        t = torch.from_numpy(img).permute(2, 0, 1).unsqueeze(0).to(dev) / PIXEL_MAX
        with torch.no_grad():
            out = model(t)
        out = out.clamp(0, 1).squeeze(0).permute(1, 2, 0).cpu().numpy()
        return out * PIXEL_MAX

    return predict


# M-LSD-tiny 直线检测 ── LiteRT/TFLite 解释器执行，产出一张「高分响应热力图」PNG。
def _build_mlsd(weight_dir: Path):
    """构建 M-LSD-tiny 的 tflite 解释器并返回其 predict 闭包。

    Args:
        weight_dir: 权重目录（内含 mlsd_fp16.tflite）。

    Returns:
        `predict(img, params) -> np.ndarray`；输出为原图尺寸的热力图叠加图。
    """
    try:
        from ai_edge_litert.interpreter import Interpreter
    except Exception:
        try:
            from tflite_runtime.interpreter import Interpreter  # type: ignore
        except Exception as exc:
            # 两种解释器包名都试过仍失败：给出明确的安装指引。
            raise _missing(f'M-LSD 需要 LiteRT 解释器（pip install ai-edge-litert 或 tflite-runtime）。'
                           f'（{type(exc).__name__}: {exc}）')
    interp = Interpreter(model_path=str(weight_dir / 'mlsd_fp16.tflite'))
    interp.allocate_tensors()
    in_id = interp.get_input_details()[0]
    # 输出按维度数降序排列：真正要的"分数图"是维度最多的那个。
    out_ids = sorted(interp.get_output_details(), key=lambda d: len(d['shape']), reverse=True)
    in_shape = in_id['shape']  # [1,512,512,3]

    def predict(img: np.ndarray, params: dict) -> np.ndarray:
        """跑一次直线检测，把高响应区域提亮后叠加回原图。"""
        h, w = MLSD_INPUT_SIZE, MLSD_INPUT_SIZE
        pil = PIL.Image.fromarray(np.clip(img, 0, UINT8_MAX).astype(np.uint8)).convert('RGB').resize((w, h))
        inp = (np.asarray(pil).astype(np.float32) / PIXEL_MAX)[None, ...]
        interp.set_tensor(in_id['index'], inp.astype(in_id['dtype']))
        interp.invoke()
        # 取 channel 数最多的输出作为分割分数，叠加到原图上。
        score = None
        for d in out_ids:
            t = interp.get_tensor(d['index'])
            if t is not None and t.ndim == MLSD_SCORE_TENSOR_NDIM and t.shape[-1] >= MLSD_SCORE_MIN_CHANNELS:
                score = np.max(t[0], axis=-1)  # HxW
                break
        if score is None:
            raise _missing('M-LSD 输出的张量形状不符合预期，无法提取线段分数。')
        base = np.clip(img, 0, UINT8_MAX).astype(np.uint8)
        disp = base.copy()
        m = score > MLSD_SCORE_THRESHOLD
        # 命中区域按 alpha 向白色提亮：out = 原图*α + 255*α（对上式两边同乘 α）。
        disp[m] = np.clip(disp[m].astype(float) * MLSD_OVERLAY_ALPHA + PIXEL_MAX * MLSD_OVERLAY_ALPHA,
                          0, UINT8_MAX).astype(np.uint8)
        return disp.astype(np.float32)

    return predict


# depth (Depth-Anything-V2) ── 官方包存在才可就地推理。
def _build_depth(weight_dir: Path):
    """构建 Depth-Anything-V2（ViT-L）并返回其 predict 闭包。

    Returns:
        `predict(img, params) -> np.ndarray`；输出把单通道深度图复制成三通道。
    """
    torch, _, _ = _torch()
    try:
        from depth_anything_v2.dpt import DepthAnythingV2  # type: ignore
    except Exception as exc:
        raise _missing(f'Depth-Anything-V2 官方包未安装（{type(exc).__name__}: {exc}）。'
                       '"pip install depth-anything-v2" 后即可用；或按 upstream repo 把 depth_anything_v2 目录放进 venv。')
    # weights_only=False：safetensors 里除张量外还带元信息，必须允许非张量对象。
    ckpt = torch.load(str(weight_dir / 'depth_anything_v2_vitl.safetensors'), map_location='cpu', weights_only=False)
    sd = ckpt.get('state_dict', ckpt) if isinstance(ckpt, dict) else ckpt
    # ViT-L 的通道配置：与官方 vitl 档一致，否则权重对不上。
    model = DepthAnythingV2(encoder='vitl', features=256, out_channels=[256, 512, 1024, 1024])
    try:
        model.load_state_dict(sd)
    except Exception as exc:
        raise _missing(f'Depth-Anything-V2 权重加载失败（{exc}）。saftensors 若带 sha 前缀需用 safetensors.torch.load_file 先转换。')
    model.eval().to('cuda' if torch.cuda.is_available() else 'cpu')

    def predict(img: np.ndarray, params: dict) -> np.ndarray:
        """推理相对深度并线性归一化到 0..255，输出三通道灰度可视化。"""
        pil = PIL.Image.fromarray(np.clip(img, 0, UINT8_MAX).astype(np.uint8)).convert('RGB')
        depth = model.infer_image(pil, height=DEPTH_INFER_SIZE)  # HxW float (0..?)
        # 相对深度：按自身 min/ptp 拉伸到满量程（+eps 防全平图除零）。
        d = (depth - depth.min()) / (depth.ptp() + NORMALIZE_EPS) * PIXEL_MAX
        return np.stack([d, d, d], axis=-1)

    return predict


# rmbg / birefnet ── 官方 BiRefNet 包存在才可就地推理。
def _build_birefnet(weight_dir: Path, tool: str):
    """构建 BiRefNet 系列抠图模型并返回其 predict 闭包。

    Args:
        weight_dir: 权重目录。
        tool: 'rmbg' 或 'birefnet'，仅用于错误提示文案。

    Returns:
        `predict(img, params) -> np.ndarray`；`params['format']=='white'` 时输出
        白底合成图，否则输出带 alpha 通道的 RGBA。
    """
    torch, _, _ = _torch()
    try:
        from birefnet import BiRefNet  # type: ignore
    except Exception as exc:
        raise _missing(f'{tool}（BiRefNet）官方包未安装（{type(exc).__name__}: {exc}）。'
                       '"pip install birefnet" 后用即可；本服务已用本地 s*afetensors 权重。')
    # 两个 tool 目前指向同一权重文件名（均是 BiRefNet v2 的 model.safetensors）。
    model_path = weight_dir / ('model.safetensors' if tool == 'rmbg' else 'model.safetensors')
    if not model_path.is_file():
        raise _missing(f'{tool} 权重缺失：{model_path}')
    model = BiRefNet.from_pretrained(str(model_path))
    model.eval().to('cuda' if torch.cuda.is_available() else 'cpu')

    def predict(img: np.ndarray, params: dict) -> np.ndarray:
        """产出前景 mask 并按 format 参数合成输出图。"""
        import torchvision.transforms as T  # type: ignore
        pil = PIL.Image.fromarray(np.clip(img, 0, UINT8_MAX).astype(np.uint8)).convert('RGB')
        inp = T.ToTensor()(pil).unsqueeze(0).to(next(model.parameters()).device)
        with torch.no_grad():
            # sigmoid 后取第 0 通道作为前景概率图，再缩放回原图尺寸。
            m = torch.sigmoid(model(inp)[0])[0, 0].cpu().numpy()
        m = np.asarray(PIL.Image.fromarray((m * UINT8_MAX).astype(np.uint8)).resize(pil.size))
        a = np.clip(img, 0, UINT8_MAX).astype(np.uint8)
        if params.get('format') == 'white':
            # 白底合成：前景按 mask 加权，背景 255 按 (1-mask) 加权。
            bg = np.full_like(a, UINT8_MAX)
            out = (a.astype(float) * m[..., None] + bg.astype(float) * (1 - m[..., None])).astype(np.uint8)
            return out.astype(np.float32)
        # 默认输出 RGBA：mask 直接作为 alpha 通道叠加。
        rgba = np.dstack([a, (m * UINT8_MAX).astype(np.uint8)])
        return rgba.astype(np.float32)

    return predict


# codeformer ── 需 basicsr/facexlib，仅就地封装，缺依赖给中文提示。
def _build_codeformer(weight_dir: Path):
    """检查 CodeFormer 的依赖与权重是否齐备（当前仅接线、未实现推理）。

    Raises:
        HTTPException: 依赖缺失 / 权重缺失 / 依赖齐备但推理尚未接线（三者都带中文指引）。
    """
    torch, _, _ = _torch()
    # 逐个 import 探测：basicsr / facexlib 较重，setup 脚本不自动安装。
    for mod in ('basicsr', 'facexlib', 'gfpgan'):
        try:
            __import__(mod)
        except Exception as exc:
            raise _missing(f'CodeFormer 依赖 {mod} 未安装（{type(exc).__name__}: {exc}）。'
                           'basicsr/facexlib 较重，setup 脚本未自动装；需按 CodeFormer upstream 手动安装。')
    if not (weight_dir / 'codeformer.pth').is_file():
        raise _missing('CodeFormer 权重缺失：codeformer.pth')
    # 仅作"依赖是否存在"的探测：导入成功后立刻抛出未实现提示，故不需要引用 _CF。
    from basicsr.archs.codeformer_arch import CodeFormer as _CF  # type: ignore  # noqa: F401
    raise _missing('CodeFormer: 已检测到依赖，请在本 service 中按 face restore + GFPGAN 流程补全推理（当前仅接线、未实现联调）。')


# universal-matting ── tf_graph.pb，需 TensorFlow，就地封装提示。
def _build_matting(weight_dir: Path):
    """检查 universal-matting 的依赖与权重（当前仅接线、未实现推理）。

    Raises:
        HTTPException: TensorFlow 未安装 / 冻结图缺失 / 张量名待人工确认。
    """
    try:
        import tensorflow as tf  # type: ignore  # noqa: F401
    except Exception as exc:
        raise _missing(
            f'universal-matting 需要 TensorFlow（{type(exc).__name__}: {exc}）。'
            'TF 依赖较重，setup 未自动装；请按 modelscope cv_unet_universal-matting '
            '示例补全 tf_graph.pb 冻结点名后启用。'
        )
    if not (weight_dir / 'tf_graph.pb').is_file():
        raise _missing('tf_graph.pb 缺失。')
    raise _missing(
        'universal-matting: tf_graph.pb 已就位，但冻结图张量名需手动指定（当前仅接线、未实现联调）。'
        '可查看 modelscope cv_unet_universal-matting 的推理脚本取 input/image + output/alpha '
        '名称后补全本 service 的推理逻辑。'
    )


# moge ── MoGe 深度+法线，官方包存在才可就地推理。
def _build_moge(weight_dir: Path):
    """构建 MoGe（ViT-L）并返回其 predict 闭包，支持深度 / 法线两种输出。

    Returns:
        `predict(img, params) -> np.ndarray`；`params['mode']=='normal'` 时输出
        法线的 RGB 可视化，否则输出归一化深度图。
    """
    torch, _, _ = _torch()
    try:
        # 探测用：真正的模型类由下一行的 moge.model 导入，这里只需让缺失时抛出友好提示。
        import moge  # type: ignore  # noqa: F401
    except Exception as exc:
        raise _missing(f'MoGe 官方包未安装（{type(exc).__name__}: {exc}）。'
                       '"pip install moge" 后用即可。本地权重我们直接用 s*afetensors 文件加载模型状态。')
    from moge.model import MoGeModel  # type: ignore
    depth_fp = weight_dir / 'geometry_estimation' / 'moge_1_vitl_fp16.safetensors'
    normal_fp = weight_dir / 'geometry_estimation' / 'moge_2_vitl_normal_fp16.safetensors'
    model = MoGeModel(backbone='vitl')
    if depth_fp.is_file():
        model.load_state_dict(torch.load(str(depth_fp), map_location='cpu', weights_only=False))
    else:
        raise _missing(f'MoGe 深度/相机权重缺失：{depth_fp}')
    model.eval().to('cuda' if torch.cuda.is_available() else 'cpu')

    def predict(img: np.ndarray, params: dict) -> np.ndarray:
        """按 mode 产出深度图（灰度）或法线图（RGB）。"""
        pil = PIL.Image.fromarray(np.clip(img, 0, UINT8_MAX).astype(np.uint8)).convert('RGB')
        out = model.infer(pil, device=next(model.parameters()).device)
        mode = params.get('mode', 'depth')
        if mode != 'normal':
            d = out['depth']
            # 与 depth 工具一致：按自身 min/ptp 拉伸到满量程。
            d = (d - d.min()) / (d.ptp() + NORMALIZE_EPS) * PIXEL_MAX
            return np.stack([d, d, d], axis=-1).astype(np.float32)
        nrm = out['normal']
        if hasattr(nrm, 'alpha'):  # fp16 autograd 探测时 tensor 带 alpha
            nrm = nrm.detach()
        # 法线值域 [-1,1] → [0,1]：先 *0.5 再 +0.5（即 *NORMAL_RANGE + NORMAL_RANGE）。
        n = (np.asarray(nrm.float().permute(1, 2, 0).cpu()) * NORMAL_RANGE + NORMAL_RANGE) * PIXEL_MAX
        return np.clip(n, 0, UINT8_MAX).astype(np.float32)

    return predict


# ─── 工具注册表（惰性构建） ───────────────────────────────────────────────────

class _Tool:
    """单个工具的惰性包装：首次调用时才构建模型，构建失败则缓存该异常。"""

    def __init__(self, build: Callable[[Path, Optional[str]], Callable]):
        self._build = build
        self._predict: Optional[Callable] = None
        # 缓存构建失败原因：避免每次请求都重复一次昂贵的（且注定失败的）初始化。
        self._err: Optional[HTTPException] = None

    def predict(self, weight_dir: Path, params: dict, tool: str) -> bytes:
        """执行一次推理并把结果编码成 PNG 字节。

        Args:
            weight_dir: 该工具的权重目录。
            params: 参数字典（`_img` 为 PIL 图，其余为工具私有参数）。
            tool: 工具名（仅用于错误文案）。

        Returns:
            PNG 字节。

        Raises:
            HTTPException: 模型构建失败（复用首次失败的原因）。
        """
        if self._predict is None and self._err is None:
            try:
                self._predict = self._build(weight_dir, tool)
            except HTTPException as exc:
                self._err = exc
            except Exception as exc:  # noqa: BLE001
                self._err = _missing(f'{tool} 初始化失败: {type(exc).__name__}: {exc}')
        if self._err is not None:
            raise self._err
        arr = self._predict(np.array(params['_img']), params)
        return _save_png(arr)


_TOOLS: dict[str, _Tool] = {
    'esrgan': _Tool(lambda wd, tool: _build_esrgan(wd)),
    'mlsd': _Tool(lambda wd, tool: _build_mlsd(wd)),
    'depth': _Tool(lambda wd, tool: _build_depth(wd)),
    'rmbg': _Tool(lambda wd, tool: _build_birefnet(wd, 'rmbg')),
    'birefnet': _Tool(lambda wd, tool: _build_birefnet(wd, 'birefnet')),
    'codeformer': _Tool(lambda wd, tool: _build_codeformer(wd)),
    'matting': _Tool(lambda wd, tool: _build_matting(wd)),
    'moge': _Tool(lambda wd, tool: _build_moge(wd)),
}

# 每个工具在 MODEL_ROOT 下的权重子目录。
_TOOL_DIR = {
    'rmbg': 'RMBG-2.0', 'birefnet': 'BiRefNet', 'codeformer': 'CodeFormer',
    'esrgan': 'cv_rrdb_image-super-resolution_x2', 'matting': 'cv_unet_universal-matting',
    'depth': 'Depth-Anything-V2', 'moge': 'MoGe', 'mlsd': 'M-LSD-tiny-LiteRT',
}


# ─── FastAPI ─────────────────────────────────────────────────────────────────

# 关闭自动文档页：该服务只被内部适配器调用，不需要暴露 Swagger UI。
app = FastAPI(title='MeshForge ImageOpt', docs_url=None, redoc_url=None)

@app.get('/health')
def health() -> dict:
    """GET /health — 存活探测；返回当前注册的全部工具名。"""
    return {'ok': True, 'tools': list(_TOOLS)}


@app.post('/generate')
async def generate(tool: str = Form(...), image: UploadFile = File(...)) -> bytes:
    """POST /generate — 按 `tool` 分派到对应模型，返回处理后的 PNG 字节。

    Args:
        tool: 工具名（见文件头的支持列表）。
        image: 输入图片（multipart 上传）。

    Raises:
        HTTPException: 未知 tool（400）、图片无法解析（400）、
            模型根目录/权重缺失（500）。
    """
    t = _TOOLS.get(tool)
    if t is None:
        raise HTTPException(status_code=400, detail=f'未知工具 tool={tool}，可选: {", ".join(_TOOLS)}')
    data = await image.read()
    try:
        img = PIL.Image.open(io.BytesIO(data)).convert('RGB')
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'无法解析上传图片: {exc}')
    if not MODEL_ROOT.is_dir():
        raise _missing(f'模型根目录不存在：{MODEL_ROOT}。可用 MESHFORGE_IMAGEOPT_MODEL_ROOT 环境变量覆盖。')
    wd = MODEL_ROOT / _TOOL_DIR[tool]
    # 图片通过 params 传入 predict（保持 predict 签名的统一性）。
    params = {'_img': img}
    return t.predict(wd, params, tool)


def main() -> None:
    """CLI 入口：解析参数后直接拉起 uvicorn。"""
    global MODEL_ROOT
    ap = argparse.ArgumentParser(description='MeshForge 图像预处理推理服务')
    ap.add_argument('--model-root', default=str(MODEL_ROOT.parent))
    ap.add_argument('--model', default='ImageOptimization')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8783)
    args = ap.parse_args()
    # 用 CLI 参数重算权重根目录，覆盖模块导入时的环境变量取值。
    MODEL_ROOT = Path(args.model_root) / args.model
    # log_level=warning：该服务被适配器高频调用，info 级会把日志刷爆。
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
