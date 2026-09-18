"""MeshForge Hunyuan3D-2 推理服务（独立进程）。

承载 ``generators/`` 中 Hunyuan3D 系列生成器的**模型侧**。
默认加载 Hunyuan3D-2-mini 权重（向后兼容），也可从本地目录加载完整的
Hunyuan3D-2 权重（由环境变量 HY3DGEN_MODELS 指定，见 hy3dgen 包里的
``smart_load_model``），并对外暴露两个与 MeshForge 生成器约定一致的接口：

  GET  /health   -> {"status": "ok", "model": ..., "loaded": bool}
  POST /generate -> multipart：图片文件 + steps/guidance
                    返回生成的网格（GLB 字节）

它必须运行在 *hy3dgen* 那个 virtualenv 里（Python 3.11 + torch cu12x +
hy3dgen + pymeshlab ...），**不能**跑在轻量的 MeshForge 服务端 venv 中。
典型启动方式：

  D:/github/hy3dgen-venv/Scripts/python.exe hunyuan_service.py
    --model-root D:/github/models
    --port 8767              # Hunyuan3D-2-mini
    --port 8768 --model Hunyuan3D-2   # 完整版 Hunyuan3D-2（turbo 子目录）

服务跑起来后，把对应生成器的 URL 环境变量指向它即可。

模型选择相关环境变量（同样暴露为命令行参数）：
  HY3DGEN_MODEL     Hunyuan3D-2 | Hunyuan3D-2mini        （默认：Hunyuan3D-2mini）
  HY3DGEN_SUBFOLDER 完整版用：hunyuan3d-dit-v2-0-turbo（默认）|
                    hunyuan3d-dit-v2-0 | hunyuan3d-dit-v2-0-fast
  HY3DGEN_OFFLOAD   none | model     -> 取 "model" 时启用
                    enable_model_cpu_offload()（需要 accelerate>=0.17）。默认 none。
  HY3DGEN_DEVICE    auto | cuda | cpu。取 "cpu" 时用 fp32（完整模型放进内存；
                    慢，但能让没有可用 GPU 的机器跑起来）。
"""

import argparse
import io
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response

logger = logging.getLogger('hunyuan')

# ─── 重量级 import 延后到真正用模型时，保证 --help / 文档接口依然轻量 ────────
_IMPORT_LOCK = threading.Lock()
_PIPELINE = None
_PIPELINE_DEVICE = None
_PIPELINE_LOCK = threading.Lock()  # 6 GB VRAM only fits one job at a time
_START = time.time()

# 与 generators/hunyuan.py 共享的端点契约默认值
DEFAULT_STEPS = 20
DEFAULT_GUIDANCE = 4.0
DEFAULT_OCTREE = 256
DEFAULT_BOX_V = 1.01
DEFAULT_SEED = -1  # <0 => random each run; >=0 => reproducible

# ─── 底盘切除启发式（_remove_base_disc）──────────────────────────────────────
# 从底部向上逐层扫描，找"点数骤降"的那一层作为底盘分界；再用悬垂比做安全门，
# 避免把平底物体（马克杯、方块、花瓶）误切。
BASE_DISC_LAYER_RATIO = 0.02           # 扫描层厚度 = 模型高度的 2%
BASE_DISC_MAX_SCAN_RATIO = 0.15        # 只扫描底部 15% 的高度
BASE_DISC_DROP_RATIO = 0.35            # 层点数跌破上一层的 35% → 疑似底盘边界
BASE_DISC_MIN_THICKNESS_RATIO = 0.005  # 底盘最小厚度（占模型高度）
BASE_DISC_OVERHANG_RATIO = 1.05        # 底面半径需 > 上方 1.05 倍才算"外扩底盘"

# ─── 网格规模 / 单位 ─────────────────────────────────────────────────────────
MAX_FACES = 120_000                    # 超过则触发面数简化（FaceReducer）
MIN_RING_VERTICES = 3                  # 构成一个三角环所需的最少顶点数
BYTES_PER_GB = 1e9                     # 显存字节 → GB（十进制，与 nvidia-smi 口径一致）


