"""扩展管理：schema 驱动的模型生成器 + 网格处理工具。

GET  /extensions                → 统一列表（内置 + manifest 扩展）
POST /extensions/install        → 从 GitHub URL 安装（zip → manifest → 目录）
POST /extensions/install-local  → 从上传的本地目录安装（webkitdirectory）
POST /extensions/uninstall      → 删除扩展目录 + 注册表条目
POST /extensions/reload         → 重新扫描扩展目录
GET  /extensions/install/status → 轮询安装进度（步骤 / 百分比）

安装进度通过一个可轮询的"进度槽"暴露，而不是 Electron IPC 事件（当前构建没有
主进程扩展通道），并镜像 Modly 的 download → extract → validate →
setting_up → done/error 这套步骤。
"""

import asyncio
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, UploadFile
from pydantic import BaseModel

from generators.registry import EXTENSIONS_DIR, registry

router = APIRouter(prefix='/extensions', tags=['extensions'])

# ─── 内置网格处理工具（mesh → mesh） ─────────────────────────────────────────
# 与模型生成器一样走 schema 驱动；运行引擎会用扩展 id 分发到
# POST /process/mesh。处理后端在 server/tools/mesh_tools.py 里。
# 之所以放在这里（而不是 registry 里），是为了与住在 extensions/ 目录下的
# manifest 扩展保持一致。

PROCESS_EXTENSIONS = [
    {
        'id': 'mesh-repair',
        'display_name': 'Mesh Repair',
        'kind': 'process',
        'category': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'fill_holes', 'label': '补洞', 'type': 'select', 'default': 'auto',
             'options': [{'value': 'auto', 'label': '自动'}, {'value': 'off', 'label': '关闭'}]},
        ],
    },
    {
        'id': 'mesh-smoother',
        'display_name': 'Mesh Smooth',
        'kind': 'process',
        'category': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'iterations', 'label': '平滑次数', 'type': 'int', 'default': 3, 'min': 1, 'max': 20},
            {'id': 'lambda', 'label': '松弛系数', 'type': 'float', 'default': 0.5, 'min': 0.0, 'max': 1.0},
        ],
    },
    {
        'id': 'mesh-remesher',
        'display_name': 'Mesh Remesh',
        'kind': 'process',
        'category': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'target_faces', 'label': '目标面数', 'type': 'int', 'default': 10000, 'min': 100, 'max': 200000},
        ],
    },
    {
        'id': 'mesh-optimizer',
        'display_name': 'Mesh Optimize',
        'kind': 'process',
        'category': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'merge_vertices', 'label': '合并顶点', 'type': 'select', 'default': 'on',
             'options': [{'value': 'on', 'label': '开启'}, {'value': 'off', 'label': '关闭'}]},
        ],
    },
    {
        'id': 'mesh-exporter',
        'display_name': 'Mesh Export',
        'kind': 'process',
        'category': 'process',
        'input': 'mesh',
        'output': 'none',
        'params': [
            {'id': 'format', 'label': '导出格式', 'type': 'select', 'default': 'obj',
             'options': [{'value': 'obj', 'label': 'OBJ'}, {'value': 'stl', 'label': 'STL'}, {'value': 'ply', 'label': 'PLY'}]},
        ],
    },
]

# ─── 安装进度槽（由前端轮询） ─────────────────────────────────────────────────

_INSTALL_PROGRESS: dict = {'step': 'done', 'percent': 0, 'message': '', 'extensionId': None}
# 同一时刻只允许一个安装任务在跑（下载 + 解包会互相抢磁盘与进度槽）。
_INSTALL_LOCK = asyncio.Lock()
# 持有后台任务引用：asyncio 只保留弱引用，不存住会被 GC 提前回收。
_background_tasks: set[asyncio.Task] = set()

# 白名单式 id 校验：同时用于扩展 id 与目录名，杜绝路径穿越。
_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

