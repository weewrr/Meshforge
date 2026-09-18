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
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('three') || id.includes('troika')) return 'three-vendor'
            return 'vendor'
          }
        }
      }
    },
    plugins: [react()]
  }
})
