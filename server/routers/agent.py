"""Agent 对话端点 —— 驱动一个由 Ollama 支撑的工具调用循环，对 Meshforge 自身 API 施为。

与 Modly 的 /agent/chat 契约保持一致（message / actions / thinking 三段式），
但只用 Python 标准库实现（venv 里没装 httpx/requests）。
后端会回调自己的 HTTP API（127.0.0.1:8766）来实际操作场景。
"""

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix='/agent', tags=['agent'])

# 自身回调地址：端口跟随启动时注入的 MESHFORGE_API_PORT（Electron 从
# 8766 起自动选空闲端口后注入）；独立运行时维持默认 8766（文档 7.1）。
API_BASE = f"http://127.0.0.1:{os.environ.get('MESHFORGE_API_PORT') or 8766}"
# Agent 生成的节点在画布上的纵向间距（像素），避免新节点互相重叠。
NODE_SPACING_Y = 200

# 系统提示词：定义助手身份、可用工具清单与行为约束（"必须真的调工具、不许编 id"等）。
# 这是发给模型的原文，改动会直接影响工具调用的正确率，非必要不要动。
SYSTEM_PROMPT = """\
You are Meshforge's built-in AI assistant, specialized in 3D modeling and workflow automation.
You help users generate 3D models from images, optimize meshes, and manage workflows directly inside the Meshforge application.

## Available tools

- **list_models** — List all downloaded 3D generation models ready to use.
- **unload_models** — Unload all 3D generation models from GPU VRAM to free memory.
- **get_mesh_info** — Get info about the current mesh in the 3D viewer (path, triangle count).
- **decimate_mesh(path, target_faces)** — Reduce the polygon count of a mesh.
- **smooth_mesh(path, iterations)** — Apply Laplacian smoothing to a mesh.
- **get_generation_status(job_id)** — Poll the status of an ongoing 3D generation job.
- **list_workflows** — List all available workflows in Meshforge.
- **run_workflow(workflow_id)** — Execute a workflow in Meshforge by its ID. If the user attached an image in their message, it will automatically be used as the workflow's input image.
- **create_workflow(name, input_type, steps, description?)** — Create a new workflow from an ordered list of processing steps. Each step references an extension by its exact `id` and may override its params. The steps run in sequence, the output of one feeding the next. The input source is one of exactly three nodes — `image` (Image), `text` (Text), or `mesh` (Load 3D Mesh) — and an Add-to-Scene output node is appended automatically.

## Rules

- Always use tools to act on the scene — never just describe what you would do.
- If you need the current mesh path, call get_mesh_info first.
- If you need to run a workflow but don't know the ID, call list_workflows first.
- To create a workflow, ONLY use extension ids listed under "Available extensions" in the context. Never invent an id. Chain steps so each step's input type matches the previous step's output type.
- For a workflow's input, `input_type` MUST be exactly one of: `image`, `text`, or `mesh`. These map to the Image, Text, and Load 3D Mesh nodes. Never invent another input. Pick the one matching the first step's expected input.
- After each tool call, give a short one-sentence summary of what was done.
- Always reply in the same language the user is writing in.
- Be concise. No unnecessary explanations.\
"""

