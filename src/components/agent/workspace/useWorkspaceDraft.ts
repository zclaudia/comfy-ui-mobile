import { useEffect, useState } from 'react';
import { useWorkspace } from './WorkspaceContext';

export function useWorkspaceDraft(draftId: string) {
  const { api, sessionId, view } = useWorkspace(); const { merge, getWatermark } = view;
  const draft = view.drafts[draftId]; const missing = !draft; const [error, setError] = useState('');
  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController(); const watermark = getWatermark(); setError('');
    void api.draft(sessionId, draftId, controller.signal).then(result => { if (!controller.signal.aborted) merge({ drafts: [result.draft] }, watermark); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '加载失败'); });
    return () => controller.abort();
  }, [api, sessionId, draftId, missing, merge, getWatermark]);
  return { draft, error };
}
