import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import { emptyWorkspaceState, mergeEntities, mergeWorkspaceSnapshot } from './state';
import type { WorkspaceEntities } from './state';

/** One in-flight cursor request per session. Refresh wakes polling without clearing history, references or local input. */
export function useWorkspaceSnapshot(api: WorkspaceApi, sessionId: string | undefined) {
  const [state, setState] = useState(emptyWorkspaceState);
  const latest = useRef(state); latest.current = state;
  const [error, setError] = useState('');
  const wake = useRef<() => void>(() => undefined);
  useEffect(() => {
    const blank = emptyWorkspaceState(); latest.current = blank; setState(blank); setError('');
    if (!sessionId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let inFlight = false; let requested = false;
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (inFlight) { requested = true; return; }
      clearTimeout(timer); inFlight = true; requested = false;
      let delay = 1500;
      try {
        const snapshot = await api.snapshot(sessionId, latest.current.cursor, controller.signal);
        if (controller.signal.aborted) return;
        const next = mergeWorkspaceSnapshot(latest.current, snapshot);
        latest.current = next; setState(next); setError('');
        if (next.cursor < next.highWater) delay = 0;
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '连接中断，正在重试'); delay = 4000; }
      finally { inFlight = false; if (!controller.signal.aborted) timer = setTimeout(poll, requested ? 0 : delay); }
    };
    wake.current = () => { void poll(); };
    void poll();
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearTimeout(timer); wake.current = () => undefined; document.removeEventListener('visibilitychange', onVisible); };
  }, [api, sessionId]);
  const merge = useCallback((entities: WorkspaceEntities, observedAt: number) => {
    const next = mergeEntities(latest.current, entities, observedAt); latest.current = next; setState(next);
  }, []);
  const refresh = useCallback(() => wake.current(), []);
  const getWatermark = useCallback(() => latest.current.highWater, []);
  return { ...state, error, refresh, merge, getWatermark, caughtUp: !!state.snapshot && state.cursor >= state.highWater };
}