# 下载/安装阶段占用进度条的 0..SPAN%，剩余留给解包与落盘。
DOWNLOAD_PCT_SPAN = 90
# 目录型扩展的上限，防止误选一个大目录把服务拖死。
MAX_FOLDER_MIB = 64
MAX_FOLDER_BYTES = MAX_FOLDER_MIB * 1024 * 1024
MAX_FOLDER_FILES = 2000
# GitHub zip 下载体积上限（压缩后）。
MAX_ZIP_DOWNLOAD_BYTES = 256 * 1024 * 1024
# zip 解包后的总体积上限——防御 zip bomb（压缩比可达千倍，
# 只限压缩体积拦不住，优化文档 12.4）。
MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024


def _set_progress(step: str, percent: Optional[int] = None, message: str = '', extension_id: Optional[str] = None) -> None:
    """更新全局进度槽；未传入的字段沿用上一次的值。

    Args:
        step: 当前阶段（downloading / extracting / validating / done / error）。
        percent: 进度百分比；None 表示不改。
        message: 展示给用户的说明文案。
        extension_id: 正在安装的扩展 id；None 表示不改。
    """
    _INSTALL_PROGRESS.update({
        'step': step,
        'percent': percent if percent is not None else _INSTALL_PROGRESS.get('percent'),
        'message': message,
        'extensionId': extension_id if extension_id is not None else _INSTALL_PROGRESS.get('extensionId'),
    })


def _safe_ext_dir(ext_id: str) -> Path:
    """把扩展 id 解析为 extensions/<id> 的绝对路径。

    Raises:
        HTTPException: id 不符合白名单规则（400）。
    """
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail='invalid extension id')
    return (EXTENSIONS_DIR / ext_id).resolve()


def _validate_manifest(manifest: dict, source_label: str) -> str:
    """校验 manifest.json 的必填字段，返回扩展 id。

    Args:
        manifest: 已解析的 manifest 字典。
        source_label: 出错信息里用来指明来源的标签（如 'extension folder'）。

    Raises:
        HTTPException: 缺 id / id 非法 / kind 取值非法（均为 400）。
    """
    ext_id = str(manifest.get('id') or '').strip()
    if not ext_id:
        raise HTTPException(status_code=400, detail=f'manifest.json: required field "id" missing in {source_label}')
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail=f'manifest.json: invalid id "{ext_id}"')
    # kind 缺省按 'model' 处理，兼容早期只写生成器扩展的 manifest。
    kind = str(manifest.get('kind') or 'model')
    if kind not in ('model', 'process'):
        raise HTTPException(status_code=400, detail=f'manifest.json: kind must be "model" or "process" in {source_label}')
    return ext_id


def _install_from_folder(staging: Path, source: str = 'local-upload', source_detail: str = '') -> dict:
    """校验暂存目录并拷贝到 extensions/<id>/，随后重新扫描注册表。

    这是所有安装路径（URL / 上传 / 本地目录）的**唯一落盘出口**，
    保证三种来源走完全一致的校验与回滚逻辑。

    Args:
        staging: 已把扩展内容摊平的暂存目录。

    Returns:
        `{'ok': True, 'id': ..., 'kind': ..., 'name': ...}`。

    Raises:
        HTTPException: manifest 缺失/非法、入口文件缺失、加载失败（400）。
    """
    manifest_path = staging / 'manifest.json'
    if not manifest_path.is_file():
        raise HTTPException(status_code=400, detail='manifest.json missing from the extension folder')
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail='manifest.json is not valid JSON')
    ext_id = _validate_manifest(manifest, 'extension folder')
    kind = str(manifest.get('kind') or 'model')

    # model 类扩展必须有 generator.py；process 类扩展必须有 processor.py。
    # 入口文件名按 kind 区分，缺了就没法被 registry 加载。
    needed = 'generator.py' if kind == 'model' else 'processor.py'
    if not (staging / needed).is_file():
        raise HTTPException(status_code=400, detail=f'{needed} missing from the extension folder')

    _set_progress('validating', 90, f'Validated {ext_id}')
    dest = _safe_ext_dir(ext_id)
    EXTENSIONS_DIR.mkdir(parents=True, exist_ok=True)
    # 事务性替换（文档 12.4）：先把旧版本改名备份（同盘 rename，原子操作），
    # 再拷入新版本；加载失败立即恢复备份，避免一次失败更新丢掉已可用的扩展。
    backup: Path | None = None
    if dest.exists():
        backup = dest.with_name(f'{ext_id}.backup-{int(time.time())}')
        dest.rename(backup)
    shutil.copytree(staging, dest)

    # 重新扫描，让新扩展立刻注册生效。
    errors = registry.scan_extensions()
    if ext_id in errors:
        # 回滚损坏的安装：删掉坏目录，恢复备份，重扫注册表。
        shutil.rmtree(dest, ignore_errors=True)
        if backup is not None:
            backup.rename(dest)
        registry.scan_extensions()
        raise HTTPException(status_code=400, detail=f'Extension failed to load: {errors[ext_id]}')

    # 新版本加载成功：延迟清理旧版本备份。
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)

    # 审计元数据（优化文档 13.6 供应链治理）：记录来源 / 时间 / manifest 哈希。
    # uninstall 删除目录时随之消失；覆盖安装时被新文件覆盖；registry 扫描
    # 只认 .py 入口与 manifest.json，不受这个额外文件影响。
    try:
        import hashlib

        meta = {
            'id': ext_id,
            'kind': kind,
            'source': source,
            'sourceDetail': source_detail,
            'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            'displayName': str(manifest.get('display_name') or ext_id),
            'version': str(manifest.get('version') or ''),
            'installedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
        (dest / '.install-meta.json').write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8'
        )
    except OSError:
        pass  # 审计写失败不回滚安装本身

    _set_progress('done', 100, f'Installed {ext_id}', ext_id)
    return {'ok': True, 'id': ext_id, 'kind': kind, 'name': manifest.get('display_name', ext_id)}


