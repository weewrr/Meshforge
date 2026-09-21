"""生成器模型（category='mesh'）参数契约测试 —— 数字参数不再摆输入框。

既可用 pytest 运行（`python -m pytest server/tests/test_generator_node_params.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_generator_node_params.py`）。

背景（用户反馈）：「生成器的节点也要修改，先修改输入框的，下拉框先不动」。
与上一轮生视图节点（`test_multiview_params.py`）同一套约定：

- **数字参数**（int/float）一律 `pin_only: True` —— 节点上不摆输入框，默认值够用，
  要改就从左侧引脚喂一个数值变量（执行期 `resolveParamPins` 按 schema 类型把
  引脚上的文本协调成数字）；
- **下拉框**（select）本轮不动：它的"选项"本身就是信息，摆成一行文字反而看不懂。

## 四视角输入：4 个**图片引脚**（不再是"第几张"的数字映射）

hunyuan3d-2-mv 的 `view_front` / `view_left` / `view_back` / `view_right` 是
`type: 'image'` 参数。它同样不在节点上摆输入框（值不可能靠打字给出），但引脚是
**image** 端口，图片节点的输出能直接接进来；执行期由
`src/stores/workflowRun/helpers.ts::mvViewsFrom()` 逐引脚读回 `File`。

上一版这里是 4 个 int（`view_<tag>_index` =「取上游数组的第几张」）。它的问题不是
"该不该留输入框"，而是**根本接不上图片**：参数引脚的端口类型恒为 `text`
（`paramPortType()`），图片连线会被 `validConnection` 直接拒绝 —— 用户反馈
「4 个都不能手动接入 image」。序号映射本身也答非所问：用户要给的本来就是图片。

（更早的一版还把这 4 个参数误判成"死控件"删掉过：当时只按字面量 `view_front_index`
搜代码，漏了 `mvViewsFrom` 里 `params[f'view_{tag}_index']` 这种拼接键；
`scripts/test_nodes.mjs` 的 A9 用例一直覆盖着它的行为。）

本文件锁住后端这一侧的契约，其中最关键的一条是 **schema 默认值 == 执行期回落默认值**：
`pin_only` 之后节点上不再写 `data.params[<id>]`，执行期完全依赖 `params.get(id, 默认)`，
两处一旦不一致，节点上写着「默认 20」而实际按别的数值跑，且没有任何报错。
"""

import os
import sys
import tempfile
import threading
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_gen_params_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from generators import hunyuan, hunyuan_full, hunyuan_mv, instantmesh  # noqa: E402
from generators.registry import registry  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []

#: 四视角参数的 id（`type: 'image'`：只给图片引脚、不摆输入框）。
VIEW_IMAGE_IDS = ('view_front', 'view_left', 'view_back', 'view_right')
#: 上一版的外部映射参数；本轮已删，留下来供"不许复活"的断言使用。
REMOVED_VIEW_INDEX_IDS = ('view_front_index', 'view_left_index', 'view_back_index', 'view_right_index')
#: 只有 hunyuan3d-2mv 这一族（3 个变体共用同一份类级 params）有视角参数。
VIEW_PARAM_OWNER_PREFIX = 'hunyuan3d-2-mv'


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


def mesh_generators() -> list:
    """取全部生成器模型（category='mesh'）——用户说的「生成器的节点」。"""
    return [g for g in registry._generators.values() if getattr(g, 'category', None) == 'mesh']


def param_of(gen, param_id: str) -> dict:
    """按 id 取生成器的一个参数定义；不存在则直接失败。"""
    for p in gen.params:
        if p['id'] == param_id:
            return p
    raise AssertionError(f'{gen.id}: 缺少参数 {param_id!r}（现有：{[p["id"] for p in gen.params]}）')


def is_editable_input(p: dict) -> bool:
    """该参数会不会在节点上渲染成一个内联输入框。

    与 `src/pages/workflows/nodes/extension.tsx` 的分支保持一致：
    select / label / image 有专属渲染，其余（int/float/string）落到输入框。
    """
    if p.get('type') in ('select', 'label', 'image'):
        return False
    return not p.get('pin_only')


# ─── 执行期实测：把提交函数换成捕获器，抓生成器真正发出去的表单字段 ─────────────