# 各模型变体加载的子目录，位于 model_root 下各自的 model_dir 内。
_FULL_SUBFOLDERS = {
    'hunyuan3d-dit-v2-0': 'hunyuan3d-dit-v2-0',          # standard, 50-step CFG
    'hunyuan3d-dit-v2-0-turbo': 'hunyuan3d-dit-v2-0-turbo',  # distilled, low-VRAM
    'hunyuan3d-dit-v2-0-fast': 'hunyuan3d-dit-v2-0-fast',
}
_FULL_SUBFOLDER_DEFAULT = 'hunyuan3d-dit-v2-0-turbo'

# Hunyuan3D-2mv（多视图）：需要 {front,left,back,right} 四向视图。
_MV_SUBFOLDERS = {
    'hunyuan3d-dit-v2-mv': 'hunyuan3d-dit-v2-mv',          # standard
    'hunyuan3d-dit-v2-mv-turbo': 'hunyuan3d-dit-v2-mv-turbo',  # distilled, low-VRAM
    'hunyuan3d-dit-v2-mv-fast': 'hunyuan3d-dit-v2-mv-fast',
}
_MV_SUBFOLDER_DEFAULT = 'hunyuan3d-dit-v2-mv-turbo'


def _model_config() -> tuple[str, str]:
    """由环境变量解析出 (模型目录名, 子目录名)（启动时调用一次即可）。

    支持三档：多视角（-2mv）、mini（-2mini）、完整版（-2，可选子目录）。
    子目录名不在白名单时会打警告并回退到默认值，避免拼错导致找不到权重。

    Returns:
        `(model_dir, subfolder)` 二元组。
    """
    model = os.environ.get('HY3DGEN_MODEL', 'Hunyuan3D-2mini').strip()
    model_key = (model or '').lower()
    if model_key.endswith('2mv') or 'hunyuan3d-2mv' in model_key:
        subfolder = os.environ.get('HY3DGEN_SUBFOLDER', _MV_SUBFOLDER_DEFAULT).strip()
        if subfolder not in _MV_SUBFOLDERS:
            logger.warning('unknown HY3DGEN_SUBFOLDER=%r for MV, falling back to %r',
                           subfolder, _MV_SUBFOLDER_DEFAULT)
            subfolder = _MV_SUBFOLDER_DEFAULT
        # 解析为 <model_root>/Hunyuan3D-2mv/<subfolder> —— 与实际下载位置
        # （D:/github/models/Hunyuan3D-2mv/）一致；没有 `tencent/` 前缀。
        return 'Hunyuan3D-2mv', subfolder
    if model_key.endswith('mini'):
        # mini 只有一个固定子目录，无需可配置。
        return 'Hunyuan3D-2mini', 'hunyuan3d-dit-v2-mini'
    subfolder = os.environ.get('HY3DGEN_SUBFOLDER', _FULL_SUBFOLDER_DEFAULT).strip()
    if subfolder not in _FULL_SUBFOLDERS:
        logger.warning('unknown HY3DGEN_SUBFOLDER=%r, falling back to %r',
                       subfolder, _FULL_SUBFOLDER_DEFAULT)
        subfolder = _FULL_SUBFOLDER_DEFAULT
    return 'Hunyuan3D-2', subfolder


def _load_pipeline(model_root: str, device: str) -> object:
    """惰性构建 Hy3D pipeline 单例。

    Args:
        model_root: 权重父目录（会写回 HY3DGEN_MODELS 供 hy3dgen 内部读取）。
        device: 'auto' | 'cuda' | 'cpu'。

    Returns:
        已就绪的 pipeline；重复调用命中缓存。
    """
    global _PIPELINE, _PIPELINE_DEVICE
    with _IMPORT_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE

        # 重依赖放在这里 import：只有真要跑模型时才加载 torch/hy3dgen。
        import torch
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        # CUDA 用 fp16 省显存；CPU 上 fp16 反而慢且可能不支持，故用 fp32。
        dtype = torch.float16 if device == 'cuda' else torch.float32
        if device == 'cuda':
            logger.info('CUDA device: %s (%.1f GB)',
                        torch.cuda.get_device_name(0),
                        torch.cuda.get_device_properties(0).total_memory / BYTES_PER_GB)

        model_dir, subfolder = _model_config()
        offload = os.environ.get('HY3DGEN_OFFLOAD', 'none').strip().lower()
        if device != 'cuda' and offload != 'none':
            # offload 是"显存不够才把模块挪回 CPU"，CPU 推理下没有意义。
            logger.info('offload only makes sense on CUDA; ignoring HY3DGEN_OFFLOAD')
            offload = 'none'

        # hy3dgen 内部按 HY3DGEN_MODELS 找权重根目录，这里必须显式写回。
        os.environ['HY3DGEN_MODELS'] = model_root
        pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            model_dir,
            subfolder=subfolder,
            device=device,
            dtype=dtype,
        )

        if device == 'cuda':
            if offload == 'model':
                # 每个模块在自己的步骤时搬上 GPU、用完搬回 CPU，
                # 显存峰值 ≈ 单个最大模块。需要 accelerate>=0.17。
                pipeline.enable_model_cpu_offload()
            else:
                pipeline.to(device, dtype)
        else:
            pipeline.to(device, dtype)

        _PIPELINE, _PIPELINE_DEVICE = pipeline, device
        logger.info('loaded %s/%s on %s (offload=%s)',
                    model_dir, subfolder, device, offload)
        return pipeline


