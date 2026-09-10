import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import type { Page, WorkspaceSession } from '../../../shared/types/agentWorkspace';

/** Refresh the entire visible prefix, so archived rows disappear without losing older loaded pages. */
export function useWorkspaceSessions(api: WorkspaceApi, archived: boolean, search: string) {
  const [page, setPage] = useState<Page<WorkspaceSession>>({ items: [] });
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const visiblePages = useRef(1); const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async (more = false, reset = false) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    if (reset) { visiblePages.current = 1; setPage({ items: [] }); }
    const wanted = visiblePages.current + (more ? 1 : 0);
    setLoading(true);
    try {
      const items: WorkspaceSession[] = []; let before: number | undefined; let loaded = 0;
      do {
        const result = await api.sessions({ before, limit: 30, archived, search }, request.signal);
        if (request.signal.aborted) return;
        items.push(...result.items); before = result.nextCursor; loaded++;
      } while (before !== undefined && loaded < wanted);
      visiblePages.current = loaded;
      setPage({ items: [...new Map(items.map(item => [item.id, item])).values()], nextCursor: before }); setError('');
    } catch (error) { if (!request.signal.aborted) setError(error instanceof Error ? error.message : '加载会话失败'); }
    finally { if (!request.signal.aborted) { setLoading(false); controller.current = null; } }
  }, [api, archived, search]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async (first = false) => {
      if (first || (document.visibilityState === 'visible' && !controller.current)) await refresh(false, first);
      if (!stopped) timer = setTimeout(() => void tick(), 5000);
    };
    void tick(true);
    const visible = () => { if (document.visibilityState === 'visible' && !controller.current) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); controller.current?.abort(); controller.current = null; document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return { ...page, loading, error, refresh: () => void refresh(), loadMore: () => void refresh(true) };
}