def captured_fields(gen, module, helper: str, params: dict) -> dict:
    """调用 `gen.generate()`，返回它实际提交的 fields（不联网）。

    做法：把模块级的 multipart 提交函数替换成捕获器并返回一段假 GLB，
    同时跳过服务探活（`_loaded = True`）。这样测的是**真实执行路径**上的默认值，
    而不是去读源码里那串字面量。
    """
    captured: dict = {}

    def fake_post(_url, *_args, **kwargs):
        # hunyuan/instantmesh: (url, image_path, fields)
        # hunyuan_mv:        (url, view_paths, fields)
        fields = _args[-1] if _args else kwargs.get('fields')
        captured['fields'] = dict(fields or {})
        return b'glb-stub'

    original = getattr(module, helper)
    setattr(module, helper, fake_post)
    try:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            image = root / 'input.png'
            image.write_bytes(b'\x89PNG\r\n\x1a\n')
            call_params = dict(params)
            # MV 变体要求 4 个视角文件真实存在，先落 4 个最小文件再指过去。
            if isinstance(gen, hunyuan_mv.Hunyuan3DMVGenerator):
                for tag in ('front', 'left', 'back', 'right'):
                    f = root / f'{tag}.png'
                    f.write_bytes(b'\x89PNG\r\n\x1a\n')
                    call_params[f'view_{tag}'] = str(f)

            gen._loaded = True
            gen.load = lambda progress=None: None  # type: ignore[method-assign]
            gen.generate(image, root, call_params, lambda *_: None, threading.Event())
    finally:
        setattr(module, helper, original)

    assert 'fields' in captured, f'{gen.id}: 没有走到 multipart 提交（参数变化导致路径改变？）'
    return captured['fields']


def module_and_helper(gen) -> tuple:
    """返回（所在模块, 该模块的 multipart 提交函数名）。"""
    if isinstance(gen, hunyuan_mv.Hunyuan3DMVGenerator):
        return hunyuan_mv, '_multipart_views'
    if isinstance(gen, instantmesh.InstantMeshGenerator):
        return instantmesh, '_multipart_post'
    if isinstance(gen, hunyuan_full.Hunyuan3DFullGenerator):
        return hunyuan_full, '_multipart_post'
    return hunyuan, '_multipart_post'


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def _eight_generators() -> None:
    """生成器节点 = 1 mini + 2 full + 3 mv + 2 instantmesh。"""
    ms = mesh_generators()
    assert len(ms) == 8, f'期望 8 个 mesh 生成器，实际 {len(ms)}: {[g.id for g in ms]}'


check('生成器模型恰好 8 个（mini / full×2 / mv×3 / instantmesh×2）', _eight_generators)


def _no_editable_input_left() -> None:
    """核心断言：生成器节点上没有任何参数会渲染成输入框。"""
    left = [
        f'{g.id}.{p["id"]}({p.get("type")})'
        for g in mesh_generators()
        for p in g.params
        if is_editable_input(p)
    ]
    assert not left, f'这些参数仍会渲染成输入框（应标 pin_only，或本就是 select/label/image）：{left}'


check('生成器节点上不再有输入框', _no_editable_input_left)


def _view_params_are_image_pins() -> None:
    """四视角必须是 `type: 'image'` 的图片引脚 —— 这样图片才接得进去。

    这是本轮改动的核心断言：以前这 4 个位置的端口类型是 `text`，连线校验会拒绝
    图片输出，用户根本没法手动接入图片。
    """
    for g in mesh_generators():
        has_any = any(p['id'] in VIEW_IMAGE_IDS for p in g.params)
        if not g.id.startswith(VIEW_PARAM_OWNER_PREFIX):
            assert not has_any, f'{g.id}: 不该有视角参数'
            continue
        for pid in VIEW_IMAGE_IDS:
            p = param_of(g, pid)
            assert p['type'] == 'image', (
                f'{g.id}.{pid}: 类型应为 image（图片引脚），实际 {p["type"]} —— '
                'text 端口的引脚接不上图片'
            )
            # 图片参数没有"节点上的值"，默认值只用于序列化占位；真正的路径由后端
            # 收到上传后写回同名 params 键（routers/generate.py）。
            assert p.get('default') == '', f'{g.id}.{pid}: 默认值应为空串，实际 {p.get("default")!r}'
            assert 'min' not in p, f'{g.id}.{pid}: 图片参数不该有 min'
            assert 'tooltip' in p, f'{g.id}.{pid}: 缺 tooltip（节点上只剩这一行提示）'


check('hunyuan3d-2-mv 的四视角是图片引脚（type=image，图片可接入）', _view_params_are_image_pins)


def _removed_view_index_params_stay_removed() -> None:
    """旧的 `view_*_index`（"取第几张"的数字映射）不得复活。

    它既接不上图片、又和视图片引脚表达同一件事，留着只会让用户以为要填序号。
    """
    for g in mesh_generators():
        alive = [p['id'] for p in g.params if p['id'] in REMOVED_VIEW_INDEX_IDS]
        assert not alive, f'{g.id}: 旧的视角序号映射参数又回来了：{alive}'


