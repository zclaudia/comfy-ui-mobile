import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Film, Image as ImageIcon, Menu, Network, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import AppSideMenu from '@/components/controls/AppSideMenu';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { loadAllWorkflows, updateWorkflowAgentBinding } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentGuide } from './AgentGuide';
import { SessionRow } from './SessionRow';
import { NEW_CHAT_PRESETS, resolveBoundWorkflow, sessionTitle } from './binding';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';

const POLL_MS = 5000;

export default function SessionListPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { api, state, ready, retry } = useAgentStatus();
  const serverUrl = useConnectionStore(s => s.url);
  const setActive = useAgentActivityStore(s => s.setActive);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, local] = await Promise.all([api.sessions(signal), loadAllWorkflows().catch(() => [] as Workflow[])]);
      if (signal?.aborted) return;
      setSessions(list.sessions); setWorkflows(local); setError('');
      setActive(list.sessions.some(s => s.active));
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : '加载会话失败'); }
    finally { if (!signal?.aborted) setLoaded(true); }
  }, [api, setActive]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(controller.signal); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [ready, load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sessions;
    return sessions.filter(s => `${sessionTitle(s, '')} ${s.lastMessage ?? ''} ${s.preview ?? ''}`.toLocaleLowerCase().includes(query));
  }, [sessions, search]);
  const serverHost = (serverUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  async function remove(session: AgentSession) {
    try {
      await api.remove(session.id);
      const bound = resolveBoundWorkflow(session.workflow, workflows);
      if (bound?.agent?.sessionId === session.id) await updateWorkflowAgentBinding(bound.id, undefined);
      setSessions(previous => previous.filter(s => s.id !== session.id));
      toast.success(at('会话已删除'));
    } catch (e) { toast.error(at(e instanceof Error ? e.message : '删除失败')); }
  }

  const chips = [
    { icon: <ImageIcon size={14} strokeWidth={1.8} />, label: at('生成一张图片'), to: `/chat/new?draft=${encodeURIComponent(at(NEW_CHAT_PRESETS.image))}` },
    { icon: <Film size={14} strokeWidth={1.8} />, label: at('生成一段短视频'), to: `/chat/new?draft=${encodeURIComponent(at(NEW_CHAT_PRESETS.video))}` },
    { icon: <Network size={14} strokeWidth={1.8} />, label: at('从我的工作流开始'), to: '/chat/new?pick=1' },
  ];

  return <div className="h-full flex flex-col text-[#e9ebef] overflow-hidden" style={{ background: '#0b0c0f' }}>
    <header className="flex-none z-40 border-b border-white/[0.08] pwa-header" style={{ background: '#0b0c0f' }}>
      <div className="max-w-[1600px] mx-auto h-[52px] px-4 flex items-center gap-2.5">
        <button onClick={() => setMenuOpen(true)} className="shrink-0 -ml-1 p-1.5 text-[#c8ccd4] hover:text-white transition-colors" aria-label={at('菜单')}><Menu className="w-5 h-5" strokeWidth={1.7} /></button>
        <div className="w-[26px] h-[26px] shrink-0 rounded-[7px] bg-[#3069f0] flex items-center justify-center"><Bot size={16} strokeWidth={2} className="text-white" /></div>
        <span className="shrink-0 text-[13.5px] font-semibold">{at('对话')}</span>
        {serverHost && <span className="min-w-0 shrink font-mono text-[11px] text-[#565d6b] px-1.5 py-[3px] border border-white/10 rounded-[5px] max-w-[164px] truncate">{serverHost}</span>}
        <div className="flex-1" />
        {ready && <button data-agent-new onClick={() => navigate('/chat/new')} className="shrink-0 h-9 px-3.5 flex items-center gap-1.5 rounded-[9px] bg-[#3069f0] hover:bg-[#3f78f5] text-white text-[12.5px] font-semibold transition-colors"><Plus className="w-[13px] h-[13px]" strokeWidth={2.4} />{at('新对话')}</button>}
      </div>
    </header>
    {state !== 'ready' ? <AgentGuide state={state} onRetry={retry} /> : <>
      <div className="flex-none border-b border-white/[0.08] px-4 py-2.5">
        <div className="flex items-center h-9 pl-3 pr-2 rounded-[9px] border border-white/[0.08] focus-within:border-[#3069f0]/50 transition-colors" style={{ background: 'rgba(255,255,255,0.045)' }}>
          <Search className="w-3.5 h-3.5 text-[#71798a] shrink-0" strokeWidth={1.8} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={at('搜索会话')} aria-label={at('搜索会话')} className="flex-1 h-9 min-w-0 bg-transparent border-none outline-none px-2 text-[12.5px] text-[#e9ebef] placeholder:text-[#71798a]" />
          {search ? <button onClick={() => setSearch('')} className="shrink-0 text-[#565d6b]" aria-label={at('清除')}><X className="w-3.5 h-3.5" /></button>
            : <span className="shrink-0 font-mono text-[10px] text-[#565d6b] border border-white/10 rounded-[4px] px-1.5 py-0.5">{sessions.length}</span>}
        </div>
      </div>
      <div className="flex-none px-4 pt-3 pb-2 flex items-center gap-2.5">
        <span className="font-mono text-[10px] font-semibold text-[#565d6b] tracking-[0.14em]">SESSIONS · {filtered.length}</span>
        <div className="flex-1 h-px bg-white/[0.06]" />
      </div>
      <main className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
        {error && <div role="alert" className="rounded-[10px] border border-[#f0a35b]/30 bg-[#f0a35b]/10 px-3 py-2.5 text-[12px] text-[#f0a35b] flex items-center gap-3"><span className="flex-1">{at(error)}</span><button className="font-semibold" onClick={() => void load()}>{at('重试')}</button></div>}
        {loaded && !sessions.length && !error && <div className="py-16 flex flex-col items-center text-center gap-3">
          <Bot size={34} strokeWidth={1.4} className="text-[#5b8af5]" />
          <p className="text-[14px] font-semibold text-[#c8ccd4]">{at('你想创作什么？')}</p>
          <p className="text-[12px] text-[#66758a] max-w-xs">{at('直接描述目标。助手会根据已安装的模型选择合适的工作流，生成预览并写入你的工作流库。')}</p>
          <div className="flex flex-wrap justify-center gap-2 mt-2">{chips.map(chip => <button key={chip.to} onClick={() => navigate(chip.to)} className="h-[34px] px-3 rounded-[9px] border border-white/[0.08] bg-white/[0.035] text-[12px] font-medium text-[#c8ccd4] flex items-center gap-1.5">{chip.icon}{chip.label}</button>)}</div>
        </div>}
        {loaded && sessions.length > 0 && !filtered.length && <p className="py-10 text-center text-[12px] text-[#66758a]">{at('没有匹配的会话')}</p>}
        {filtered.map(session => {
          const bound = resolveBoundWorkflow(session.workflow, workflows);
          return <SessionRow key={session.id} session={session} baseUrl={api.baseUrl} thumbnail={bound?.thumbnail} onOpen={() => navigate(`/chat/${session.id}`)} onLongPress={() => setPendingDelete(session)} />;
        })}
      </main>
    </>}
    <AppSideMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    <SimpleConfirmDialog isOpen={!!pendingDelete} onClose={() => setPendingDelete(null)} onConfirm={() => { const target = pendingDelete; setPendingDelete(null); if (target) void remove(target); }} title={at('删除会话')} message={at('只删除对话记录和版本历史，工作流库里的工作流会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </div>;
}
