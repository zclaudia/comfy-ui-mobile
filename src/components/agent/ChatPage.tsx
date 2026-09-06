import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, Film, Image as ImageIcon, Loader2, Network, Send, Square } from 'lucide-react';
import { toast } from 'sonner';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { addWorkflow, loadAllWorkflows, updateWorkflow, updateWorkflowAgentBinding } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { AgentEvent, AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentTranscript } from './transcript/AgentTranscript';
import { ChatHeader } from './ChatHeader';
import { ErrorCard, NoticeCard, ResultCard, WorkflowChangeCard } from './ChatCards';
import { WorkflowPickerSheet } from './WorkflowPickerSheet';
import { VersionHistorySheet } from './VersionHistorySheet';
import { RenameSheet } from './RenameSheet';
import { NEW_CHAT_PRESETS, hashCanvas, resolveBoundWorkflow, sessionTitle } from './binding';
import { importCanvasIfChanged, mirrorVersion, type MirrorDeps } from './mirror';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';
import { useSessionSnapshot } from './useSessionSnapshot';

const active = new Set(['queued', 'running', 'waiting_comfy', 'reconciling']);
const states: Record<string, string> = { queued: '等待助手处理', running: '正在分析和操作工作流', waiting_comfy: 'ComfyUI 正在生成', reconciling: '正在核对提交状态' };
const BACKGROUND_HINT_KEY = 'comfy_mobile_agent_background_hint';