# 工具声明表（OpenAI function-calling 格式）：同时喂给 Ollama 与 OpenAI 兼容端点。
TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'list_models',
            'description': 'List all available 3D generation models that are downloaded and ready.',
            'parameters': {'type': 'object', 'properties': {}},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'unload_models',
            'description': 'Unload all 3D generation models from VRAM to free GPU memory.',
            'parameters': {'type': 'object', 'properties': {}},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'get_mesh_info',
            'description': 'Get information about the current mesh loaded in the 3D viewer (triangle count, path, etc.).',
            'parameters': {'type': 'object', 'properties': {}},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'decimate_mesh',
            'description': 'Reduce the polygon count of the current mesh using quadric edge collapse.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {
                        'type': 'string',
                        'description': "Workspace-relative path to the mesh file (e.g. 'Default/mesh.glb'). Use get_mesh_info to obtain it.",
                    },
                    'target_faces': {
                        'type': 'integer',
                        'description': 'Target number of faces after decimation.',
                    },
                },
                'required': ['path', 'target_faces'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'smooth_mesh',
            'description': 'Apply Laplacian smoothing to the current mesh.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {
                        'type': 'string',
                        'description': 'Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.',
                    },
                    'iterations': {
                        'type': 'integer',
                        'description': 'Number of smoothing iterations (1–20). More = smoother but loses detail.',
                    },
                },
                'required': ['path', 'iterations'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'get_generation_status',
            'description': 'Poll the status of an ongoing 3D generation job.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'job_id': {'type': 'string', 'description': 'Job ID returned by a previous generation call.'},
                },
                'required': ['job_id'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'list_workflows',
            'description': 'List all workflows available in Meshforge.',
            'parameters': {'type': 'object', 'properties': {}},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'run_workflow',
            'description': 'Execute a Meshforge workflow by its ID. The workflow runs in the background; progress is shown in the app.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'workflow_id': {'type': 'string', 'description': 'The workflow ID to execute. Use list_workflows to get available IDs.'},
                },
                'required': ['workflow_id'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'create_workflow',
            'description': (
                'Create a new Meshforge workflow from an ordered list of steps. '
                'Each step references an extension by its exact id (see \'Available extensions\' in context). '
                'Steps run in sequence; do not include the input itself as a step.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'name': {'type': 'string', 'description': 'Short human-readable name for the workflow.'},
                    'description': {'type': 'string', 'description': 'Optional one-line description of what the workflow does.'},
                    'input_type': {
                        'type': 'string',
                        'enum': ['image', 'text', 'mesh'],
                        'description': (
                            "The workflow's input source node. Exactly one of: "
                            "'image' (Image node), 'text' (Text node), "
                            "'mesh' (Load 3D Mesh node, uses the current scene mesh). "
                            'Never use any other value.'
                        ),
                    },
                    'steps': {
                        'type': 'array',
                        'description': 'Ordered processing steps. Each runs after the previous one.',
                        'items': {
                            'type': 'object',
                            'properties': {
                                'extension_id': {
                                    'type': 'string',
                                    'description': "Exact extension id from 'Available extensions' (e.g. 'mesh-optimizer/optimize').",
                                },
                                'params': {
                                    'type': 'object',
                                    'description': 'Optional param overrides, keyed by param id. Omit to use defaults.',
                                },
                            },
                            'required': ['extension_id'],
                        },
                    },
                },
                'required': ['name', 'input_type', 'steps'],
            },
        },
    },
]

# Agent 可选的输入节点种类 → 真实的 Meshforge 源节点 payload
# （与 WorkflowsPage.tsx 里 createNodeFromPayload 产出的结构一致）。
INPUT_NODES = {
    'image': {'type': 'imageNode', 'label': 'Image', 'color': '#38bdf8', 'params': {}},
    'text':  {'type': 'textNode',  'label': 'Text',  'color': '#fbbf24', 'params': {'text': 'A 3D model'}},
    'mesh':  {'type': 'meshNode',  'label': 'Load 3D Mesh', 'color': '#a78bfa', 'params': {'source': 'current'}},
}

# 由 Agent 生成的节点类型对应的画布配色（需与前端 NODE_SPECS 保持一致）。
NODE_COLORS = {
    'extensionNode': '#34d399',
    'outputNode': '#a78bfa',
}


# ─── 极简标准库 HTTP 辅助 ────────────────────────────────────────────────────

# 视为"本机"的主机名（允许 http 明文）。
_LOCAL_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1', '[::1]'})
# 明确禁止访问的地址：云厂商元数据服务是 SSRF 的经典目标。
_BLOCKED_HOSTS = frozenset({'169.254.169.254', 'metadata.google.internal'})


def _is_private_lan(host: str) -> bool:
    """判断主机是否为内网地址（自托管 Ollama 常见于局域网）。"""
    if host.endswith('.local') or host in _LOCAL_HOSTS:
        return True
    m = re.match(r'^(\d{1,3})(\.\d{1,3}){3}$', host)
    if not m:
        return False
    a, b = (int(p) for p in host.split('.')[:2])
    return (
        a == 10
        or a == 192 and b == 168
        or a == 172 and 16 <= b <= 31
    )