check('旧的 view_*_index 序号映射参数已彻底移除', _removed_view_index_params_stay_removed)


def _numeric_params_pin_only_with_default() -> None:
    """数字参数必须是「有默认值 + 有界 + 走引脚」的完整形态。"""
    expected = {
        'hunyuan3d-2-mini': {'steps': 20, 'guidance': 4.0, 'seed': -1},
        'hunyuan3d-2': {'steps': 20, 'guidance': 5.0, 'seed': -1},
        'hunyuan3d-2-standard': {'steps': 20, 'guidance': 5.0, 'seed': -1},
        'hunyuan3d-2-mv': {'steps': 20, 'seed': -1},
        'hunyuan3d-2-mv-fast': {'steps': 20, 'seed': -1},
        'hunyuan3d-2-mv-standard': {'steps': 20, 'seed': -1},
        'instantmesh': {'diffusion_steps': 30, 'seed': 42},
        'instantmesh-base': {'diffusion_steps': 30, 'seed': 42},
    }
    seen = {}
    for g in mesh_generators():
        assert g.id in expected, f'{g.id}: 出现了未纳入本测试的新生成器，请补充期望值'
        actual = {}
        for p in g.params:
            if p.get('type') not in ('int', 'float'):
                continue
            assert p.get('pin_only') is True, f'{g.id}.{p["id"]}: 数字参数必须 pin_only'
            assert 'default' in p, f'{g.id}.{p["id"]}: 缺默认值（节点上没有输入框可兜底了）'
            # 引脚喂进来的是文本，数值型参数必须有 min/max 供执行期与 UI 校验。
            assert 'min' in p and 'max' in p, f'{g.id}.{p["id"]}: 缺 min/max'
            actual[p['id']] = p['default']
        seen[g.id] = actual
    assert seen == expected, f'数字参数集合或默认值变了：\n实际 {seen}\n期望 {expected}'


check('数字参数均为 pin_only 且默认值 / 边界完整', _numeric_params_pin_only_with_default)


def _schema_default_matches_runtime_default() -> None:
    """schema 默认值必须等于执行期回落默认值（pin_only 之后这条是唯一的兜底）。

    注意：视角参数（`type: 'image'`）**不进这条检查** —— 它们由前端
    `mvViewsFrom()` 消费，根本不随 multipart 表单发给推理服务
    （`generate()` 只发 steps/octree/seed/remove_base）。
    """
    for g in mesh_generators():
        module, helper = module_and_helper(g)
        fields = captured_fields(g, module, helper, {})
        for p in g.params:
            if p.get('type') not in ('int', 'float'):
                continue
            sent = fields.get(p['id'])
            assert sent is not None, f'{g.id}.{p["id"]}: 不传参时没有提交该字段（fields={fields}）'
            # 表单字段一律是字符串；浮点数比较走 float()，避免 4.0 vs "4" 的假失败。
            assert float(sent) == float(p['default']), (
                f'{g.id}.{p["id"]}: 节点上写着默认 {p["default"]}，执行期实际发的是 {sent} —— '
                'pin_only 之后用户看不到输入框，这种不一致不会被任何人发现'
            )


check('schema 默认值 == 执行期回落默认值', _schema_default_matches_runtime_default)


def _pin_values_still_override() -> None:
    """引脚注入的数值仍要能覆盖默认值（resolveParamPins 把文本转成数字后传进来）。"""
    overrides = {
        'hunyuan3d-2-mini': {'steps': 8, 'guidance': 7.5, 'seed': 123},
        'hunyuan3d-2-mv': {'steps': 12, 'seed': 7},
        'instantmesh': {'diffusion_steps': 75, 'seed': 1},
    }
    for gid, values in overrides.items():
        g = registry.get(gid)
        module, helper = module_and_helper(g)
        fields = captured_fields(g, module, helper, values)
        for pid, want in values.items():
            assert float(fields[pid]) == float(want), f'{gid}.{pid}: 引脚值未生效，发出的是 {fields[pid]}'


check('引脚传入的数值仍可覆盖默认值', _pin_values_still_override)


