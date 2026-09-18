/**
 * Electron 主进程入口。
 *
 * 负责窗口生命周期（无边框主窗口、单实例锁）、崩溃恢复（渲染进程异常退出后
 * 自动重载，并把原因暂存给前端展示）、Python 后端子进程的拉起与退出清理，
 * 以及 IPC 通道注册（原生对话框、文件路径、系统信息、窗口控制）。
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { API_TOKEN, getApiPort, startPythonBackend, stopPythonBackend } from './python-bridge'
import { clearSecrets, getSecret, setSecret } from './secret-store'

// 虚拟机 / 远程桌面宿主的 GPU 驱动常有缺陷，会冻住渲染进程的合成器
// （渲染进程无响应、WebGL 上下文丢失）。回退到 SwiftShader 可让应用
// 在这类机器上保持稳定。
app.disableHardwareAcceleration()
// 在本机上 Chromium 沙箱 broker 会破坏子进程启动：GPU 进程以退出码 1
// 退出、网络服务失败，且一切导航（连 data: URL 也一样）都以
// ERR_FAILED (-2) 被拒绝。
// --no-sandbox is the only reliable workaround here; contextIsolation stays on.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

let mainWindow: BrowserWindow | null = null

// 在每次"因崩溃触发重载"之前写入；重载后的渲染进程通过一次性 IPC
// `fs:getLastCrash` 读取它并显示"已恢复"横幅，使崩溃不会再被静默地跳回默认页面。
let lastCrash: { reason: string; at: number } | null = null

// 记录崩溃原因与时间戳，供重载后的渲染进程读取并展示恢复横幅。
function markCrash(reason: string): void {
  lastCrash = { reason, at: Date.now() }
  console.error(`[main] markCrash: ${reason}`)
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    title: 'Meshforge',
    backgroundColor: '#090d15',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  // 外链协议白名单（文档 13.5）：只放行 https 链接到系统默认浏览器，
  // 防止 file:// / 自定义协议处理器被恶意页面借 shell.openExternal 触发。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 同时约束本窗口导航：仅允许 https 外链跳系统浏览器，其余拒绝。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://')) event.preventDefault()
  })

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })

  // ── Renderer crash / hang recovery ─────────────────────────────────────
  // 窗口无边框（`frame: false`），标题栏由 React 绘制：如果渲染进程死掉
  // 或主线程卡死（本机常见原因是 GPU 驱动异常 / WebGL 崩溃），
  // 最小化/最大化/关闭按钮会随之消失，窗口看起来"卡死"，
  // 关闭与最小化像是失灵。恢复必须由主进程完成——
  // 主进程独立于渲染进程存活，可以替用户收掉窗口；
  // 不要把这类兜底逻辑放进渲染进程。
  let crashCount = 0
  let crashWindowStart = 0
  const CRASH_BUCKET_MS = 30_000
  const MAX_AUTO_RELOADS = 2

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[main] renderer process gone: ${details.reason} (exit ${details.exitCode})`)
    const now = Date.now()
    if (now - crashWindowStart > CRASH_BUCKET_MS) {
      crashWindowStart = now
      crashCount = 0
    }
    crashCount++
    if (crashCount > MAX_AUTO_RELOADS && !process.env.MF_NO_CRASH_DIALOG) {
      // 停止自动重载——重载只会再次崩溃；交给用户决定。
      const win = mainWindow
      const options: Electron.MessageBoxOptions = {
        type: 'error',
        title: 'MeshForge renderer crashed',
        message: 'The interface crashed (GPU/WebGL failure).',
        detail: `${details.reason} (exit code ${details.exitCode}). Reloading did not help — you can retry or close the window.`,
        buttons: ['Reload', 'Close'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }
      const ask = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
      void ask.then(({ response }) => {
        if (response === 0) {
          crashWindowStart = Date.now()
          crashCount = 0
          markCrash(`renderer crash (${details.reason}, exit ${details.exitCode}) — reload did not help`)
          mainWindow?.webContents.reload()
        } else {
          mainWindow?.close()
        }
      })
      return
    }
    // 自动恢复：重载会清空内存状态，因此 3D 查看器不会自动重新挂载
    // 那个会让它崩溃的模型。
    // MF_NO_CRASH_DIALOG=1（自动化/e2e 运行）：继续自动重载循环，
    // 不被弹窗阻塞，让每次崩溃都被记录下来。
    markCrash(`renderer crash (${details.reason}, exit ${details.exitCode})`)
    if (process.env.MF_NO_CRASH_DIALOG) {
      crashWindowStart = Date.now()
      crashCount = 0
    }
    mainWindow?.webContents.reload()
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[main] renderer unresponsive — showing recovery dialog')
    const win = mainWindow
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'MeshForge is not responding',
      message: 'The interface has stopped responding (likely a GPU/WebGL hang).',
      buttons: ['Reload', 'Wait', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const ask = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    void ask.then(({ response }) => {
      if (response === 0) {
        markCrash('renderer hang (unresponsive) — reloaded from recovery dialog')
        mainWindow?.webContents.reload()
      } else if (response === 2) mainWindow?.close()
      // response === 1（等待）：什么都不做；后续可能触发 'responsive' 事件。
    })
  })


  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('win:min', () => mainWindow?.minimize())
ipcMain.handle('win:max', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('win:close', () => mainWindow?.close())

// 原生文件对话框（与 Modly 对齐）。在本机环境下，渲染进程内打开 Chromium 的
// <input type=file> 会让渲染主线程冻结，因此网格导入改由主进程承接：主进程返回
// 文件系统路径，由后端直接提供该文件的访问。
ipcMain.handle('fs:selectMeshFile', async (): Promise<string | null> => {
  const win = mainWindow
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Select a 3D mesh file',
    filters: [{ name: '3D Mesh', extensions: ['glb', 'obj', 'stl', 'ply'] }],
    properties: ['openFile']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

ipcMain.handle('fs:selectImageFile', async (): Promise<string | null> => {
  const win = mainWindow
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Select an image file',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// 工作流 JSON 导入——在主进程读取文件，因为沙箱化的渲染进程
// 没有文件系统权限，且 <input type=file> 会冻住这台机器的渲染进程
//（渲染进程最终只拿得到解析后的 JSON 文本）。
ipcMain.handle('fs:selectWorkflowFile', async (): Promise<{ name: string; content: string } | null> => {
  const win = mainWindow
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Import workflow JSON',
    filters: [{ name: 'Workflow JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  const filePath = result.canceled ? null : (result.filePaths[0] ?? null)
  if (!filePath) return null
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return { name: path.basename(filePath), content }
  } catch (err) {
    console.error('[main] read workflow file failed:', err)
    return null
  }
})

// 扩展源文件夹选择器。扩展页的"链接本地文件夹"原本在渲染进程里用
// webkitdirectory 的 <input type=file>，会冻结 / 崩溃本机渲染进程（与上面的
// 网格/图片选择器同源）。主进程返回目录路径，由后端在服务端复制整棵目录树——
// 渲染进程全程不接触这些文件。
ipcMain.handle('fs:selectFolder', async (): Promise<string | null> => {
  const win = mainWindow
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Select extension folder (must contain manifest.json)',
    buttonLabel: 'Link local folder',
    properties: ['openDirectory']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// 一次性：渲染进程在崩溃触发的重载后立刻调用本接口，以获知
// 这次为什么被重载（供恢复横幅 / 日志使用）。读取即清空，
// 因此横幅在每次崩溃后只会显示一次。
ipcMain.handle('fs:getLastCrash', async (): Promise<{ reason: string; at: number } | null> => {
  const crash = lastCrash
  lastCrash = null
  return crash
})

ipcMain.handle('sys:ram', () => {
  const total = os.totalmem()
  const free = os.freemem()
  return { total, free, percent: Math.round(((total - free) / total) * 100) }
})

// 本地 API token：渲染层经 apiFetch 给每个请求附加 Authorization 头。
// token 只经受控 IPC 传递，不出现在 URL / localStorage / 日志里（文档 3.2 / 13.3）。
ipcMain.handle('fs:getApiToken', () => API_TOKEN)

// 本地 API 端口：后端启动时从 8766 起自动选空闲端口，渲染层在首帧前
// 经此 IPC 取到实际端口并配置 API_BASE（文档 12.3 动态端口）。
ipcMain.handle('api:getInfo', () => ({ port: getApiPort() }))

// 凭据安全存取（文档 13.3）：HF Token / Agent API Key 由主进程经 safeStorage
// 加密落盘，渲染层不再把它们放进 localStorage。键名白名单在 secret-store 内校验。
ipcMain.handle('secrets:get', (_e, key: string) => getSecret(key))
ipcMain.handle('secrets:set', (_e, key: string, value: string) => setSecret(key, String(value ?? '')))
ipcMain.handle('secrets:clear', () => clearSecrets())

app.whenReady().then(async () => {
  // 本地 API 绝不能走用户的系统代理。
  await session.defaultSession.setProxy({ mode: 'direct' })

  // 权限默认拒绝（文档 13.5）：应用未声明任何浏览器权限需求，
  // 未声明的权限请求（通知/定位/摄像头等）一律拒绝，收敛渲染层被利用后的影响面。
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  await startPythonBackend()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

// 窗口全部关闭（macOS 除外）或应用即将退出时，停掉 Python 后端子进程，释放端口。
app.on('window-all-closed', () => {
  stopPythonBackend()
  if (process.platform !== 'darwin') app.quit()
})

// 退出前兜底再清理一次后端进程，避免极端情况下子进程残留。
app.on('before-quit', () => {
  stopPythonBackend()
})
