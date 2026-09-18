"""标题栏监控用的系统 / 性能指标。

跨平台实现：CPU 与内存走 psutil，显卡走 nvidia-smi（尽力而为）。
每一路指标都是"尽力而为"读取——单项失败只把该字段降级为 None，
而不会让整个响应报错，从而保证渲染进程始终能拿到一份完整 JSON。

缓存采样器（优化文档 13.8）：带 TTL 的进程内缓存把多次并发请求合并成
一次真实采样——nvidia-smi 是外部子进程（最坏 3s 超时），前端 2s 轮询 +
多个展示位同时读取时，绝不能每个请求都打一遍系统命令。
"""

import logging
import subprocess
import threading
import time
from typing import Optional

from fastapi import APIRouter

import psutil

logger = logging.getLogger('system_stats')

router = APIRouter(prefix='/system', tags=['system'])

# 缓存 TTL：与前端 2s 轮询周期对齐——同一窗口内的全部请求共享一次采样。
SAMPLE_TTL_SECONDS = 2.0
_cache_lock = threading.Lock()
# (采样时刻 monotonic, 结果 dict)；None 表示还没有任何采样。
_cache: Optional[tuple[float, dict]] = None

# 不考虑多卡场景，只上报主显卡。
def _nvidia(keys: str) -> Optional[list[str]]:
    """查询一组逗号分隔的 nvidia-smi 字段；显卡不存在时返回 None。

    Args:
        keys: nvidia-smi 的 `--query-gpu` 字段列表，如 `'memory.total,utilization.gpu'`。

    Returns:
        每张卡一行的字段值列表；无显卡 / 命令失败 / 超时均返回 None。
    """
    if not keys:
        return None
    try:
        out = subprocess.run(
            [
                'nvidia-smi',
                '--query-gpu=' + keys,
                '--format=csv,noheader,nounits',
            ],
            capture_output=True,
            text=True,
            # 3s 超时：nvidia-smi 在驱动异常时可能挂住，不能让接口跟着卡死。
            timeout=3,
        )
    except (subprocess.SubprocessError, OSError):
        # 命令不存在（无 N 卡 / 无驱动）或超时，都按"无 GPU 信息"处理。
        return None
    if out.returncode != 0:
        return None
    vals = [line.strip() for line in out.stdout.strip().splitlines() if line.strip()]
    return vals or None


def _sample_uncached() -> dict:
    """真实采样一次（可能触发 nvidia-smi 子进程，最坏 3s）。"""
    cpu = None
    try:
        # interval=None：取"上次调用至今"的均值，非阻塞，适合被前端定时轮询。
        cpu = psutil.cpu_percent(interval=None)
    except Exception as exc:  # noqa: BLE001 - best-effort metric, degrade to None
        logger.debug('cpu_percent failed: %s', exc)

    mem_total = mem_used = mem_percent = None
    try:
        vm = psutil.virtual_memory()
        mem_total = vm.total
        mem_used = vm.used  # excludes buffers/cache
        mem_percent = vm.percent
    except Exception as exc:  # noqa: BLE001 - best-effort metric, degrade to None
        logger.debug('virtual_memory failed: %s', exc)

    gpu = None
    gpu_read = _nvidia('memory.total,memory.used,utilization.gpu')
    if gpu_read:
        try:
            total, used, util = gpu_read[0].split(', ')
            # nvidia-smi 以 MiB 为单位，这里统一换算成字节。
            used_b = int(used) * 1024**2
            total_b = int(total) * 1024**2
            used_b = min(used_b, total_b)  # guard against over-counting shared WRAM
            gpu = {
                'vramTotal': total_b,
                'vramUsed': used_b,
                'vramPercent': round(used_b / max(total_b, 1) * 100),
                'util': int(util),
            }
        except (ValueError, IndexError):
            # 字段数不对或含非数字（如 [N/A]）时，整块 GPU 指标置空。
            gpu = None

    return {
        'cpuPercent': cpu,
        'memory': {
            'total': mem_total,
            'used': mem_used,
            'percent': round(mem_percent) if mem_percent is not None else None,
        },
        'gpu': gpu,
    }


def _sample() -> dict:
    """带 TTL 缓存的采样入口（优化文档 13.8）。

    锁内双检查：命中缓存直接返回；未命中才做真实采样并刷新缓存。
    真实采样放在锁内——最坏情况（nvidia-smi 挂满 3s）下并发请求会排队等
    同一次采样完成，而不是各自再起一个子进程把系统打爆；缓存命中路径
    只做一次时间比较，纳秒级。
    """
    global _cache
    with _cache_lock:
        now = time.monotonic()
        if _cache is not None and now - _cache[0] < SAMPLE_TTL_SECONDS:
            return _cache[1]
        data = _sample_uncached()
        _cache = (now, data)
        return data


@router.get('/stats')
def system_stats() -> dict:
    """GET /system/stats — 一次性返回 CPU / 内存 / GPU 指标（≤2s 缓存）。

    Returns:
        `{'cpuPercent': float|None, 'memory': {...}, 'gpu': {...}|None}`。
    """
    return _sample()


# ─── GPU 静态探测（优化文档 6.3 自动探测降级） ────────────────────────────────

_gpu_detect_lock = threading.Lock()
# 探测结果进程内缓存一次：显卡插拔极罕见，且 /settings/runtime 调用频繁，
# 不值得每次都起 nvidia-smi 子进程。
_gpu_detect_cache: Optional[dict] = None


def detect_gpu() -> dict:
    """探测 NVIDIA GPU（cuda 可用性 / 卡数 / 型号名），结果进程内缓存。

    与 {@link _nvidia} 一致的"尽力而为"语义：无驱动 / 无 N 卡 / 超时
    一律返回 `cudaAvailable: False`，调用方据此降级到 CPU。
    """
    global _gpu_detect_cache
    with _gpu_detect_lock:
        if _gpu_detect_cache is not None:
            return _gpu_detect_cache
        names = _nvidia('name') or []
        result = {
            'cudaAvailable': len(names) > 0,
            'count': len(names),
            'names': [n.strip() for n in names],
        }
        _gpu_detect_cache = result
        return result
