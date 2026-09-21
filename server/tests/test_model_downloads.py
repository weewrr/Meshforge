"""模型下载（ModelScope CLI）单元测试 —— 设置页「模型下载」分区。

既可用 pytest 运行（`python -m pytest server/tests/test_model_downloads.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_model_downloads.py`）——
独立模式下自动把 server/ 加入 sys.path，并输出逐条 PASS/FAIL 结果。

覆盖点：
- modelscope 启动时打印的 ASCII banner 必须被过滤，不能污染转发给前端的进度行；
- tqdm 的 \\r 原地刷新要压成「每个逻辑行只留最新一段」，同时保住收尾行；
- banner 过滤只在输出起始段生效，正文里的普通行一律照发；
- PROFILES 清单：key 唯一、含 Hunyuan3D-2 全系变体（标准 / mini / MV）；
- _installed_state：只有非 .part 文件才算已安装，纯 .part 目录判为未安装；
- /model-services/download/status 的载荷结构（供设置页渲染卡片）。
"""

import os
import sys
import tempfile
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_modeldl_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

import model_downloads as md  # noqa: E402
from routers.model_downloads import _clean_output, _is_banner_line  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    """运行单个用例并记录结果；独立运行模式下最终汇总输出。"""
    try:
        fn()
        RESULTS.append((name, True, ''))
        print(f'PASS {name}')
    except Exception as exc:  # noqa: BLE001
        RESULTS.append((name, False, f'{type(exc).__name__}: {exc}'))
        print(f'FAIL {name}: {type(exc).__name__}: {exc}')
        print(f'::error::{name}: {type(exc).__name__}: {exc}')


# ─── 样本：modelscope 启动 banner ─────────────────────────────────────────────
# 优先用 modelscope 自带的常量（随依赖升级自动跟随），未安装时退回实测文本。

_FALLBACK_BANNER = r"""
 _   .-')                _ .-') _     ('-.             .-')                              _ (`-.    ('-.
( '.( OO )_             ( (  OO) )  _(  OO)           ( OO ).                           ( (OO  ) _(  OO)
 ,--.   ,--.).-'),-----. \     .'_ (,------.,--.     (_)---\_)   .-----.  .-'),-----.  _.`     \(,------.
 |   `.'   |( OO'  .-.  ',`'--..._) |  .---'|  |.-') /    _ |   '  .--./ ( OO'  .-.  '(__...--'' |  .---'
 |         |/   |  | |  ||  |  \  ' |  |    |  | OO )\  :` `.   |  |('-. /   |  | |  | |  /  | | |  |
 |  |'.'|  |\_) |  |\|  ||  |   ' |(|  '--. |  |`-' | '..`''.) /_) |OO  )\_) |  |\|  | |  |_.' |(|  '--.
 |  |   |  |  \ |  | |  ||  |   / : |  .--'(|  '---.'.-._)   \ ||  |`-'|   \ |  | |  | |  .___.' |  .--'
 |  |   |  |   `'  '-'  '|  '--'  / |  `---.|      | \       /(_'  '--'\    `'  '-'  ' |  |      |  `---.
 `--'   `--'     `-----' `-------'  `------'`------'  `-----'    `-----'      `-----'  `--'      `------'
"""


def _banner_text() -> str:
    """取一份 banner 文本作测试样本（modelscope 常量优先）。"""
    try:
        from modelscope.hub.constants import MODELSCOPE_ASCII

        return MODELSCOPE_ASCII
    except Exception:  # noqa: BLE001 - 未装 modelscope 时退回实测文本
        return _FALLBACK_BANNER


# ─── banner 过滤 ──────────────────────────────────────────────────────────────

def test_banner_lines_are_detected() -> None:
    """banner 的每一行都要被识别出来，否则会漏进前端进度区。"""
    lines = [ln.strip() for ln in _banner_text().splitlines() if ln.strip()]
    assert lines, 'banner sample is empty'
    missed = [ln for ln in lines if not _is_banner_line(ln)]
    assert not missed, f'{len(missed)} banner line(s) not detected, e.g. {missed[:2]!r}'


def test_normal_lines_are_not_banner() -> None:
    """正常输出行不能被误判成 banner，否则真实进度会被吞掉。"""
    samples = [
        'README.md:   0%|          | 0.00/9.52k [00:00<?, ?B/s]',
        r'README.md -> D:\github\models\Hunyuan3D-2\README.md',
        'Model Tencent-Hunyuan/Hunyuan3D-2 not found on ModelScope',
        'Downloading [1/6]: model.fp16.safetensors',
    ]
    for line in samples:
        assert not _is_banner_line(line), f'misjudged as banner: {line!r}'


