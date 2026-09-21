"""图像处理模型（category='image'）参数契约测试 —— 节点上不留「显存 / 6GB 卡」提示。

**用户反馈**：「图像处理节点没必要提示什么 6g 卡这些」。

背景与设计取舍：
- 节点上只应出现"改了会有用"的控件。显卡档位属于 README 部署章节的事，摆在画布节点里
  是纯噪音 —— 用户看一次就知道了，之后每次打开工作流都被念一遍。
- 历史上这里挂过 4 条 `type: 'label'` 的纯说明文字（`id='vram_note'`）：
  抠图(RMBG/BiRefNet)、Real-ESRGAN、CodeFormer、Universal Matting（后两条其实是
  "缺依赖"说明，却共用了「显存」这个表头）。
- 深度图还挂过一个 `low_vram` 下拉（选项写着「开 (518px, 6GB)」）——它不但是显存提示，
  而且**服务端根本没读这个参数**（`imageopt_service.py` 的 `/generate` 只声明了
  `tool` 与 `image`），是个点了没用的死控件，一并删掉。
- 缺依赖的场景不需要节点提示：`imageopt_service.py` 在真正调用时会抛出带安装指引的
  中文 500 错误，比节点上那句泛泛的提示精确得多（见该文件 `_build_codeformer` /
  `_build_matting`），本测试顺带把"后端提示仍在"锁住，确保删提示没有真的丢信息。

同时锁住"没删过头"：抠图的 `format`、MoGe 的 `mode` 这类真参数必须留下；
`label` 仍被建模模型（InstantMesh）使用，前端对它的支持不能因此被当成死代码删掉。

既可用 pytest 运行，也可独立执行：
    server/.venv/Scripts/python.exe server/tests/test_image_node_params.py
"""

import json
import os
import re
import sys
import tempfile
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_image_params_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from generators.registry import registry  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []

# 「显存」类提示的判定：中文词 + 「数字 + GB/G」的显卡档位写法。
# 只查参数字典的可见文案（label / default / options[].label），不查 tooltip：
# tooltip 是悬浮才出现的补充说明，不占节点版面，允许写显存与耗时之类的代价提示。
_VRAM_RE = re.compile(r'显存|\b\d+\s*GB\b|\b\d+\s*G\b', re.IGNORECASE)


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


def image_generators() -> list:
    """取全部图像处理模型（category='image'）。"""
    return [g for g in registry._generators.values() if getattr(g, 'category', None) == 'image']


def visible_texts(param: dict) -> list[str]:
    """一个参数在节点上会显示出来的全部文案（label / default / 选项标签）。"""
    out = [str(param.get('label', '')), str(param.get('default', ''))]
    for opt in param.get('options') or []:
        out.append(str(opt.get('label', '')))
    return [s for s in out if s]


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def _exactly_eight() -> None:
    """图像处理模型共 8 个 —— 少了说明顺手动坏了注册，多了说明分类串了。"""
    gs = image_generators()
    assert len(gs) == 8, f'期望 8 个图像处理模型，实际 {len(gs)}: {[g.id for g in gs]}'


check('图像处理模型恰好 8 个', _exactly_eight)


def _no_label_param() -> None:
    """节点上不该再有 label 型（纯说明文字）参数。"""
    for g in image_generators():
        labels = [p['id'] for p in g.params if p.get('type') == 'label']
        assert not labels, f'{g.id}: 仍有 label 型参数 {labels}（节点上的说明文字）'


check('图像处理节点都不再带 label 型参数', _no_label_param)


def _no_vram_hints_at_all() -> None:
    """★ 用户报告的诉求：节点可见文案里不许再出现「显存 / 6GB 卡」这类提示。"""
    offenders: list[str] = []
    for g in image_generators():
        for p in g.params:
            for text in visible_texts(p):
                if _VRAM_RE.search(text):
                    offenders.append(f'{g.id}.{p["id"]}: {text!r}')
    assert not offenders, '图像处理节点上仍出现显存/显卡档位提示：\n  ' + '\n  '.join(offenders)


check('★ 图像处理节点可见文案里无「显存 / 6GB」字样', _no_vram_hints_at_all)


