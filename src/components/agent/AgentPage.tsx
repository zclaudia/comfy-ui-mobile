import { useAgentText } from './useAgentText';
import { AgentHistory } from './AgentHistory';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Bot, History, Send, Plus, Square, Loader2, RotateCcw, Network } from 'lucide-react';
import { toast } from 'sonner';
import { AgentApi } from '@/infrastructure/api/AgentApi';
import type { AgentEvent, AgentSession, AgentSnapshot, AgentStatus } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';
import { loadAllWorkflows, addWorkflow } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentMedia } from './AgentMedia';
import { AgentTranscript } from './transcript/AgentTranscript';
import type { AgentMediaOutput } from './AgentMedia';

const active = new Set(['queued', 'running', 'waiting_comfy', 'reconciling']);
const states: Record<string, string> = { queued: '等待助手处理', running: '正在分析和操作工作流', waiting_comfy: 'ComfyUI 正在生成', reconciling: '正在核对提交状态', completed: '本轮完成', failed: '任务未完成', cancelled: '已停止' };
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';

export default function AgentPage() {
  const at = useAgentText();
  const [historyOpen, setHistoryOpen] = useState(false);
  const { url, authMode } = useConnectionStore();
  const api = useMemo(() => new AgentApi(url), [url]);
  const navigate = useNavigate();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selected, setSelected] = useState('');
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [importId, setImportId] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [retry, setRetry] = useState(0);
  const request = useRef<{ session: string; text: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setSessions([]); setSelected(''); setSnapshot(null); setEvents([]); setError('');
    if (!url || authMode !== 'gateway') { setConnecting(false); return; }
    setConnecting(true);
    void Promise.all([api.status(controller.signal), api.sessions(controller.signal), loadAllWorkflows().catch(() => [])]).then(([state, list, local]) => {
      if (controller.signal.aborted) return;
      setStatus(state); setSessions(list.sessions); setWorkflows(local);
      setSelected(list.sessions[0]?.id ?? '');
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setConnecting(false); });
    return () => controller.abort();
  }, [api, url, authMode, retry]);

  useEffect(() => {
    setSnapshot(null); setEvents([]); followLatest.current = true; setShowLatest(false);
    if (!selected) return;
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1500;
      try {
        const value = await api.snapshot(selected, cursor, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(value); setError(''); cursor = value.cursor;
        setEvents(previous => {
          const ids = new Set(previous.map(e => e.seq));
          const incoming = value.events.filter(e => !ids.has(e.seq));
          return incoming.length ? [...previous, ...incoming] : previous;
        });
        setSessions(previous => previous.map(s => s.id === selected ? { ...s, ...value.session } : s));
        if (value.hasMore) delay = 0;
      } catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : '连接中断，正在重试'); delay = 4000; } }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, selected]);

  useEffect(() => { if (followLatest.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); else setShowLatest(true); }, [events.length]);
  const task = snapshot?.tasks.find(t => active.has(t.state));
  const currentVersion = snapshot?.session.version ?? 0;
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(at(e instanceof Error ? e.message : '操作失败')); }
    finally { setBusy(false); }
  }
  async function create() {
    const workflow = workflows.find(w => w.id === importId);
    const { session } = await api.create(workflow ? `${workflow.name} · ${at('助手副本')}` : at('新工作流'), workflow?.workflow_json);
    setSessions(previous => [session, ...previous]); setSelected(session.id); setImportId(''); setDraft('');
  }
  async function send() {
    const text = draft.trim(); if (!text || !selected) return;
    if (!request.current || request.current.text !== text || request.current.session !== selected) request.current = { session: selected, text, id: crypto.randomUUID() };
    await api.message(selected, text, request.current.id);
    setDraft(''); request.current = null;
    const value = await api.snapshot(selected);
    setSnapshot(value);
  }
  async function openVersion(version: number) {
    const value = await api.version(selected, version);
    const id = crypto.randomUUID();
    await addWorkflow({ id, name: `${snapshot?.session.name || 'Agent'} · v${version}`, workflow_json: value.canvas, nodeCount: value.canvas.nodes.length, createdAt: new Date(), modifiedAt: new Date(), isValid: true });
    navigate(`/workflow/${id}`);
  }
  const versionActions = (version: number) => <div className="flex flex-wrap gap-2 mt-3">
    <button className={button} disabled={busy} onClick={() => void action(() => openVersion(version))}><Network size={14} />{at('在画布打开副本')}</button>
    <button className={button} disabled={busy || !!task || currentVersion === version} onClick={() => void action(async () => { await api.restore(selected, version, currentVersion); toast.success(at('已恢复为新版本')); })}><RotateCcw size={14} />{at('恢复')}</button>
  </div>;

  return <main className="h-dvh overflow-hidden bg-[#0b1018] text-slate-200 flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
    <header className="shrink-0 z-10 bg-[#0b1018]/95 border-b border-white/10 px-4 py-3 flex items-center gap-3">
      <Link to="/" className={button} aria-label={at('返回工作流')}><ArrowLeft size={18} /></Link>
      <Bot className="text-blue-400" size={22} /><div className="flex-1 min-w-0"><h1 className="font-semibold">{at('工作流助手')}</h1><p className="text-xs text-slate-500">{at('描述目标，一起生成和调整')}</p></div>
      <button className={button} aria-label={at('历史会话')} title={at('历史会话')} onClick={() => setHistoryOpen(true)} data-agent-history><History size={18} /><span>{at('历史')}</span></button>
      {connecting && <Loader2 className="animate-spin" size={18} />}
    </header>
    <div onScroll={e => { const el = e.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (followLatest.current) setShowLatest(false); }} className="w-full max-w-4xl mx-auto flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5 space-y-4">
      {(!url || authMode !== 'gateway') && <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">{at('请先连接 Gateway，再使用工作流助手。')}<Link className="block text-blue-400 mt-2" to="/settings/server">{at('打开连接设置')}</Link></div>}
      {error && <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm text-amber-200">{at(error)}<button className={`${button} ml-3`} onClick={() => setRetry(r => r + 1)}>{at('重新连接')}</button></div>}
      {status && !status.providerReady && <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 text-sm"><strong>{at('助手尚未连接语言模型')}</strong><p className="mt-1 text-slate-400">{at('可以创建会话、导入工作流和查看已保存版本。管理员配置模型后，即可开始对话。')}</p><button className={`${button} mt-3`} onClick={() => setRetry(r => r + 1)}>{at('检查连接')}</button></div>}
      {status && <section aria-label={at('会话管理')} className="rounded-xl border border-white/10 p-3 space-y-3">
        <div className="flex gap-2"><select disabled={busy} aria-label={at('选择会话')} className="min-w-0 flex-1 rounded-lg bg-slate-900 p-2 text-sm" value={selected} onChange={e => { setSelected(e.target.value); setDraft(''); }}><option value="">{at('选择会话')}</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name} · v{s.version}</option>)}</select><button className={button} disabled={busy} onClick={() => void action(create)}><Plus size={16} />{at('新建')}</button></div>
        <label className="block text-xs text-slate-400">{at('新会话的起点')}<select aria-label={at('导入工作流')} className="block mt-1 w-full bg-slate-900 p-2 rounded-lg text-sm" value={importId} onChange={e => setImportId(e.target.value)}><option value="">{at('从空白开始')}</option>{workflows.map(w => <option key={w.id} value={w.id}>{w.name}（{at('导入副本')}）</option>)}</select></label>
      </section>}
      {selected && !events.length && <div className="py-12 text-center text-slate-400"><Bot className="mx-auto mb-3 text-blue-400" size={34} /><p>{at('你想创作什么？')}</p><p className="text-sm mt-2">{at('例如：用 Z-Image 生成一张图片，或用 H3 生成一段短视频。')}</p><p className="text-xs mt-3 text-slate-500">{at('支持 Z-Image 图片、MiniMax H3 视频及已适配节点工作流。')}</p></div>}
      <AgentTranscript events={events} tasks={snapshot?.tasks ?? []} caughtUp={!!snapshot && !snapshot.hasMore && (events.at(-1)?.seq ?? 0) >= snapshot.cursor} renderContent={event => {
          const data = event.data;
          if (event.kind === 'workflow') return <article key={event.seq} className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4"><h2 className="font-medium text-sm">{at('工作流 v{{version}}', { version: data.version })}</h2><p className="text-sm text-slate-400 mt-1">{at(data.summary)}</p>{data.operations && <details className="text-xs mt-2"><summary className="cursor-pointer text-violet-300">{at('查看改动')}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(data.operations, null, 2)}</pre></details>}{versionActions(data.version)}</article>;
          if (event.kind === 'result') return <article key={event.seq} className="rounded-xl border border-emerald-500/25 p-4"><h2 className="font-medium text-sm mb-3">{at('生成结果 · v{{version}}', { version: data.version })}</h2><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{(data.outputs ?? []).map((output: AgentMediaOutput, index: number) => <AgentMedia key={index} baseUrl={api.baseUrl} output={output} index={index} />)}</div>{!data.outputs?.length && <p className="text-sm text-slate-400">{at('执行完成，但没有返回可预览媒体。')}</p>}{versionActions(data.version)}</article>;
          if (event.kind === 'execution_error') return <article key={event.seq} className="rounded-xl border border-red-500/25 p-4"><h2 className="text-sm text-red-300">{at('这次生成未成功')}</h2><details className="text-xs mt-2"><summary>{at('查看诊断')}</summary><pre className="whitespace-pre-wrap break-all mt-2">{data.diagnostic || JSON.stringify(data)}</pre></details></article>;
          if (event.kind === 'state' && data.state === 'failed') return <div role="alert" key={event.seq} className="text-sm text-amber-300 p-3 border border-amber-500/20 rounded-lg">{at(data.error)}</div>;
          if (event.kind === 'saved') return <p key={event.seq} className="text-xs text-emerald-400">✓ {at('版本 {{version}} 已保存', { version: data.version })}</p>;
          return null;
        }} />
      {!!snapshot?.versions.length && <details className="border-t border-white/10 pt-3 text-sm"><summary className="cursor-pointer text-slate-400">{at('版本历史（{{count}}）', { count: snapshot.versions.length })}</summary>{snapshot.versions.map(v => <div key={v.version} className="py-3 border-b border-white/5"><p>v{v.version} · {at(v.summary)}{v.saved ? ` · ${at('已保存')}` : ''}</p>{versionActions(v.version)}</div>)}</details>}
      <div ref={bottom} />
    </div>
    <AgentHistory open={historyOpen} onOpenChange={setHistoryOpen} api={api} enabled={!!url && authMode === 'gateway'} sessions={sessions} selected={selected} onSessions={setSessions} onSelect={id => { setSelected(id); setDraft(''); }} />
    <footer className="shrink-0 bg-[#0b1018]/95 border-t border-white/10" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-4xl mx-auto p-4">
        {showLatest && <button className={`${button} mb-2`} onClick={() => { followLatest.current = true; setShowLatest(false); bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }}>{at('回到最新消息')}</button>}
        {task && <div role="status" className="flex items-center gap-2 mb-3 text-sm text-blue-300"><Loader2 size={14} className="animate-spin" />{at(states[task.state] ?? '正在处理')}<button className={`${button} ml-auto`} disabled={busy} onClick={() => void action(async () => { await api.cancel(selected, task.id); })}><Square size={12} />{at('停止助手')}</button></div>}
        <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); if (!busy && !task && status?.providerReady) void action(send); }}>
          <textarea aria-label={at('给助手的消息')} value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={8000} disabled={!selected || !status?.providerReady} placeholder={!status?.providerReady ? at('等待模型连接') : at('描述你想要的效果，或告诉助手如何调整…')} className="flex-1 min-w-0 resize-none rounded-xl border border-white/10 bg-slate-900 p-3 text-sm disabled:opacity-50 focus:outline-none focus:border-blue-500" />
          <button type="submit" className={`${button} bg-blue-600 hover:bg-blue-500 h-12`} disabled={busy || !!task || !selected || !status?.providerReady || !draft.trim()} aria-label={at('发送消息')}><Send size={18} /></button>
        </form>
        <p className="text-[11px] text-slate-500 mt-2">{at('离开页面后，后台任务继续运行。打开画布会创建独立副本。')}</p>
      </div>
    </footer>
  </main>;
}