def _download_to(url: str, dest: Path, max_bytes: Optional[int] = None) -> None:
    """把文件流式下载到 dest（用标准库 urllib —— 这个 venv 里没有 requests）。

    边下边写，避免大 zip 占满内存；有 Content-Length 时同步更新进度槽。
    `max_bytes` 给出时超限立即中止（413），防止无上限下载占满磁盘。

    Raises:
        HTTPException: 下载体积超过 max_bytes（413）。
    """
    req = urllib.request.Request(url, headers={'User-Agent': 'meshforge'})
    with urllib.request.urlopen(req, timeout=60.0) as resp:
        total = int(resp.headers.get('Content-Length') or 0)
        if max_bytes is not None and total > max_bytes:
            raise HTTPException(status_code=413, detail='download too large')
        done = 0
        with dest.open('wb') as fh:
            while True:
                # 64KB 分块：兼顾吞吐与进度更新频率。
                chunk = resp.read(65536)
                if not chunk:
                    break
                done += len(chunk)
                if max_bytes is not None and done > max_bytes:
                    raise HTTPException(status_code=413, detail='download too large')
                fh.write(chunk)
                # 无 Content-Length（分块传输）时无法算百分比，保持上次进度即可。
                if total > 0:
                    _set_progress('downloading', int(done * DOWNLOAD_PCT_SPAN / total))


def _extract_zip_capped(zip_path: Path, dest: Path) -> None:
    """带资源上限与 zip-slip 防御地解包 zip 到 dest。

    替代裸 `extractall`（优化文档 12.4）：
    - 文件数超过 MAX_FOLDER_FILES 拒绝；
    - 解压后总体积 / 单文件体积超过 MAX_ZIP_UNCOMPRESSED_BYTES 拒绝（zip bomb）；
    - 绝对路径或含 `..` 段的成员直接跳过（zip-slip 穿越防御）。

    Raises:
        HTTPException: 超出任一资源上限（413）。
    """
    dest_res = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        files = [i for i in infos if not i.is_dir()]
        if len(files) > MAX_FOLDER_FILES:
            raise HTTPException(status_code=413, detail='archive contains too many files (limit 2000)')
        total_uncompressed = 0
        for info in files:
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES or info.file_size > MAX_ZIP_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail='archive too large when uncompressed (zip bomb?)')
            # 统一分隔符并做穿越检查；不安全的成员跳过而不是中断整个安装。
            name = info.filename.replace('\\', '/')
            if name.startswith('/') or '..' in name.split('/'):
                continue
            target = (dest / name).resolve()
            try:
                target.relative_to(dest_res)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open('wb') as out:
                shutil.copyfileobj(src, out)


