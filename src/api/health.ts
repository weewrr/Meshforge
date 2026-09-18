/**
 * 后端健康检查。用于启动阶段轮询：Python 子进程冷启动需要数秒，
 * 前端必须等到 `/health` 可应答后才发第一个业务请求。
 */

import { API_BASE, apiFetch } from './http'

// ─── 健康检查 ─────────────────────────────────────────────────────────────────

/**
 * 探活：后端服务是否已就绪。
 *
 * 网络异常（连接被拒、超时）一律视为"未就绪"并返回 `false`，
 * 不向上抛错——调用方是轮询逻辑，抛错只会污染日志。
 *
 * @returns 后端返回 2xx 时为 `true`，否则 `false`。
 */
export async function health(): Promise<boolean> {
  try {
    const res = await apiFetch(`${API_BASE}/health`)
    return res.ok
  } catch {
    return false
  }
}
