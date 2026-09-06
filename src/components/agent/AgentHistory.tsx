import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { X, RefreshCw, MessageSquare } from 'lucide-react';
import type { AgentApi, AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';

export function AgentHistory({ open, onOpenChange, api, enabled, sessions, selected, onSessions, onSelect }: {
  open: boolean; onOpenChange: (open: boolean) => void; api: AgentApi; enabled: boolean;
  sessions: AgentSession[]; selected: string; onSessions: (sessions: AgentSession[]) => void; onSelect: (id: string) => void;
}) {
  const at = useAgentText();
  const { i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSearch('');
  }, [open]);
  useEffect(() => {
    if (!open || !enabled) return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    api.sessions(controller.signal).then(list => { if (!controller.signal.aborted) onSessions(list.sessions); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, open, enabled, refresh, onSessions]);
  const filtered = sessions.filter(s => `${s.name} ${s.preview ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const title = (s: AgentSession) => ['新工作流', 'New workflow', '新しいワークフロー', '새 워크플로'].includes(s.name) ? (s.preview || at('新工作流')) : s.name;
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
    <Dialog.Content className="fixed z-[101] inset-x-3 top-[max(1rem,env(safe-area-inset-top))] bottom-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[440px] rounded-2xl border border-white/10 bg-[#0b1018] text-slate-200 flex flex-col p-4 shadow-2xl">
      <div className="flex items-center gap-2"><Dialog.Title className="font-semibold flex-1">{at('历史会话')}</Dialog.Title><button className="p-3" disabled={loading || !enabled} aria-label={at('刷新')} onClick={() => setRefresh(n => n+1)}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button><Dialog.Close className="p-3" aria-label={at('关闭')}><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="text-xs text-slate-400 mb-3">{at('选择历史会话，继续之前的对话。')}</Dialog.Description>
      <input value={search} onChange={e => setSearch(e.target.value)} aria-label={at('搜索会话')} placeholder={at('搜索会话')} className="rounded-lg border border-white/10 bg-slate-900 p-3 text-sm mb-3" />
      {error && <p role="alert" className="text-sm text-amber-300 mb-3">{at('加载历史会话失败')}</p>}
      <div className="min-h-0 overflow-y-auto flex-1 space-y-2">
        {!loading && !filtered.length && <p className="text-sm text-slate-400 py-6">{at(search ? '没有匹配的会话' : '暂无历史会话')}</p>}
        {filtered.map(s => <button key={s.id} data-agent-history-session={s.id} aria-current={s.id === selected ? 'true' : undefined} className={`w-full rounded-xl border p-3 text-left ${s.id === selected ? 'border-blue-500/50 bg-blue-500/10' : 'border-white/10 hover:bg-white/5'}`} onClick={() => { onSelect(s.id); onOpenChange(false); }}>
          <div className="flex items-start gap-2"><MessageSquare className="shrink-0 mt-1" size={16} /><span className="text-sm break-words line-clamp-2">{title(s)}</span></div>
          <p className="mt-2 text-xs text-slate-500">{new Date(s.created).toLocaleString(i18n.resolvedLanguage || 'en')} · v{s.version}</p>
        </button>)}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