def _remove_base_disc(mesh) -> object:
    """切掉 Hunyuan 常加在底部的薄支撑底盘。

    检测思路：在网格最低的 15% 高度内按薄 y 层扫描；底盘层的顶点数远多于
    任何实体层（它是一张平面封盖）——第一个"骤降"处即底盘顶面。切掉它
    以下的全部内容，并用纯 trimesh 的扇形三角化把平面洞补上
    （**热路径上不用 pymeshlab**——它的 C++ 层在某些非流形切面上会让整个
    服务段错误崩掉）。

    Args:
        mesh: trimesh.Trimesh 实例。

    Returns:
        处理后的网格；若无明显底盘 / 不满足安全门条件，则原样返回。
    """
    import trimesh

    v = mesh.vertices
    y0 = float(v[:, 1].min())
    h = float(v[:, 1].max()) - y0
    # 退化网格（零高度 / 无面）直接返回，后续算法都依赖 y 方向有跨度。
    if h <= 0 or len(mesh.faces) == 0:
        return mesh

    layer_h = h * BASE_DISC_LAYER_RATIO
    prev = 0
    cut = None
    y = y0
    while y - y0 < h * BASE_DISC_MAX_SCAN_RATIO - 1e-9:
        band = v[(v[:, 1] >= y) & (v[:, 1] < y + layer_h)]
        n = len(band)
        # 判定"骤降"：本层点数不足上一层的 35%，且已有足够厚度（排除噪点层）。
        if prev > 0 and n > 0 and n < BASE_DISC_DROP_RATIO * prev and (y - y0) > h * BASE_DISC_MIN_THICKNESS_RATIO:
            cut = y
            break
        # 只记历史最高层点数：底盘下方可能有更薄的过渡层，逐层比较会漏判。
        if n > prev:
            prev = n
        y += layer_h

    if cut is None or cut - y0 < h * BASE_DISC_MIN_THICKNESS_RATIO:
        return mesh  # no obvious flat disc

    # 安全门槛：只有底层明显外扩于其上方主体时才切割
    # （r_below > BASE_DISC_OVERHANG_RATIO * r_above）。真正的平底物体（杯、
    # 方块、花瓶）底盘与主体同大，绝不能切。
    import numpy as _np

    # 用与质心的径向距离近似"半径"：比取包围盒更抗噪，且计算量小。
    cx = float(v[:, 0].mean())
    cz = float(v[:, 2].mean())
    rad2 = (v[:, 0] - cx) ** 2 + (v[:, 2] - cz) ** 2
    below = rad2[(v[:, 1] >= y0) & (v[:, 1] < cut)]
    # 上方取 cut 再往上 2 层，跳开切面附近的过渡带。
    above = rad2[v[:, 1] >= cut + layer_h * 2]
    if len(below) == 0 or len(above) == 0:
        return mesh
    r_below = float(_np.sqrt(below.max()))
    r_above = float(_np.sqrt(above.max()))
    if r_above <= 0 or r_below <= BASE_DISC_OVERHANG_RATIO * r_above:
        return mesh  # bottom is not wider than the body — not a support disc

    # 只要三角形的三个顶点都在切面之上就保留该面（避免留下悬挂的碎面）。
    keep = v[mesh.faces, 1].min(axis=1) >= cut - 1e-5
    if keep.all():
        return mesh

    faces = mesh.faces[keep]
    out = trimesh.Trimesh(vertices=v, faces=faces, process=True)
    if out.is_watertight:
        return out

    # 封补边界洞：沿开放边环行走，向质心做扇形三角化。
    # 边界边 = 只属于一个三角形的边（排序后去重计数为 1）。
    es = _np.sort(out.edges, axis=1)
    uniq, counts = _np.unique(es, axis=0, return_counts=True)
    boundary = uniq[counts == 1]
    if len(boundary) == 0:
        return out

    # 沿环行走（每个边界顶点在环上的度均为 2）。
    adj: dict = {}
    for be in boundary:
        a, b = int(be[0]), int(be[1])
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)

    # 沿着环走一圈收集顺序：环上每个顶点度数恰为 2，所以"非来路"的唯一邻居
    # 就是下一个顶点。
    start = int(boundary[0, 0])
    ring = [start]
    cur, prev_v = start, -1
    while True:
        nbrs = [x for x in adj.get(cur, []) if x != prev_v]
        if not nbrs:
            break
        nxt = nbrs[0]
        if nxt == start and len(ring) > 2:
            break
        ring.append(nxt)
        prev_v, cur = cur, nxt
        # 兜底死循环保护：环长不可能超过顶点总数太多。
        if len(ring) > len(adj) + 2:
            break

    if len(ring) < MIN_RING_VERTICES:
        return out

    # 扇形三角化：环上顶点 + 一个新加的中心点（质心），按绕序连成三角扇。
    rv = out.vertices[ring]
    cx, cz = float(rv[:, 0].mean()), float(rv[:, 2].mean())
    cy = float(rv[:, 1].mean())
    center_idx = len(out.vertices)
    out_verts = _np.vstack([out.vertices, [[cx, cy, cz]]])
    n = len(ring)
    fan = [(ring[i], center_idx, ring[(i + 1) % n]) for i in range(n)]
    tmp = trimesh.Trimesh(
        vertices=out_verts,
        faces=_np.vstack([out.faces, _np.asarray(fan, dtype=_np.int64)]),
        process=False,
    )
    if not tmp.is_watertight:
        # 绕序反了会导致法线朝内（非水密），换成另一种绕序再试一次。
        fan = [(ring[i], ring[(i + 1) % n], center_idx) for i in range(n)]
        tmp = trimesh.Trimesh(
            vertices=out_verts,
            faces=_np.vstack([out.faces, _np.asarray(fan, dtype=_np.int64)]),
            process=False,
        )
    return tmp


