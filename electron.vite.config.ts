import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve('electron/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve('src/index.html'),
        output: {
          // vendor 分离（优化文档 6.1）：three 生态（three/@react-three/troika）
          // 只被懒加载的 Viewer3D 引用，独立成 three-vendor chunk 后仍按需加载，
          // 但与 Viewer3D 业务代码解耦——业务改动不再使 1MB+ 的 three 缓存失效；
          // 其余 node_modules 归入 vendor，与业务代码分离以改善缓存命中。
          //
          // 匹配用「node_modules/<包名>」路径段前缀而非子串包含：
          // 原先的 id.includes('three') 会误伤任何路径中恰好含 three 的模块
          // （例如某依赖的深层目录名），把无关代码塞进 three-vendor。
          manualChunks(id: string) {
            const m = id.match(/node_modules[/\\](.+)/)
            if (!m) return undefined
            // 取包名：处理 @scope/pkg 与 pkg 两种形态
            const seg = m[1].split(/[/\\]/)
            const pkg = seg[0].startsWith('@') ? `${seg[0]}/${seg[1]}` : seg[0]
            if (pkg === 'three' || pkg.startsWith('three-') || pkg.startsWith('@react-three/')) {
              return 'three-vendor'
            }
            // troika-* 是 three 生态的文字渲染依赖
            if (pkg.startsWith('troika-')) return 'three-vendor'
            return 'vendor'
          }
        }
      }
    },
    plugins: [react()]
  }
})
