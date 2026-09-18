"""
FastAPI 应用入口（后端服务根）。

创建应用实例、挂载 CORS 中间件与本地 API 认证、注册全部业务路由
（generate / agent / workflows / extensions / process / model / library /
system_stats / settings），并把 workspace 目录以静态文件形式暴露给前端。
服务固定监听本机 8766 端口。

安全边界（优化文档 3.2 / 12.3）：
- Bearer token：Electron 主进程每次启动生成随机 token，经 MESHFORGE_API_TOKEN
  环境变量注入；未携带 token 的请求一律 401（豁免 /health、/files 静态挂载与
  CORS 预检）。独立运行后端时回退读取/生成 workspace/.api-token 文件，
  供 mcp_server 等本机同用户进程使用。
- CORS 只放行渲染层来源（file:// 的 Origin 为 "null"）与本地开发端口。
"""

import logging
import os
import re
import secrets
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from config import API_TOKEN_FILE, DATA_DIR, MODELS_DIR, WORKSPACE_DIR, ensure_dirs
from routers import agent, diagnostics, extensions, generate, library, model, process, settings, system_stats, workflows
from schemas import HealthOut, HealthStatusOut, ReadyOut

ensure_dirs()

# 进程启动时刻：/health/status 的 uptime 由此计算。
_START_TIME = time.time()

# 结构化请求日志（优化文档 7.4）：X-Request-Id + job_id 关联 + 耗时。
# /diagnostics/bundle 可把这里打的最近日志一次性带走。
api_logger = logging.getLogger('meshforge.api')
api_logger.setLevel(logging.INFO)
# /generate/jobs/<id> 里的 job_id：日志关联任务链路的关键。
_JOB_ID_RE = re.compile(r'/generate/jobs/([0-9a-f]+)')

# ─── 本地 API token ──────────────────────────────────────────────────────────
# 优先用 Electron 注入的 per-launch token；独立运行（开发 / 脚本）时读取或
# 生成一个并持久化。生效 token 始终回写到 workspace 外的 .api-token 文件，
# 供 mcp_server 等本机同用户进程读取（渲染进程经 Electron IPC 获取）。
API_TOKEN = os.environ.get('MESHFORGE_API_TOKEN') or ''
if not API_TOKEN:
    try:
        API_TOKEN = API_TOKEN_FILE.read_text(encoding='utf-8').strip()
    except OSError:
        API_TOKEN = ''
if not API_TOKEN:
    API_TOKEN = secrets.token_urlsafe(32)

# 把生效 token 同步到文件（缺失或不一致时重写），保证 MCP 侧随时读到当前值。
# 权限收敛（§20）：POSIX 上仅属主可读写（0600）；Windows 继承用户 profile 的
# NTFS ACL（默认仅本用户与管理员可见），等价安全。残余风险——本机同用户任意
# 进程仍可读到 token——需要 MCP 握手式鉴权才能根除（需上游协议支持，
# 文档 12.3 的既有取舍），文件法 + 权限收敛是当前可行性内的最大收敛。
try:
    if API_TOKEN_FILE.read_text(encoding='utf-8').strip() != API_TOKEN:
        raise OSError('token mismatch')