def _to_glb(result, reduce_faces: bool, remove_base: bool = True) -> bytes:
    """把 pipeline 的返回值（List[List[Trimesh]]）拍平并导出 GLB 字节。

    Args:
        result: pipeline 输出，可能嵌套一层 list/tuple。
        reduce_faces: 面数超过 `MAX_FACES` 时是否触发简化。
        remove_base: 是否执行底盘切除。

    Returns:
        GLB 二进制的字节内容。

    Raises:
        RuntimeError: 没有网格 / 空网格 / 输出类型不符合预期。
    """
    import trimesh

    # pipeline 返回 List[List[Trimesh]]：第一层是 batch，这里只取第一个样本。
    meshes = result[0] if isinstance(result, (list, tuple)) else result
    if isinstance(meshes, (list, tuple)):
        mesh = meshes[0]
    else:
        mesh = meshes

    if mesh is None:
        raise RuntimeError('pipeline returned no mesh')
    if len(mesh.faces) == 0 or len(mesh.vertices) == 0:
        raise RuntimeError('pipeline returned an empty mesh')

    if remove_base:
        mesh = _remove_base_disc(mesh)

    if reduce_faces and len(mesh.faces) > MAX_FACES:
        try:
            from hy3dgen.shapegen import FaceReducer
            mesh = FaceReducer()(mesh, max_facenum=MAX_FACES)
        except Exception as exc:  # noqa: BLE001 - simplification is best-effort
            # 简化失败不影响交付：面数多一点总比拿不到模型好。
            logger.warning('face reduction skipped: %s', exc)

    if isinstance(mesh, trimesh.Trimesh):
        buf = io.BytesIO()
        mesh.export(buf, file_type='glb')
        return buf.getvalue()
    raise RuntimeError(f'unexpected pipeline output type: {type(mesh)}')


