<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <img src="assets/banners/minimal-type-1600x400.svg" alt="MeshForge — image to 3D mesh, forged locally" width="900" />
</p>

<p align="center">
  <strong>Local, open-source image-to-3D mesh generation for consumer GPUs</strong>
</p>

<p align="center">
  <a href="#system-architecture"><img src="https://img.shields.io/badge/dev-Electron%20%2B%20FastAPI-blue" alt="Stack" /></a>
  <a href="https://github.com/lightningpixel/modly"><img src="https://img.shields.io/badge/based_on-modly-8A2BE2" alt="Based on modly" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
</p>

<p align="center">
  <a href="#introduction">Introduction</a> ·
  <a href="#node-types">Node Types</a> ·
  <a href="#system-architecture">Architecture</a> ·
  <a href="#data-flow">Data Flow</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#extensions">Extensions</a> ·
  <a href="#i18n">i18n</a> ·
  <a href="#license">License</a>
</p>

> **MeshForge** is an independent, node-based re-implementation of the open-source [Modly](https://github.com/lightningpixel/modly) image-to-3D workflow desktop app. You build a directed graph of **Image / Text / Mesh / Generator / Preview / Wait / While / ForEach** nodes, run it, and turn a single photo into a textured 3D mesh — all locally, targeting consumer GPUs.

***

## Introduction

A single run walks the graph left to right: an **Image** and a **Text** node feed a **Generate Mesh** node, whose output is previewed in the 3D viewport and/or added to the scene for export.

<p align="center">
  <img src="assets/diagrams/pipeline.svg" alt="MeshForge pipeline — Image + Text to Generate Mesh to Preview to Export" width="860" />
</p>

- 🎨 **Node-based workflow canvas** — React Flow graph editing with undo/redo, autosave, folders, bookmarks and keyboard shortcuts.

- 🧊 **3D viewport** — real-time Three.js preview with a grid ground plane and multi-format export (OBJ / STL / PLY / GLB).

- 🧩 **Extensible** — install generators and processing tools from **GitHub, HuggingFace or ModelScope (魔搭)**.

- 🌐 **Bilingual UI** — switch between **English** and **中文** in Settings, persisted across restarts.

- 🚀 **Local-first** — the Python backend runs inside Electron with a watchdog auto-restart; no cloud round-trips.

***

## Node Types

Nine built-in node types. Every node declares typed ports, and edges only connect when the port types match — the canvas refuses invalid links instead of failing at run time.

<p align="center">
  <img src="assets/diagrams/node-palette.svg" alt="MeshForge node palette — nine node types and their port signatures" width="820" />
</p>

| Group | Nodes | Notes |
| ----- | ----- | ----- |
| **Inputs** | Image, Text | Load a source photo or a free-form prompt |
| **Mesh I/O** | Load 3D Mesh, Generate Mesh | Import an existing mesh, or run a generator extension |
| **Output** | Preview, Add to Scene | Render in the 3D viewport, or push into the scene workspace |
| **Control flow** | Wait, While, For Each | Delays, conditional loops and batch iteration |

***

## System Architecture

Three processes cooperate: the **Electron main** process owns the window and spawns the Python backend, the **React renderer** owns all UI state, and the **FastAPI backend** owns jobs, files and model downloads.

<p align="center">
  <img src="assets/diagrams/runtime-architecture.svg" alt="MeshForge runtime architecture — Electron main, React renderer and FastAPI backend" width="840" />
</p>

<details>
<summary><strong>Expand Mermaid source</strong></summary>

```mermaid
flowchart TB
    subgraph Renderer["Electron Renderer (React)"]
        UI[Pages<br/>Workflows / Generate / Models / Settings]
        Canvas[Node Canvas<br/>@xyflow/react]
        Viewer[3D Viewer<br/>Three.js / R3F]
        Store[Zustand Stores<br/>workflow / run / logs / app]
        I18N[i18n<br/>useT / getT]
    end

    subgraph Main["Electron Main Process"]
        Win[BrowserWindow]
        Bridge[python-bridge.ts<br/>spawn + health + watchdog]
        IPC[preload IPC bridge]
    end

    subgraph Backend["Python Backend (FastAPI · :8766)"]
        API[Routers<br/>workflows / generate / process]
        Registry[Generator Registry<br/>mock-relief + manifest extensions]
        Model[Model Weight Downloads<br/>HF / ModelScope]
        Repo[(Workflow JSON<br/>workspace/workflows/)]
        ExtDir[(Extensions + Models<br/>directories)]
    end

    UI --> Store
    Canvas --> UI
    Viewer --> UI
    UI -->|fetch / SSE| API
    API --> Registry
    API --> Model
    API --> Repo
    API --> ExtDir
    UI <-->|native dialogs / IPC| Bridge
    Bridge -->|spawn uvicorn + watchdog| Backend
    Win --> IPC --> UI
```

</details>

***

## Data Flow

One run = one job. The renderer posts the image and parameters, the backend creates a job, topologically walks the graph node by node, then streams progress back over SSE until the GLB result is ready.

<details>
<summary><strong>Expand sequence diagram</strong></summary>

```mermaid
sequenceDiagram
    participant UI as Renderer UI
    participant API as Backend API
    participant Eng as Run Engine
    participant Gen as Generator
    participant View as 3D Viewer

    UI->>API: POST /generate/from-image (image + params)
    API->>API: create job_id, persist workflow ref
    UI->>API: poll GET /generate/jobs/{id} (SSE progress)
    loop per node
        API->>Eng: topo-sort / iterate nodes
        Eng->>Gen: invoke generator / processor
        Gen-->>API: progress events
        API-->>UI: state + progress
    end
    API-->>UI: result_url
    UI->>API: GET result (GLB)
    UI->>View: load mesh, render on grid floor
    UI->>API: GET /process/mesh (optional mesh→mesh pass)
    UI->>UI: export OBJ / STL / PLY / GLB
```

</details>

### Extension Install Flow

```mermaid
sequenceDiagram
    participant UI as Models Page
    participant API as /extensions/install
    participant SRC as GitHub / HF / ModelScope
    participant FS as extensions/ dir

    UI->>API: POST url (github | huggingface | modelscope)
    API->>API: classify source by host
    API->>SRC: list files (zip / tree API)
    SRC-->>API: file list
    loop per file
        API->>SRC: stream file
        SRC-->>API: chunk
        API->>FS: write to .staging/<id>
    end
    API->>FS: validate manifest.json + entrypoint
    API->>FS: copy → extensions/<id> & rescan
    API-->>UI: install/status progress → done
```

***

## Getting Started

### Requirements

- **Node.js** 18+

- **Python** 3.10+ (`fastapi`, `uvicorn`, `pydantic`, `Pillow`)

- A GPU with ≥ 6 GB VRAM recommended (developed on an **RTX 4050 6G**)

- Ships with a **mock** generator by default; wire in a real model via [Extensions](#extensions) for true inference.

### Install & Run

```bash
npm install
pip install fastapi uvicorn pydantic Pillow
npm run dev        # development (live reload)
# or
npm run build      # production bundle
```

> The app launches an Electron window that manages the backend lifecycle automatically — no separate server to start.

| Command                  | Purpose                     |
| ------------------------ | --------------------------- |
| `npm run dev`            | Dev mode with live reload   |
| `npm run build`          | Production build            |
| `npm run typecheck:web`  | TypeScript check (renderer) |
| `npm run typecheck:node` | TypeScript check (main)     |

***

## Extensions

Install packages that add new `generator.py` (model) or `processor.py` (mesh-to-mesh) nodes from multiple sources:

<p align="center">
  <img src="assets/diagrams/extension-sources.svg" alt="MeshForge extension install sources — GitHub, Hugging Face and ModelScope" width="800" />
</p>

1. Open **Models / Extensions**.
2. Pick an install source — **GitHub · Hugging Face · ModelScope (魔搭)**.
3. Paste the repository URL and install. The backend resolves the URL, streams the files, validates `manifest.json` + entrypoint, then registers the extension.

You can also install from a **local folder** via a native directory dialog.

***

## i18n

Dependency-free internalization layer (Zustand + `localStorage`). Switch under **Settings → Application → Interface → Language**; English is default, 中文 fully supported for labels, placeholders and errors.

***

## Roadmap

- [x] Node-based workflow canvas + run engine

- [x] Generate & 3D preview, multi-format export

- [x] Extensions install from **GitHub / HuggingFace / ModelScope**

- [x] English / 中文 language switching

- [x] Crash recovery, backend watchdog, install rollback

- [ ] Wire the real **Hunyuan3D-2-mini** inference model (currently mock)

***

## Acknowledgements

Built as an independent re-implementation of the workflow UX of [lightningpixel/modly](https://github.com/lightningpixel/modly).

***

## License

Released under the [MIT License](LICENSE).
