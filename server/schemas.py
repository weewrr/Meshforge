"""API 响应契约模型（优化文档 7.2）。

核心端点的 Pydantic response model：让 OpenAPI 文档与真实返回强一致，
前后端改字段时快照对比（`npm run openapi:check`）会立刻暴露漂移。
刻意只覆盖"形状稳定"的接口——SSE 流、生成类动态返回不强行建模。
"""

from typing import Optional

from pydantic import BaseModel, Field


# ─── 健康检查 ────────────────────────────────────────────────────────────────

class HealthOut(BaseModel):
    """GET /health 与 /health/live。"""

    status: str
    app: str


class ReadyOut(BaseModel):
    """GET /health/ready；not-ready 时附 detail。"""

    status: str
    app: str
    detail: Optional[str] = None


class HealthStatusOut(BaseModel):
    """GET /health/status（需认证）的详细诊断。"""

    status: str
    app: str
    version: str
    uptimeSeconds: float
    port: int
    dataDir: str
    workspaceDir: str
    modelsDir: str
    generatorCount: int
    tokenConfigured: bool


# ─── 设置契约 ────────────────────────────────────────────────────────────────

class RuntimeOut(BaseModel):
    """GET /settings/runtime —— 后端实际生效配置与未接线标记。"""

    dataDir: str
    workspaceDir: str
    workflowsDir: str
    modelsDir: str
    extensionsDir: str
    port: int
    maxConcurrentPerModel: int
    wired: dict[str, bool]
    gpu: 'GpuDetectOut'


class GpuDetectOut(BaseModel):
    """启动时探测到的 NVIDIA GPU 信息（优化文档 6.3 自动探测降级）。"""

    cudaAvailable: bool
    count: int
    names: list[str] = []


# ─── 资产库 ──────────────────────────────────────────────────────────────────

class LibraryEntry(BaseModel):
    """单条资产条目（url 指向 /files 静态挂载）。"""

    id: str
    workspacePath: str
    displayName: str
    sourceScope: str
    capability: str
    state: str
    previewKind: str
    warnings: list[str] = []
    openable: bool
    nonOpenableReason: Optional[str] = None
    createdAt: str
    updatedAt: str
    url: str


class LibraryOut(BaseModel):
    """GET /library 的分页响应。"""

    success: bool
    total: int
    offset: int
    limit: int
    entries: list[LibraryEntry]


# ─── 任务状态 ────────────────────────────────────────────────────────────────

class JobStatusOut(BaseModel):
    """GET /generate/jobs/{id}；历史回退时 historical=True。"""

    job_id: str
    state: str = Field(description='pending | running | succeeded | failed | cancelled')
    progress: float
    message: str
    result_url: Optional[str] = None
    error: Optional[str] = None
    historical: bool = False
