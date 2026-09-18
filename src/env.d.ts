/**
 * preload 桥的全局类型声明。
 *
 * `window.meshforge` 由 electron/preload 通过 contextBridge 暴露；这里给出
 * 每个 IPC 方法的签名，让渲染进程能安全地拿到补全与类型检查，而不必 cast。
 */

export {}

declare global {
  interface Window {
    meshforge?: {
      /** 最小化当前窗口。 */
      winMin: () => Promise<void>
      /** 切换窗口最大化 / 还原。 */
      winMax: () => Promise<void>
      /** 关闭当前窗口。 */
      winClose: () => Promise<void>
      /** 读取系统内存情况，返回总量、空闲量与占用百分比，供性能页展示。 */
      getRam: () => Promise<{ total: number; free: number; percent: number }>
      /** 打开文件选择对话框（限定网格文件），选中后返回路径，取消则返回 `null`。 */
      selectMeshFile: () => Promise<string | null>
      /** 打开图片选择对话框，选中后返回路径，取消则返回 `null`。 */
      selectImageFile: () => Promise<string | null>
      /** 打开工作流文件对话框，选中后返回文件名与内容，取消则返回 `null`。 */
      selectWorkflowFile: () => Promise<{ name: string; content: string } | null>
      /** 打开文件夹选择对话框，选中后返回路径，取消则返回 `null`。 */
      selectFolder: () => Promise<string | null>
      /** 取回主进程暂存的"上次崩溃原因"与发生时刻；无记录时返回 `null`。 */
      getLastCrash: () => Promise<{ reason: string; at: number } | null>
      /** 取回本地 API 的 bearer token（主进程每次启动随机生成），供 apiFetch 使用。 */
      getApiToken: () => Promise<string>
      /** 取回本地 API 实际端口，供首帧前初始化 API_BASE。 */
      getApiInfo: () => Promise<{ port: number }>
      /** 读取安全存储中的凭据（键名白名单：hfToken / agentApiKey）。 */
      getSecret: (key: string) => Promise<string>
      /** 写入安全存储中的凭据；传空字符串等价于删除。 */
      setSecret: (key: string, value: string) => Promise<void>
      /** 清除全部凭据。 */
      clearSecrets: () => Promise<void>
    }
  }
}