def _http_get_json(url: str) -> dict:
    """GET 一个 JSON 接口，失败时抛出带说明的 HTTPException。

    Raises:
        HTTPException: HTTP 错误码 / 网络不可达 / 响应不是合法 JSON（均为 400）。
    """
    req = urllib.request.Request(url, headers={'User-Agent': 'meshforge'})
    try:
        with urllib.request.urlopen(req, timeout=60.0) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f'lookup failed ({exc.code}) for {url}')
    except (urllib.error.URLError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f'lookup failed ({type(exc).__name__}) for {url}')


def _parse_hf(url: str) -> str:
    """从 HuggingFace URL（huggingface.co 或 hf.co）中提取 'owner/repo'。

    Raises:
        HTTPException: URL 不是 HF 仓库地址（400）。
    """
    m = re.search(r'(?:huggingface|hf)\.co/(?:models/)?([^/]+)/([^/?#]+)', url)
    if not m:
        raise HTTPException(status_code=400, detail='Must be a HuggingFace repository URL')
    # 去掉常见的 .git 后缀，避免拼出无效的 API 路径。
    return f"{m.group(1)}/{m.group(2).removesuffix('.git')}"


def _hf_file_list(repo: str) -> list[str]:
    """通过 tree API 列出 HuggingFace 仓库里的文件路径。

    Args:
        repo: 'owner/repo'。

    Returns:
        相对路径列表（只含 type='file' 的条目，目录会被过滤掉）。
    """
    data = _http_get_json(f'https://huggingface.co/api/models/{repo}/tree/main?recursive=true')
    files = []
    for item in data:
        if isinstance(item, dict) and item.get('type') == 'file':
            files.append(item['path'])
    return files


def _parse_ms(url: str) -> tuple[str, str]:
    """从 ModelScope URL 中提取 (owner, repo)。

    Raises:
        HTTPException: URL 不是 ModelScope 仓库地址（400）。
    """
    m = re.search(r'modelscope\.cn/(?:models/)?([^/]+)/([^/?#]+)', url)
    if not m:
        raise HTTPException(status_code=400, detail='Must be a ModelScope repository URL')
    return m.group(1), m.group(2).removesuffix('.git')


def _ms_file_list(owner: str, repo: str) -> list[str]:
    """通过 repo files API 列出 ModelScope 仓库里的文件路径。

    Returns:
        相对路径列表（只含 Type='blob' 的文件条目）。
    """
    data = _http_get_json(f'https://modelscope.cn/api/v1/models/{owner}/{repo}/repo/files?Revision=master')
    files = []
    for item in data.get('Data', {}).get('Files', []) or []:
        if isinstance(item, dict) and item.get('Type') == 'blob':
            files.append(item['Path'])
    return files


def _download_repo_files(paths: list[str], download_url: str, staging: Path) -> None:
    """把一批相对路径逐个下载到 staging（跳过目录与 __MACOSX）。

    Args:
        paths: 仓库内的相对文件路径列表。
        download_url: 下载模板，含一个 `{}` 占位符（由 `format` 填入转义后的路径）。
        staging: 暂存根目录。
    """
    for rel in paths:
        # __MACOSX 是 macOS 打包残留；以 '/' 结尾的是目录条目。
        if rel.startswith('__MACOSX') or rel.endswith('/'):
            continue
        staging_root = staging.resolve()
        dest = (staging_root / rel.lstrip('/')).resolve()
        # 绝不允许路径逃出暂存目录。
        # 用 relative_to 归属校验而非字符串前缀——仓库里若有 `../` 或
        # 同名前缀目录（`pkg` vs `pkg-evil`），startswith 会误放行（文档 12.2）。
        try:
            dest.relative_to(staging_root)
        except ValueError:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        # 扩展代码文件很小，单文件 64MB 上限足够拦截异常源。
        _download_to(download_url.format(urllib.parse.quote_plus(rel)), dest, max_bytes=MAX_FOLDER_BYTES)


class InstallUrlBody(BaseModel):
    """从 URL 安装扩展的请求体。"""

    url: str


