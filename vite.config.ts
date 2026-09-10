import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'node:fs'
import { offlineShellPlugin } from './build/offlineShell'

const versionFile = path.resolve(__dirname, 'comfy-mobile-ui-api-extension/version.json')
const versionPayload = JSON.stringify(
  JSON.parse(fs.readFileSync(versionFile, 'utf8')),
  null,
  2,
)

const versionPlugin = {
  name: 'comfy-mobile-version',
  configureServer(server: { middlewares: { use: (path: string, handler: (request: { method?: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use('/version.json', (request, response, next) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return next()
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-cache')
      response.end(request.method === 'HEAD' ? undefined : versionPayload)
    })
  },
  generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => void }) {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: versionPayload,
    })
  },
}

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
      versionPlugin,
      react(),
      tailwindcss(),
      offlineShellPlugin()
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