def _vram_note_gone() -> None:
    """按 id 双重确认 4 条 vram_note 彻底删除，防止换个 id 又溜回来。"""
    for g in image_generators():
        ids = [p['id'] for p in g.params]
        assert 'vram_note' not in ids, f'{g.id}: vram_note 仍在'
        assert all(p.get('label') != '显存' for p in g.params), f'{g.id}: 仍有「显存」表头的参数'


check('4 条 vram_note（含「显存」表头）彻底消失', _vram_note_gone)


def _dead_low_vram_gone() -> None:
    """`low_vram` 是死控件（服务端没读）+ 显存品牌下拉，必须删。"""
    for g in image_generators():
        assert 'low_vram' not in [p['id'] for p in g.params], f'{g.id}: low_vram 仍在'


check('死控件 low_vram（点了没用且带 6GB 字样）已移除', _dead_low_vram_gone)


def _real_params_survive() -> None:
    """没删过头：真正有语义的参数必须留下。"""
    by_id = {g.id: g for g in image_generators()}

    for matting_id in ('image-rmbg', 'image-birefnet'):
        ids = [p['id'] for p in by_id[matting_id].params]
        assert ids == ['format'], f'{matting_id}: 应只剩 format，实际 {ids}'
        opts = by_id[matting_id].params[0]['options']
        assert {o['value'] for o in opts} == {'rgba', 'white'}, f'{matting_id}: format 选项被改坏 {opts}'

    moge = [p['id'] for p in by_id['image-moge'].params]
    assert moge == ['mode'], f'image-moge: 应只剩 mode，实际 {moge}'


check('真参数未被误删（抠图 format / MoGe mode）', _real_params_survive)


def _zero_param_nodes_are_intentional() -> None:
    """超分 / 深度 / 线段 / 人像修复 / Matting 本就无参数，应是真的空列表而不是 None。"""
    by_id = {g.id: g for g in image_generators()}
    for gen_id in ('image-esrgan', 'image-depth', 'image-mlsd', 'image-codeformer', 'image-matting'):
        params = by_id[gen_id].params
        assert params == [], f'{gen_id}: 参数应为空列表，实际 {params!r}'


check('无参数的五类节点参数为空列表（不残留 None/占位）', _zero_param_nodes_are_intentional)


def _label_type_still_supported() -> None:
    """`label` 仍是受支持的 schema 值：建模模型还在用，前端不能把它当死代码删掉。"""
    others = [
        (g.id, p)
        for g in registry._generators.values()
        if getattr(g, 'category', None) != 'image'
        for p in g.params
        if p.get('type') == 'label'
    ]
    assert others, '预期仍有其它扩展在用 type=label（否则前端支持它的理由就没了）'
    assert all('default' in p for _, p in others), 'label 型参数必须带 default（它就是要显示的文案）'


check('label 型参数在其它类别仍在使用（前端需继续支持）', _label_type_still_supported)


def _backend_error_message_still_exists() -> None:
    """删掉节点提示的前提：缺依赖时后端要给出明确中文指引，不能变成静默失败。"""
    source = (SERVER_DIR / 'imageopt_service.py').read_text(encoding='utf-8')
    for needle in ('_build_codeformer', '_build_matting', 'CodeFormer 依赖', 'TensorFlow'):
        assert needle in source, f'imageopt_service.py 里找不到 {needle!r}，后端提示可能被删了'
    # 未实现/缺依赖一律经 _missing(...) 抛 HTTPException（中文 detail），不是 print。
    assert '_missing(' in source and 'HTTPException' in source


check('缺依赖/未实现时后端仍返回明确中文指引（删提示没丢信息）', _backend_error_message_still_exists)


def _serializable_for_extensions_endpoint() -> None:
    """`/extensions` 直接透传 g.params：序列化后仍不得出现显存字样。"""
    payload = json.loads(json.dumps([{'id': g.id, 'params': g.params} for g in image_generators()]))
    dumped = json.dumps(payload, ensure_ascii=False)
    assert not _VRAM_RE.search(dumped), f'序列化后仍有显存/显卡档位文案：{dumped}'


check('/extensions 透传的图像节点参数不含显存字样', _serializable_for_extensions_endpoint)


# ─── 汇总 ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed')
    sys.exit(1 if failed else 0)
