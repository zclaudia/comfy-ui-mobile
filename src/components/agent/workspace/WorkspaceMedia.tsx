import { useEffect, useState } from 'react';
import { File, Image as ImageIcon, Loader2 } from 'lucide-react';
import type { Asset } from '../../../shared/types/agentWorkspace';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
import { useAuthenticatedMediaUrl } from '@/hooks/useAuthenticatedMediaUrl';
import { useAgentText } from '../useAgentText';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspaceAsset } from './useWorkspaceAsset';

const captureLabels: Record<Asset['captureState'], string> = { pending_capture: '参考素材正在准备', capturing: '参考素材正在准备', ready: '素材已保存', missing: '原素材不可用', capture_failed: '参考素材保存失败', remote_only: '仅支持服务器预览' };
/** A ready asset uses verified gateway bytes. Remote-only previews retain an explicit availability label. */
export function WorkspaceMedia({ assetId, compact = false }: { assetId: string; compact?: boolean }) {
  const { api, sessionId } = useWorkspace(); const at = useAgentText();
  const { asset, previewRef, error } = useWorkspaceAsset(assetId);
  const [failed, setFailed] = useState(false);
  const source = asset?.captureState === 'ready' ? api.assetUrl(sessionId, assetId)
    : previewRef ? `${api.baseUrl}/view?${new URLSearchParams({ filename: previewRef.filename, subfolder: previewRef.subfolder, type: previewRef.type })}` : null;
  const media = useAuthenticatedMediaUrl(asset?.kind === 'image' ? null : source);
  useEffect(() => setFailed(false), [source]);
  if (!asset) return <div role="status" className="flex items-center justify-center rounded-lg bg-white/5 p-4 text-xs text-slate-400">{error ? at(error) : <Loader2 size={16} className="animate-spin" />}</div>;
  const style = compact ? 'w-full h-20 object-cover rounded-lg bg-black/20' : 'w-full max-h-[480px] object-contain rounded-xl bg-black/25';
  return <figure className="min-w-0" data-workspace-asset={assetId}>
    {source && !failed && asset.kind === 'image' ? <AuthenticatedImage source={source} alt={asset.name} className={style} loading="lazy" onError={() => setFailed(true)} onAuthenticatedError={() => setFailed(true)} />
      : source && !failed && media.url && asset.kind === 'video' ? <video controls={!compact} muted={compact} playsInline preload="metadata" src={`${media.url}#t=0.1`} className={style} aria-label={asset.name} onError={() => setFailed(true)} />
      : source && !failed && media.url && asset.kind === 'audio' ? <audio controls preload="metadata" src={media.url} className="w-full" aria-label={asset.name} onError={() => setFailed(true)} />
      : <div className={`${compact ? 'h-20' : 'h-28'} flex items-center justify-center gap-2 rounded-lg bg-white/5 text-slate-500`}>{media.loading ? <Loader2 size={18} className="animate-spin" /> : asset.kind === 'image' ? <ImageIcon size={24} /> : <File size={24} />}</div>}
    {!compact && <figcaption className="mt-1 text-[11px] text-slate-400 flex flex-wrap gap-x-2">
      <span>{at(asset.kind === 'image' ? '图片 {{index}}' : asset.kind === 'video' ? '视频 {{index}}' : asset.kind === 'audio' ? '音频 {{index}}' : '文件 {{index}}', { index: asset.displayOrdinal })}</span>
      {asset.metadata.width && asset.metadata.height && <span>{asset.metadata.width} × {asset.metadata.height}</span>}
      {asset.captureState !== 'ready' && <span className="text-amber-300">{at(captureLabels[asset.captureState])}</span>}
      {asset.legacy?.unverified && <span className="text-amber-300">{at('旧素材：当前可读内容尚未证实与历史原文件一致')}</span>}
      {(failed || media.error) && <span className="text-amber-300">{at('媒体加载失败')}</span>}
    </figcaption>}
  </figure>;
}