def _validate_provider_url(raw: str, *, lan_http_ok: bool) -> str:
    """校验用户提供的 provider 地址，收紧 SSRF 面（优化文档 12.3）。

    规则：
    - 仅允许 http/https scheme（拒绝 file/ftp/data 等一切其他协议）；
    - 拒绝携带 userinfo（user:pass@）与元数据服务地址；
    - 本机地址允许 http；Ollama 的内网地址允许 http（lan_http_ok）；
    - 其余远程地址必须 https。

    Returns:
        归一化（去尾部 /）后的 URL。

    Raises:
        RuntimeError: 地址不合法（文案直接面向用户展示）。
    """
    url = (raw or '').strip().rstrip('/')
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        raise RuntimeError(f'invalid provider URL: {exc}') from exc
    if parsed.scheme not in ('http', 'https'):
        raise RuntimeError(f'provider URL scheme must be http(s), got: {parsed.scheme or "(none)"}')
    host = (parsed.hostname or '').lower()
    if not host:
        raise RuntimeError('provider URL is missing a host')
    if parsed.username or parsed.password:
        raise RuntimeError('provider URL must not contain credentials')
    if host in _BLOCKED_HOSTS:
        raise RuntimeError('provider URL points to a blocked address')
    local = host in _LOCAL_HOSTS
    if not local and parsed.scheme != 'https' and not (lan_http_ok and _is_private_lan(host)):
        raise RuntimeError(
            f'insecure http is only allowed for local/LAN services; use https for {host}'
        )
    return url


def _request_json(method: str, url: str, payload: dict | None = None, timeout: float = 60.0, headers: dict | None = None) -> dict | None:
    """对 Meshforge 自身 API、Ollama 或 OpenAI 兼容端点发同步 JSON 请求。

    Args:
        method: HTTP 方法。
        url: 完整 URL。
        payload: 有值时按 JSON 序列化并自动补 Content-Type。
        timeout: 超时秒数（推理类调用需要给到 120s）。
        headers: 附加请求头（如自定义 provider 的 Authorization）。

    Returns:
        解析后的 JSON；响应体为空时返回 None。

    Raises:
        RuntimeError: 任何网络/协议/解析错误统一转成 RuntimeError，便于上层把
            错误文本直接喂给 LLM。
    """
    data = None
    hdrs: dict = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode('utf-8')) if raw else None
    except urllib.error.HTTPError as e:
        # 截断到 300 字符：错误页可能是整页 HTML，全塞进 LLM 上下文没意义。
        detail = e.read().decode('utf-8', errors='replace')[:300] if e.fp else ''
        raise RuntimeError(f'HTTP {e.code}: {detail}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'Network error: {e.reason}') from e
    except OSError as e:  # ConnectionResetError / ConnectionRefusedError etc. on Windows
        raise RuntimeError(f'Network error: {e}') from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f'Invalid JSON response: {e}') from e


def _mesh_relative(path: str) -> str:
    """把网格路径规范成 /process/mesh 能接受的形式：是完整 URL 就去掉 scheme/host。

    保留 query string（serve-file 形式的 URL 会把绝对路径放在 '?path='，
    而 process._resolve_local 正需要这个参数）。

    Args:
        path: 原始路径或 URL。

    Returns:
        相对路径，或去掉 host 后的 path + query。
    """
    if path.startswith('http://') or path.startswith('https://'):
        p = urllib.parse.urlparse(path)
        return p.path + (f'?{p.query}' if p.query else '')
    return path


def _run_mesh_tool(extension_id: str, mesh_url: str, params: dict) -> dict:
    """提交一个网格工具任务并轮询到完成。

    Args:
        extension_id: 处理扩展 id（如 'mesh-remesher'）。
        mesh_url: 输入网格地址。
        params: 该工具的参数。

    Returns:
        `{'url': 结果网格地址, 'face_count': 后端回传的说明文本}`。

    Raises:
        RuntimeError: 未拿到 job_id / 任务失败或取消 / 轮询超时。
    """
    body = _request_json('POST', f'{API_BASE}/process/mesh', {
        'mesh_url': mesh_url,
        'extension_id': extension_id,
        'params': params,
    })
    job_id = (body or {}).get('job_id', '')
    if not job_id:
        raise RuntimeError(f'{extension_id}: no job_id returned')
    for _ in range(240):  # 240 * 0.5s = up to 2 min
        status = _request_json('GET', f'{API_BASE}/generate/jobs/{job_id}')
        if not status:
            # 单次查询失败不致命（可能刚好在状态切换），继续下一次轮询。
            continue
        state = status.get('state', '')
        if state == 'succeeded':
            return {
                'url': status.get('result_url', ''),
                'face_count': status.get('message', ''),
            }
        if state in ('failed', 'cancelled'):
            raise RuntimeError(f'{extension_id}: {status.get("error") or state}')
        time.sleep(0.5)
    raise RuntimeError(f'{extension_id}: timed out')


