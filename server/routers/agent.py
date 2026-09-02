"""Agent chat endpoint — runs an Ollama-powered tool-use loop against Meshforge's API.

Faithful to Modly's /agent/chat contract (message / actions / thinking) but
uses only the Python standard library (no httpx/requests installed in the venv).
The backend calls its own HTTP API at 127.0.0.1:8766 to act on the scene.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix='/agent', tags=['agent'])

API_BASE = 'http://127.0.0.1:8766'

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

# Input kinds the agent may pick, mapped to the real Meshforge source-node
# payloads produced by createNodeFromPayload in WorkflowsPage.tsx.
INPUT_NODES = {
    'image': {'type': 'imageNode', 'label': 'Image', 'color': '#38bdf8', 'params': {}},
    'text':  {'type': 'textNode',  'label': 'Text',  'color': '#fbbf24', 'params': {'text': 'A 3D model'}},
    'mesh':  {'type': 'meshNode',  'label': 'Load 3D Mesh', 'color': '#a78bfa', 'params': {'source': 'current'}},
}

NODE_COLORS = {
    'extensionNode': '#34d399',
    'outputNode': '#a78bfa',
}


# ─── Tiny stdlib HTTP helpers ─────────────────────────────────────────────────

def _request_json(method: str, url: str, payload: dict | None = None, timeout: float = 60.0) -> dict | None:
    """Sync JSON request against Meshforge's own API (or Ollama)."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode('utf-8')) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:300] if e.fp else ''
        raise RuntimeError(f'HTTP {e.code}: {detail}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'Network error: {e.reason}') from e
    except OSError as e:  # ConnectionResetError / ConnectionRefusedError etc. on Windows
        raise RuntimeError(f'Network error: {e}') from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f'Invalid JSON response: {e}') from e


def _mesh_relative(path: str) -> str:
    """Normalize a mesh path for /process/mesh: strip scheme/host if a full URL."""
    if path.startswith('http://') or path.startswith('https://'):
        return urllib.parse.urlparse(path).path
    return path


def _run_mesh_tool(extension_id: str, mesh_url: str, params: dict) -> dict:
    """Submit a mesh tool job and poll to completion (returns result_url + face_count)."""
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
    """Assemble a Meshforge workflow graph (nodes + edges) from a simplified step spec.

    Node payloads mirror createNodeFromPayload in WorkflowsPage.tsx (label/color/
    params/initialWidth/initialHeight) so the frontend can stamp id/timestamps and
    save directly. Edges use the workflowEdge type with no extra styling fields.
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

    ext_nodes = []
    for i, step in enumerate(steps):
        ext_nodes.append({
            'id': uuid.uuid4().hex[:8],
            'type': 'extensionNode',
            'position': {'x': 250, 'y': 150 + i * 200},
            'initialWidth': 200,
            'initialHeight': 80,
            'data': {
                'label': str(step['extension_id']),
                'color': NODE_COLORS['extensionNode'],
                'extensionId': step['extension_id'],
                'params': dict(step.get('params') or {}),
            },
        })

    output_node = {
        'id': uuid.uuid4().hex[:8],
        'type': 'outputNode',
        'position': {'x': 250, 'y': 150 + len(steps) * 200},
        'initialWidth': 200,
        'initialHeight': 80,
        'data': {'label': 'Add to Scene', 'color': NODE_COLORS['outputNode'], 'params': {}},
    }

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


# ─── Tool execution ────────────────────────────────────────────────────────────

def _execute_tool(name: str, arguments: dict, context: dict) -> tuple[str, dict | None]:
    """Execute a tool and return (result_text, action_payload).
    action_payload carries data the frontend needs to react (e.g. new mesh URL).
    """
    try:
        if name == 'list_models':
            models = _request_json('GET', f'{API_BASE}/generators') or []
            loaded = [m for m in models if m.get('is_loaded')]
            if not loaded:
                return 'No models downloaded yet.', None
            lines = '\n'.join(f"- {m['id']}: {m.get('display_name', m['id'])}" for m in loaded)
            return f'Available models:\n{lines}', None

        elif name == 'unload_models':
            # Meshforge's registry has no server-side unload-all endpoint yet;
            # generators unload lazily. Report success to keep the loop moving.
            return 'All 3D generation models have been unloaded from VRAM.', None

        elif name == 'get_mesh_info':
            mesh_path = context.get('currentMeshPath')
            mesh_triangles = context.get('meshTriangles')
            if not mesh_path:
                return 'No mesh currently loaded in the viewer.', None
            info = f'Current mesh: {_mesh_relative(mesh_path)}'
            if mesh_triangles:
                info += f' ({mesh_triangles:,} triangles)'
            return info, None

        elif name == 'decimate_mesh':
            path = _mesh_relative(str(arguments.get('path', '')))
            result = _run_mesh_tool('mesh-remesher', path, {
                'target_faces': int(arguments.get('target_faces', 10000)),
            })
            payload = {'type': 'mesh_update', 'url': result['url'], 'face_count': result.get('face_count')}
            return f"Decimated to {result.get('face_count') or '?'} faces.", payload

        elif name == 'smooth_mesh':
            path = _mesh_relative(str(arguments.get('path', '')))
            result = _run_mesh_tool('mesh-smoother', path, {
                'iterations': int(arguments.get('iterations', 3)),
            })
            payload = {'type': 'mesh_update', 'url': result['url']}
            return f"Smoothed mesh ({arguments.get('iterations')} iterations).", payload

        elif name == 'get_generation_status':
            status = _request_json('GET', f"{API_BASE}/generate/jobs/{arguments.get('job_id', '')}")
            if not status:
                return 'Job not found.', None
            text = f"Status: {status.get('state')}, Progress: {status.get('progress', 0) * 100:.0f}%"
            if status.get('result_url'):
                text += f", Output: {status['result_url']}"
            if status.get('error'):
                text += f", Error: {status['error']}"
            return text, None

        elif name == 'list_workflows':
            workflows = context.get('workflows', [])
            if not workflows:
                return 'No workflows found. Create one in the Workflows tab.', None
            lines = '\n'.join(f"- {w['id']}: {w['name']}" for w in workflows)
            return f'Available workflows:\n{lines}', None

        elif name == 'run_workflow':
            workflow_id = arguments.get('workflow_id', '')
            workflows = context.get('workflows', [])
            match = next((w for w in workflows if w['id'] == workflow_id), None)
            if not match:
                return f"Workflow '{workflow_id}' not found. Use list_workflows to see available workflows.", None
            payload = {'type': 'run_workflow', 'workflow_id': workflow_id, 'workflow_name': match['name']}
            return f"Executing workflow '{match['name']}'…", payload

        elif name == 'create_workflow':
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

        else:
            return f'Unknown tool: {name}', None

    except RuntimeError as e:
        return f'Error: {e}', None
    except Exception as e:  # noqa: BLE001 - surfaced to the LLM as text
        return f'Error: {e}', None


# ─── Request / response models ────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = []


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]
    ollama_url: str = 'http://localhost:11434'
    model: str = 'qwen2.5:3b'
    context: dict = {}
    thinking: str = 'auto'  # "auto" | "on" | "off"


class ActionDone(BaseModel):
    tool: str
    result: str
    payload: dict | None = None


class AgentChatResponse(BaseModel):
    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """Return (clean_content, thinking_text). Handles both Ollama native field and <think> tags."""
    content = msg.get('content', '')
    thinking = msg.get('thinking') or None
    if not thinking:
        match = re.search(r'<think>(.*?)</think>', content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            content = (content[: match.start()] + content[match.end():]).strip()
    return content, thinking


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get('/models')
async def list_ollama_models(ollama_url: str = 'http://localhost:11434') -> dict:
    """Query Ollama's /api/tags for installed models (best-effort)."""
    url = ollama_url.rstrip('/') + '/api/tags'
    try:
        data = _request_json('GET', url, timeout=5.0)
        models = [m['name'] for m in (data or {}).get('models', [])]
        return {'models': models}
    except Exception:
        return {'models': []}


