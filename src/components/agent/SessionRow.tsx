import { Bot, ChevronRight, Film, Loader2, Music, Network } from 'lucide-react';
import { useLongPress } from '@/hooks/useLongPress';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
import { useAuthenticatedMediaUrl } from '@/hooks/useAuthenticatedMediaUrl';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';
import { sessionTitle, thumbnailKind } from './binding';

// eslint-disable-next-line react-refresh/only-export-components -- pure helper shared with tests, no component state involved
export function relativeTime(timestamp: number, now: number, at: (text: string, values?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return at('刚刚');
  if (minutes < 60) return at('{{count}} 分钟前', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return at('{{count}} 小时前', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return at('{{count}} 天前', { count: days });
  return new Date(timestamp).toLocaleDateString();
}

/** Video covers show their first frame; the browser only fetches metadata plus that frame. Audio has nothing to show, so it gets an icon. */
function VideoCover({ source }: { source: string }) {
  const media = useAuthenticatedMediaUrl(source);
  return <div className="relative w-full h-full">
    {media.url && <video muted playsInline preload="metadata" src={`${media.url}#t=0.1`} className="w-full h-full object-cover pointer-events-none" aria-hidden />}
    <Film size={12} strokeWidth={2} className="absolute bottom-1 right-1 text-white/85 drop-shadow" />
  </div>;
}

export function SessionRow({ session, baseUrl, thumbnail, onOpen, onLongPress }: { session: AgentSession; baseUrl: string; thumbnail?: string; onOpen: () => void; onLongPress: () => void }) {
  const at = useAgentText();
  const press = useLongPress(onLongPress, onOpen, { threshold: 500 });
  const kind = session.thumbnail ? thumbnailKind(session.thumbnail) : undefined;
  const media = session.thumbnail ? `${baseUrl}/view?${new URLSearchParams({ filename: session.thumbnail.filename, subfolder: session.thumbnail.subfolder, type: session.thumbnail.type })}` : undefined;
  // A bound workflow's own thumbnail (always an image) wins; otherwise the latest generated media by kind.
  const image = thumbnail ?? (kind === 'image' ? media : undefined);
  const video = !thumbnail && kind === 'video' ? media : undefined;
  const audio = !thumbnail && kind === 'audio';
  const failed = !session.active && session.lastState === 'failed';
  return <div role="button" tabIndex={0} data-agent-session={session.id} {...press} style={{ ...press.style, background: '#101217' }} className="w-full flex items-center gap-3 p-[10px_11px] rounded-[10px] border border-white/[0.07] active:border-white/[0.14] transition-colors text-left cursor-pointer" onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
    <div className="w-14 h-14 shrink-0 rounded-lg border border-white/[0.06] overflow-hidden flex items-center justify-center" style={{ background: '#0c0e12' }}>
      {image ? <AuthenticatedImage source={image} alt="" className="w-full h-full object-cover" />
        : video ? <VideoCover source={video} />
        : audio ? <Music size={22} strokeWidth={1.6} className="text-white/25" />
        : session.sourceRef ? <Network size={22} strokeWidth={1.6} className="text-white/15" /> : <Bot size={22} strokeWidth={1.6} className="text-white/15" />}
    </div>
    <div className="flex-1 min-w-0 flex flex-col gap-1">
      <div className="text-[13px] font-semibold text-[#e9ebef] truncate">{sessionTitle(session, at('新对话'))}</div>
      <div className="text-[11.5px] text-[#8a919e] truncate">{session.lastMessage || session.preview || at('还没有消息')}</div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#565d6b]">
        <span>{relativeTime(session.lastActivity ?? session.created, Date.now(), at)}</span>
        {session.version > 0 && <><span className="text-[#31363f]">·</span><span className="text-[#5b8af5]">V{session.version}</span></>}
      </div>
    </div>
    {session.active
      ? <span className="shrink-0 h-6 px-2 rounded-md border border-[#3069f0]/30 bg-[#3069f0]/12 text-[10.5px] font-semibold text-[#5b8af5] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />{at('生成中')}</span>
      : failed ? <span aria-label={at('上轮出错')} className="shrink-0 w-2 h-2 rounded-full bg-[#f0a35b] mr-1.5" />
      : <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-[#4a5261] mr-1" />}
  </div>;
}