except OSError:
    try:
        API_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        # os.open 以 0600 创建（受 umask 影响），替代 write_text 的默认 0644。
        _fd = os.open(API_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(_fd, 'w', encoding='utf-8') as _fh:
            _fh.write(API_TOKEN)
    except OSError:
        pass  # 写不进文件只影响 MCP 集成，不影响认证本身
# 历史版本可能以宽松权限创建过该文件：每次启动都强制收紧一次。
if os.name == 'posix':
    try:
        os.chmod(API_TOKEN_FILE, 0o600)
    except OSError:
        pass

# 无需认证的路径：/health 与 /health/live、/health/ready 供桥接探活（只读、
# 不暴露敏感信息）；/files 是 workspace 静态资源，由 <img>/<model> 标签直接
# 加载，无法附加请求头（读取范围已收敛在 workspace 内）。
# 注意 /health/status 返回数据目录等诊断细节，需要 token（不进公开白名单）。
_PUBLIC_EXACT = {'/health', '/health/live', '/health/ready'}
_PUBLIC_PREFIXES = ('/files',)

# ─── 任务跨重启恢复（优化文档 4.1 尾巴 / §22） ────────────────────────────────
# 上一次运行遗留的非终态任务（pending / running）随进程消失，没有任何机制
# 会再把它们推进到终态——启动时统一标记为失败，前端查询能拿到明确收尾。
from jobstore import store as _jobstore  # noqa: E402

_interrupted_jobs = _jobstore.mark_interrupted(
    'interrupted: backend restarted before the job finished'
)
if _interrupted_jobs:
    api_logger.warning(
        'marked %d job(s) from a previous run as failed (backend restart): %s',
        len(_interrupted_jobs),
        ', '.join(_interrupted_jobs),
    )


def _is_authorized(request: Request) -> bool:
    if not API_TOKEN:
        return True  # token 未配置（极少数只读场景）时保持开放
    if request.method == 'OPTIONS':  # CORS 预检不携带自定义头
        return True
    path = request.url.path
    if path in _PUBLIC_EXACT:
        return True
    if any(path.startswith(p + '/') or path == p for p in _PUBLIC_PREFIXES):
        return True
    auth = request.headers.get('Authorization', '')
    return auth == f'Bearer {API_TOKEN}'


app = FastAPI(title='Meshforge API', version='0.1.0')

# 渲染层来源：打包态从 file:// 发起的请求 Origin 为 "null"；
# 开发态是 electron-vite 的本地 dev server 端口。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'^(null|http://localhost:\d+|http://127\.0\.0\.1:\d+)$',
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.middleware('http')
async def local_auth(request: Request, call_next):
    """本地 API 认证中间件：未携带有效 Bearer token 的请求一律拒绝。"""
    if not _is_authorized(request):
        return JSONResponse({'detail': 'unauthorized: missing or invalid API token'}, status_code=401)
    return await call_next(request)


@app.middleware('http')
async def request_logging(request: Request, call_next):
    """请求日志中间件（优化文档 7.4）。

    - 每个请求分配/透传 `X-Request-Id`（响应头回带，跨端关联）；
    - 记录 method / path / 状态码 / 耗时；命中任务查询端点时附带 job_id；
    - `/files` 静态资源高频且无诊断价值，降为 DEBUG。
    本中间件后注册、先执行（在最外层），认证拒绝的 401 也会被记录。
    """
    rid = request.headers.get('X-Request-Id') or uuid.uuid4().hex[:12]
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        api_logger.exception('%s [%s] %s -> 500 (unhandled)', rid, request.method, request.url.path)
        raise
    duration_ms = (time.perf_counter() - start) * 1000
    path = request.url.path
    log_fn = api_logger.debug if path.startswith('/files') else api_logger.info
    job_part = ''
    m = _JOB_ID_RE.search(path)
    if m:
        job_part = f' job={m.group(1)}'
    log_fn('%s [%s] %s -> %s (%.0fms)%s', rid, request.method, path, response.status_code, duration_ms, job_part)
    response.headers['X-Request-Id'] = rid
    return response


app.include_router(generate.router)
app.include_router(agent.router)
app.include_router(workflows.router)
app.include_router(extensions.router)
app.include_router(process.router)
app.include_router(model.router)
app.include_router(library.router)
app.include_router(system_stats.router)
app.include_router(settings.router)
app.include_router(diagnostics.router)

# 日志环形缓冲：诊断包的数据源之一，进程启动即挂载。
diagnostics.install_ring_handler()
# 把 workspace 挂成 /files 静态目录，前端用 /files/<job_id>/... 直接取产物。
app.mount('/files', StaticFiles(directory=WORKSPACE_DIR), name='files')


# ─── 健康检查分级（优化文档 13.4） ───────────────────────────────────────────
# live = 进程活着（K8s liveness 语义）；ready = 依赖就绪、可以接活（readiness）；
# status = 需认证的详细诊断。老端点 /health 保留并等价 /health/live，
# 既有桥接与脚本无需改动。

@app.get('/health')
@app.get('/health/live', response_model=HealthOut)
def health() -> dict:
    """存活探针（GET /health 或 /health/live）：进程在即返回 200。"""
    return {'status': 'ok', 'app': 'meshforge'}


@app.get('/health/ready', response_model=ReadyOut)
def health_ready() -> JSONResponse:
    """就绪探针（GET /health/ready）：数据目录可写才返回 200，否则 503。

    用一次性探针文件验证写权限——目录不可写时（磁盘满 / 权限被收回 /
    杀软锁定）后端看似存活但一切写入都会失败，就绪探针据此提前暴露。
    """
    try:
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        probe = WORKSPACE_DIR / '.ready-probe'
        probe.write_text('ok', encoding='utf-8')
        probe.unlink(missing_ok=True)
        return JSONResponse({'status': 'ready', 'app': 'meshforge'})
    except OSError as exc:
        return JSONResponse(
            {'status': 'not-ready', 'app': 'meshforge', 'detail': str(exc)},
            status_code=503,
        )


@app.get('/health/status', response_model=HealthStatusOut)
def health_status() -> dict:
    """详细诊断（GET /health/status，需 Bearer token）。

    返回版本 / 运行时长 / 实际端口 / 数据目录布局 / 已注册生成器数，
    供设置页与诊断包导出使用；不公开（含本机路径）。
    """
    from generators.registry import registry  # 延迟导入，避免拉重依赖

    return {
        'status': 'ok',
        'app': 'meshforge',
        'version': str(app.version),
        'uptimeSeconds': round(time.time() - _START_TIME, 1),
        'port': int(os.environ.get('MESHFORGE_API_PORT') or 8766),
        'dataDir': str(DATA_DIR),
        'workspaceDir': str(WORKSPACE_DIR),
        'modelsDir': str(MODELS_DIR),
        'generatorCount': len(registry.describe_all()),
        'tokenConfigured': bool(API_TOKEN),
    }