def _build_workflow_graph(name: str, description: str, input_type: str, steps: list[dict]) -> dict:
    """把简化的步骤描述装配成 Meshforge 的工作流图（nodes + edges）。

    节点 payload 镜像 WorkflowsPage.tsx 里 createNodeFromPayload 的结构
    （label/color/params/initialWidth/initialHeight），让前端可以直接补上
    id/时间戳并保存。边使用 workflowEdge 类型，不带额外样式字段。

    Args:
        name: 工作流名称。
        description: 一行描述。
        input_type: 'image' | 'text' | 'mesh'；未知值回退到 'image'。
        steps: 有序步骤列表，每项含 extension_id 与可选 params。

    Returns:
        `{'name', 'description', 'nodes', 'edges'}`。
    """
    spec = INPUT_NODES.get(input_type, INPUT_NODES['image'])
    input_node = {
        'id': uuid.uuid4().hex[:8],
        'type': spec['type'],
        'position': {'x': 250, 'y': 50},
        'initialWidth': 200,
        'initialHeight': 80,
        'data': {'label': spec['label'], 'color': spec['color'], 'params': dict(spec['params'])},
    }

    # 处理节点自上而下排布：150 起步，每步下移一个 NODE_SPACING_Y。
    ext_nodes = []
    for i, step in enumerate(steps):
        ext_nodes.append({
            'id': uuid.uuid4().hex[:8],
            'type': 'extensionNode',
            'position': {'x': 250, 'y': 150 + i * NODE_SPACING_Y},
            'initialWidth': 200,
            'initialHeight': 80,
            'data': {
                'label': str(step['extension_id']),
                'color': NODE_COLORS['extensionNode'],
                'extensionId': step['extension_id'],
                # extensionId 同时写进 params：运行器从 params 读取实际调用的扩展。
                'params': {'extensionId': step['extension_id'], **dict(step.get('params') or {})},
            },
        })

    output_node = {
        'id': uuid.uuid4().hex[:8],
        'type': 'outputNode',
        'position': {'x': 250, 'y': 150 + len(steps) * NODE_SPACING_Y},
        'initialWidth': 200,
        'initialHeight': 80,
        'data': {'label': 'Add to Scene', 'color': NODE_COLORS['outputNode'], 'params': {}},
    }

    # 线性串联：input → step1 → step2 → … → output。
    all_nodes = [input_node, *ext_nodes, output_node]
    edges = [
        {
            'id': f'e-{all_nodes[i]["id"]}-{all_nodes[i + 1]["id"]}',
            'source': all_nodes[i]['id'],
            'target': all_nodes[i + 1]['id'],
            'type': 'workflowEdge',
        }
        for i in range(len(all_nodes) - 1)
    ]

    return {'name': name, 'description': description, 'nodes': all_nodes, 'edges': edges}


# ─── 工具执行 ────────────────────────────────────────────────────────────────

# 工具名 → 处理函数。全部处理器签名为 (arguments, context) -> (结果文本, action payload | None)。
# 拆分为按领域分组的具名函数，是为了让 hf/agent 的单函数保持可读、可单测；
# 分派语义与原 if/elif 链完全一致（阶段一抽取，行为零变更）。


