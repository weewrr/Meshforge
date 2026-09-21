"""外部 AI 服务模型权重的下载（走 ModelScope CLI）。

MeshForge 的 Hunyuan3D / InstantMesh / MVDream / Stable-Zero123 / Wonder3D ……
这些推理服务共用一套"权重根目录 = MESHFORGE_SERVICES_ROOT/models"（机器相关路径，
见 config.SERVICES_ROOT）。本模块把"要下载哪个模型、落到哪个子目录、装没装"集中为
一份数据驱动的清单，供设置页"模型下载"分区渲染卡片、并在用户点击下载时通过
`modelscope download` 命令把权重拉下来。

它不是核心后端的必需依赖：modelscope CLI 不可用时，列表只显示"未安装"并给出提示，
其余功能不受影响（与各生成器对缺失权重的降级一致）。
"""

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from config import SERVICES_ROOT

# 外部服务权重的根目录：<SERVICES_ROOT>/models/<服务子目录>。
MODELS_ROOT = SERVICES_ROOT / 'models'


@dataclass(frozen=True)
class ModelProfile:
    """一个可下载的模型权重档案。

    Attributes:
        key: 稳定 id，前后端用它对齐（也是 i18n 描述键的段名）。
        label: 展示名（服务专名，非本地化称谓）。
        local_rel: 权重落在 ``MODELS_ROOT/<local_rel>`` 的子目录名。
        modelscope_id: ModelScope 仓库 id；为 None 表示 ModelScope 上无单一仓库，
            仅能经 ``hf_ref`` 手动放置。
        hf_ref: 参考用的 Hugging Face 仓库 id（供手动下载 / 溯源）。
        files: 只下载这些仓库内路径（``modelscope download`` 的 files 位置参数）；
            留空表示整仓快照。用于跳过体积巨大的可选权重。
    """

    key: str
    label: str
    local_rel: str
    modelscope_id: str | None
    hf_ref: str | None = None
    files: tuple[str, ...] = ()


# ─── 可下载清单（设置页按此渲染卡片） ─────────────────────────────────────────
# 依据 README「部署模型总览」的推理服务逐一登记；modelscope_id 为 None 的
# 服务（ModelScope 上无单一权重仓库）卡片上不做下载，仅展示状态与 HF 参考。
# Hunyuan3D-2 家族登记三个变体（标准版 / mini / MV），与 README 的服务清单一致。
PROFILES: list[ModelProfile] = [
    ModelProfile(
        key='hunyuan3d-2',
        label='Hunyuan3D-2',
        local_rel='Hunyuan3D-2',
        modelscope_id='Tencent-Hunyuan/Hunyuan3D-2',
        hf_ref='tencent/Hunyuan3D-2',
    ),
    ModelProfile(
        key='hunyuan3d-2-mini',
        label='Hunyuan3D-2 mini',
        local_rel='Hunyuan3D-2mini',
        modelscope_id='Tencent-Hunyuan/Hunyuan3D-2mini',
        hf_ref='tencent/Hunyuan3D-2mini',
    ),
    ModelProfile(
        key='hunyuan3d-2mv',
        label='Hunyuan3D-2 MV',
        local_rel='Hunyuan3D-2mv',
        modelscope_id='Tencent-Hunyuan/Hunyuan3D-2mv',
        hf_ref='tencent/Hunyuan3D-2mv',
    ),
    ModelProfile(
        key='instantmesh',
        label='InstantMesh',
        local_rel='InstantMesh',
        modelscope_id='TencentARC/InstantMesh',
        hf_ref='TencentARC/InstantMesh',
    ),
    ModelProfile(
        key='stable-zero123',
        label='Stable Zero123',
        local_rel='stable-zero123',
        modelscope_id='stabilityai/stable-zero123',
        hf_ref='stabilityai/stable-zero123',
    ),
    ModelProfile(
        key='mvdream',
        label='MVDream',
        local_rel='MVDream',
        modelscope_id=None,
        hf_ref='ByteDance/MVDream',
    ),
    ModelProfile(
        key='wonder3d-plus',
        label='Wonder3D Plus',
        local_rel='Wonder3D_plus',
        modelscope_id=None,
        hf_ref='flamehaze1115/Wonder3D_plus',
    ),
    ModelProfile(
        key='imageopt',
        label='图像处理工具包 (imageopt)',
        local_rel='ImageOptimization',
        modelscope_id=None,
        hf_ref='',
    ),
]

_PROFILES: dict[str, ModelProfile] = {p.key: p for p in PROFILES}


def profile(key: str) -> ModelProfile | None:
    """按 key 查档案，未知 key 返回 None。"""
    return _PROFILES.get(key)


# ─── modelscope CLI 探测 ──────────────────────────────────────────────────────

def _modelscope_cli() -> Path | None:
    """在可执行环境中定位 `modelscope` 命令行入口；找不到返回 None。

    优先取与后端同一 Python 的 virtualenv（装了 modelscope 后其 console script
    就在 ``<venv>/Scripts/modelscope``），再回退系统 PATH。
    """
    if sys.prefix:
        bin_dir = Path(sys.prefix) / ('Scripts' if os.name == 'nt' else 'bin')
        exe = bin_dir / ('modelscope.exe' if os.name == 'nt' else 'modelscope')
        if exe.is_file():
            return exe
    found = shutil.which('modelscope')
    return Path(found) if found else None


def modelscope_version() -> str | None:
    """运行 `modelscope --version` 拿到版本号；不可用时返回 None。"""
    cli = _modelscope_cli()
    if cli is None:
        return None
    # 部分 CLI 对 --version 不响应，用 -v 补一轮。
    for flag in ('--version', '-v'):
        try:
            out = subprocess.run([str(cli), flag], capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            return None
        text = (out.stdout or out.stderr).strip()
        if out.returncode == 0 and text:
            return text.splitlines()[0]
    return None


# ─── 安装态探测 ───────────────────────────────────────────────────────────────

def _installed_state(profile: ModelProfile) -> tuple[bool, int]:
    """返回 (是否已下过权重, 目录占用字节数)。

    与 model.py 的判定一致：存在任一非 ``.part`` 的文件即视为"下过"，半成品不算。
    """
    folder = MODELS_ROOT / profile.local_rel
    if not folder.is_dir():
        return False, 0
    size = 0
    has_real = False
    for p in folder.rglob('*'):
        if p.is_file():
            size += p.stat().st_size
            if p.suffix != '.part':
                has_real = True
    return has_real, size