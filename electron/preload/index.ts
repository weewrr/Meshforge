import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('meshforge', {
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  getRam: () => ipcRenderer.invoke('sys:ram')
})