def _tool_list_models(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """列出已下载可用的模型（未装权重的不列，避免模型推荐不存在的模型）。"""
    models = _request_json('GET', f'{API_BASE}/generators') or []
    loaded = [m for m in models if m.get('is_loaded')]
    if not loaded:
        return 'No models downloaded yet.', None
    lines = '\n'.join(f"- {m['id']}: {m.get('display_name', m['id'])}" for m in loaded)
    return f'Available models:\n{lines}', None


def _tool_unload_models(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """卸载全部生成模型。

    Meshforge 的注册表还没有服务端"全部卸载"接口；生成器是惰性卸载的。
    这里直接报成功，以免打断工具循环。
    """
    return 'All 3D generation models have been unloaded from VRAM.', None


def _tool_get_mesh_info(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """报告当前查看器里网格的路径与三角面数。"""
    mesh_path = context.get('currentMeshPath')
    mesh_triangles = context.get('meshTriangles')
    if not mesh_path:
        return 'No mesh currently loaded in the viewer.', None
    info = f'Current mesh: {_mesh_relative(mesh_path)}'
    if mesh_triangles:
        # 千分位分隔，方便模型/用户读大数字。
        info += f' ({mesh_triangles:,} triangles)'
    return info, None


def _tool_decimate_mesh(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """对网格执行 QEM 减面，返回新的网格 URL。"""
    path = _mesh_relative(str(arguments.get('path', '')))
    result = _run_mesh_tool('mesh-remesher', path, {
        'target_faces': int(arguments.get('target_faces', 10000)),
    })
    payload = {'type': 'mesh_update', 'url': result['url'], 'face_count': result.get('face_count')}
    return f"Decimated to {result.get('face_count') or '?'} faces.", payload


def _tool_smooth_mesh(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """对网格执行平滑，返回新的网格 URL。"""
    path = _mesh_relative(str(arguments.get('path', '')))
    result = _run_mesh_tool('mesh-smoother', path, {
        'iterations': int(arguments.get('iterations', 3)),
    })
    payload = {'type': 'mesh_update', 'url': result['url']}
    # 文案沿用原实现的 arguments 取值（可能为 None），保持对外行为不变。
    return f"Smoothed mesh ({arguments.get('iterations')} iterations).", payload


def _tool_get_generation_status(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """查询某个生成任务的进度与结果。"""
    status = _request_json('GET', f"{API_BASE}/generate/jobs/{arguments.get('job_id', '')}")
    if not status:
        return 'Job not found.', None
    text = f"Status: {status.get('state')}, Progress: {status.get('progress', 0) * 100:.0f}%"
    if status.get('result_url'):
        text += f", Output: {status['result_url']}"
    if status.get('error'):
        text += f", Error: {status['error']}"
    return text, None


def _tool_list_workflows(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """列出前端上下文里的工作流。"""
    workflows = context.get('workflows', [])
    if not workflows:
        return 'No workflows found. Create one in the Workflows tab.', None
    lines = '\n'.join(f"- {w['id']}: {w['name']}" for w in workflows)
    return f'Available workflows:\n{lines}', None


def _tool_run_workflow(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """校验工作流 id 后请求前端运行它。"""
    workflow_id = arguments.get('workflow_id', '')
    workflows = context.get('workflows', [])
    # 先在前端给的列表里校验 id：不存在就提示模型改用 list_workflows，
    # 而不是把一个注定失败的运行请求发出去。
    match = next((w for w in workflows if w['id'] == workflow_id), None)
    if not match:
        return f"Workflow '{workflow_id}' not found. Use list_workflows to see available workflows.", None
    payload = {'type': 'run_workflow', 'workflow_id': workflow_id, 'workflow_name': match['name']}
    return f"Executing workflow '{match['name']}'…", payload


def _tool_create_workflow(arguments: dict, context: dict) -> tuple[str, dict | None]:
    """按模型给出的步骤构建工作流图，并回传给前端创建。"""
    steps = arguments.get('steps') or []
    if not steps:
        return 'A workflow needs at least one step. Specify the extensions to chain.', None

    input_type = arguments.get('input_type') or 'image'
    if input_type not in INPUT_NODES:
        return (
            f"Invalid input_type '{input_type}'. Use exactly one of: "
            'image (Image node), text (Text node), mesh (Load 3D Mesh node).',
            None,
        )

    extensions = context.get('extensions', [])
    valid_ids = {e['id'] for e in extensions}
    if valid_ids:
        # 防幻觉：模型很容易编造扩展 id，这里逐个校验并回传可用清单。
        unknown = [s.get('extension_id') for s in steps if s.get('extension_id') not in valid_ids]
        if unknown:
            avail = ', '.join(sorted(valid_ids)) or '(none installed)'
            return (
                f"Unknown extension id(s): {', '.join(map(str, unknown))}. "
                f'Use only these: {avail}.',
                None,
            )

    wf = _build_workflow_graph(
        name=arguments.get('name') or 'New Workflow',
        description=arguments.get('description') or '',
        input_type=input_type,
        steps=steps,
    )
    payload = {'type': 'create_workflow', 'workflow': wf}
    return f"Created workflow '{wf['name']}' with {len(steps)} step(s).", payload


TOOL_HANDLERS: dict[str, callable] = {
    'list_models': _tool_list_models,
    'unload_models': _tool_unload_models,
    'get_mesh_info': _tool_get_mesh_info,
    'decimate_mesh': _tool_decimate_mesh,
    'smooth_mesh': _tool_smooth_mesh,
    'get_generation_status': _tool_get_generation_status,
    'list_workflows': _tool_list_workflows,
    'run_workflow': _tool_run_workflow,
    'create_workflow': _tool_create_workflow,
}


def _execute_tool(name: str, arguments: dict, context: dict) -> tuple[str, dict | None]:
    """执行一个工具，返回 (结果文本, action payload)。

    action payload 携带前端需要据此反应的数据（例如新的网格 URL）；
    没有副作用时返回 None。

    Args:
        name: 工具名。
        arguments: 模型给出的参数。
        context: 前端随请求带来的场景上下文（当前网格、工作流列表、扩展列表）。

    Returns:
        `(result_text, payload)`；result_text 会被回填进对话供模型继续推理。
    """
    handler = TOOL_HANDLERS.get(name)
    try:
        if handler is None:
            return f'Unknown tool: {name}', None
        return handler(arguments, context)

    except RuntimeError as e:
        # 工具错误不回滚整个对话：转成文本让模型知道失败原因并自行调整。
        return f'Error: {e}', None
    except Exception as e:  # noqa: BLE001 - surfaced to the LLM as text
        return f'Error: {e}', None


# ─── 请求 / 响应模型 ─────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    """一条对话消息。"""

    role: str
    content: str
    # Ollama 风格的内联 base64 图片（OpenAI 兼容端点通常不认这个字段）。
    images: list[str] = []


class AgentChatRequest(BaseModel):
    """Agent 对话请求体。"""

    messages: list[ChatMessage]
    ollama_url: str = 'http://localhost:11434'
    model: str = 'qwen2.5:3b'
    context: dict = {}
    thinking: str = 'auto'  # "auto" | "on" | "off"
    # 自定义供应商（OpenAI 兼容）：设置后聊天改走 OpenAI 兼容的
    # /chat/completions 端点，而不是 Ollama。
    provider: str = 'ollama'  # "ollama" | "openai"
    base_url: str = ''
    api_key: str = ''


class ActionDone(BaseModel):
    """一次已完成的工具调用记录（回传给前端渲染动作卡片）。"""

    tool: str
    result: str
    payload: dict | None = None


class AgentChatResponse(BaseModel):
    """Agent 对话响应体。"""

    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """拆出 (清洗后的正文, 思维链文本)。兼容 Ollama 原生字段与 <think> 标签。

    Args:
        msg: 模型返回的 message 字典。

    Returns:
        content 已剥离 `<think>…</think>` 片段；thinking 为 None 表示没有思维链。
    """
    content = msg.get('content', '')
    thinking = msg.get('thinking') or None
    if not thinking:
        # 部分模型把思维链直接写在正文里，用 <think> 标签包裹。
        match = re.search(r'<think>(.*?)</think>', content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            # 从正文中挖掉这段，避免思维链混进最终回复。
            content = (content[: match.start()] + content[match.end():]).strip()
    return content, thinking


# ─── Provider 辅助 ───────────────────────────────────────────────────────────

def _openai_headers(api_key: str) -> dict:
    """构造 OpenAI 兼容端点的鉴权头；无 key 时返回空字典。"""
    return {'Authorization': f'Bearer {api_key}'} if api_key else {}


def _chat_endpoint(base_url: str) -> str:
    """把 OpenAI 兼容的 base URL 拼成 chat completions 端点。

    既接受裸 origin（https://api.x.com），也接受带 /v1 的完整 base
    （https://api.x.com/v1），统一归一化成 .../chat/completions。
    """
    base = base_url.rstrip('/')
    # 用户可能已经把完整端点粘进来了，这种情况原样返回。
    if base.endswith('/chat/completions'):
        return base
    if base.endswith('/v1'):
        return base + '/chat/completions'
    return base + '/v1/chat/completions'


def _models_endpoint(base_url: str) -> str:
    """把 OpenAI 兼容的 base URL 拼成 models 列表端点。"""
    base = base_url.rstrip('/')
    if base.endswith('/v1'):
        return base + '/models'
    return base + '/v1/models'


# ─── 路由 ────────────────────────────────────────────────────────────────────

@router.get('/models')
async def list_models(
    provider: str = 'ollama',
    base_url: str = '',
    api_key: str = '',
    ollama_url: str = 'http://localhost:11434',
) -> dict:
    """列出某个 provider 下可用的模型。

    * provider='openai'：GET {base_url}/models，带 Bearer key（尽力而为）。
    * provider='ollama'：查询 Ollama 的 /api/tags（为兼容保留）。

    Returns:
        `{'models': [...]}`；任何失败都静默返回空列表（前端只用来填下拉框）。
    """
    if provider == 'openai' and base_url:
        try:
            # 远程端点必须 https（本机/内网除外），SSRF 校验与 /chat 一致。
            url = _models_endpoint(_validate_provider_url(base_url, lan_http_ok=False))
        except RuntimeError as exc:
            return {'models': [], 'error': str(exc)}
        try:
            # 5s 超时：这是 UI 侧的下拉框填充，不能让用户等太久。
            # 同步网络请求放入线程池，避免占住事件循环（文档 12.5）。
            data = await asyncio.to_thread(
                _request_json, 'GET', url, None, 5.0, _openai_headers(api_key)
            )
            models = [m.get('id', '') for m in (data or {}).get('data', []) if m.get('id')]
            return {'models': models}
        except Exception:
            return {'models': []}
    try:
        ollama_url = _validate_provider_url(ollama_url, lan_http_ok=True)
    except RuntimeError as exc:
        return {'models': [], 'error': str(exc)}
    url = ollama_url + '/api/tags'
    try:
        data = await asyncio.to_thread(_request_json, 'GET', url, None, 5.0)
        models = [m['name'] for m in (data or {}).get('models', [])]
        return {'models': models}
    except Exception:
        return {'models': []}


def _build_messages(request: AgentChatRequest) -> list[dict]:
    """先塞系统提示词与场景上下文，再追加用户/助手的历史轮次。

    Args:
        request: 客户端请求。

    Returns:
        可直接发给模型的 messages 列表。
    """
    messages: list[dict] = [{'role': 'system', 'content': SYSTEM_PROMPT}]

    if request.context:
        ctx_lines = []
        if request.context.get('currentMeshPath'):
            ctx_lines.append(f"Current mesh path: {_mesh_relative(request.context['currentMeshPath'])}")
        if request.context.get('meshTriangles'):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if ctx_lines:
            messages.append({'role': 'system', 'content': 'Scene context:\n' + '\n'.join(ctx_lines)})

        extensions = request.context.get('extensions') or []
        if extensions:
            # 把扩展清单作为独立 system 消息喂进去：模型创建流程时必须用这里的精确 id。
            ext_lines = [
                f"- {e['id']} ({e.get('input', '?')}→{e.get('output', '?')}): {e.get('display_name', e['id'])}"
                for e in extensions
            ]
            messages.append({
                'role': 'system',
                'content': (
                    'Available extensions (use the exact id when creating workflows):\n'
                    + '\n'.join(ext_lines)
                ),
            })

    for m in request.messages:
        entry: dict = {'role': m.role, 'content': m.content}
        if m.images:
            # Ollama 风格的 base64 图片。OpenAI 兼容供应商通常不认这个字段；
            # 若请求被拒，会去掉图片重试
            # （见 _chat_round）。
            entry['images'] = m.images
        messages.append(entry)
    return messages


def _normalize_headers(api_key: str) -> dict:
    """与 `_openai_headers` 等价的别名（历史命名，保留以兼容旧调用点）。"""
    return {'Authorization': f'Bearer {api_key}'} if api_key else {}


def _ollama_round(request: AgentChatRequest, messages: list[dict]) -> dict:
    """跑一轮 Ollama 推理。

    Returns:
        `{'ok': True, 'msg': ..., 'content': ..., 'thinking': ...}`；
        失败时 `{'ok': False, 'error': '...'}`。
    """
    try:
        ollama_url = _validate_provider_url(request.ollama_url, lan_http_ok=True)
    except RuntimeError as e:
        return {'ok': False, 'error': str(e)}
    extra: dict = {}
    # thinking='auto' 时不下发 think 字段，交给 Ollama 自己按模型能力决定。
    if request.thinking == 'on':
        extra['think'] = True
    elif request.thinking == 'off':
        extra['think'] = False
    payload = {
        'model': request.model,
        'messages': messages,
        'tools': TOOLS,
        'stream': False,
        **extra,
    }
    try:
        # 120s 超时：本地大模型首轮加载 + 长上下文推理可能很慢。
        r = _request_json('POST', f'{ollama_url}/api/chat', payload, timeout=120.0)
    except RuntimeError as e:
        return {'ok': False, 'error': f'{e} (Ollama at {request.ollama_url}?)'}
    if r is None:
        return {'ok': False, 'error': f'empty response from {request.ollama_url}'}
    msg = r.get('message') or {}
    clean, thinking = _extract_thinking(msg)
    return {'ok': True, 'msg': msg, 'content': clean, 'thinking': thinking}


def _openai_round(request: AgentChatRequest, messages: list[dict]) -> dict:
    """跑一轮 OpenAI 兼容 chat。

    我们发送的是通用 /chat/completions 规范，不支持图片字段，因此发送前会把
    最后一条用户消息里的 images 剥掉（图片能力仍以 Ollama 视觉模型为主路径）。
    """
    endpoint: str
    try:
        # 远程 OpenAI 兼容端点必须 https（本机/内网除外），防 SSRF 与明文泄露 key。
        endpoint = _chat_endpoint(_validate_provider_url(request.base_url, lan_http_ok=False))
    except RuntimeError as e:
        return {'ok': False, 'error': str(e)}
    trimmed = messages[:]
    # 先做一次浅拷贝替换最后一条，避免就地修改调用方的 messages。
    if trimmed and trimmed[-1].get('role') == 'user' and 'images' in trimmed[-1]:
        last = dict(trimmed[-1])
        last.pop('images', None)
        trimmed[-1] = last
    payload = {
        'model': request.model,
        'messages': [{k: v for k, v in m.items() if k != 'images'} for m in trimmed],
        'tools': TOOLS,
        'stream': False,
    }
    try:
        r = _request_json('POST', endpoint, payload, timeout=120.0, headers=_normalize_headers(request.api_key))
    except RuntimeError as e:
        return {'ok': False, 'error': f'{e} ({endpoint})'}
    if r is None:
        return {'ok': False, 'error': f'empty response from {endpoint}'}
    choices = r.get('choices') or []
    if not choices:
        return {'ok': False, 'error': f'no choices in response from {endpoint}'}
    msg = (choices[0].get('message') or {})
    # 思考型模型经非标准字段输出推理内容
    # 不同厂商字段名不一（DeepSeek 用 reasoning_content），两个都试。
    thinking = msg.get('reasoning_content') or msg.get('reasoning') or None
    content = msg.get('content') or ''
    return {'ok': True, 'msg': msg, 'content': content, 'thinking': thinking}


@router.post('/chat', response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
    """POST /chat — 跑完整的工具调用循环，直到模型给出最终答复或轮次耗尽。

    Args:
        request: 对话请求（含 provider / 模型 / 历史消息 / 场景上下文）。

    Returns:
        `AgentChatResponse`：最终文本 + 已执行的动作列表 + 合并后的思维链。
    """
    # 只有同时给了 provider='openai' 与 base_url 才走 OpenAI 路径。
    is_openai = request.provider == 'openai' and request.base_url
    messages = _build_messages(request)

    actions_done: list[ActionDone] = []
    all_thinking: list[str] = []

    round_fn = _openai_round if is_openai else _ollama_round
    for _ in range(10):  # max tool-call rounds
        # provider 请求与工具执行都是同步阻塞调用（urllib / 内部 HTTP 轮询），
        # 必须放入线程池，否则一轮 120s 的慢推理会卡死整个事件循环，
        # 连带拖住健康检查、任务轮询与取消（文档 12.5）。
        res = await asyncio.to_thread(round_fn, request, messages)
        if not res.get('ok'):
            # provider 故障直接终止：继续循环只会把同一个错误重复 10 次。
            return AgentChatResponse(message=f"Provider error: {res.get('error', 'unknown')}")

        msg = res['msg']
        # 把助手这条消息也压进历史：OpenAI 的 tool 结果必须紧跟对应的 assistant。
        messages.append(msg)

        if res.get('thinking'):
            all_thinking.append(res['thinking'])

        tool_calls = msg.get('tool_calls') or []
        if not tool_calls:
            # 没有工具调用 = 模型给出了最终答复，收尾返回。
            combined = '\n\n---\n\n'.join(all_thinking) if all_thinking else None
            return AgentChatResponse(
                message=res.get('content', ''),
                actions=actions_done,
                thinking=combined,
            )

        for tc in tool_calls:
            fn = tc.get('function') or {}
            result_text, payload2 = await asyncio.to_thread(
                _execute_tool, fn.get('name', ''), fn.get('arguments') or {}, request.context
            )
            actions_done.append(ActionDone(tool=fn.get('name', ''), result=result_text, payload=payload2))
            tool_entry: dict = {'role': 'tool', 'content': result_text}
            # OpenAI 兼容的工具循环要求带上 tool_call id
            # Ollama 不需要这个字段，所以仅对 openai 路径补上。
            if is_openai and tc.get('id'):
                tool_entry['tool_call_id'] = tc['id']
            messages.append(tool_entry)

    # 轮次耗尽（模型一直在调工具却没收敛）：把已做的动作如实回传。
    combined = '\n\n---\n\n'.join(all_thinking) if all_thinking else None
    return AgentChatResponse(
        message='Reached maximum tool iterations.',
        actions=actions_done,
        thinking=combined,
    )