export default function ChatPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const { api, ready, state, retry } = useAgentStatus();
  const setActive = useAgentActivityStore(s => s.setActive);
  const { snapshot, events, error, caughtUp, setSnapshot, refresh } = useSessionSnapshot(api, id);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [pending, setPending] = useState<Workflow | null>(null); // workflow chosen for a not-yet-created session
  const [draft, setDraft] = useState(() => params.get('draft') ?? '');
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(params.get('pick') === '1');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [mirroredVersion, setMirroredVersion] = useState(0); // highest version this page has handled, successfully written or not
  const [writtenVersion, setWrittenVersion] = useState(0); // highest version actually present in the library workflow
  const [mirrorError, setMirrorError] = useState('');
  const mirroring = useRef(0); // version currently being written to the library, 0 when idle
  const alive = useRef(true);
  const request = useRef<{ text: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  useEffect(() => () => { alive.current = false; }, []);
  const reloadWorkflows = useCallback(() => loadAllWorkflows().then(setWorkflows).catch(() => setWorkflows([])), []);
  useEffect(() => { void reloadWorkflows(); }, [reloadWorkflows, id]);
  useEffect(() => {
    const preset = params.get('workflow');
    if (!id && preset) void loadAllWorkflows().then(list => { const found = list.find(w => w.id === preset); if (found) setPending(found); });
  }, [id, params]);

  const session = snapshot?.session;
  const bound = useMemo(() => resolveBoundWorkflow(session?.workflow, workflows), [session, workflows]);
  // The snapshot session carries no preview (only the session list computes one), so name new workflows after the first message.
  const firstMessage = useMemo(() => (events.find(e => e.kind === 'user')?.data.text as string | undefined)?.trim().slice(0, 100), [events]);
  const fallbackName = useMemo(() => firstMessage || at('新对话'), [firstMessage, at]);
  const task = snapshot?.tasks.find(t => active.has(t.state));
  useEffect(() => { if (snapshot) setActive(!!task); }, [snapshot, task, setActive]);
  useEffect(() => { if (followLatest.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); else setShowLatest(true); }, [events.length]);

  const mirrorDeps: MirrorDeps = useMemo(() => ({
    workflows: loadAllWorkflows,
    add: addWorkflow,
    update: updateWorkflow,
    bind: (sessionId, ref) => api.update(sessionId, { workflow: ref }).then(({ session: next }) => setSnapshot(previous => previous ? { ...previous, session: next } : previous)),
  }), [api, setSnapshot]);

  // Mirror the session's current version into the library whenever it moves forward. Single-flight: polling re-runs this
  // effect every snapshot, and a second run for the same session must not write the library twice.
  useEffect(() => {
    if (mirroring.current || mirrorError || !session || session.version === 0 || session.version <= mirroredVersion) return;
    const target = session, version = session.version;
    mirroring.current = version;
    void (async () => {
      try {
        const saved = await api.version(target.id, version);
        const result = await mirrorVersion(target, version, saved.canvas, mirrorDeps, { fallbackName });
        setMissing(result.kind === 'missing');
        setConflict(result.kind === 'conflict');
        // Only a version that reached the library may claim 已写入工作流库; a conflict leaves the library on its own canvas.
        if (result.kind === 'updated' || result.kind === 'created') setWrittenVersion(version);
        else if (result.kind === 'unchanged') setWrittenVersion(result.workflow.agent?.mirroredVersion ?? version);
        setMirroredVersion(version);
        await reloadWorkflows();
      } catch (e) {
        // Polling re-runs this effect every snapshot; hold the failure in a card instead of toasting on every tick.
        setMirrorError(e instanceof Error ? e.message : String(e));
      }
      finally { mirroring.current = 0; }
    })();
  }, [api, session, mirroredVersion, mirrorError, mirrorDeps, reloadWorkflows, fallbackName]);

  // A workflow re-downloaded from cloud on another device has a new id, so the binding only resolves through the
  // filename. Teach the session the id and filename it actually matched, once per resolution, so it stops guessing.
  const filenameSynced = useRef('');
  useEffect(() => {
    const ref = session?.workflow, filename = bound?.cloud?.filename;
    if (!session || !ref || !bound || !filename) return;
    if (filename === ref.filename && bound.id === ref.id) return;
    const key = `${session.id}|${bound.id}|${filename}`;
    if (filenameSynced.current === key) return;
    filenameSynced.current = key;
    // updateSession renames the session after workflow.name, so keep the name the session already carries.
    void api.update(session.id, { workflow: { id: bound.id, name: ref.name, filename } })
      .then(({ session: next }) => setSnapshot(p => p ? { ...p, session: next } : p))
      .catch(() => { /* best effort; the filename fallback still resolves the binding */ });
  }, [api, session, bound, setSnapshot]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(at(e instanceof Error ? e.message : '操作失败')); }
    finally { setBusy(false); }
  }

  async function send() {
    const text = draft.trim(); if (!text) return;
    let target: AgentSession | undefined = session;
    if (!target && id) return; // an existing route whose snapshot has not arrived yet must never lazy-create a session
    if (!target) {
      const created = await api.create(pending ? pending.name : at('新工作流'), pending?.workflow_json, pending ? { id: pending.id, name: pending.name, filename: pending.cloud?.filename } : undefined);
      target = created.session;
      if (pending) await updateWorkflowAgentBinding(pending.id, { sessionId: target.id, mirroredVersion: 1, mirroredHash: hashCanvas(pending.workflow_json) });
    } else if (!unsupported) {
      const result = await importCanvasIfChanged(target, bound, { importVersion: (sid, canvas, base, summary) => api.importVersion(sid, canvas, base, summary), setBinding: updateWorkflowAgentBinding });
      if (result.kind === 'unsupported') { setUnsupported(result.message); return; }
      if (result.kind === 'imported') { target = { ...target, version: result.version }; setMirroredVersion(result.version); setWrittenVersion(result.version); setConflict(false); await reloadWorkflows(); }
    }
    setUnsupported(null);
    if (!request.current || request.current.text !== text) request.current = { text, id: crypto.randomUUID() };
    await api.message(target.id, text, request.current.id);
    request.current = null; setDraft('');
    try { if (!localStorage.getItem(BACKGROUND_HINT_KEY)) { toast.info(at('离开页面后，后台任务继续运行。')); localStorage.setItem(BACKGROUND_HINT_KEY, '1'); } } catch { /* storage unavailable */ }
    if (!session) { setPending(null); if (alive.current) navigate(`/chat/${target.id}`, { replace: true }); }
    else setSnapshot(await api.snapshot(target.id));
  }

  const title = session ? sessionTitle(session, firstMessage || at('新对话')) : pending ? pending.name : at('新对话');
  const subtitle = session ? [session.version ? `V${session.version}` : '', bound ? `${bound.nodeCount}N` : ''].filter(Boolean).join(' · ') : pending ? `${pending.nodeCount}N` : undefined;
  const chips = [
    { icon: <ImageIcon size={14} strokeWidth={1.8} />, label: at('生成一张图片'), onClick: () => setDraft(at(NEW_CHAT_PRESETS.image)) },
    { icon: <Film size={14} strokeWidth={1.8} />, label: at('生成一段短视频'), onClick: () => setDraft(at(NEW_CHAT_PRESETS.video)) },
    { icon: <Network size={14} strokeWidth={1.8} />, label: at('从我的工作流开始'), onClick: () => setPickerOpen(true) },
  ];
  const canSend = ready && !busy && !task && !!draft.trim() && (!id || !!session);

  const renderContent = (event: AgentEvent) => {
    const data = event.data;
    if (event.kind === 'workflow') return <WorkflowChangeCard key={event.seq} version={data.version} summary={data.summary} operations={data.operations} mirrored={data.version <= writtenVersion && !!bound} onOpenCanvas={bound ? () => navigate(`/workflow/${bound.id}`) : undefined} />;
    if (event.kind === 'result') return <ResultCard key={event.seq} version={data.version} outputs={data.outputs ?? []} baseUrl={api.baseUrl} />;
    if (event.kind === 'saved') return <p key={event.seq} className="text-[11px] text-[#4ade80]">✓ {at('版本 {{version}} 已保存', { version: data.version })}</p>;
    if (event.kind === 'execution_error') return <ErrorCard key={event.seq} title="这次生成未成功" detail={data.diagnostic || JSON.stringify(data, null, 2)} />;
    if (event.kind === 'state' && data.state === 'failed') return <NoticeCard key={event.seq} text={data.error || '任务未完成'} />;
    return null;
  };

  return <main className="h-dvh overflow-hidden flex flex-col text-[#e9ebef]" style={{ background: '#0b0c0f', paddingTop: 'env(safe-area-inset-top)' }}>
    <ChatHeader title={title} subtitle={subtitle} onBack={() => navigate('/chats')}
      onOpenCanvas={bound ? () => navigate(`/workflow/${bound.id}`) : undefined}
      onRename={session ? () => setRenameOpen(true) : undefined}
      onHistory={session && snapshot?.versions.length ? () => setHistoryOpen(true) : undefined}
      onDelete={session ? () => setDeleteOpen(true) : undefined} />
    <div onScroll={e => { const el = e.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (followLatest.current) setShowLatest(false); }} className="w-full max-w-4xl mx-auto flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
      {state === 'no-gateway' && <NoticeCard text="请先连接 Gateway，再使用工作流助手。" action="打开连接设置" onAction={() => navigate('/settings/server')} />}
      {state === 'no-provider' && <NoticeCard text="助手尚未连接语言模型，管理员配置后即可开始对话。" action="重新检查" onAction={retry} />}
      {state === 'error' && <NoticeCard text="暂时无法连接助手。" action="重新检查" onAction={retry} />}
      {error && <NoticeCard text={error} action="重新连接" onAction={refresh} />}
      {mirrorError && <NoticeCard text={at('写入工作流库失败：{{message}}', { message: mirrorError })} action="重试" onAction={() => setMirrorError('')} />}
      {missing && <NoticeCard text="绑定的工作流已从库里删除。" action="从当前版本重新创建" onAction={() => void action(async () => { if (!session) return; const version = await api.version(session.id, session.version); await mirrorVersion(session, session.version, version.canvas, mirrorDeps, { recreate: true, fallbackName }); setMissing(false); await reloadWorkflows(); })} />}
      {conflict && <NoticeCard text="画布上有未同步的修改，发送下一条消息时会先导入画布，助手最新版本不会覆盖它。" />}
      {unsupported && <NoticeCard text="画布里有助手暂不支持的改动，助手将基于上一版本继续。" action="继续发送" onAction={() => { void action(send); }} />}
      {pending && !session && <div className="rounded-[10px] border border-white/[0.07] p-3 flex items-center gap-2 text-[12.5px]" style={{ background: '#101217' }}><Network size={15} className="text-[#5b8af5]" />{at('已载入工作流 · {{count}} 个节点', { count: pending.nodeCount })}</div>}
      {!id && !pending && <div className="py-14 flex flex-col items-center text-center gap-3">
        <div className="w-[52px] h-[52px] rounded-[14px] bg-[#3069f0]/12 border border-[#3069f0]/25 flex items-center justify-center"><Bot size={26} strokeWidth={1.8} className="text-[#5b8af5]" /></div>
        <p className="text-[16px] font-semibold">{at('你想创作什么？')}</p>
        <p className="text-[12.5px] text-[#66758a] max-w-[280px] leading-relaxed">{at('直接描述目标。助手会根据已安装的模型选择合适的工作流，生成预览并写入你的工作流库。')}</p>
      </div>}
      {id && <AgentTranscript events={events} tasks={snapshot?.tasks ?? []} caughtUp={caughtUp} renderContent={renderContent} />}
      <div ref={bottom} />
    </div>
    <footer className="shrink-0 border-t border-white/[0.08]" style={{ background: 'rgba(11,12,15,0.95)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-4xl mx-auto p-4 space-y-2.5">
        {showLatest && <button className="text-[12px] text-[#5b8af5] font-semibold" onClick={() => { followLatest.current = true; setShowLatest(false); bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }}>{at('回到最新消息')}</button>}
        {!id && <div className="flex gap-2 overflow-x-auto scrollbar-hide">{chips.map(chip => <button key={chip.label} onClick={chip.onClick} className="h-[34px] px-3 shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.035] text-[12px] font-medium text-[#c8ccd4] flex items-center gap-1.5">{chip.icon}{chip.label}</button>)}</div>}
        {task && <div role="status" className="h-10 pl-3 pr-1.5 rounded-[10px] border border-[#3069f0]/30 bg-[#3069f0]/10 flex items-center gap-2 text-[12.5px] font-medium text-[#5b8af5]">
          <Loader2 size={14} className="animate-spin" /><span className="flex-1">{at(states[task.state] ?? '正在处理')}</span>
          <button className="h-7 px-2.5 rounded-[7px] border border-white/10 bg-white/5 text-[11.5px] font-semibold text-[#c8ccd4] flex items-center gap-1.5" disabled={busy} onClick={() => void action(async () => { if (session) await api.cancel(session.id, task.id); })}><Square size={10} fill="currentColor" />{at('停止')}</button>
        </div>}
        <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); if (canSend) void action(send); }}>
          <textarea aria-label={at('给助手的消息')} value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={8000} disabled={!ready} placeholder={ready ? at('描述你想要的效果，或告诉助手如何调整…') : at('等待模型连接')} className="flex-1 min-w-0 resize-none rounded-[12px] border border-white/[0.08] bg-white/[0.045] p-3 text-[13px] disabled:opacity-50 focus:outline-none focus:border-[#3069f0]/50" />
          <button type="submit" aria-label={at('发送消息')} disabled={!canSend} className={`w-11 h-11 shrink-0 rounded-[12px] flex items-center justify-center ${canSend ? 'bg-[#3069f0] text-white' : 'bg-[#23262d] text-[#565d6b]'}`}><Send size={18} /></button>
        </form>
      </div>
    </footer>
    <RenameSheet open={renameOpen} onOpenChange={setRenameOpen} initial={title} onSubmit={name => void action(async () => {
      if (!session) return;
      const { session: next } = await api.update(session.id, { name, ...(session.workflow ? { workflow: { ...session.workflow, name } } : {}) });
      setSnapshot(p => p ? { ...p, session: next } : p);
      if (bound) await updateWorkflow({ ...bound, name });
      await reloadWorkflows();
    })} />
    <WorkflowPickerSheet open={pickerOpen} onOpenChange={setPickerOpen} onPick={workflow => { if (workflow.agent?.sessionId) navigate(`/chat/${workflow.agent.sessionId}`, { replace: true }); else setPending(workflow); }} />
    {snapshot && <VersionHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} versions={snapshot.versions} current={snapshot.session.version} busy={busy || !!task} onRestore={version => void action(async () => { await api.restore(snapshot.session.id, version, snapshot.session.version); setSnapshot(await api.snapshot(snapshot.session.id)); })} />}
    <SimpleConfirmDialog isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); void action(async () => { if (!session) return; await api.remove(session.id); if (bound?.agent?.sessionId === session.id) await updateWorkflowAgentBinding(bound.id, undefined); navigate('/chats', { replace: true }); }); }} title={at('删除会话')} message={at('只删除对话记录和版本历史，工作流库里的工作流会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </main>;
}
