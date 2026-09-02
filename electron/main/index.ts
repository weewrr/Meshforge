import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
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
