import { useEffect, useMemo } from 'react'
import { AgentApi } from '@/infrastructure/api/AgentApi'
import { useConnectionStore } from '@/ui/store/connectionStore'
import { useAgentActivityStore } from '@/ui/store/agentActivityStore'

const POLL_MS = 15_000

/** Keeps `agentActivityStore.active` fresh app-wide so tab and editor badges are live even when no chat page is mounted. */
export function useAgentActivityPoll() {
  const url = useConnectionStore(s => s.url)
  const authMode = useConnectionStore(s => s.authMode)
  const setActive = useAgentActivityStore(s => s.setActive)
  const api = useMemo(() => new AgentApi(url), [url])

  useEffect(() => {
    if (!url || authMode !== 'gateway') {
      setActive(false)
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      try {
        const status = await api.status(controller.signal)
        if (!controller.signal.aborted) setActive((status.activeTasks ?? 0) > 0)
      } catch {
        // keep the last known value; the next tick retries
      }
    }

    const tick = async () => {
      await refresh()
      if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS)
    }

    void tick()

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, url, authMode, setActive])
}
