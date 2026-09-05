import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Capacitor WebView 需要相对路径
  base: './',
  // 版本号注入：APK 安装包能自报版本，闪退诊断里也带上
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(process.env.GITHUB_RUN_NUMBER || 'dev'),
  },
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
})
