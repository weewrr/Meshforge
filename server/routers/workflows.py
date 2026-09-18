"""工作流的持久化路由：列表 / 读取 / 保存 / 删除。

每个工作流就是一个 JSON 文件，存在 `server/workspace/workflows/<id>.json`。
不引入数据库：图结构本身是自由形态的 nodes/edges，直接落盘 JSON 最简单，
也方便用户手动查看与版本管理。
"""
import json
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import WORKSPACE_DIR

router = APIRouter(prefix='/workflows', tags=['workflows'])

WORKFLOWS_DIR = WORKSPACE_DIR / 'workflows'
# 导入期就建目录：路由注册后随时可能收到请求，不能等到首次写入才创建。
WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)

# 白名单式 id 校验：杜绝 `../` 之类的路径穿越，同时限制文件名长度。
_ID_RE = re.compile(r'^[A-Za-z0-9-]{1,64}$')

# 画布规模上限：拦截异常巨大的请求体拖垮保存路径（文档 4.2）。
MAX_NODES = 500
MAX_EDGES = 1000

# 当前工作流 schema 版本；加载旧文件时由前端（或未来的迁移链）逐级升级。
SCHEMA_VERSION = 1


class WorkflowIn(BaseModel):
    """保存工作流时的请求体。

    `nodes` / `edges` 保持为宽松的 dict 列表——图结构由前端自由演化，
    后端不参与其 schema 校验，避免每次加节点类型都要改服务端。
    """

    id: str = Field(min_length=1, max_length=64)  # 文件名主体，须匹配 _ID_RE
    name: str = Field(default='Workflow', max_length=120)
    description: str = ''
    folder: str | None = None  # 资产库中的分组文件夹，None 表示未分组
    bookmarked: bool = False
    nodes: list[dict] = []
    edges: list[dict] = []
    createdAt: str = ''
    updatedAt: str = ''


def _safe_path(workflow_id: str) -> Path:
    """把工作流 id 解析为磁盘路径，并拦截非法 id。

    Args:
        workflow_id: 来自 URL 路径的原始 id。

    Returns:
        该工作流对应的 JSON 文件路径。

    Raises:
        HTTPException: id 不符合白名单规则（400）。
    """
    if not _ID_RE.match(workflow_id):
        raise HTTPException(status_code=400, detail='invalid workflow id')
    return WORKFLOWS_DIR / f'{workflow_id}.json'


def _mtime(path: Path) -> str:
    """把文件修改时间格式化为本地时间的 ISO 串（兜底 updatedAt 缺失的情况）。"""
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(path.stat().st_mtime))


@router.get('')
def list_workflows() -> list[dict]:
    """GET /workflows — 列出全部工作流摘要（不含 nodes/edges）。

    Returns:
        按 `updatedAt` 倒序排列的摘要列表；损坏或缺少 id 的文件被静默跳过。
    """
    items = []
    for path in WORKFLOWS_DIR.glob('*.json'):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            items.append(
                {
                    'id': data['id'],
                    # name 缺失时用文件名兜底，保证列表项总有个可读标题。
                    'name': data.get('name', path.stem),
                    'updatedAt': data.get('updatedAt') or _mtime(path),
                    'folder': data.get('folder'),
                    'bookmarked': bool(data.get('bookmarked', False)),
                }
            )
        except (json.JSONDecodeError, KeyError):
            # 单个文件坏掉不应拖垮整个列表：跳过它，继续返回其余工作流。
            continue
    items.sort(key=lambda item: item['updatedAt'], reverse=True)
    return items


@router.get('/{workflow_id}')
def get_workflow(workflow_id: str) -> dict:
    """GET /workflows/{id} — 读取单个工作流的完整定义（含 nodes/edges）。

    Raises:
        HTTPException: id 非法（400）或文件不存在（404）。
    """
    path = _safe_path(workflow_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail='workflow not found')
    return json.loads(path.read_text(encoding='utf-8'))


@router.post('')
def save_workflow(workflow: WorkflowIn) -> dict:
    """POST /workflows — 整体覆盖保存一个工作流（upsert 语义）。

    原子写入（文档 4.2）：先写同目录临时文件，flush + fsync 落盘后用
    `os.replace` 原子替换目标——进程中断最多留下一个临时文件，
    主文件永远要么是旧的完整 JSON，要么是新的完整 JSON。

    `ensure_ascii=False` 让中文名称以原字符落盘；`indent=2` 便于人工查看与 diff。
    """
    if len(workflow.nodes) > MAX_NODES:
        raise HTTPException(status_code=413, detail=f'too many nodes (limit {MAX_NODES})')
    if len(workflow.edges) > MAX_EDGES:
        raise HTTPException(status_code=413, detail=f'too many edges (limit {MAX_EDGES})')

    path = _safe_path(workflow.id)
    data = workflow.model_dump()
    # schema 版本 + 服务端时间戳：为未来的迁移链留下入口。
    data['schemaVersion'] = SCHEMA_VERSION
    data['updatedAt'] = data['updatedAt'] or time.strftime('%Y-%m-%dT%H:%M:%S')

    tmp_path = path.with_suffix('.json.tmp')
    try:
        with tmp_path.open('w', encoding='utf-8') as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        # 写入中途失败时清掉残留的临时文件，不污染工作流目录。
        tmp_path.unlink(missing_ok=True)
    return {'ok': True}


@router.delete('/{workflow_id}')
def delete_workflow(workflow_id: str) -> dict:
    """DELETE /workflows/{id} — 删除工作流文件。

    幂等：文件本就不存在时同样返回成功，方便前端做"删除后刷新"。
    """
    path = _safe_path(workflow_id)
    if path.exists():
        path.unlink()
    return {'ok': True}
