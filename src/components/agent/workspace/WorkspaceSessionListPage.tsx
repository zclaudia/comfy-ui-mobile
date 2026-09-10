import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ArchiveRestore, Bot, Loader2, Menu, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import AppSideMenu from '@/components/controls/AppSideMenu';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
import { useAuthenticatedMediaUrl } from '@/hooks/useAuthenticatedMediaUrl';
import type { AgentStatus } from '../../../infrastructure/api/AgentApi';
import { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import type { WorkspaceSession } from '../../../shared/types/agentWorkspace';
import { useAgentText } from '../useAgentText';
import { relativeTime } from '../SessionRow';
import { sessionTitle } from '../binding';
import { accentChip, chipButton } from '../chatStyles';
import { NoticeCard } from '../ChatCards';
import { useWorkspaceSessions } from './useWorkspaceSessions';
import { WorkspaceCleanupSheet } from './WorkspaceCleanupSheet';

function SessionThumbnail({ api, session }: { api: WorkspaceApi; session: WorkspaceSession }) {
  const [kind, setKind] = useState('');
  const id = session.deletedAt ? undefined : session.thumbnailAssetId;
  useEffect(() => {
    setKind(''); if (!id) return;
    const controller = new AbortController();
    void api.asset(session.id, id, controller.signal).then(({ asset }) => { if (!controller.signal.aborted && asset.captureState === 'ready') setKind(asset.kind); }).catch(() => undefined);
    return () => controller.abort();
  }, [api, session.id, id]);
  const source = id && kind ? api.assetUrl(session.id, id) : null;
  const media = useAuthenticatedMediaUrl(kind === 'video' ? source : null);
  return <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden bg-black/25 flex items-center justify-center">
    {kind === 'image' && source ? <AuthenticatedImage source={source} alt="" className="w-full h-full object-cover" /> : kind === 'video' && media.url ? <video muted playsInline preload="metadata" src={`${media.url}#t=0.1`} className="w-full h-full object-cover" aria-hidden /> : <Bot size={22} className="text-slate-600" />}
  </div>;
}

export function WorkspaceSessionListPage({ baseUrl, status }: { baseUrl: string; status: AgentStatus }) {
  const api = useMemo(() => new WorkspaceApi(baseUrl, status.serverId), [baseUrl, status.serverId]); const at = useAgentText(); const navigate = useNavigate();
  const [menu, setMenu] = useState(false); const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const [cleanup, setCleanup] = useState<WorkspaceSession>();
  const [archived, setArchived] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const page = useWorkspaceSessions(api, archived, query);
  async function toggleArchive(session: WorkspaceSession) {
    if (busy) return; setBusy(session.id);
    try { await api.update(session.id, { archivedAt: archived ? null : Date.now() }); page.refresh(); }
    catch (error) { toast.error(at(error instanceof Error ? error.message : '操作失败')); }
    finally { setBusy(null); }
  }
  return <main className="h-full flex flex-col overflow-hidden bg-[#0b0c0f] text-[#e9ebef]" data-workspace-sessions>
    <header className="pwa-header shrink-0 border-b border-white/10"><div className="h-[52px] px-4 flex items-center gap-3">
      <button aria-label={at('菜单')} onClick={() => setMenu(true)}><Menu size={20} /></button><Bot size={20} className="text-blue-400" /><span className="text-sm font-semibold flex-1">{at('对话')}</span>
      <button aria-label={at('助手模型')} className={chipButton} onClick={() => navigate('/settings/agent')}><Settings2 size={16} /></button>
      <button className={accentChip} data-agent-new onClick={() => navigate('/chat/new')}><Plus size={14} />{at('新对话')}</button>
    </div></header>
    <div className="shrink-0 p-4 space-y-3">
      <label className="flex gap-2 items-center px-3 rounded-lg border border-white/10 bg-white/5"><Search size={14} className="text-slate-500" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={at('搜索会话')} aria-label={at('搜索会话')} className="h-10 flex-1 min-w-0 text-sm outline-none bg-transparent" /></label>
      <div className="flex gap-2">{[false, true].map(value => <button key={String(value)} className={archived === value ? accentChip : chipButton} aria-pressed={archived === value} onClick={() => setArchived(value)}>{at(value ? '已归档' : '进行中的会话')}</button>)}</div>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2" aria-busy={page.loading}>
      {!status.providerReady && <NoticeCard text="Gateway 已连接，添加语言模型后即可开始对话。" action="添加模型" onAction={() => navigate('/settings/agent')} />}
      {page.error && <NoticeCard text={page.error} action="重试" onAction={page.refresh} />}
      {!page.loading && !page.error && !page.items.length && <p className="py-12 text-center text-sm text-slate-400">{at(query ? '没有匹配的会话' : archived ? '没有已归档的会话' : '你想创作什么？')}</p>}
      {page.items.map(session => <article key={session.id} className="rounded-xl border border-white/10 bg-[#101217] flex items-center p-2 gap-2" data-agent-session={session.id}>
        <button className="flex-1 min-w-0 flex items-center gap-3 text-left p-1" onClick={() => session.deletedAt ? setCleanup(session) : navigate(`/chat/${session.id}`)}>
          <SessionThumbnail api={api} session={session} /><div className="flex-1 min-w-0 space-y-1"><p className="text-sm font-semibold truncate">{sessionTitle(session, at('新对话'))}</p><p className="text-xs text-slate-400 truncate">{session.deletedAt ? at('媒体清理待完成') : session.lastMessage || session.preview || at('还没有消息')}</p><p className="text-[10px] text-slate-500">{relativeTime(session.lastActivity ?? session.created, Date.now(), at)}</p></div>
          {session.active && <Loader2 size={16} className="text-blue-400 animate-spin shrink-0" aria-label={at('正在处理')} />}
        </button>
        <button disabled={!!busy || !!session.active || !!session.deletedAt} className={`${chipButton} shrink-0`} aria-label={at(archived ? '恢复会话' : '归档会话')} onClick={() => void toggleArchive(session)}>{busy === session.id ? <Loader2 size={14} className="animate-spin" /> : archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
        {archived && <button className={`${chipButton} shrink-0 text-red-300`} aria-label={at('永久清理会话')} disabled={!!busy} onClick={() => setCleanup(session)}><Trash2 size={14} /></button>}
      </article>)}
      {page.loading && !page.items.length && <p role="status" className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin" /></p>}
      {page.nextCursor !== undefined && <button className={`${chipButton} w-full justify-center`} disabled={page.loading} onClick={page.loadMore}>{at(page.loading ? '正在加载' : '加载更多')}</button>}
    </div>
    {cleanup && <WorkspaceCleanupSheet key={`${status.serverId}:${cleanup.id}`} api={api} session={page.items.find(item => item.id === cleanup.id) ?? cleanup} onClose={() => setCleanup(undefined)} onChanged={page.refresh} />}
    <AppSideMenu isOpen={menu} onClose={() => setMenu(false)} />
  </main>;
}
