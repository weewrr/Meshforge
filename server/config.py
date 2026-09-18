"""集中式路径与运行配置。

所有可变数据目录（workspace / models / extensions）统一从这里取值，
禁止各模块再自行 `Path(__file__)...` 拼路径（优化文档 7.1 / 13.1）：

- 开发态（未设置 MESHFORGE_DATA_DIR）：目录位于 server/ 源码目录下，
  与历史行为完全一致，不影响现有工作区。
- 打包态：Electron 主进程通过环境变量 MESHFORGE_DATA_DIR 把用户数据目录
  （app.getPath('userData')）传进来，可变数据全部落在用户目录，
  安装目录（resources/server）只保留不可变的程序文件。
"""

import os
from pathlib import Path

# 后端源码根目录（server/）。
SERVER_DIR = Path(__file__).resolve().parent

# 可变数据根目录：打包态由 Electron 注入，开发态退回 server/ 自身。
DATA_DIR = Path(os.environ.get('MESHFORGE_DATA_DIR') or SERVER_DIR).resolve()

# 产物 / 上传 / 工作流定义的落盘根目录。
WORKSPACE_DIR = DATA_DIR / 'workspace'
# HF 模型权重下载根目录（每个扩展 id 一个子目录）。
MODELS_DIR = DATA_DIR / 'models'
# manifest 扩展安装根目录。
EXTENSIONS_DIR = DATA_DIR / 'extensions'

# 外部模型服务根目录：各独立推理服务的 venv（hy3dgen-venv / mvdream-venv /
# zero123-venv / wonder3d-venv / imageopt-venv）与权重根（models/ 子目录）
# 所在位置。机器相关路径，可用环境变量 MESHFORGE_SERVICES_ROOT 覆盖；
# 未设置时保留本机开发默认值。路径不存在时对应生成器按"未安装"处理，
# 不影响其余功能（优化文档 4.3 / 7.1：机器路径只允许出现在这一处）。
SERVICES_ROOT = Path(os.environ.get('MESHFORGE_SERVICES_ROOT') or r'D:\github')

# 本地 API 的 bearer token 文件：后端启动时把生效 token 写到这里，
# 供 MCP server 等本机同用户进程读取（渲染进程经 Electron IPC 获取）。
# 注意：必须放在 workspace 之外——workspace 会被 /files 静态挂载公开。
API_TOKEN_FILE = DATA_DIR / '.api-token'


def ensure_dirs() -> None:
    """启动时创建全部可变目录，避免首个请求才触发 mkdir 的时序问题。"""
    for d in (WORKSPACE_DIR, WORKSPACE_DIR / 'uploads', WORKSPACE_DIR / 'workflows', MODELS_DIR, EXTENSIONS_DIR):
        d.mkdir(parents=True, exist_ok=True)
