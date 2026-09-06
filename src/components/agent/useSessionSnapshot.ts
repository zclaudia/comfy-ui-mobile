import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentApi, AgentEvent, AgentSnapshot } from '@/infrastructure/api/AgentApi';

/** Cursor-based polling: dedupes by seq, drains pagination immediately, backs off on errors. Never cancels the task. */
export function useSessionSnapshot(api: AgentApi, sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setSnapshot(null); setEvents([]); setError(''); cursor.current = 0;
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1500;
      try {
        const value = await api.snapshot(sessionId!, cursor.current, controller.signal);
        if (controller.signal.aborted) return;
        cursor.current = value.cursor;
        setSnapshot(value); setError('');
        setEvents(previous => {
          const seen = new Set(previous.map(e => e.seq));
          const incoming = value.events.filter(e => !seen.has(e.seq));
          return incoming.length ? [...previous, ...incoming] : previous;
        });
        if (value.hasMore) delay = 0;
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '连接中断，正在重试');
        delay = 4000;
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, sessionId, refreshKey]);

  const caughtUp = !!snapshot && !snapshot.hasMore && (events.at(-1)?.seq ?? 0) >= snapshot.cursor;
  const refresh = useCallback(() => setRefreshKey(n => n + 1), []);
  return { snapshot, events, error, caughtUp, setSnapshot, refresh };
}
