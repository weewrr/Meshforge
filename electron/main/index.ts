import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startPythonBackend, stopPythonBackend } from './python-bridge'

// VM / remote-desktop hosts often ship broken GPU drivers that freeze the
// renderer's compositor (renderer becomes unresponsive, WebGL context lost).
// SwiftShader fallback keeps the app stable on such machines.
app.disableHardwareAcceleration()
// On this machine the Chromium sandbox broker breaks child-process startup:
// GPU process exits with code 1, the network service fails, and every
// navigation (even data: URLs) rejects with ERR_FAILED (-2).
// --no-sandbox is the only reliable workaround here; contextIsolation stays on.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

let mainWindow: BrowserWindow | null = null

// Set right before any crash-driven reload; the freshly loaded renderer asks
// for it via `fs:getLastCrash` (one-shot) and shows a "recovered" banner, so a
// crash is never a silent jump back to the default page.
let lastCrash: { reason: string; at: number } | null = null

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
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })

  // ── Renderer crash / hang recovery ─────────────────────────────────────
  // The window is frameless (`frame: false`) and its title bar is drawn by
  // React: if the renderer process dies or its main thread freezes (broken
  // GPU drivers / WebGL crashes are the usual cause on this machine), the
  // min/max/close buttons vanish with it and the window looks "stuck" —
  // close and minimize appear dead. Recovery must come from the main
  // process, which stays alive independently of the renderer.
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
      // Stop auto-reloading — it would just crash again; let the user decide.
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
    // Auto-recover: a reload clears in-memory state, so the 3D viewer will
    // not remount a crashing model automatically.
    // MF_NO_CRASH_DIALOG=1 (automated/e2e runs): keep the auto-reload loop
    // going without blocking on a message box, so each crash is logged.
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
      // response === 1 (Wait): do nothing; 'responsive' may fire later.
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

// Native file dialogs (Modly-aligned). Opening a Chromium <input type=file>
// inside the renderer is documented to freeze this machine's renderer main
// thread, so mesh imports go through the main process instead: it returns a
// filesystem path and the backend serves the file directly.
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

// Workflow JSON import — reads the file in the main process because the
// sandboxed renderer has no fs access (and <input type=file> freezes this
// machine's renderer).
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

// Extension source-folder picker. The Extensions page's "Link local folder"
// used a webkitdirectory <input type=file> in the renderer, which freezes /
// crashes this machine's renderer (same root cause as the mesh/image pickers
// above). The main process returns the directory path and the backend copies
// the tree server-side — the renderer never touches the files.
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

// One-shot: the renderer calls this right after a crash-driven reload to learn
// why it was reloaded (for the recovery banner / log). Clears on read so the
// banner only shows once per crash.
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

app.whenReady().then(async () => {
  // Local API must never go through the user's system proxy.
  await session.defaultSession.setProxy({ mode: 'direct' })

  await startPythonBackend()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  stopPythonBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopPythonBackend()
})
