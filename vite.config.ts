import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const proxyPrefixes = [
  '/api/gateway',
  '/api/customnode',
  '/comfymobile',
  '/system_stats',
  '/object_info',
  '/prompt',
  '/queue',
  '/history',
  '/view',
  '/upload',
  '/delete',
  '/free',
  '/interrupt',
  '/internal',
  '/ws',
]

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const gatewayTarget = env.VITE_GATEWAY_TARGET || 'http://127.0.0.1:8080'

  return {
    plugins: [
      react(),
      tailwindcss()
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: Object.fromEntries(proxyPrefixes.map((prefix) => [prefix, {
        target: gatewayTarget,
        changeOrigin: true,
        ws: prefix === '/ws' || prefix === '/comfymobile',
      }])),
    }
  }
})
