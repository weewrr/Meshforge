"""已卸载（停用）扩展的持久化记录。

**为什么需要这个模块**：内置模型生成器与内置网格处理工具是**代码注册**的
（见 `generators/registry.py` 模块末尾的 `registry.register(...)` 与
`routers/extensions.py` 的 `PROCESS_EXTENSIONS`），磁盘上没有对应的扩展目录。
旧实现里 `/extensions/uninstall` 只把它们从内存注册表里摘掉、再去删一个并不存在
的目录——于是当场看起来"卸载成功"（模型页与工作流节点面板里都没了），但进程重启
后 `registry` 模块被重新导入、模块级的 `register(...)` 又把这些扩展装了回来，
用户会认为"卸载没生效"。

本模块把"用户已停用哪些扩展"落到 `DATA_DIR/disabled-extensions.json`；
`GeneratorRegistry.register()` 在装载时跳过这些 id，于是停用能扛住重启。

范围的边界：**只有代码内置（不可从磁盘删除）的扩展需要它**。清单扩展
（`extensions/<id>/`）的卸载是真的 `rmtree` 掉目录，下次扫描自然扫不到，本身就是
持久的，不进这个文件。

写盘与容错策略：

- 原子写（同目录临时文件 + `os.replace`），避免写到一半掉电留下半截 JSON，
  让下次启动读不出任何停用项；
- 读盘失败（文件缺失 / JSON 损坏 / 权限不足 / 类型不对）一律退化成"没有任何
  停用项"，绝不因为一个状态文件坏了就阻断后端启动；
- id 过白名单校验（与 `routers/extensions.py::_ID_RE` 同规则），杜绝把任意字符串
  写进状态文件。
"""

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Iterable

from config import DATA_DIR

# 状态文件：放在用户数据目录下（与 .api-token 同级），不在 workspace 内
# —— workspace 会被 /files 静态挂载对外公开。
STATE_FILE = DATA_DIR / 'disabled-extensions.json'

# 与 routers/extensions.py::_ID_RE 同规则：白名单式 id，兼作目录名安全约束。
_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

# 进程内缓存：一次读盘，之后由 save_disabled 维护。
# 单进程后端 + 单写者，不需要跨进程失效机制。
_CACHE: set[str] | None = None


def _valid(ext_id: object) -> bool:
    """id 是否合法：必须匹配白名单正则，否则拒绝写入/采信。"""
    return isinstance(ext_id, str) and bool(_ID_RE.match(ext_id))


def _parse(raw: object) -> set[str]:
    """从已解析的 JSON 值里提取合法 id 集合，兼容 list 与 {'ids': [...]} 两种写法。"""
    if isinstance(raw, list):
        candidates: Iterable[object] = raw
    elif isinstance(raw, dict):
        candidates = [
            item
            for key in ('ids', 'disabled')
            for item in (raw.get(key) if isinstance(raw.get(key), list) else [])
        ]
    else:
        return set()
    return {item for item in candidates if _valid(item)}


def load_disabled() -> set[str]:
    """返回已停用扩展 id 集合（首次调用读盘，之后走缓存）。

    Returns:
        id 集合的**副本**——调用方随意改不会污染缓存。

    Note:
        任何读取/解析异常都退化为空集合：状态文件坏了不该让服务起不来。
    """
    global _CACHE
    if _CACHE is not None:
        return set(_CACHE)

    ids: set[str] = set()
    try:
        ids = _parse(json.loads(STATE_FILE.read_text(encoding='utf-8')))
    except FileNotFoundError:
        # 首次运行：没有状态文件是正常情况，不建空文件（避免无意义写盘）。
        pass
    except (OSError, ValueError):
        # JSON 损坏 / 读不动：当作没有停用项，保证启动不受影响。
        pass

    _CACHE = ids
    return set(ids)


def save_disabled(ids: Iterable[str]) -> None:
    """把停用集合原子落盘。

    先更新缓存再写盘：即使写盘失败，本次进程内的行为也与用户操作一致
    （停用立即生效），只是重启后会退回——比"接口报错但内存已改"更好解释。

    Args:
        ids: 待写入的 id 集合；其中的非法 id 会被静默丢弃（`_valid` 过滤）。
    """
    global _CACHE
    clean = sorted({item for item in ids if _valid(item)})
    _CACHE = set(clean)

    tmp_path: str | None = None
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(STATE_FILE.parent), prefix='.disabled-', suffix='.tmp'
        )
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump({'ids': clean}, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, STATE_FILE)  # 同盘 rename，原子替换
        tmp_path = None
    except OSError:
        # 磁盘满 / 只读目录：吞掉。停用列表丢失不该让卸载接口整体失败。
        pass
    finally:
        if tmp_path is not None:
            Path(tmp_path).unlink(missing_ok=True)


def is_disabled(ext_id: str) -> bool:
    """该 id 是否已被用户停用。"""
    return ext_id in load_disabled()


def add_disabled(ext_id: str) -> set[str]:
    """把 id 加入停用集合并落盘；id 非法时原样返回不写盘。"""
    ids = load_disabled()
    if _valid(ext_id) and ext_id not in ids:
        ids.add(ext_id)
        save_disabled(ids)
    return ids


def remove_disabled(ext_id: str) -> set[str]:
    """把 id 移出停用集合并落盘；不在集合里时也照样落盘一次（幂等）。"""
    ids = load_disabled()
    if ext_id in ids:
        ids.discard(ext_id)
        save_disabled(ids)
    return ids


def clear_disabled() -> None:
    """清空停用集合（测试与"全部恢复"用）。"""
    save_disabled(set())


def reset_cache() -> None:
    """丢弃进程内缓存，强制下次 `load_disabled()` 重新读盘。

    仅供测试使用：用于模拟"外部改了状态文件"或"进程刚启动"。
    """
    global _CACHE
    _CACHE = None
