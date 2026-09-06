import { useEffect, useMemo, useState } from 'react';
import { AgentApi, type AgentStatus } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';

export type AgentAvailability = 'loading' | 'no-gateway' | 'no-provider' | 'error' | 'ready';

/** Resolves whether the chat feature can be used with the current connection. Re-runs when the connection changes. */
export function useAgentStatus() {
  const { url, authMode } = useConnectionStore();
  const api = useMemo(() => new AgentApi(url), [url]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [state, setState] = useState<AgentAvailability>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStatus(null);
    if (!url || authMode !== 'gateway') { setState('no-gateway'); return; }
    const controller = new AbortController();
    setState('loading');
    api.status(controller.signal)
      .then(value => { if (controller.signal.aborted) return; setStatus(value); setState(value.providerReady ? 'ready' : 'no-provider'); })
      .catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [api, url, authMode, attempt]);
  return { api, status, state, ready: state === 'ready', retry: () => setAttempt(n => n + 1) };
}
