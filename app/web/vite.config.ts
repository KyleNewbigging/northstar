import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  root: 'app/web',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': {
        target: 'ws://127.0.0.1:4317',
        ws: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
})
