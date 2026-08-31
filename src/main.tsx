import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/i18n' // i18n initialization
import { installComfyAuthAxiosInterceptor } from './infrastructure/auth/ComfyAuthService'
import { useConnectionStore } from './ui/store/connectionStore'
import { initializePlatformRuntime } from './platform/runtime'
import App from './App.tsx'

const root = document.getElementById('root')!

const bootstrap = async () => {
  await initializePlatformRuntime()
  installComfyAuthAxiosInterceptor()
  useConnectionStore.getState().hydrateAuth()

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap().catch((error) => {
  console.error('Failed to initialize Comfy Mobile:', error)
  root.textContent = 'Comfy Mobile failed to initialize.'
})
