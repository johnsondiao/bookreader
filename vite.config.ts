import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 从项目根目录的 key.env 读取 MINMAXKEY，作为构建期宏注入到客户端代码。
 * key.env 不是 Vite 默认会加载的 .env 文件，且 MINMAXKEY 没有 VITE_ 前缀，
 * 因此这里手动解析并通过 define 注入为全局常量 MINMAXKEY。
 */
function loadMinimaxKey(): string {
  try {
    const p = fileURLToPath(new URL('./key.env', import.meta.url))
    const txt = fs.readFileSync(p, 'utf-8')
    const m = txt.match(/^MINMAXKEY\s*=\s*(.+)$/m)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

const minimaxKey = loadMinimaxKey()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Capacitor WebView 需要相对路径
  base: './',
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
  define: {
    MINMAXKEY: JSON.stringify(minimaxKey),
  },
})