app = FastAPI(title='MeshForge Hunyuan3D-2-mini inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    """GET /health — 健康检查；回传当前模型配置与是否已加载权重。"""
    model_dir, subfolder = _model_config()
    return {
        'status': 'ok',
        'model': f'{model_dir}/{subfolder}',
        'loaded': _PIPELINE is not None,
        'uptime_s': int(time.time() - _START),
    }


@app.post('/generate')
async def generate(
    image: UploadFile = File(...),
    steps: int = Form(DEFAULT_STEPS),
    guidance: float = Form(DEFAULT_GUIDANCE),
    octree: int = Form(DEFAULT_OCTREE),
    seed: int = Form(DEFAULT_SEED),
    remove_base: int = Form(1),
) -> Response:
    """POST /generate — 单图生网格，返回 `model/gltf-binary`（GLB）。

    Args:
        image: 输入图片（multipart 上传）。
        steps: 扩散采样步数。
        guidance: 引导强度（classifier-free guidance）。
        octree: 等值面提取的八叉树分辨率（越大越精细、越吃显存）。
        seed: 随机种子；负值表示不固定。
        remove_base: 非 0 时执行底盘切除。
    """
    model_root = os.environ.get('HY3DGEN_MODELS', '')
    if not model_root:
        return Response('HY3DGEN_MODELS not configured on the service', status_code=500)

    try:
        pipeline = _load_pipeline(model_root, os.environ.get('HY3DGEN_DEVICE', 'auto'))
    except Exception as exc:  # noqa: BLE001
        return Response(f'model load failed: {exc}', status_code=500)

    # 临时目录承载上传图；请求结束自动清理，不污染权重目录。
    with tempfile.TemporaryDirectory(prefix='hy3d_') as tmp:
        suffix = Path(image.filename or 'input.png').suffix or '.png'
        src = Path(tmp) / f'input{suffix}'
        src.write_bytes(await image.read())

        try:
            with _PIPELINE_LOCK:  # one inference at a time
                gen = None
                # seed >= 0 才建生成器；负值交给 pipeline 自己随机。
                if int(seed) >= 0:
                    import torch
                    gen = torch.Generator(device=_PIPELINE_DEVICE or 'cpu').manual_seed(int(seed))
                out = pipeline(
                    str(src),
                    num_inference_steps=int(steps),
                    guidance_scale=float(guidance),
                    octree_resolution=int(octree),
                    box_v=DEFAULT_BOX_V,
                    # mc_level=0.0：以 SDF 零等值面作为提取阈值。
                    mc_level=0.0,
                    generator=gen,
                )
            payload = _to_glb(out, reduce_faces=True, remove_base=int(remove_base) != 0)
        except Exception as exc:  # noqa: BLE001 - surface a clean error
            return Response(f'inference failed: {exc}', status_code=500)

    if not payload:
        return Response('empty mesh produced', status_code=500)
    return Response(content=payload, media_type='model/gltf-binary')


@app.post('/generate-mv')
async def generate_mv(
    front: UploadFile = File(...),
    left: UploadFile = File(...),
    back: UploadFile = File(...),
    right: UploadFile = File(...),
    steps: int = Form(DEFAULT_STEPS),
    octree: int = Form(DEFAULT_OCTREE),
    seed: int = Form(DEFAULT_SEED),
    remove_base: int = Form(1),
) -> Response:
    """多视角形状生成（Hunyuan3D-2mv）。

    需要 front/left/back/right 四个规范视角分别作为 multipart 文件上传
    （视角顺序见 MVImageProcessorV2 的 view2idx）。仅在服务以
    --model tencent/Hunyuan3D-2mv 启动时才有意义；否则单图 pipeline
    没有 MV 编码器，本接口必然失败（见下方 400 分支）。

    Args:
        front: 正视图。
        left: 左视图。
        back: 后视图。
        right: 右视图。
        steps / octree / seed / remove_base: 同单图接口。
    """
    model_root = os.environ.get('HY3DGEN_MODELS', '')
    if not model_root:
        return Response('HY3DGEN_MODELS not configured on the service', status_code=500)
    # 模型不匹配属于调用方误用，用 400 与"服务端故障"区分开。
    if '2mv' not in (os.environ.get('HY3DGEN_MODEL', '') or '').lower():
        return Response('service is not running the Hunyuan3D-2mv model', status_code=400)

    try:
        pipeline = _load_pipeline(model_root, os.environ.get('HY3DGEN_DEVICE', 'auto'))
    except Exception as exc:  # noqa: BLE001
        return Response(f'model load failed: {exc}', status_code=500)

    with tempfile.TemporaryDirectory(prefix='hy3d_mv_') as tmp:
        # 按固定视角顺序落盘；pipeline 依据字典里的 tag 找对应视角。
        views: dict[str, str] = {}
        for tag, upload in (('front', front), ('left', left),
                            ('back', back), ('right', right)):
            suffix = Path(upload.filename or 'view.png').suffix or '.png'
            path = Path(tmp) / f'{tag}{suffix}'
            path.write_bytes(await upload.read())
            views[tag] = str(path)

        try:
            with _PIPELINE_LOCK:  # one inference at a time
                gen = None
                if int(seed) >= 0:
                    import torch
                    gen = torch.Generator(device=_PIPELINE_DEVICE or 'cpu').manual_seed(int(seed))
                out = pipeline(
                    views,
                    num_inference_steps=int(steps),
                    # MV 路径没有 guidance 参数（该模型蒸馏后不需要 CFG）。
                    octree_resolution=int(octree),
                    box_v=DEFAULT_BOX_V,
                    mc_level=0.0,
                    generator=gen,
                )
            payload = _to_glb(out, reduce_faces=True, remove_base=int(remove_base) != 0)
        except Exception as exc:  # noqa: BLE001 - surface a clean error
            return Response(f'inference failed: {exc}', status_code=500)

    if not payload:
        return Response('empty mesh produced', status_code=500)
    return Response(content=payload, media_type='model/gltf-binary')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('HY3DGEN_MODELS', ''),
                        help='parent dir of the Hunyuan3D weights folder')
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--model', default=os.environ.get('HY3DGEN_MODEL', 'Hunyuan3D-2mini'),
                        help='Hunyuan3D-2mini (default) | Hunyuan3D-2')
    parser.add_argument('--subfolder', default=os.environ.get('HY3DGEN_SUBFOLDER', ''),
                        help='full-variant subfolder: hunyuan3d-dit-v2-0 '
                             '(standard) | -turbo (default when full) | -fast')
    parser.add_argument('--offload', default=os.environ.get('HY3DGEN_OFFLOAD', 'none'),
                        help='none | model  (enable_model_cpu_offload on CUDA)')
    parser.add_argument('--device', default=os.environ.get('HY3DGEN_DEVICE', 'auto'),
                        help='auto | cuda | cpu')
    parser.add_argument('--preload', action='store_true',
                        help='load model weights at startup (instead of on first /generate)')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format='[hunyuan] %(levelname)s: %(message)s')

    if not args.model_root:
        logger.error('--model-root is required (e.g. D:/github/models)')
        raise SystemExit(2)
    # 命令行参数统一写回环境变量：运行期所有取值都只读环境变量。
    os.environ['HY3DGEN_MODELS'] = args.model_root
    os.environ['HY3DGEN_MODEL'] = args.model
    if args.subfolder:
        os.environ['HY3DGEN_SUBFOLDER'] = args.subfolder
    os.environ['HY3DGEN_OFFLOAD'] = args.offload
    if args.device:
        os.environ['HY3DGEN_DEVICE'] = args.device

    if args.preload:
        import threading

        def _warmup() -> None:
            """后台线程里预热权重，避免阻塞 uvicorn 起来（/health 可立刻响应）。"""
            logger.info('preloading model weights ...')
            try:
                _load_pipeline(args.model_root, args.device)
                logger.info('model preloaded')
            except Exception as exc:  # noqa: BLE001
                # 预热失败不退出：留给首个 /generate 请求去报更具体的错。
                logger.error('preload FAILED: %s', exc)

        # daemon=True：主进程退出时该线程不阻塞进程结束。
        threading.Thread(target=_warmup, daemon=True).start()

    import uvicorn

    logger.info('model root: %s (preload=%s)', args.model_root,
                'on' if args.preload else 'off')
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
