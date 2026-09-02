import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'

export const API_PORT = 8766
export const API_BASE = `http://127.0.0.1:${API_PORT}`

let backend: ChildProcess | null = null
let watchdog: NodeJS.Timeout | null = null
let stopping = false

function serverDir(): string {
  return path.join(app.getAppPath(), 'server')
}

function pythonExecutable(): string {
  const venvPython = path.join(serverDir(), '.venv', 'Scripts', 'python.exe')
  if (existsSync(venvPython)) return venvPython
  return 'python'
}

function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${API_BASE}/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
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
    // Kill the whole process tree, uvicorn may spawn children.
    spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'])
  } else {
    backend.kill('SIGTERM')
  }
}

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

export async function startPythonBackend(): Promise<void> {
  stopping = false
  const exe = pythonExecutable()

  backend = spawn(
    exe,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)],
    {
      cwd: serverDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  backend.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[meshforge-api] ${chunk.toString().trim()}`)
  })
  backend.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[meshforge-api] ${chunk.toString().trim()}`)
  })
  backend.on('exit', (code) => {
    backend = null
    if (!stopping) {
      console.error(`[meshforge-api] exited with code ${code}, restarting in 3s`)
      setTimeout(() => {
        void startPythonBackend()
      }, 3000)
    }
  })

  const healthy = await waitForHealth(30_000)
  console.log(
    healthy
      ? '[meshforge-api] backend healthy'
      : '[meshforge-api] health check timed out (watchdog will keep retrying)'
  )
  startWatchdog()
}

export function stopPythonBackend(): void {
  stopping = true
  if (watchdog) {
    clearInterval(watchdog)
    watchdog = null
  }
  killBackend()
  backend = null
}
