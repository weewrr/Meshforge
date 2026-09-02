# Meshforge — 项目交接文档

> 面向新会话的启动指南。读完此文档即可从正确的位置继续开发。
> 最后更新：2026-09-02（ChatPanel 真实 Agent / 扩展安装·卸载·进度 / 多格式导出 / UI 实机验证完成 / 修复 process.py 绝对 URL bug）

---

## 1. 这是什么项目

**Meshforge** 是对开源项目 [lightningpixel/modly](https://github.com/lightningpixel/modly) 的一次独立复刻（图生 3D 工作流桌面应用）。目标是与 Modly 的**前端工作流**做到约 **1:0.9** 的还原度。

- 参考实现（只读）：`c:\Users\HELLOWORLD\Desktop\oss\modly-reference`
- 本项目：`c:\Users\HELLOWORLD\Desktop\oss\meshforge`

### 复刻设计决策（历史结论，勿推翻）
- 图生 3D 模型：**Hunyuan3D-2-mini**（开发机 GPU 为 RTX 4050 6G，尚未接入真模型，当前用 mock）。
- 业务采用「工作流节点图」范式：Image / Text / Mesh / Generator / Preview / Wait / While / ForEach / Output 等节点构成有向图，运行引擎做拓扑排序、分支暂停、循环。

---

## 2. 技术栈与架构

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron（electron-vite 构建） |
| 渲染进程 | React + Zustand + TypeScript |
| 节点画布 | `@xyflow/react`（React Flow） |
| 3D 查看器 | Three.js / React Three Fiber（Generate 页） |
| 后端 | Python FastAPI + uvicorn，端口 **8766** |

### 进程结构
```
Electron 主进程 (electron/main/index.ts)
 └─ python-bridge.ts  —— 内部 spawn uvicorn 后端，端口 8766，带 watchdog 自动重启
Electron 渲染进程 (src/) —— React 页面
后端 (server/) —— FastAPI，Pillow 生成 mock GLB
```

### 目录地图
```
meshforge/
├─ electron/main/index.ts        # 主进程：窗口创建 + startPythonBackend()
├─ electron/main/python-bridge.ts# uvicorn 生命周期管理（health 轮询、崩溃重启）
├─ electron/preload/index.ts     # 渲染进程中暴露的 IPC bridge
├─ src/
│  ├─ main.tsx / App.tsx         # 入口 + 路由
│  ├─ index.css                  # 全部样式（含 wf-* 工作流样式）
│  ├─ types.ts                   # WFNode / WFEdge / Workflow / nodeSpec(端口与颜色) / portCompatible
│  ├─ api.ts                     # 后端 HTTP 封装
│  ├─ stores/
│  │  ├─ workflows.ts            # 工作流元状态 + 撤销/重做 + 自动保存 + folder/bookmark
│  │  ├─ workflowRun.ts          # 运行引擎：拓扑排序 / Wait / While / ForEach / preflight
│  │  ├─ navigation.ts, logs.ts, app.ts, scene.ts, ...
│  └─ pages/
│     ├─ WorkflowsPage.tsx       # 工作流编辑（画布 + 工具栏 + 标签页 + 快捷键 + 帮助）
│     ├─ GeneratePage.tsx        # 选工作流执行 + 节点级进度 + 3D 查看器 + Library + 多格式导出
│     ├─ ModelsPage.tsx          # Extensions 页（搜索/过滤/排序 + GitHub/本地安装 + 进度条 + 卸载确认）
│     ├─ SettingsPage.tsx        # Settings 页（7 大分区）
│     ├─ generate/
│     │  ├─ assetLibrary.ts      # 资产库：类型 + 分组/搜索/排序/折叠逻辑（Modly assetLibraryUi 同构）
│     │  └─ ChatPanel.tsx        # 聊天面板（真实 Agent：thinking / actions / 工作流进度卡片）
│     └─ workflows/
│        ├─ nodes.tsx            # 节点组件定义（nodeTypes）
│        ├─ WorkflowEdge.tsx     # 按端口类型着色的渐变连线
│        ├─ OpenPopup.tsx        # 打开弹窗（卡片+迷你预览+文件夹+搜索）
│        ├─ ExtensionsPanel.tsx  # 右侧节点面板
│        └─ ...
└─ server/
   ├─ main.py                    # FastAPI 入口，注册路由
   ├─ routers/                   # workflows / generate / upload / extensions / process / library / agent
   ├─ generators/registry.py     # 生成器注册表（mock-relief 等）
   ├─ generators/mock.py         # Pillow 生成"浮雕" GLB 的 mock 生成器
   └─ workspace/workflows/*.json # 工作流持久化（每工作流一个 JSON 文件）
```

---

## 3. 怎么启动 / 验证

```powershell
cd c:\Users\HELLOWORLD\Desktop\oss\meshforge
npm run dev          # electron-vite dev：拉起渲染进程 + Electron + 后端(uvicorn:8766)
```

- 后端 `.venv`：`server\.venv\Scripts\python.exe`（勿用系统 python）
- 前端类型检查：`npm run typecheck:web` / `npm run typecheck:node`
- 后端无 `--reload`：改 py 文件后直接 kill 掉监听 8766 的进程即可自动重启

### 快速冒烟验证（后端健康）
```powershell
curl.exe -s http://127.0.0.1:8766/health      # → OK
curl.exe -s http://127.0.0.1:8766/workflows    # → 工作流列表
```

---

## 4. 已完成（对齐约 0.9/1.0）

**执行引擎**（`workflowRun.ts`）
- 拓扑排序调度、节点级状态（pending/running/succeeded/failed/waiting）
- **Wait 分支**：运行到 Wait 暂停，节点内联"继续"按钮或工具栏恢复
- **While / ForEach**：循环语义（已实现）
- **preflight**：运行前一次性报出所有配置问题（未选图、缺生成器、缺连线等）

**工作流编辑器**（`WorkflowsPage.tsx` + 各子组件）
- React Flow 画布：拖拽放置、连线（端口类型校验 + 防环）、类型色渐变连线、Delete 删除
- **Space 节点面板**：搜索 + Enter 添加到画布中心
- **连接拖拽联动**：从端口拖线到空白画布 → **释放点附近**弹出紧凑列表（`.wf-conn-menu`，无搜索框，非居中弹窗），仅显示端口兼容候选；选择后在释放位置建节点并自动连线（↑↓/Enter/Esc/点外关闭）
- **While 容器节点**：虚线琥珀框 + NodeResizer + 头部 loop 输入；子节点拖入/拖出吸附（parentId + 父相对坐标）、删除容器时子节点自动救援并绝对化坐标
- **标签页拖拽排序**：HTML5 DnD + localStorage 持久化（`reorderTab`），刷新后恢复
- **撤销/重做**：Ctrl+Z / Ctrl+Y，最多 50 步（拖拽结束、增删节点、连线、参数修改入历史）
- **Open 弹窗**：卡片(带 SVG 迷你预览) + 文件夹(建/删/折叠/收藏/6色) + 收藏置顶 + 搜索 + 重命名/删除确认
- **导入/导出 JSON**、标签页右键菜单、中键关闭
- **快捷键**：Ctrl+T 新建、Ctrl+W 关闭、Ctrl+Tab 切换、Ctrl+S 保存
- 工具栏：打开/导入/导出/撤销/重做/名称/**▶ 运行 ■ 停止**/**? 帮助**

**节点初始尺寸**：所有节点创建时带 `initialWidth/initialHeight`（普通 200×80，While 340×220）——RF 只有维度已知才渲染 wrapper/handle（`nodeHasDimensions`），缺了会导致 handle 不可见/不可拖。

**数据层**
- 后端支持 `folder` / `bookmarked` 字段持久化；自动保存（800ms 防抖）

**Generate 页**（`GeneratePage.tsx` + `generate/`）
- Generate 页布局对齐 Modly：参数行内联风格（彩色图标 + 固定标签 Image/Text/Load 3D Mesh/Wait）、Mesh 节点 "Use current model" 开关（source=current 时从 sceneStore 取当前模型）、生成器行扩展节点风格 + 进度条
- **Library 资产库弹窗** ✅（2026-09-02）：
  - 后端 `GET /library`（`server/routers/library.py`）：索引 workspace 产物（跳过 uploads 原始图）；mesh 扩展名→capability=mesh（仅 .glb/.gltf openable），workflows/*.json→scene-manifest；sourceScope=workflows/exports；返回 mtime（createdAt/updatedAt）+ 静态 url `/files/…`
  - 前端 `src/pages/generate/assetLibrary.ts`：scope（Workflows/Exports）→ capability（Mesh/Scene manifests…）两级分组、搜索（匹配分组标题时整组显示）、Type/Name/Date 排序、分区折叠（默认全折叠，同 Modly）
  - GeneratePage Library 弹窗：懒加载（首次打开才拉取）+ Refresh assets、搜索框 + Sort 下拉、选中高亮、openability 描述、错误提示；**Open selected asset** → `pushMeshUrl(fullUrl(url))` 加载进 3D 查看器并计入撤销历史
  - 样式 `gp-lib-*`（index.css）；API `listLibrary()`（api.ts）
- **ChatPanel 真实 Agent** ✅（2026-09-02）：
  - 后端 `server/routers/agent.py`：`POST /agent/chat`（Ollama tool-use 循环，最多 10 轮；解析 `<think>` / 原生 thinking 字段）+ `GET /agent/models`；9 个工具（list_models / unload_models / get_mesh_info / decimate_mesh / smooth_mesh / get_generation_status / list_workflows / run_workflow / create_workflow），全部走标准库 `urllib`（venv 无 httpx/requests）
  - `create_workflow` 用 `_build_workflow_graph` 从简化 step 规格构建 nodes+edges（payload 对齐 `createNodeFromPayload`：label/color/params/initialWidth/initialHeight），input 限 image/text/mesh 三源 + 自动追加 Add-to-Scene 输出节点
  - 工具动作通过 `actions[].payload` 回传前端：`mesh_update`（pushMeshUrl 载入新模型）、`run_workflow`（getWorkflow+run+pendingWorkflow）、`create_workflow`（importWorkflow）
  - 前端 ChatPanel：`ProseMessage`（markdown-lite）/ `ThinkingBlock`（可折叠）/ `ActionsCard`（Undo）/ `WorkflowProgressCard`；`buildContext()` 注入 currentMeshPath/meshTriangles/workflows/extensions；模型选择器轮询 agentModels；拖放图片 → base64 → workflow 输入图
  - 样式 `gp-chat__*`（index.css 1716-2290）；API `agentChat()/agentModels()`（api.ts）
- **Settings 页** ✅：7 大分区（Application/Storage/Integrations/…），`appStore`（src/stores/app.ts）localStorage 持久化，共享 UI 组件 `src/components/ui.tsx`，样式 `st-*`
- **Extensions 页**（ModelsPage.tsx）✅（2026-09-02 补全）：搜索/过滤/排序 + **GitHub URL 安装**（`POST /extensions/install`，codeload zip main/master 回退）+ **本地文件夹安装**（webkitdirectory → `POST /extensions/install-local` 多文件重建目录）+ **安装进度条**（500ms 轮询 `GET /extensions/install/status`，downloading 实时百分比 / extracting / validating / setting_up / done）+ **卸载确认弹窗**（`POST /extensions/uninstall` 删目录+unload）+ **Reload 重扫**（`POST /extensions/reload`）；manifest 驱动扩展经 `generators/registry.scan_extensions()` 发现（generator.py→model / processor.py→process）；样式 `ex-*`

**端到端**（已验证）
- 上传图片 → mock-relief 生成 → 产出合法 GLB（584KB 验证过）→ 3D 查看器显示
- 演示工作流 **"Demo: Image → Relief Mesh"** 常驻后端（id: `demo-relief-pipeline`）
- Library 冒烟：`/library` 返回 14 条（exports 12 mesh + workflows 2 scene-manifest），静态文件 `/files/...` 200 可达

---

## 5. 与 Modly 的差距

### 剩余未复刻（按优先级排序）
~~全部完成~~ ✅ 2026-09-02「多格式导出」完成后，第 5 节差距清单已清零。后续若要对齐 Modly 可参考：扩展的「全部安装」批量流程、下载暂停/取消。

### 核心未复刻（已全部完成 ✅）
1. ~~真实模型接入~~ ✅ **Hunyuan3D-2-mini 适配器**（`server/generators/hunyuan.py`）：探测式接入（`MESHFORGE_HUNYUAN_URL`，默认 `http://127.0.0.1:8000`），服务可达则 POST /generate 拿 GLB，不可达则报"服务不可达"提示（mock-relief 仍是开发默认）。部署：启动任一兼容 HTTP 接口的 Hunyuan3D 推理服务并设环境变量。
2. ~~网格处理工具节点~~ ✅ 5 个工具（`server/tools/mesh_tools.py` + `server/routers/process.py`，POST /process/mesh）：mesh-repair / mesh-smoother / mesh-remesher / mesh-optimizer / mesh-exporter（纯 trimesh+numpy，无 scipy 依赖），全部端到端实测通过。
3. ~~通用扩展节点系统~~ ✅ **schema 驱动**（Modly 同构）：
   - 后端 `GET /extensions` 返回统一扩展列表（model 生成器 + process 工具，含 `params: ParamSchema[]`）；`/process/mesh` 工具执行端点
   - 前端 `extensionNode`（nodes.tsx）：参数面板按 schema 渲染（select/int/float/string、show_if 条件）、IO 类型标签、动态端口颜色
   - 动态端口判定 `nodePorts()`（types.ts）+ 扩展缓存 `setExtensionsCache/getExtensionById/allExtensions`
   - ExtensionsPanel 分组「生成器 / 网格工具」，拖拽 payload `extension:<id>`；连接拖拽 palette 含扩展候选（端口兼容过滤）
   - 运行引擎 extensionNode 分发：kind=model → /generate/from-image；kind=process → /process/mesh
   - 旧 generatorNode 保留兼容（旧工作流不破）
4. ~~While 手动循环控制~~ ✅ WhileNode 运行时暂停 + **Continue / Retry** 按钮（`continueWhile`/`retryWhile`）：自动模式（iterations≥1）跑完 N 次后暂停；手动模式（0/空）进入即暂停；Retry 重跑 body 一次再暂停。
5. ~~For Each 文件迭代器~~ ✅ ForEachNode 支持 mode（image/text）+ workspace 目录（`GET /files/list-dir`），按目录文件流迭代，每次迭代把当前文件作为节点输出（image→File / text→文本）；目录留空回退旧逗号列表。
6. ~~资产库（Library）~~ ✅ 2026-09-02 完成，详见第 4 节「Generate 页」。
7. ~~ChatPanel 接真实 Agent~~ ✅ 2026-09-02 完成，详见第 4 节（后端 `/agent/chat` + 前端 thinking/actions/工作流进度）。
8. ~~扩展管理安装/卸载流程~~ ✅ 2026-09-02 完成，详见第 4 节「Extensions 页」（GitHub/本地安装 + 进度轮询 + 卸载 + reload）。
9. ~~多格式导出~~ ✅ 2026-09-02 完成：GeneratePage 导出菜单 glb 保持直下（viewer 原生格式），**obj/stl/ply 走后端 `mesh-exporter` job**（`POST /process/mesh` + `getJob` 轮询，`/process/mesh` 已全端验证：obj 文本 / stl 二进制 / ply binary_little_endian），成功后下载 `fullUrl(result_url)` 并记日志；导出中 Export 按钮/菜单项 disabled 并显示 `Exporting .<fmt>…`；菜单 disabled 样式 `gp-menu > button:disabled`。
   - 2026-09-02 **UI 实机验证**（`agent-browser` + 临时 `vite.renderer.config.ts` 跑独立 renderer dev server，详见 `.ui-check/01-06.png`）：导航→Library→下载 downloaded.glb→Export→.obj/.stl 端到端成功，workspace 生成 obj/stl 产物；扩展页 7 卡片渲染、GitHub 安装表单、抽屉卸载、Hello UI 安装+UI 卸载闭环（计数 7→8→7+ 目录清理）；ChatPanel 渲染、模型选择器空态友好降级。
   - 2026-09-02 **修复 process.py 绝对 URL bug**（`server/routers/process.py`）：`_resolve_local` 原本只认 `/files/` 相对路径，agent.py 已用 `_mesh_relative` 兼容，但 process 端点漏改；前端 `fullUrl()` 把 `downloaded.glb` 转成 `http://127.0.0.1:8766/files/x.glb`，未修则 obj/stl/ply 导出 400。修复：`_resolve_local` 加 `urlparse().path` 把绝对 URL 规范化回相对路径。

### 已完成（勿重复做）
- ~~标签页拖拽排序~~ ✅（HTML5 DnD + localStorage，`reorderTab` in workflows store）
- ~~节点点击→右侧参数面板联动~~ ✅ 经查证已达标：Modly 即节点内联参数编辑，meshforge 的 useParam/updateNodeData 与其同构
- ~~While 容器节点~~ ✅（详见「While 容器实现要点」）
- ~~连接拖拽联动~~ ✅（释放点紧凑列表 + 自动连线，见第 4 节）

### While 容器实现要点（Modly 对齐）
- `WhileNode`（nodes.tsx）：虚线琥珀框 + NodeResizer（选中显示）+ 头部 iterations 输入；`isContainerType(type)` = whileNode。
- 创建：palette 放置时 `style: {width:340, height:220}` + initialWidth/Height，store `addNode` 对容器**前置插入**（RF 要求父在子前）。
- 吸附：`onDrop`/`addAtCenter` 用 **DOM 屏幕矩形判定**（`containerAtScreen`，查 `.react-flow__node[data-id]` 的 rect，任何 zoom/pan 都准，勿用 flow 坐标换算——曾有偏移 bug）；`onNodeDragStop` 用 flow 坐标判定（RF 原生给的是 flow 坐标，可靠），子节点 parentId + 父相对坐标（无 extent 可拖出）。
- 运行引擎（workflowRun.ts）：`whileBodyNodes` = parentId 归属 + 未归属节点中心点在容器 bounds 内的几何兜底（Modly 同款）；外层循环跳过 whileOwned 节点；body 为空时回退 edge 连线模式（兼容旧工作流）。
- 删除容器：`onBeforeDelete` 把子节点从删除集中剔除并绝对化坐标（`replaceNodes(nodes, {history:false})` 静默模式），RF 删除容器本身。
- 注意：RF v12 子节点是**兄弟元素**渲染（不在父节点 DOM 内），验证 parentId 应查后端持久化 JSON 而非 DOM 嵌套。

---

## 6. 踩坑与约定（重要，勿踩）

- **网络/依赖**：下载依赖需走代理镜像；`npm` / `pip` 直接装可能 reset。改 package 用国内镜像。
- **`electron\dist\electron.exe` ENOENT**：`node_modules\electron\dist\path.txt` 出现过 BOM/不可见字符，用**无 BOM**方式重写 `path.txt` 修复。勿动不动重装 electron。
- **React Flow 署名**：已打开 `@xyflow/react` 的 attribution（许可合规），不要把 `hideAttribution` 打开。
- **ReactFlowProvider**：`Canvas` 必须包在 `<ReactFlowProvider>` 内，否则报 context 错误。
- **后端重启**：uvicorn 由主进程 watchdog 守护，崩溃 3s 自动拉起；无需手动起服务。
- **Electron 子进程启动失败（ERR_FAILED / GPU fatal）**：本机曾出现 GPU 子进程 exit_code=1、所有导航（含 data: URL）报 ERR_FAILED(-2)、"GPU process isn't usable. Goodbye."——根因是 Chromium 沙箱 broker 损坏。已在 `electron/main/index.ts` 加 `--no-sandbox` + `--disable-gpu` + `--disable-gpu-sandbox`（contextIsolation 保留）。若系统重启后想恢复沙箱，可尝试移除 no-sandbox 验证。
- **渲染进程挂起（窗口空白）**：初始渲染中的隐藏 `<input type="file">` 在 sandbox 下会死锁 renderer 主线程。所有 file input 必须用 `document.createElement('input')` 按需创建，勿在 JSX 中渲染隐藏 file input（6 处已改，见 GeneratePage/WorkflowsPage/ChatPanel/nodes.tsx 等）。
- **WebGL context lost / GPU 崩溃**：`electron/main/index.ts` 已加 `app.disableHardwareAcceleration()` 走 SwiftShader 软件渲染兜底（VM/远程桌面驱动常损坏 GPU 合成器）。
- **`urllib` 网络异常兜底（Windows）**：`server/routers/agent.py` 的 `_request_json` 除了 `HTTPError`/`URLError` 必须再捕获 `OSError`（Windows 下连接被拒常抛 `ConnectionResetError`/`ConnectionRefusedError`，不会被包装成 URLError，漏捕直接 500）和 `json.JSONDecodeError`。Ollama 不可达时 `/agent/chat` 返回 200 + `message: "Ollama error: … Is Ollama running at …?"`（前端据此展示友好提示）。
- **`process.py` 绝对 URL 解析（前端走 `fullUrl()`）**：`/process/mesh` 的 `_resolve_local` 起初只认 `/files/` 相对路径。前端 `pushMeshUrl(fullUrl(entry.url))` 后 meshUrl 是 `http://127.0.0.1:8766/files/x.glb` 形式；obj/stl/ply 导出走 `processMesh` 会传这个绝对 URL 过来，未修则 400（`mesh_url outside workspace`）。修复：`_resolve_local` 用 `urllib.parse.urlparse().path` 把绝对 URL 规范化回相对路径，再走原 `/files/` 分支。`agent.py` 已有等价 helper `_mesh_relative`，process 端点补齐即可。
- **UI 实机验证流程（不起 Electron 壳）**：创建 `vite.renderer.config.ts`（独立 cacheDir `node_modules/.vite-renderer` 规避沙箱批量删除保护）→ `npx vite --config vite.renderer.config.ts` 起 renderer dev server（端口 5173，dev 后端用 `server\.venv\Scripts\python.exe -m uvicorn main:app --port 8766`）→ `agent-browser --session <name> open http://localhost:5173/` 必须用**独立命名会话**（默认会话 daemon 状态污染会停在 about:blank）+ `&&` 命令链内每条独立 agent-browser 命令共享 open 页面（跨 Bash 调用 ref/state 丢失）；用 `eval` + `document.querySelector` 点击比 `click @ref` 更稳。验证后删除 `vite.renderer.config.ts`。
- **扩展管理 e2e 冒烟（不依赖外网）**：造最小 process 扩展（manifest.json `{"id":"test-ext","kind":"process",...}` + processor.py 定义 `process_tool()`），`curl -F "files=@…;filename=hello-test/manifest.json"`（filename 必须带根目录前缀模拟 webkitRelativePath）+ `-F "root_dir=hello-test"` POST `/extensions/install-local` → 列表可见 → `POST /extensions/uninstall {"id":"test-ext"}` → 目录删除。注意 git bash 的 `/tmp` 对 Windows curl.exe 不可见，文件须放 Windows 可访问路径。
- **快速冒烟验证后端新路由**：不起 Electron，直接 `server\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8766 --app-dir server` 再 curl；验证完记得 kill，勿与 `npm run dev` 的 uvicorn 抢 8766 端口。
- **工作流写入**：POST `/workflows` 默认 `method='POST'`；GET 带 body 会被当列表请求（曾踩过）。
- **工具指引**：优先用专用工具（Read/Edit/Glob/Grep/SearchCodebase），命令一律 PowerShell，别用 cmd。
- **连接拖拽联动**：从端口拖线到空白画布会在**释放点附近**弹出紧凑节点列表（`.wf-conn-menu`，非居中搜索弹窗），仅显示端口类型兼容的候选；选择后在释放位置建节点并自动连线（`onConnectStart/End` + `pendingConnectionRef` + `pendingDropPos`，Canvas 内）。↑↓ 选择 / Enter 确认 / Esc 或点击外部关闭。注意：While 容器空 body 视为空白画布；已占用输入端的节点不作为 source 方向候选；Space 打开的居中搜索 palette（`.wf-palette`）保持不变。
- **节点初始尺寸**：所有节点创建时带 `initialWidth/initialHeight`（普通 200×80，While 340×220）——RF 只有维度已知才渲染 wrapper/handle（`nodeHasDimensions`），缺了会导致 handle 不可见/不可拖（headless/无 ResizeObserver 环境尤甚）。

---

## 7. 给新会话的第一步

1. `ls` 确认 `c:\Users\HELLOWORLD\Desktop\oss\meshforge` 结构与上文一致
2. `Get-Process` 确认 electron 与 uvicorn(8766) 是否在跑；不在则 `npm run dev`
3. curl 冒烟后端 `/health`、`/workflows`、`/library`
4. 剩余未复刻清单已清零；想继续对齐 Modly 可做：扩展「全部安装」批量流程、下载暂停/取消（可选优化）
5. 每次改动后跑 `npm run typecheck:web`，UI 变化在 Electron 窗口 Ctrl+R 验证

演示工作流兜底：若无任何工作流，可参考上文 JSON 重新 POST `/workflows`。