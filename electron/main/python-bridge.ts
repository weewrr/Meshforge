/**
 * Python 后端进程桥接。
 *
 * 探测 server/.venv 里的解释器 → 以子进程拉起 uvicorn → 轮询 /health 直到
 * 端口就绪 → 崩溃后自动重启；应用退出时逆序优雅关闭。前后端解耦的关键就在
 * 这里：渲染进程只认 127.0.0.1:8766，不关心后端进程是谁拉起的。
 *
 * 打包兼容（优化文档 3.1 / 12.1 / 13.1）：
 * - 后端目录区分开发态与打包态：开发态在 app.getAppPath()/server，
 *   打包态在 process.resourcesPath/server（electron-builder extraResources
 *   的实际落点，app.asar 内没有 server/）。
 * - 可变数据（workspace / models / extensions）经 MESHFORGE_DATA_DIR
 *   指向 app.getPath('userData')，不写入只读的安装资源目录。
 * - 每次启动生成随机 API token，经 MESHFORGE_API_TOKEN 注入后端，
 *   并通过 IPC 暴露给渲染层（preload → apiFetch）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'

// 首选端口：被占用（例如残留的旧后端实例）时自动向后扫描空闲端口，
// 不再与未知进程抢 8766（优化文档 12.3）。
const PREFERRED_PORT = 8766

// 本次启动实际使用的端口；startPythonBackend 时确定。
let currentPort = PREFERRED_PORT

/** 后端实际监听的端口（渲染层经 IPC `api:getInfo` 获取）。 */
export function getApiPort(): number {
  return currentPort
}

/** 后端基址；等 startPythonBackend 选定端口后即为最终值。 */
export function getApiBase(): string {
  return `http://127.0.0.1:${currentPort}`
}

// 本次应用生命周期的本地 API token：后端中间件与渲染层 apiFetch 共同持有。
export const API_TOKEN = crypto.randomBytes(32).toString('hex')

// 探测端口是否空闲：尝试 bind，成功即空闲（立即关闭）。
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

