import { useEffect, useState } from 'react';
import type { AssetDetail } from '../../../shared/types/agentWorkspace';
import { useWorkspace } from './WorkspaceContext';

export function useWorkspaceAsset(assetId: string) {
  const { api, sessionId, view } = useWorkspace();
  const asset = view.assets[assetId];
  const [detail, setDetail] = useState<AssetDetail | null>(null); const [error, setError] = useState('');
  const { merge, getWatermark } = view;
  const needsDetail = !asset || asset.captureState !== 'ready';
  useEffect(() => {
    if (!needsDetail) return;
    const controller = new AbortController(); const watermark = getWatermark();
    setDetail(null); setError('');
    void api.asset(sessionId, assetId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setDetail(result); merge({ assets: [result.asset], ...(result.sourceRun ? { runs: [result.sourceRun] } : {}) }, watermark);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '素材加载失败'); });
    return () => controller.abort();
  }, [api, sessionId, assetId, needsDetail, getWatermark, merge]);
  const current = detail?.asset.id === assetId ? detail : null;
  return { asset: asset ?? current?.asset, previewRef: current?.previewRef, error };
}

