/**
 * 预加载脚本：向渲染进程安全暴露受限的 `meshforge` API。
 *
 * 在 `contextIsolation` 开启的前提下，仅通过 `contextBridge` 把"窗口控制、
 * 文件选择、系统信息"这几类能力以异步方法的形式暴露给渲染进程；
 * 所有方法底层都走 `ipcRenderer.invoke` 与主进程通信，渲染进程无法直接触碰 Node/Electron。
 */

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
  getLastCrash: () => ipcRenderer.invoke('fs:getLastCrash'),
  /** 取回本地 API 的 bearer token（主进程每次启动随机生成），供 apiFetch 使用。 */
  getApiToken: () => ipcRenderer.invoke('fs:getApiToken'),
  /** 取回本地 API 实际端口（后端从 8766 起自动选空闲端口），供 API_BASE 初始化。 */
  getApiInfo: () => ipcRenderer.invoke('api:getInfo'),
  /** 读取安全存储中的凭据（HF Token / Agent API Key），明文不落 localStorage。 */
  getSecret: (key: string) => ipcRenderer.invoke('secrets:get', key),
  /** 写入安全存储中的凭据；传空字符串等价于删除该键。 */
  setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  /** 清除全部凭据。 */
  clearSecrets: () => ipcRenderer.invoke('secrets:clear')
})
