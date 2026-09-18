/**
 * 凭据安全存储（Electron 主进程侧）。
 *
 * HF Token、Agent API Key 等敏感凭据不再存放在渲染进程 localStorage——
 * 那里任何 XSS / 恶意网页命中即可直接读取长期明文（优化文档 13.3）。
 * 改为：主进程用 `safeStorage`（OS 级 DPAPI / Keychain / libsecret）加密后
 * 落盘到 userData/secrets.json，渲染进程只经受控 IPC 读写，明文不落 localStorage。
 *
 * safeStorage 不可用时（极少数 Linux 无 libsecret 环境）退回 base64 明文存储，
 * 并以 `plain:` 前缀标记——降级但有功能。
 */

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** 凭据文件：userData/secrets.json，值统一为 base64 字符串。 */
const SECRETS_FILE = path.join(app.getPath('userData'), 'secrets.json')

/** 已知凭据键；未知键一律拒绝，防止这个通道变成任意 KV 存储。 */
const KNOWN_KEYS = new Set(['hfToken', 'agentApiKey'])

type SecretMap = Record<string, string>

function loadAll(): SecretMap {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: SecretMap = {}
    for (const [key, b64] of Object.entries(parsed)) {
      if (!KNOWN_KEYS.has(key) || typeof b64 !== 'string') continue
      try {
        if (b64.startsWith('plain:')) {
          // 加密不可用时的降级存储。
          out[key] = Buffer.from(b64.slice(6), 'base64').toString('utf-8')
        } else {
          out[key] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
        }
      } catch {
        /* 解不开的条目（系统用户变更等）直接丢弃 */
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveAll(map: SecretMap): void {
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (!KNOWN_KEYS.has(key)) continue
    if (safeStorage.isEncryptionAvailable()) {
      serialized[key] = safeStorage.encryptString(value).toString('base64')
    } else {
      // 降级：标记为明文，下次可用时会在写入时自动升级为加密。
      serialized[key] = `plain:${Buffer.from(value, 'utf-8').toString('base64')}`
    }
  }
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true })
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(serialized, null, 2), 'utf-8')
}

/** 读取一个凭据；不存在时返回空字符串。 */
export function getSecret(key: string): string {
  if (!KNOWN_KEYS.has(key)) return ''
  return loadAll()[key] ?? ''
}

/** 写入一个凭据（立即加密落盘）。传空字符串等价于删除。 */
export function setSecret(key: string, value: string): void {
  if (!KNOWN_KEYS.has(key)) return
  const map = loadAll()
  if (value) map[key] = value
  else map[key] = ''
  saveAll(map)
}

/** 清除全部已知凭据（"清除全部凭据"设置项用）。 */
export function clearSecrets(): void {
  saveAll({})
}
