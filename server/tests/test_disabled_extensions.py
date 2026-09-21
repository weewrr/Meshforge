"""扩展卸载的持久化契约测试 —— 内置扩展"卸载后重启不能复活"。

**用户报告的现象**：扩展页 →「MVDream (4视图, Text)」→ 点击卸载，当场生效
（卡片没了、工作流节点面板里也没了），但**重启程序后又回来了**。

**根因**：内置生成器（`registry.py` 模块末尾那批 `registry.register(...)`）与内置
网格处理工具（`PROCESS_EXTENSIONS` 字面量）是**代码注册**的，磁盘上没有扩展目录。
旧实现的 `/extensions/uninstall` 只把 id 从内存注册表里摘掉、再尝试删一个并不存在的
目录——不落盘。进程重启后 `registry` 模块被重新导入、模块顶层那几行 `register(...)`
又跑了一遍，扩展自然就"复活"了。

**修复**：把已停用的 id 落到 `disabled-extensions.json`（见 `extension_state.py`），
`GeneratorRegistry.register()` 装载时跳过，并新增 `GET /extensions/disabled` +
`POST /extensions/restore` 让用户能放回来。

本测试逐条锁住这些行为。**"重启"用子进程真实模拟**（新解释器重新 import registry），
不靠 mock —— 这正是 bug 所在的那一层，mock 掉就测不到了。

既可用 pytest 运行，也可独立执行：
    server/.venv/Scripts/python.exe server/tests/test_disabled_extensions.py
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_disabled_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from fastapi import HTTPException  # noqa: E402

import extension_state  # noqa: E402
from generators.registry import EXTENSIONS_DIR, registry  # noqa: E402
from routers.extensions import (  # noqa: E402
    RestoreBody,
    UninstallBody,
    list_disabled_extensions,
    list_extensions,
    restore_extensions,
    uninstall_extension,
)

STATE_FILE = extension_state.STATE_FILE

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


# ─── 工具 ─────────────────────────────────────────────────────────────────────

_RESTART_SNIPPET = (
    'import json,sys;'
    f'sys.path.insert(0, {str(SERVER_DIR)!r});'
    'from generators.registry import registry;'
    'print(json.dumps(sorted(registry._generators)))'
)


def after_restart() -> list[str]:
    """在**全新解释器**里导入 registry —— 等价于"重启程序"。

    Returns:
        该进程里最终可用的生成器 id（已按停用表过滤）。
    """
    env = dict(os.environ)
    env['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)
    proc = subprocess.run(
        [sys.executable, '-c', _RESTART_SNIPPET],
        capture_output=True,
        text=True,
        env=env,
        timeout=300,
    )
    assert proc.returncode == 0, f'重启模拟失败（退出码 {proc.returncode}）：\n{proc.stderr[-2000:]}'
    return json.loads(proc.stdout.strip().splitlines()[-1])


def reset(disabled_ids: tuple[str, ...] = ()) -> None:
    """把内存注册表与状态文件都恢复到干净状态（每个用例自带前置条件）。"""
    for gen_id in list(registry._all_generators):
        registry.restore(gen_id)
    extension_state.save_disabled(set(disabled_ids))


def ids_in_listing() -> set[str]:
    """当前 `/extensions` 暴露的全部 id（模型 + 处理工具）。"""
    return {ext['id'] for ext in list_extensions()}


def uninstall(ext_id: str) -> dict:
    return asyncio.run(uninstall_extension(UninstallBody(id=ext_id)))


def restore(ids: list[str]) -> dict:
    return asyncio.run(restore_extensions(RestoreBody(ids=ids)))


def install_demo_manifest_extension(ext_id: str = 'demo-manifest-ext') -> Path:
    """在 extensions/ 下造一个最小的清单扩展，用于验证"真删目录"那条路径没被改坏。"""
    ext_dir = EXTENSIONS_DIR / ext_id
    ext_dir.mkdir(parents=True, exist_ok=True)
    (ext_dir / 'manifest.json').write_text(
        json.dumps({
            'id': ext_id,
            'display_name': 'Demo Manifest Ext',
            'kind': 'model',
            'category': 'mesh',
            'input': 'image',
            'output': 'mesh',
        }),
        encoding='utf-8',
    )
    (ext_dir / 'generator.py').write_text(
        'from generators.base import BaseGenerator\n\n\n'
        'class _Demo(BaseGenerator):\n'
        f"    id = '{ext_id}'\n"
        "    display_name = 'Demo Manifest Ext'\n\n"
        '    def generate(self, image_path, out_dir, params, progress, cancel):\n'
        '        raise NotImplementedError\n\n\n'
        'def build_generator():\n'
        '    return _Demo()\n',
        encoding='utf-8',
    )
    registry.scan_extensions()
    return ext_dir


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def _builtin_is_registered_initially() -> None:
    """前提：MVDream 是代码内置生成器（磁盘上没有目录）。"""
    reset()
    assert 'mvdream' in registry._generators, 'MVDream 未注册，后面的用例都无从谈起'
    assert registry.is_builtin('mvdream'), 'MVDream 应被识别为代码内置生成器'
    assert not (EXTENSIONS_DIR / 'mvdream').exists(), 'MVDream 不该在 extensions/ 下有目录'
    assert next(e for e in list_extensions() if e['id'] == 'mvdream')['builtin'] is True


check('MVDream 是代码内置生成器（无磁盘目录）且列表标 builtin', _builtin_is_registered_initially)


def _uninstall_takes_effect_immediately() -> None:
    """卸载当场生效（旧实现这一半是对的，别在修复中弄丢）。"""
    reset()
    result = uninstall('mvdream')
    assert result['ok'] is True, result
    assert result['builtin'] is True, f'应报告为内置扩展：{result}'
    assert result['removed'] is False, f'内置扩展没有目录可删：{result}'
    assert 'mvdream' not in registry._generators, '会话内应立刻从注册表消失'
    assert 'mvdream' not in ids_in_listing(), '/extensions 不该再返回它'


check('卸载内置扩展当场生效（注册表与 /extensions 都移除）', _uninstall_takes_effect_immediately)


def _survives_restart() -> None:
    """★ 用户报告的 bug 本身：重启后不能复活。"""
    reset()
    uninstall('mvdream')
    survivors = after_restart()
    assert 'mvdream' not in survivors, (
        '重启后 MVDream 又回来了 —— 停用没有落盘。'
        f'（重启后可见：{[i for i in survivors if "mv" in i]}）'
    )
    assert len(survivors) == len(registry._all_generators) - 1, '只该少掉被停用的那一个'


check('★ 停用跨重启保持（重启后不会复活）', _survives_restart)


def _other_extensions_unaffected() -> None:
    """停用一个不能误伤别人 —— 状态文件只记 id，不该顺带关掉别的。"""
    reset()
    before = after_restart()
    uninstall('mvdream')
    after = after_restart()
    assert set(before) - set(after) == {'mvdream'}, f'受影响的不止 MVDream：{set(before) ^ set(after)}'


check('停用只影响目标扩展，其余生成器照常装载', _other_extensions_unaffected)


def _disabled_listing_and_restore() -> None:
    """停用项要能被列出、能被恢复，且恢复同样跨重启生效。"""
    reset()
    uninstall('mvdream')
    items = list_disabled_extensions()['items']
    assert [i['id'] for i in items] == ['mvdream'], f'停用列表不对：{items}'
    assert items[0]['display_name'] == 'MVDream (4视图, Text)', f'显示名丢失：{items[0]}'
    assert items[0]['kind'] == 'model' and items[0]['category'] == 'multiview', items[0]

    result = restore(['mvdream'])
    assert result['restored'] == ['mvdream'], f'恢复未生效：{result}'
    assert 'mvdream' in registry._generators, '会话内应立刻回到注册表'
    assert 'mvdream' in ids_in_listing(), '/extensions 应重新返回它'
    assert list_disabled_extensions()['items'] == [], '停用列表该空了'
    assert 'mvdream' in after_restart(), '恢复也必须跨重启生效'


check('停用列表可查、恢复后重启仍在（不再是单向门）', _disabled_listing_and_restore)


def _restore_is_idempotent() -> None:
    """重复恢复、恢复没停用过的 id 都不该报错（前端"全部恢复"会多传）。"""
    reset()
    result = restore(['mvdream', 'mesh-repair'])
    assert result['ok'] is True and result['restored'] == [], f'不该有可恢复项：{result}'
    assert 'mvdream' in registry._generators, '未被停用的扩展不该被误伤'


check('恢复幂等：恢复未停用的 id 不报错也不误伤', _restore_is_idempotent)


def _builtin_process_tool_can_be_disabled() -> None:
    """内置网格工具（PROCESS_EXTENSIONS 字面量）同样要能停用 —— 它绕过了 registry。"""
    reset()
    result = uninstall('mesh-smoother')
    assert result['builtin'] is True and result['removed'] is False, result
    assert 'mesh-smoother' not in ids_in_listing(), '内置网格工具应从 /extensions 消失'
    assert 'mesh-smoother' not in after_restart(), '内置网格工具的停用也要跨重启'

    assert {'mesh-repair', 'mesh-remesher', 'mesh-optimizer', 'mesh-exporter'} <= ids_in_listing(), \
        '停用一个网格工具不该影响同组的其它工具'

    restore(['mesh-smoother'])
    assert 'mesh-smoother' in ids_in_listing(), '恢复后应回到列表'


check('内置网格工具可停用、可恢复，且不误伤同组工具', _builtin_process_tool_can_be_disabled)


def _manifest_extension_still_really_deletes() -> None:
    """清单扩展那条路径不能被改变：仍要真删目录，且**不**写停用表。"""
    reset()
    ext_dir = install_demo_manifest_extension()
    assert 'demo-manifest-ext' in ids_in_listing(), '前置条件：清单扩展应已加载'

    result = uninstall('demo-manifest-ext')
    assert result['removed'] is True, f'清单扩展应真删目录：{result}'
    assert result['builtin'] is False, f'清单扩展不该被当成内置：{result}'
    assert not ext_dir.exists(), '目录还在，没真删'
    assert 'demo-manifest-ext' not in ids_in_listing()
    assert 'demo-manifest-ext' not in after_restart(), '重启后不该复活'

    ids = list_disabled_extensions()['items']
    assert all(i['id'] != 'demo-manifest-ext' for i in ids), \
        '清单扩展删了就是删了，不该进停用表（它没有可恢复的代码）'


check('清单扩展仍真删目录且不进停用表（未破坏原有语义）', _manifest_extension_still_really_deletes)


def _unknown_id_rejected() -> None:
    """既无目录也非内置的 id 应明确 404，而不是像旧实现那样静默返回 ok。"""
    reset()
    try:
        uninstall('no-such-extension')
    except HTTPException as exc:
        assert exc.status_code == 404, f'期望 404，实际 {exc.status_code}'
    else:
        raise AssertionError('不存在的扩展竟卸载"成功"了（旧实现的静默 no-op）')


check('卸载不存在的扩展返回 404（不再静默成功）', _unknown_id_rejected)


def _invalid_id_rejected() -> None:
    """白名单之外的 id 一律 400 —— 状态文件与目录名共用同一套 id，不能有路径穿越。"""
    reset()
    for bad in ('../evil', 'a/b', 'x' * 65, ''):
        try:
            uninstall(bad)
        except HTTPException as exc:
            assert exc.status_code == 400, f'{bad!r} → 期望 400，实际 {exc.status_code}'
        else:
            raise AssertionError(f'{bad!r} 未被拒绝')


check('非法 id 被 400 拒绝（路径穿越防护）', _invalid_id_rejected)


def _invalid_id_not_written() -> None:
    """`add_disabled` 也要自校验：非法 id 不许写进状态文件。"""
    reset()
    extension_state.add_disabled('../../etc/passwd')
    raw = json.loads(STATE_FILE.read_text(encoding='utf-8'))
    assert raw == {'ids': []}, f'非法 id 竟被写盘：{raw}'
    assert '..' not in STATE_FILE.read_text(encoding='utf-8')


check('非法 id 不会被写进停用表', _invalid_id_not_written)


def _corrupt_state_file_does_not_break_startup() -> None:
    """状态文件损坏时必须退化成"没有停用项"，绝不能把后端起不来。"""
    reset()
    STATE_FILE.write_text('{ this is not json', encoding='utf-8')
    extension_state.reset_cache()

    survivors = after_restart()
    assert 'mvdream' in survivors, '损坏的状态文件让内置扩展全没了 —— 容错失效'
    assert len(survivors) == len(registry._all_generators), f'装载数量不对：{len(survivors)}'
    assert extension_state.load_disabled() == set(), '损坏文件应被当作"无停用项"'


check('停用表损坏时退化为无停用项，不影响启动', _corrupt_state_file_does_not_break_startup)


def _state_file_is_atomic() -> None:
    """原子写：目录里不该留下临时文件残渣。"""
    reset()
    uninstall('mvdream')
    leftovers = [p.name for p in STATE_FILE.parent.glob('.disabled-*.tmp')]
    assert not leftovers, f'留下临时文件：{leftovers}'
    assert STATE_FILE.is_file(), '状态文件没写出来'


check('状态文件原子写、不留临时文件', _state_file_is_atomic)


def _fresh_install_clears_disabled_flag() -> None:
    """先停用内置扩展、再装同 id 的清单扩展时，停用标记要让路，否则新装完看不到。"""
    reset()
    uninstall('mvdream')
    assert 'mvdream' in extension_state.load_disabled(), '前置条件：mvdream 应已停用'
    extension_state.remove_disabled('mvdream')
    registry.restore('mvdream')
    assert 'mvdream' in ids_in_listing(), '恢复后仍看不到'


check('停用标记可被安装/恢复路径清除（状态不残留）', _fresh_install_clears_disabled_flag)


# ─── 汇总 ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed')
    sys.exit(1 if failed else 0)