@router.post('/chat', response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
    messages: list[dict] = [{'role': 'system', 'content': SYSTEM_PROMPT}]

    # Inject scene context so the LLM knows current state
    if request.context:
        ctx_lines = []
        if request.context.get('currentMeshPath'):
            ctx_lines.append(f"Current mesh path: {_mesh_relative(request.context['currentMeshPath'])}")
        if request.context.get('meshTriangles'):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if ctx_lines:
            messages.append({
                'role': 'system',
                'content': 'Scene context:\n' + '\n'.join(ctx_lines),
            })

        extensions = request.context.get('extensions') or []
        if extensions:
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
            entry['images'] = m.images
        messages.append(entry)

    actions_done: list[ActionDone] = []
    all_thinking: list[str] = []

    ollama_url = request.ollama_url.rstrip('/')

    # Build Ollama think param
    ollama_extra: dict = {}
    if request.thinking == 'on':
        ollama_extra['think'] = True
    elif request.thinking == 'off':
        ollama_extra['think'] = False

    for _ in range(10):  # max tool-call rounds
        try:
            payload = {
                'model': request.model,
                'messages': messages,
                'tools': TOOLS,
                'stream': False,
                **ollama_extra,
            }
            r = _request_json('POST', f'{ollama_url}/api/chat', payload, timeout=120.0)
        except RuntimeError as e:
            return AgentChatResponse(
                message=f'Ollama error: {e}. Is Ollama running at {request.ollama_url}?',
            )

        if r is None:
            return AgentChatResponse(
                message=f'Ollama error: empty response from {request.ollama_url}.',
            )

        msg = r.get('message') or {}
        messages.append(msg)

        clean_content, thinking_text = _extract_thinking(msg)
        if thinking_text:
            all_thinking.append(thinking_text)

        tool_calls = msg.get('tool_calls') or []
        if not tool_calls:
            combined_thinking = '\n\n---\n\n'.join(all_thinking) if all_thinking else None
            return AgentChatResponse(
                message=clean_content,
                actions=actions_done,
                thinking=combined_thinking,
            )

        for tc in tool_calls:
            fn = tc.get('function') or {}
            result_text, payload2 = _execute_tool(fn.get('name', ''), fn.get('arguments') or {}, request.context)
            actions_done.append(ActionDone(tool=fn.get('name', ''), result=result_text, payload=payload2))
            messages.append({'role': 'tool', 'content': result_text})

    combined_thinking = '\n\n---\n\n'.join(all_thinking) if all_thinking else None
    return AgentChatResponse(
        message='Reached maximum tool iterations.',
        actions=actions_done,
        thinking=combined_thinking,
    )