def test_banner_dropped_and_progress_collapsed() -> None:
    """整段输出：banner 全丢、tqdm 快照压成最新一条、收尾行保留。"""
    raw = (
        _banner_text()
        + '\n'
        + 'README.md:   0%|          | 0.00/9.52k [00:00<?, ?B/s]'
        + '\r'
        + 'README.md: 100%|##########| 9.52k/9.52k [00:00<00:00, 1.2MB/s]'
        + '\r'
        + 'README.md -> out/README.md'
        + '\n'
    ).encode('utf-8')

    events, phase = _clean_output(raw, True)

    assert phase is False, '见到第一条真实输出后应退出 banner 阶段'
    assert events == ['README.md -> out/README.md'], events


def test_banner_phase_only_applies_at_start() -> None:
    """banner 过滤只在起始段生效：之后的输出即使含特征串也要照发。"""
    raw = (
        "task: downloading\n"
        "note: the flag is '---force'\n"
    ).encode('utf-8')

    events, phase = _clean_output(raw, True)

    assert phase is False
    assert len(events) == 2, events


def test_trailing_partial_line_is_flushed() -> None:
    """末尾没有以换行结束的残段也要能转发出去。"""
    events, _ = _clean_output(b'no newline at end', True)
    assert events == ['no newline at end'], events


# ─── 档案清单 ─────────────────────────────────────────────────────────────────

def test_profiles_cover_hunyuan3d_family() -> None:
    """清单要覆盖 Hunyuan3D-2 全系（标准 / mini / MV），与 README 服务表一致。"""
    keys = [p.key for p in md.PROFILES]
    assert len(keys) == len(set(keys)), f'duplicate profile key in {keys}'
    for key in ('hunyuan3d-2', 'hunyuan3d-2-mini', 'hunyuan3d-2mv'):
        assert key in keys, f'missing profile: {key}'


def test_profiles_local_rel_is_relative() -> None:
    """local_rel 必须是单层相对目录名，防止越出 MODELS_ROOT。"""
    for p in md.PROFILES:
        rel = Path(p.local_rel)
        assert not rel.is_absolute(), f'{p.key}: local_rel must be relative'
        assert len(rel.parts) == 1, f'{p.key}: local_rel must be a single directory name'


def test_modelscope_ids_look_like_owner_name() -> None:
    """有 modelscope_id 的档案都必须是 owner/name 形状。"""
    for p in md.PROFILES:
        if p.modelscope_id is None:
            continue
        owner, sep, name = p.modelscope_id.partition('/')
        assert sep and owner and name, f'{p.key}: bad modelscope id {p.modelscope_id!r}'


def test_profile_lookup() -> None:
    """profile() 按 key 取档案，未知 key 返回 None。"""
    assert md.profile('hunyuan3d-2') is not None
    assert md.profile('hunyuan3d-2mv') is not None
    assert md.profile('__nope__') is None


# ─── 安装态判定 ───────────────────────────────────────────────────────────────

def test_installed_state_ignores_part_files() -> None:
    """只有非 .part 文件才算已安装；纯 .part 目录判为未安装。"""
    root = Path(tempfile.mkdtemp(prefix='meshforge_models_'))
    target = root / 'T'
    target.mkdir(parents=True)
    (target / 'w.bin.part').write_bytes(b'123')

    p = md.ModelProfile(key='t', label='T', local_rel='T', modelscope_id='a/b')
    saved = md.MODELS_ROOT
    md.MODELS_ROOT = root
    try:
        installed, size = md._installed_state(p)
        assert installed is False, '含 .part 的目录不能算已安装'
        assert size == 3, f'unexpected size {size}'

        (target / 'w.bin').write_bytes(b'12345')
        installed, size = md._installed_state(p)
        assert installed is True, '有真实文件后应判为已安装'
        assert size == 8, f'unexpected size {size}'
    finally:
        md.MODELS_ROOT = saved


# ─── 状态载荷 ─────────────────────────────────────────────────────────────────

def test_status_payload_shape() -> None:
    """download_status() 要给出 modelscope 可用性与每张卡片的字段。"""
    import asyncio

    import routers.model_downloads as rmd

    root = Path(tempfile.mkdtemp(prefix='meshforge_status_'))
    saved = (md.MODELS_ROOT, rmd.MODELS_ROOT)
    md.MODELS_ROOT = root
    rmd.MODELS_ROOT = root
    try:
        body = asyncio.run(rmd.download_status())
    finally:
        md.MODELS_ROOT, rmd.MODELS_ROOT = saved

    assert isinstance(body.get('modelscopeAvailable'), bool)
    assert 'modelscopeVersion' in body
    services = body.get('services')
    assert isinstance(services, list) and len(services) == len(md.PROFILES)
    for entry in services:
        for field in ('key', 'label', 'modelscopeId', 'hfRef', 'localDir', 'installed', 'sizeBytes', 'root'):
            assert field in entry, f'missing field {field!r} in card payload'
        assert entry['installed'] is False, '临时空目录下不应判为已安装'
        assert entry['sizeBytes'] == 0


if __name__ == '__main__':
    for _name, _fn in sorted(
        ((k, v) for k, v in list(globals().items()) if k.startswith('test_') and callable(v))
    ):
        check(_name, _fn)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed')
    sys.exit(1 if failed else 0)
