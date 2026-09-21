"""生视图模型（category='multiview'）参数契约测试 —— 3 个节点不再摆"假输入框"。

既可用 pytest 运行（`python -m pytest server/tests/test_multiview_params.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_multiview_params.py`）。

背景（用户反馈）：生视图模型的 3 个节点上出现了三类不该有的输入框 ——
- 「显存」是一条说明文字（schema 里写成 `type: 'label'`），却在节点上渲染成一个
  能打字、但打了也没用的文本输入框；
- 「采样步数」「随机种子」默认值够用，也不该摆输入框，要改应从引脚喂变量。

前端侧的修复是：`type: 'label'` 渲染为静态文案、`pin_only: True` 的参数只留引脚
与默认值（见 `scripts/test_node_ui.mjs`）。本测试锁住后端这一侧的契约：

- multiview 生成器恰好 3 个（MVDream / Stable Zero123 / Wonder3D Plus）；
- 这 3 个节点的参数里不得再有 `type == 'label'` 的项（显存行已彻底移除）；
- `steps` / `seed` 为 int、带默认值、且 `pin_only is True`；
- 默认值真的要能驱动推理：不传参时 `hydrated_params({})` 得到 30 / -1，而不是空串；
- 引脚注入的值仍能覆盖默认值；
- `label` 仍是合法 schema 值（instantmesh / imageopt 等仍在用），前端必须继续支持。
"""

import os
import sys
import tempfile
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_mv_params_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from generators.registry import registry  # noqa: E402

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


def multiview_generators() -> list:
    """取全部生视图模型（category='multiview'）。"""
    return [g for g in registry._generators.values() if getattr(g, 'category', None) == 'multiview']


def param_of(gen, param_id: str) -> dict:
    """按 id 取生成器的一个参数定义；不存在则直接失败。"""
    for p in gen.params:
        if p['id'] == param_id:
            return p
    raise AssertionError(f'{gen.id}: 缺少参数 {param_id!r}（现有：{[p["id"] for p in gen.params]}）')


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def _exactly_three() -> None:
    """用户说的"生视图模型的 3 个节点"就是这 3 个 multiview 生成器。"""
    ms = multiview_generators()
    assert len(ms) == 3, f'期望 3 个，实际 {len(ms)}: {[g.id for g in ms]}'


check('生视图模型恰好 3 个（用户所指的 3 个节点）', _exactly_three)


def _no_label_param() -> None:
    """3 个节点都不该再有 label 型参数 —— 那是渲染成假输入框的「显存」行。"""
    for g in multiview_generators():
        labels = [p['id'] for p in g.params if p.get('type') == 'label']
        assert not labels, f'{g.id}: 仍有 label 型参数 {labels}（会渲染成改了没用的输入框）'


check('3 个节点都不再带 label 型参数（显存行已移除）', _no_label_param)


def _vram_note_gone() -> None:
    """显存那条参数按 id / 标签双重确认已删除，防止换个 id 又溜回来。"""
    for g in multiview_generators():
        ids = [p['id'] for p in g.params]
        assert 'vram_note' not in ids, f'{g.id}: vram_note 仍在'
        assert all(p['label'] != '显存' for p in g.params), f'{g.id}: 仍有「显存」标签的参数'


check('显存参数（vram_note / 标签「显存」）彻底消失', _vram_note_gone)


def _steps_seed_pin_only() -> None:
    """steps / seed 必须是「有默认值 + 走引脚」的形态。"""
    for g in multiview_generators():
        for pid, default in (('steps', 30), ('seed', -1)):
            p = param_of(g, pid)
            assert p['type'] == 'int', f'{g.id}.{pid}: 类型应为 int，实际 {p["type"]}'
            assert p['default'] == default, f'{g.id}.{pid}: 默认值应为 {default}，实际 {p["default"]}'
            assert p.get('pin_only') is True, f'{g.id}.{pid}: 应标记 pin_only（前端据此不渲染输入框）'
            # 引脚注入的是文本，数值型参数必须有 min/max 供执行期与 UI 校验。
            assert 'min' in p and 'max' in p, f'{g.id}.{pid}: 缺 min/max'


check('steps / seed 为 pin_only 的 int 参数且保留默认值', _steps_seed_pin_only)


def _defaults_drive_inference() -> None:
    """默认值必须真的能驱动推理：不传参时 hydrated_params 要给出 30 / -1。"""
    for g in multiview_generators():
        hy = g.hydrated_params({})
        assert hy == {'steps': '30', 'seed': '-1'}, f'{g.id}: 默认参数异常 {hy}'


check('不传参时默认值仍驱动推理（steps=30 / seed=-1）', _defaults_drive_inference)


def _pin_override_still_works() -> None:
    """引脚注入的数值要能覆盖默认值（resolveParamPins 在把文本转成数字后传进来）。"""
    for g in multiview_generators():
        hy = g.hydrated_params({'steps': 77, 'seed': 5})
        assert hy == {'steps': '77', 'seed': '5'}, f'{g.id}: 覆盖失效 {hy}'


check('引脚传入的数值仍可覆盖默认值', _pin_override_still_works)


def _label_type_still_supported() -> None:
    """`label` 仍是受支持的 schema 值：前端不能因为本次改动把它当成普通文本输入。"""
    others = [
        p
        for g in registry._generators.values()
        if getattr(g, 'category', None) != 'multiview'
        for p in g.params
        if p.get('type') == 'label'
    ]
    assert others, '预期仍有其它扩展在使用 type=label（否则前端支持它的理由就没了）'
    assert all('default' in p for p in others), 'label 型参数必须带 default（它就是要显示的文案）'


check('label 型参数在其它扩展中仍在使用（前端需继续支持）', _label_type_still_supported)


def _params_serializable() -> None:
    """`/extensions` 直接透传 g.params，字段要能 JSON 序列化且 pin_only 不丢。"""
    import json

    for g in multiview_generators():
        payload = json.loads(json.dumps({'params': g.params}))
        steps = next(p for p in payload['params'] if p['id'] == 'steps')
        assert steps['pin_only'] is True, f'{g.id}: 序列化后 pin_only 丢失'


check('/extensions 透传的参数可序列化且保留 pin_only', _params_serializable)


# ─── 汇总 ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed')
    sys.exit(1 if failed else 0)