// 从 PREFERRED_PORT 起向后找第一个空闲端口（最多扫 50 个，防极端情况死循环）。
async function findFreePort(): Promise<number> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 50; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port found from ${PREFERRED_PORT}`)
}

let backend: ChildProcess | null = null
let watchdog: NodeJS.Timeout | null = null
let stopping = false
// 崩溃重启的连续失败次数：决定指数退避的延迟；一旦探活成功即归零。
let restartAttempts = 0

// 返回后端源码目录：开发态用仓库路径，打包态用 extraResources 的落点。
// 打包后 app.getAppPath() 指向 app.asar 内部，而 server/ 被装在
// resources/server，因此必须按 app.isPackaged 分流。
function serverDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server')
  }
  return path.join(app.getAppPath(), 'server')
}

// 可变数据根目录：打包态固定为用户数据目录（随用户漫游、可写、
// 升级/卸载不影响），开发态保持仓库内目录不动。
function dataDir(): string {
  if (app.isPackaged) {
    return app.getPath('userData')
  }
  return serverDir()
}

// 探测 Python 可执行文件：优先用 server/.venv 里的虚拟环境解释器，
// 找不到再回退到系统 PATH 中的 `python`（开发期常用）。
function pythonExecutable(): string {
  const venvPython = path.join(serverDir(), '.venv', 'Scripts', 'python.exe')
  if (existsSync(venvPython)) return venvPython
  return 'python'
}

// 单次握手探测：不只是"端口上有 HTTP 服务"，还要验证"这个服务是我们的后端"——
// 带 Bearer token 请求一个需认证的轻量端点，只有持有同一 token 的本应用后端
// 才会返回 200；残留旧实例 / 无关进程 / 别的 HTTP 服务一律失败（文档 12.3）。
function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `${getApiBase()}/generators`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ping()) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function killBackend(): void {
  if (!backend?.pid) return
  if (process.platform === 'win32') {
    // 杀掉整个进程树——uvicorn 可能派生子进程。
    spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'])
  } else {
    backend.kill('SIGTERM')
  }
}

// 启动看门狗：每 5s 探活一次，连续 3 次失败就杀掉后端触发自动重启，避免僵死。
function startWatchdog(): void {
  if (watchdog) return
  let misses = 0
  watchdog = setInterval(async () => {
    if (await ping()) {
      misses = 0
      return
    }
    misses += 1
    if (misses >= 3 && backend) {
      console.error('[meshforge-api] unhealthy, killing for restart')
      killBackend()
    }
  }, 5000)
}

/**
 * 拉起 Python 后端并等待其就绪。
 *
 * 以子进程方式启动 `uvicorn`，把 stdout/stderr 镜像到主进程终端，
 * 监听 `exit` 以便非主动退出时自动重启，最后轮询 `/health` 直到就绪并启动看门狗。
 */
export async function startPythonBackend(): Promise<void> {
  stopping = false
  const dir = serverDir()
  const exe = pythonExecutable()

  // 每次启动（含崩溃重启）都重新选端口：上次的端口可能已被别的进程占用。
  currentPort = await findFreePort()

  // 启动前预检：给出可操作的错误信息，而不是干等 /health 超时（文档 3.1）。
  const entry = path.join(dir, 'main.py')
  if (!existsSync(entry)) {
    console.error(
      `[meshforge-api] FATAL: backend entry not found: ${entry}\n` +
        `  packaged=${app.isPackaged}, resourcesPath=${process.resourcesPath}, appPath=${app.getAppPath()}\n` +
        `  重新安装应用，或确认 electron-builder extraResources 已包含 server/。`
    )
    return
  }
  if (exe === 'python') {
    console.warn(
      '[meshforge-api] 未找到内置 .venv 解释器，回退到系统 python。' +
        '需保证系统 Python 已安装 fastapi/uvicorn 等依赖，否则后端无法启动。'
    )
  }

  backend = spawn(
    exe,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(currentPort)],
    {
      cwd: dir,
      env: {
        ...process.env,
        // 数据目录：workspace / models / extensions 全部落在可写位置。
        MESHFORGE_DATA_DIR: dataDir(),
        // 本地 API 认证：渲染层经 IPC 取同一 token。
        MESHFORGE_API_TOKEN: API_TOKEN,
        // 实际端口：agent.py / mcp_server.py 等同进程模块据此回调自身 API。
        MESHFORGE_API_PORT: String(currentPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true  // 隐藏 uvicorn 的控制台窗口，避免弹出黑框
    }
  )

  backend.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[meshforge-api] ${chunk.toString().trim()}`)
  })
  backend.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[meshforge-api] ${chunk.toString().trim()}`)
  })
  // spawn 本身失败（解释器路径无效、权限不足等）：exit 可能永不触发，
  // 必须单独捕获并说明解释器路径，否则用户只能看到无尽的健康检查超时。
  backend.on('error', (err) => {
    console.error(
      `[meshforge-api] failed to start backend via "${exe}": ${err.message}\n` +
        `  检查 Python 环境是否可用，或在 server/ 下重建 .venv。`
    )
  })
  backend.on('exit', (code) => {
    backend = null
    if (!stopping) {
      // 非正常退出：按指数退避自动重启（3s → 6s → 12s → …上限 60s），
      // 避免后端持续崩溃时形成秒级重启风暴；探活成功后计数归零。
      const delay = Math.min(60_000, 3000 * 2 ** restartAttempts)
      restartAttempts += 1
      console.error(
        `[meshforge-api] exited with code ${code}, restarting in ${Math.round(delay / 1000)}s ` +
          `(attempt ${restartAttempts})`
      )
      setTimeout(() => {
        void startPythonBackend()
      }, delay)
    }
  })

  const healthy = await waitForHealth(30_000)
  if (healthy) restartAttempts = 0
  console.log(
    healthy
      ? `[meshforge-api] backend healthy on :${currentPort} (data dir: ${dataDir()})`
      : '[meshforge-api] health check timed out (watchdog will keep retrying)'
  )
  startWatchdog()
}

/**
 * 优雅停止 Python 后端。
 *
 * 先置 `stopping` 标志避免 `exit` 监听器误触发自动重启，再停掉看门狗并杀掉进程。
 */
export function stopPythonBackend(): void {
  stopping = true
  if (watchdog) {
    clearInterval(watchdog)
    watchdog = null
  }
  killBackend()
  backend = null
}