@router.get('')
@router.get('/')
def list_extensions() -> list[dict]:
    """列出全部 schema 驱动的扩展。

    包含内置模型生成器 + 内置处理工具 + extensions/ 目录下发现的 manifest 扩展。

    Returns:
        扩展描述字典列表（id / display_name / kind / input / output /
        category / params，manifest 扩展还会带上 HF 下载相关字段）。
    """
    models = [
        {
            'id': g.id,
            'display_name': g.display_name,
            'kind': 'model',
            'input': g.input_type,
            'output': g.output_type,
            'category': g.category,
            'params': g.params,
        }
        for g in registry._generators.values()
    ]
    # 清单加载的扩展可携带可选的 HF 下载元数据，
    # 模型页据此为它们提供权重下载入口。
    # 只透传这三个与权重下载相关的字段，其余 manifest 内部信息不外泄。
    for ext in models + registry.process_tools():
        manifest = registry.get_manifest(ext['id'])
        if not manifest:
            continue
        for key in ('hfRepo', 'hf_skip_prefixes', 'hf_include_prefixes'):
            if manifest.get(key) is not None:
                ext[key] = manifest[key]
    return models + PROCESS_EXTENSIONS + registry.process_tools()


@router.get('/install/status')
async def install_status() -> dict:
    """GET /install/status — 返回安装进度槽（前端轮询用）。"""
    return {'progress': _INSTALL_PROGRESS}


@router.post('/install')
async def install_extension(body: InstallUrlBody) -> dict:
    """从 GitHub / HuggingFace / ModelScope 仓库 URL 安装扩展。

    下载阶段按 URL 主机名分流，但三种来源最终都会落到同一个暂存目录，
    再由同一个 `_install_from_folder` 校验并落盘。

    Args:
        body: `{'url': ...}`。

    Returns:
        `{'ok': True, 'message': 'install started'}`（下载在后台任务里进行）。

    Raises:
        HTTPException: URL 非法或无法识别来源（400）。
    """
    url = body.url.strip()
    if not url.startswith('http://') and not url.startswith('https://'):
        raise HTTPException(status_code=400, detail='Must be an http(s) URL')

    # 判别来源（约 150ms 的开销，放在异步任务之外无碍）。
    # 只在主协程里做 URL 解析与来源判定，真正的下载放进后台任务。
    low = url.lower()
    if 'github.com' in low:
        source = 'github'
        m = re.search(r'github\.com/([^/]+)/([^/?#]+)', url)
        if not m:
            raise HTTPException(status_code=400, detail='Must be a GitHub repository URL')
        owner_repo = f"{m.group(1)}/{m.group(2).removesuffix('.git')}"
    elif 'huggingface.co' in low or 'hf.co' in low:
        source = 'huggingface'
        owner_repo = _parse_hf(url)
    elif 'modelscope.cn' in low:
        source = 'modelscope'
        owner_repo = '/'.join(_parse_ms(url))
    else:
        raise HTTPException(status_code=400, detail='Must be a GitHub, HuggingFace or ModelScope repository URL')

    async def run() -> None:
        """后台安装任务：下载 → 解包/摊平 → 校验落盘，全程更新进度槽。

        下载 / 解包 / 落盘全是同步阻塞 IO，统一包进 `_blocking` 后放到
        线程池执行——直接在协程里跑会把 FastAPI 事件循环卡住，
        连带拖住健康检查与任务轮询（优化文档 12.5）。
        """
        # 串行化：并发安装会互相覆盖进度槽，也会让磁盘写入互相干扰。
        async with _INSTALL_LOCK:
            staging = EXTENSIONS_DIR.parent / '.staging' / f'{int(time.time() * 1000)}'

            def _blocking() -> None:
                staging.mkdir(parents=True, exist_ok=True)
                _set_progress('downloading', 0, f'Downloading {owner_repo}')

                if source == 'github':
                    zip_path = staging / 'repo.zip'
                    owner, repo = owner_repo.split('/', 1)
                    try:
                        _download_to(
                            f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main',
                            zip_path,
                            max_bytes=MAX_ZIP_DOWNLOAD_BYTES,
                        )
                    except urllib.error.HTTPError:
                        # 有些仓库默认分支仍是 master：main 拉不到就改试 master。
                        _download_to(
                            f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master',
                            zip_path,
                            max_bytes=MAX_ZIP_DOWNLOAD_BYTES,
                        )
                    _set_progress('extracting', 50, 'Extracting…')
                    _extract_zip_capped(zip_path, staging)
                    # codeload 的 zip 根目录是 <repo>-<ref>/…；定位唯一根文件夹。
                    # 解包后会多出一层 <repo>-<ref>/，取出它作为真正的扩展内容根。
                    extracted = [p for p in staging.iterdir() if p.is_dir() and p.name != '__MACOSX']
                    source_folder = extracted[0] if extracted else staging
                elif source == 'huggingface':
                    paths = _hf_file_list(owner_repo)
                    _download_repo_files(
                        paths,
                        f'https://huggingface.co/{owner_repo}/resolve/main/' + '{}',
                        staging,
                    )
                    source_folder = staging
                else:  # modelscope
                    owner, repo = owner_repo.split('/', 1)
                    paths = _ms_file_list(owner, repo)
                    _download_repo_files(
                        paths,
                        f'https://modelscope.cn/api/v1/models/{owner}/{repo}/repo?Revision=master&FilePath=' + '{}',
                        staging,
                    )
                    source_folder = staging

                _set_progress('validating', 90, 'Validating…')
                _install_from_folder(source_folder, source=source, source_detail=url)

            try:
                await asyncio.to_thread(_blocking)
            except HTTPException as exc:
                # 业务性错误：detail 已经是给用户看的中文文案。
                _set_progress('error', 0, exc.detail)
            except Exception as exc:  # noqa: BLE001
                _set_progress('error', 0, f'{type(exc).__name__}: {exc}')
            finally:
                # 无论成败都清掉暂存目录，避免 .staging 无限膨胀。
                shutil.rmtree(staging, ignore_errors=True)

    task = asyncio.create_task(run())
    _background_tasks.add(task)
    # 完成后从集合里移除，防止任务对象越攒越多。
    task.add_done_callback(_background_tasks.discard)
    return {'ok': True, 'message': 'install started'}


