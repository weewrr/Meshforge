import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('meshforge', {
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  getRam: () => ipcRenderer.invoke('sys:ram'),
  selectMeshFile: () => ipcRenderer.invoke('fs:selectMeshFile'),
  selectImageFile: () => ipcRenderer.invoke('fs:selectImageFile'),
  selectWorkflowFile: () => ipcRenderer.invoke('fs:selectWorkflowFile'),
  selectFolder: () => ipcRenderer.invoke('fs:selectFolder'),
  getLastCrash: () => ipcRenderer.invoke('fs:getLastCrash')
})
