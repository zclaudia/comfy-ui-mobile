import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentApi, type AgentStatus } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';

export type AgentAvailability = 'loading' | 'no-gateway' | 'no-provider' | 'outdated' | 'error' | 'ready';

/** Resolves whether the chat feature can be used with the current connection. Re-runs when the connection changes. */
export function useAgentStatus() {
  const url = useConnectionStore(s => s.url);
  const authMode = useConnectionStore(s => s.authMode);
  const api = useMemo(() => new AgentApi(url), [url]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [state, setState] = useState<AgentAvailability>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStatus(null);
    if (!url || authMode !== 'gateway') { setState('no-gateway'); return; }
    const controller = new AbortController();
    setState('loading');
    // A gateway that accepts the connection but never answers would otherwise leave the app stuck on 'loading'.
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 4000);
    api.status(controller.signal)
      .then(value => {
        clearTimeout(timeout);
        if (controller.signal.aborted) return;
        // The app speaks schema 2 only. An older Gateway is a server-side upgrade, not a connection fault.
        if (value.agentSchemaVersion !== 2) { setStatus(null); setState('outdated'); return; }
        setStatus(value); setState(value.providerReady ? 'ready' : 'no-provider');
      })
      .catch(() => { clearTimeout(timeout); if (timedOut || !controller.signal.aborted) setState('error'); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [api, url, authMode, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { api, status, state, ready: state === 'ready', retry };
}