@router.post('/install-local')
async def install_from_local(files: list[UploadFile], root_dir: str = Body(default='')) -> dict:
    """从上传的本地目录安装扩展（webkitdirectory 输入）。

    浏览器会把每个文件连同其相对路径一起发来；这里在 extensions/<id>/ 下
    重建目录结构后重扫。所选根目录之外的文件会被忽略。

    Args:
        files: multipart 上传的文件列表（filename 携带相对路径）。
        root_dir: 浏览器给出的根目录名（作为暂存目录名使用）。

    Raises:
        HTTPException: 没有任何文件上传（400）。
    """
    if not files:
        raise HTTPException(status_code=400, detail='no files uploaded')

    # 去掉两端的路径分隔符，防止拼出绝对路径或空段。
    root = root_dir.strip('/\\') or 'extension'
    # root_dir 即扩展文件夹名（用作暂存目录名）。
    staging_root = EXTENSIONS_DIR.parent / '.staging' / f'local-{int(time.time() * 1000)}'
    staging_root.mkdir(parents=True, exist_ok=True)

    # 与 /install-dir 相同的资源上限：multipart 请求没有总量约束，
    # 恶意或误选的大目录会直接占满磁盘（文档 12.4）。
    total_bytes = 0
    for f in files:
        # 统一分隔符：Windows 下 webkitRelativePath 可能带反斜杠。
        rel = (f.filename or '').replace('\\', '/')
        # webkitRelativePath 形如 "my-ext/manifest.json"；若浏览器
        # 只给了文件名，则视作位于根目录下。
        if rel.startswith(root + '/'):
            rel = rel[len(root) + 1:]
        # 空路径或含 '..' 的路径一律丢弃（路径穿越防护）。
        if not rel or '..' in rel.split('/'):
            continue
        dest = staging_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        try:
            with dest.open('wb') as fh:
                while True:
                    chunk = f.file.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    total_bytes += len(chunk)
                    if total_bytes > MAX_FOLDER_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f'extension too large (limit {MAX_FOLDER_MIB} MB)',
                        )
                    fh.write(chunk)
        finally:
            await f.close()

    try:
        result = _install_from_folder(staging_root)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
    return result