def _selects_untouched() -> None:
    """下拉框本轮不动：类型、选项、默认值都要还在。

    若将来决定把下拉框也转成 pin_only，改这一条即可 —— 它是刻意留的决策点，
    不是"忘了改"。
    """
    expected = {
        'hunyuan3d-2-mini': {'octree': [256, 320, 384], 'remove_base': [1, 0]},
        'hunyuan3d-2-mv': {'octree': [256, 320, 384], 'remove_base': [1, 0]},
        'instantmesh': {'export_texmap': [1, 0], 'rembg': [0, 1]},
    }
    for gid, spec in expected.items():
        g = registry.get(gid)
        for pid, option_values in spec.items():
            p = param_of(g, pid)
            assert p['type'] == 'select', f'{gid}.{pid}: 类型变了（{p["type"]}）'
            assert p.get('pin_only') is not True, f'{gid}.{pid}: 下拉框本轮不该转 pin_only'
            got = [o['value'] for o in p['options']]
            assert got == option_values, f'{gid}.{pid}: 选项变了 {got}，期望 {option_values}'
            assert 'default' in p, f'{gid}.{pid}: 缺默认值'


check('下拉框（octree / remove_base / export_texmap / rembg）保持原状', _selects_untouched)


def _select_values_still_submitted() -> None:
    """保留下来的下拉框必须仍然作用于推理（否则"先不动"就没意义）。"""
    g = registry.get('instantmesh')
    module, helper = module_and_helper(g)
    fields = captured_fields(g, module, helper, {'export_texmap': 1, 'rembg': 1})
    assert fields['export_texmap'] == '1' and fields['rembg'] == '1', fields
    fields = captured_fields(g, module, helper, {})
    assert fields['export_texmap'] == '0' and fields['rembg'] == '0', fields


check('下拉框的取值仍会提交给推理服务', _select_values_still_submitted)


def _view_pins_are_read_by_mvViewsFrom() -> None:
    """视角引脚的**消费方**确实按 `p:view_<tag>` 去读边 —— 否则图片接了也白接。

    后端把 4 个参数改成 image 只是让"接得上"成立；真正把引脚的 File 取出来的是
    `helpers.ts::mvViewsFrom()`。这条断言盯住它：一旦有人把这条读取路径改掉
    （例如又退回读 `data.params` 里的数字），这张"图片引脚"的承诺就断了。
    """
    helpers = (SERVER_DIR.parent / 'src' / 'stores' / 'workflowRun' / 'helpers.ts').read_text(encoding='utf-8')
    assert 'mvViewsFrom' in helpers, 'mvViewsFrom 不在 helpers.ts 里了，请同步本测试'
    assert 'paramHandleFor(`view_${tag}`)' in helpers, (
        'helpers.ts 里找不到按 `p:view_<tag>` 读引脚的动作 —— '
        '图片引脚接上后视角取不到 File，四个视角会全部落回上游回退层'
    )
    assert 'view_${tag}_index' not in helpers, '旧的序号映射读取还在 helpers.ts 里，应一并删除'


check('视角引脚的消费方按 p:view_<tag> 读边（图片接得上才算数）', _view_pins_are_read_by_mvViewsFrom)


def _mv_still_requires_all_four_views() -> None:
    """四视图缺一张就必须报错 —— 去掉输入框不等于放宽校验。

    用真实执行路径验证：逐个抽掉一个视角文件，`generate()` 必须抛
    RuntimeError 且点名缺的那一个。
    """
    g = registry.get('hunyuan3d-2-mv')
    for missing in VIEW_IMAGE_IDS:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            image = root / 'input.png'
            image.write_bytes(b'\x89PNG\r\n\x1a\n')
            call_params = {}
            for pid in VIEW_IMAGE_IDS:
                if pid == missing:
                    continue
                f = root / f'{pid}.png'
                f.write_bytes(b'\x89PNG\r\n\x1a\n')
                call_params[pid] = str(f)
            g._loaded = True
            g.load = lambda progress=None: None  # type: ignore[method-assign]
            try:
                g.generate(image, root, call_params, lambda *_: None, threading.Event())
            except RuntimeError as exc:
                # params 键是 `view_front`，报错文案里用的是短名 `front`。
                assert missing.replace('view_', '') in str(exc), (
                    f'缺少 {missing} 时的报错没点名该视角：{exc}'
                )
            else:
                raise AssertionError(f'缺 {missing} 时竟然没报错')


check('四视图缺一张仍会报错并点名（不因改引脚而放松校验）', _mv_still_requires_all_four_views)


def _params_serializable() -> None:
    """`/extensions` 直接透传 g.params，字段要能 JSON 序列化且 pin_only 不丢。"""
    import json

    for g in mesh_generators():
        payload = json.loads(json.dumps({'params': g.params}))
        pinned = [p['id'] for p in payload['params'] if p.get('pin_only') is True]
        assert pinned, f'{g.id}: 序列化后没有任何 pin_only 参数'


check('/extensions 透传的参数可序列化且保留 pin_only', _params_serializable)


# ─── 汇总 ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed')
    sys.exit(1 if failed else 0)
