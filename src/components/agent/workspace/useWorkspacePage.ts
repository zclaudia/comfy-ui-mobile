import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../../../shared/types/agentWorkspace';

/** Stable cursor paging for sheets; a closed/replaced sheet cannot be filled by a late network response. */
export function useWorkspacePage<T extends { id?: string; revision?: number }>(enabled: boolean, load: (before: number | undefined, signal: AbortSignal) => Promise<Page<T>>) {
  const [page, setPage] = useState<Page<T>>({ items: [] });
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const fetchPage = useCallback(async (before?: number) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await load(before, controller.signal);
      if (controller.signal.aborted) return;
      setPage(previous => {
        const items = before === undefined ? result.items : [...previous.items, ...result.items];
        const seen = new Set<string | number | undefined>();
        return { ...result, items: items.filter(item => { const key = item.id ?? item.revision; if (seen.has(key)) return false; seen.add(key); return true; }) };
      });
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '加载失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [load]);
  useEffect(() => {
    setPage({ items: [] }); setError('');
    if (enabled) void fetchPage();
    return () => { request.current?.abort(); };
  }, [enabled, fetchPage]);
  return { ...page, loading, error, retry: () => void fetchPage(), loadMore: () => { if (!loading && page.nextCursor !== undefined) void fetchPage(page.nextCursor); } };
}