class InstallDirBody(BaseModel):
    """从本地目录路径安装扩展的请求体。"""

    path: str


@router.post('/install-dir')
def install_from_dir(body: InstallDirBody) -> dict:
    """直接从本地目录路径安装扩展。

    路径来自主进程的原生目录选择对话框（fs:selectFolder）：渲染进程里的
    webkitdirectory <input type=file> 会把本机 Chromium 卡死/崩溃
    （mesh/image 选择器也是同一根因 —— 见 19e/19f/19h），所以渲染进程从不
    接触这些文件。后端在服务端复制整棵目录树，然后复用与 /install-local
    完全一致的校验 + 安装路径：manifest.json + generator.py/processor.py，
    拷贝到 extensions/<id>/，重扫，加载失败则回滚。

    Args:
        body: `{'path': 本地目录绝对路径}`。

    Raises:
        HTTPException: 目录不存在（400）、选了 meshforge 内部目录（400）、
            目录过大（400）、目录不可读（400）。
    """
    src = Path(body.path).expanduser()
    if not src.is_dir():
        raise HTTPException(status_code=400, detail=f'folder not found: {src}')
    src_res = src.resolve()
    ext_res = EXTENSIONS_DIR.resolve()
    # 拒绝选择 meshforge 内部目录（extensions 目录本身、已安装的
    # 某个扩展、或暂存区）——否则要么递归自拷，
    # 要么会把已安装的扩展破坏掉。
    if src_res == ext_res or ext_res in src_res.parents or '.staging' in src_res.parts:
        raise HTTPException(status_code=400, detail='pick the extension source folder (the one containing manifest.json), not a meshforge-internal directory')

    # 设置合理上限，避免误选超大文件夹撑爆磁盘。
    total_bytes = 0
    total_files = 0
    try:
        for p in src_res.rglob('*'):
            if p.is_file():
                try:
                    total_bytes += p.stat().st_size
                except OSError:
                    # 个别文件读不到（权限/被占用）时跳过，不因此中断整个统计。
                    continue
                total_files += 1
                if total_bytes > MAX_FOLDER_BYTES or total_files > MAX_FOLDER_FILES:
                    raise HTTPException(status_code=400, detail='folder too large (limit 64 MB / 2000 files)')
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=400, detail=f'cannot read folder: {src}')

    staging_root = EXTENSIONS_DIR.parent / '.staging' / f'local-{int(time.time() * 1000)}'
    staging_root.parent.mkdir(parents=True, exist_ok=True)
    try:
        # symlinks=True：按链接原样复制而非跟随（避免循环）。
        shutil.copytree(src_res, staging_root, symlinks=True)
        return _install_from_folder(staging_root, source='local-dir', source_detail=str(src_res))
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


class UninstallBody(BaseModel):
    """卸载扩展的请求体。"""

    id: str


@router.post('/uninstall')
async def uninstall_extension(body: UninstallBody) -> dict:
    """删除扩展目录（若存在）并从注册表注销。

    Returns:
        `{'ok': True, 'removed': 是否真的删掉了目录, 'id': ...}`。
    """
    ext_id = body.id
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail='invalid extension id')
    dest = _safe_ext_dir(ext_id)
    # 内置扩展没有目录，只有 manifest 扩展才可能被真正删掉。
    removed_dir = dest.exists() and dest.is_dir()
    if removed_dir:
        shutil.rmtree(dest)
    registry.unload(ext_id)
    registry.scan_extensions()
    return {'ok': True, 'removed': removed_dir, 'id': ext_id}


@router.post('/reload')
async def reload_extensions() -> dict:
    """重新扫描扩展目录并重载注册表（无需重启服务）。

    Returns:
        `{'reloaded': True, 'models': [...], 'errors': {...}}`；errors 为
        扫描中加载失败的扩展及其原因。
    """
    errors = registry.scan_extensions()
    return {
        'reloaded': True,
        'models': list(registry._generators.keys()),
        'errors': errors,
    }
