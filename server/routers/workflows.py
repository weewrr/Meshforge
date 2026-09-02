import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix='/workflows', tags=['workflows'])

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / 'workspace' / 'workflows'
WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)

_ID_RE = re.compile(r'^[A-Za-z0-9-]{1,64}$')


class WorkflowIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(default='Workflow', max_length=120)
    description: str = ''
    folder: str | None = None
    bookmarked: bool = False
    nodes: list[dict] = []
    edges: list[dict] = []
    createdAt: str = ''
    updatedAt: str = ''


def _safe_path(workflow_id: str) -> Path:
    if not _ID_RE.match(workflow_id):
        raise HTTPException(status_code=400, detail='invalid workflow id')
    return WORKFLOWS_DIR / f'{workflow_id}.json'


def _mtime(path: Path) -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(path.stat().st_mtime))


@router.get('')
def list_workflows() -> list[dict]:
    items = []
    for path in WORKFLOWS_DIR.glob('*.json'):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            items.append(
                {
                    'id': data['id'],
                    'name': data.get('name', path.stem),
                    'updatedAt': data.get('updatedAt') or _mtime(path),
                    'folder': data.get('folder'),
                    'bookmarked': bool(data.get('bookmarked', False)),
                }
            )
        except (json.JSONDecodeError, KeyError):
            continue
    items.sort(key=lambda item: item['updatedAt'], reverse=True)
    return items


@router.get('/{workflow_id}')
def get_workflow(workflow_id: str) -> dict:
    path = _safe_path(workflow_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail='workflow not found')
    return json.loads(path.read_text(encoding='utf-8'))


@router.post('')
def save_workflow(workflow: WorkflowIn) -> dict:
    path = _safe_path(workflow.id)
    data = workflow.model_dump()
    data.setdefault('updatedAt', time.strftime('%Y-%m-%dT%H:%M:%S'))
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'ok': True}


@router.delete('/{workflow_id}')
def delete_workflow(workflow_id: str) -> dict:
    path = _safe_path(workflow_id)
    if path.exists():
        path.unlink()
    return {'ok': True}
