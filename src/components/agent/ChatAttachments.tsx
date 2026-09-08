import { AlertCircle, FileAudio, FileVideo, Loader2, RotateCw, X } from 'lucide-react';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
import type { AgentAttachment } from '@/infrastructure/api/AgentApi';
import { formatBytes } from './attachments';
import { useAgentText } from './useAgentText';
import type { LocalAttachment } from './useAttachments';

const iconFor = (kind: AgentAttachment['kind']) => kind === 'video' ? <FileVideo size={20} strokeWidth={1.6} /> : <FileAudio size={20} strokeWidth={1.6} />;

/** Pending uploads shown above the composer. Images preview from the local file; other media show a labelled tile. */
export function PendingAttachments({ items, onRemove, onRetry }: { items: LocalAttachment[]; onRemove: (id: string) => void; onRetry: (id: string) => void }) {
  const at = useAgentText();
  if (!items.length) return null;
  return <ul aria-label={at('待发送附件')} className="flex gap-2 overflow-x-auto scrollbar-hide px-1 pt-1 -mx-1">
    {items.map(item => <li key={item.id} data-attachment-status={item.status} className={`relative shrink-0 rounded-[12px] border overflow-hidden ${item.status === 'error' ? 'border-[#f25555]/60' : 'border-white/[0.1]'} ${item.kind === 'image' ? 'w-[68px] h-[68px]' : 'h-[68px] w-[150px]'}`} style={{ background: '#15181e' }}>
      {item.kind === 'image' && item.previewUrl
        ? <img src={item.previewUrl} alt={item.file.name} className="w-full h-full object-cover" />
        : <div className="h-full flex items-center gap-2 px-2.5 text-[#c8ccd4]">{iconFor(item.kind)}<div className="min-w-0"><p className="text-[11.5px] font-medium truncate">{item.file.name}</p><p className="font-mono text-[9.5px] text-[#66758a]">{formatBytes(item.file.size)}{item.uploaded?.width && item.uploaded.height ? ` · ${item.uploaded.width}×${item.uploaded.height}` : ''}</p></div></div>}
      {item.status === 'uploading' && <div className="absolute inset-0 flex items-center justify-center bg-black/45"><Loader2 size={18} className="animate-spin text-white" /></div>}
      {item.status === 'error' && <button type="button" onClick={() => onRetry(item.id)} aria-label={at('重试上传')} title={at(item.error ?? '上传失败')} className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 text-[#f87c7c] text-[10px] font-semibold"><AlertCircle size={16} /><span className="flex items-center gap-1"><RotateCw size={10} />{at('重试')}</span></button>}
      <button type="button" onClick={() => onRemove(item.id)} aria-label={at('移除附件')} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 border border-white/20 text-white flex items-center justify-center"><X size={11} strokeWidth={2.4} /></button>
    </li>)}
  </ul>;
}

/** Attachments already sent with a message, loaded from ComfyUI's input folder. */
export function SentAttachments({ attachments, baseUrl }: { attachments: AgentAttachment[]; baseUrl: string }) {
  const at = useAgentText();
  if (!attachments.length) return null;
  return <ul aria-label={at('消息附件')} className="flex flex-wrap gap-1.5 mb-2">
    {attachments.map((attachment, index) => {
      const source = `${baseUrl}/view?${new URLSearchParams({ filename: attachment.filename, subfolder: attachment.subfolder, type: attachment.type })}`;
      const label = attachment.name ?? attachment.filename;
      return <li key={`${attachment.subfolder}/${attachment.filename}`} className="w-[96px] h-[96px] rounded-[10px] border border-white/[0.1] overflow-hidden" style={{ background: '#15181e' }} title={label}>
        {attachment.kind === 'image'
          ? <AuthenticatedImage source={source} alt={at('附件 {{index}}', { index: index + 1 })} className="w-full h-full object-cover" />
          : <div className="h-full flex flex-col items-center justify-center gap-1.5 px-2 text-[#c8ccd4]">{iconFor(attachment.kind)}<span className="max-w-full text-[10.5px] truncate">{label}</span></div>}
      </li>;
    })}
  </ul>;
}
