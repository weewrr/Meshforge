/**
 * HTTP 基址与统一 fetch 客户端。
 *
 * 后端 FastAPI 服务监听本机端口——默认 8766，被占用时 Electron 主进程自动
 * 向后选择空闲端口，渲染层在首帧前经 IPC `getApiInfo` 拿到实际端口写入
 * {@link API_BASE}（见 {@link initApiBase}，优化文档 12.3 动态端口）。
 *
 * 认证（优化文档 3.2 / 12.3）：后端启用 Bearer token 中间件，token 由
 * Electron 主进程每次启动随机生成，经 preload IPC 注入。所有 API 调用
 * 必须走 {@link apiFetch}；`/files` 静态资源由 <img>/<model> 标签直接加载，
 * 豁免认证。
 *
 * 统一客户端治理（优化文档 13.7）：
 * - **超时**：默认 30s（AbortController）；SSE / 大文件上传等长任务传
 *   `timeoutMs: 0` 关闭。
 * - **重试**：仅幂等 GET 默认重试 2 次（429/502/503/504 与网络错误），
 *   指数退避 + 抖动；写请求默认不重试（幂等性未知）。
 * - **401 自愈**：token 缓存可能过期（如先后启动了两个实例），收到 401
 *   时清缓存重新取一次再试一轮。
 */

/**
 * 本地后端服务基址。ESM live binding：`initApiBase` 更新后，所有
 * `import { API_BASE }` 的模块在下次读取时自动拿到新值。
 */
export let API_BASE = 'http://127.0.0.1:8766'

/**
 * 首帧前调用一次：从主进程取后端实际端口并改写 {@link API_BASE}。
 * 浏览器等无桥接环境（纯前端开发预览）保持默认 8766。
 */
export async function initApiBase(): Promise<void> {
  try {
    const info = await window.meshforge?.getApiInfo?.()
    if (info?.port) API_BASE = `http://127.0.0.1:${info.port}`
  } catch {
    /* 无桥接环境 —— 维持默认端口 */
  }
}

let cachedToken: string | null | undefined

async function getApiToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken
  try {
    cachedToken = (await window.meshforge?.getApiToken?.()) ?? null
  } catch {
    cachedToken = null
  }
  return cachedToken
}

// ─── 统一客户端参数 ──────────────────────────────────────────────────────────

/** {@link apiFetch} 专有选项；其余字段与原生 `RequestInit` 一致。 */
export interface ApiInit extends RequestInit {
  /** 请求超时毫秒数；`0` 表示不限（SSE 流、大文件上传等长任务）。默认 30s。 */
  timeoutMs?: number
  /** 网络错误 / 可重试状态码的最大重试次数；默认 GET 2 次、其余 0 次。 */
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
// 这些状态码代表"稍后重试可能成功"：限流与网关类故障。
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

/** 单次请求：附加认证头 + 超时控制；调用方自行决定是否重试。 */
async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // 外部传入的 signal 与我们的超时信号"合并"：任一触发都中止本次请求。
  const onExternalAbort = (): void => controller.abort()
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }
  init.signal?.addEventListener('abort', onExternalAbort)
  try {
    const token = await getApiToken()
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return await fetch(url, { ...init, headers, signal: controller.signal })
  } catch (err) {
    // 自身超时 → 抛出可读错误（而不是晦涩的 AbortError）；
    // 外部主动取消 → 原样上抛，调用方（如下载进度循环）需要区分。
    if (timedOut) throw new Error(`api timeout after ${timeoutMs}ms: ${url}`)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    init.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 指数退避延迟：400ms 起步，每次翻倍，上限 4s，加 ±30% 抖动防惊群。 */
function backoffDelay(attempt: number): number {
  const base = Math.min(4000, 400 * 2 ** attempt)
  return Math.round(base * (0.7 + Math.random() * 0.6))
}

/**
 * 带认证的统一 fetch：自动附加 `Authorization: Bearer <token>`，
 * 并施加超时 / 重试 / 401 自愈策略（详见模块注释）。
 *
 * token 取自 preload 暴露的 `window.meshforge.getApiToken()`；在浏览器等
 * 无桥接环境（如纯前端开发预览）下退化为普通 fetch，由后端返回 401 提示。
 *
 * @param url 完整 URL（通常用 `${API_BASE}/...` 拼出）。
 * @param init 与原生 fetch 的 init 一致，另见 {@link ApiInit}。
 */
export async function apiFetch(url: string, init: ApiInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries, ...rest } = init
  const method = (rest.method ?? 'GET').toUpperCase()
  const maxRetries = retries ?? (method === 'GET' ? 2 : 0)

  let attempt = 0
  for (;;) {
    let res: Response
    try {
      res = await doFetch(url, rest, timeoutMs)
    } catch (err) {
      // 网络错误 / 超时：仅幂等 GET 重试；外部主动取消（signal 已中止）不重试。
      if (!rest.signal?.aborted && attempt < maxRetries) {
        attempt += 1
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)))
        continue
      }
      throw err
    }

    // 401 自愈：token 缓存可能已失效（多实例 / 重启后缓存未刷新），
    // 清缓存重新取一次，仅自愈一轮，避免与真正无效的 token 死循环。
    if (res.status === 401 && attempt === 0) {
      cachedToken = undefined
      attempt += 1
      continue
    }

    if (attempt >= maxRetries || !RETRYABLE_STATUS.has(res.status)) return res
    attempt += 1
    await new Promise((r) => setTimeout(r, backoffDelay(attempt)))
  }
}

/**
 * 把后端返回的相对路径补全为可直接访问的绝对 URL。
 *
 * 已是绝对地址（`http` / `https`）或 `blob:` 的路径原样返回；
 * 其余一律拼上 {@link API_BASE}——后端返回的图片、模型产物多为 `/workspace/...` 形式。
 *
 * @param path 后端返回的路径或已是绝对地址的 URL。
 * @returns 可直接用于 `fetch` / `<img src>` 的 URL。
 */
export function fullUrl(path: string): string {
  return path.startsWith('http') || path.startsWith('blob:') ? path : `${API_BASE}${path}`
}
