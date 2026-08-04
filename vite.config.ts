import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Capacitor WebView 需要相对路径
  base: './',
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
})
