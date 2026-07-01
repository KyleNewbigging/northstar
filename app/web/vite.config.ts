import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => {
  const apiPort = process.env.NORTHSTAR_PORT ?? '4317'
  const apiUrl = process.env.NORTHSTAR_API_URL ?? `http://127.0.0.1:${apiPort}`
  if (command === 'serve' && !process.env.VITE_NORTHSTAR_API_URL) process.env.VITE_NORTHSTAR_API_URL = apiUrl
  const wsUrl = apiUrl.replace(/^http/, 'ws')
  const webPort = process.env.NORTHSTAR_WEB_PORT ? Number(process.env.NORTHSTAR_WEB_PORT) : 5173
  const previewPort = process.env.NORTHSTAR_PREVIEW_PORT ? Number(process.env.NORTHSTAR_PREVIEW_PORT) : 4173

  return {
    plugins: [react()],
    root: 'app/web',
    server: {
      host: '127.0.0.1',
      port: webPort,
      proxy: {
        '/api': apiUrl,
        '/ws': {
          target: wsUrl,
          ws: true,
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: previewPort,
    },
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
    },
  }
})
