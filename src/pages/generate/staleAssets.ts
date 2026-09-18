/**
 * 旧版导入路径引用检测（行为债清偿，优化文档 §19.3）。
 *
 * 三类 serve-file 引用的命运：
 * 1. **旧版工作流**：URL 的 path 直接指向 workspace 外的磁盘路径——
 *    安全边界收紧（文档 3.2）后一律 403，永久失效；
 * 2. **obj/stl/ply 转换产物**：落在 `meshforge_import_*` 会话临时目录，
 *    后端重启即被清理，404；
 * 3. **现行 GLB 导入**：已复制进 `workspace/uploads/<32位hex>.glb`，
 *    跨会话持久有效——不算过期。
 *
 * 前端不知道 DATA_DIR 绝对路径，但 uploads 文件名有固定形态
 * （`<32 位 hex>.glb`），据此可准确区分 1/2（过期）与 3（有效）。
 */

/** 待扫描的节点最小形状（与工作流节点的 data.params 兼容）。 */
export type StaleScanNode = {
  id?: string
  data?: {
    label?: string
    params?: Record<string, unknown>
  }
}

/** uploads 内持久产物的文件名形态（import_mesh_by_path 用 uuid4().hex 命名）。 */
const PERSISTENT_UPLOAD_RE = /^[0-9a-f]{32}\.glb$/i

/**
 * 判断一个 serve-file 参数值是否为"过期引用"。
 *
 * 非字符串、或 path 落在持久 uploads 命名内的返回 false；
 * 其余（workspace 外旧路径 / 临时转换目录）返回 true。
 */
export function isStaleServeFileUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('/optimize/serve-file?path=')) return false
  try {
    const raw = decodeURIComponent(value.slice('/optimize/serve-file?path='.length))
    const fileName = raw.replaceAll('\\', '/').split('/').pop() ?? ''
    return !PERSISTENT_UPLOAD_RE.test(fileName)
  } catch {
    // path 解码失败（畸形 URL）——按过期处理，宁可多提醒一次。
    return true
  }
}

/**
 * 扫描工作流节点，返回仍引用过期导入路径的节点 label 列表（去重）。
 *
 * 扫描范围：params 顶层的全部 string 型值（路径引用历史上只出现在这一层，
 * 不递归嵌套对象）。
 */
export function findStaleAssetRefs(nodes: StaleScanNode[]): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const params = node.data?.params
    if (!params) continue
    let stale = false
    for (const value of Object.values(params)) {
      if (isStaleServeFileUrl(value)) {
        stale = true
        break
      }
    }
    if (stale) {
      const label = node.data?.label ?? node.id ?? '(unnamed)'
      if (!seen.has(label)) {
        seen.add(label)
        labels.push(label)
      }
    }
  }
  return labels
}

