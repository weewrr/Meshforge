/**
 * bundle 体积预算门禁（优化文档 6.1）。
 *
 * 扫描 out/renderer/assets 下的 JS chunk，输出体积表（降序），任一 chunk
 * 超过单块预算或总体积超过总预算时退出码 1。预算随项目演进在下方常量调整——
 * 调大必须给出理由（如新增大型依赖），防止体积悄悄膨胀。
 *
 * 用法：npm run build && npm run sizes
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS_DIR = join(process.cwd(), 'out', 'renderer', 'assets')
// 当前最大 chunk（Viewer3D 业务 ~2.2MB）；预算 = 现状 + ~10% 余量。
const PER_CHUNK_BUDGET = 2.5 * 1024 * 1024
const TOTAL_BUDGET = 8 * 1024 * 1024

const entries = readdirSync(ASSETS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, size: statSync(join(ASSETS_DIR, f)).size }))
  .sort((a, b) => b.size - a.size)

const total = entries.reduce((sum, e) => sum + e.size, 0)
const fmt = (n) => `${(n / 1024).toFixed(0)} KB`

console.log('renderer JS chunks (descending):')
for (const e of entries) console.log(`  ${fmt(e.size).padStart(9)}  ${e.file}`)
console.log(`  ${'—'.repeat(8)}  total: ${fmt(total)} / budget ${fmt(TOTAL_BUDGET)}`)

let failed = false
for (const e of entries) {
  if (e.size > PER_CHUNK_BUDGET) {
    console.error(`BUDGET EXCEEDED: ${e.file} = ${fmt(e.size)} > ${fmt(PER_CHUNK_BUDGET)}`)
    failed = true
  }
}
if (total > TOTAL_BUDGET) {
  console.error(`TOTAL BUDGET EXCEEDED: ${fmt(total)} > ${fmt(TOTAL_BUDGET)}`)
  failed = true
}
process.exit(failed ? 1 : 0)
