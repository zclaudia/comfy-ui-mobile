import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, ChevronDown, Film, Image as ImageIcon, Loader2, Network, Settings2, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { loadAllWorkflows, updateWorkflowAgentBinding } from '@/infrastructure/storage/IndexedDBWorkflowService';
import { useConnectionStore } from '@/ui/store/connectionStore';
import { ComfyFileService } from '@/infrastructure/api/ComfyFileService';
import { LibrarySaveService } from '@/infrastructure/library/LibrarySaveService';
import type { SaveRequest } from '@/infrastructure/library/librarySaveMachine';
import { isTauriRuntime } from '@/platform/runtime';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import type { AgentEvent, AgentSession, SourceRef } from '@/infrastructure/api/AgentApi';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentTranscript } from './transcript/AgentTranscript';
import { ChatHeader } from './ChatHeader';
import { ApprovalCard, ErrorCard, NoticeCard, ResultCard, RetryNotice, WorkflowChangeCard, type ApprovalStatus } from './ChatCards';
import { WorkflowPickerSheet } from './WorkflowPickerSheet';
import { VersionHistorySheet } from './VersionHistorySheet';
import { RenameSheet } from './RenameSheet';
import { ChatComposer } from './ChatComposer';
import { useAttachments } from './useAttachments';
import { MAX_ATTACHMENTS } from './attachments';
import { NEW_CHAT_PRESETS, resolveSavedTarget, serverIdOf, sessionTitle } from './binding';
import { graphHash } from './graphHash';
import { planLegacyMigration } from './migration';
import { LibrarySaveSheet } from './LibrarySaveSheet';
import { DraftStatusLine } from './DraftStatusLine';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';
import { useSessionSnapshot } from './useSessionSnapshot';

const active = new Set(['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling']);
const states: Record<string, string> = { queued: '等待助手处理', running: '正在分析和操作工作流', waiting_comfy: 'ComfyUI 正在生成', waiting_user: '等待你确认生成', reconciling: '正在核对提交状态' };
const BACKGROUND_HINT_KEY = 'comfy_mobile_agent_background_hint';

export default function ChatPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const { api, ready, state, status, retry } = useAgentStatus();
  const serverUrl = useConnectionStore(s => s.url);
  const setActive = useAgentActivityStore(s => s.setActive);
  const { snapshot, events, error, caughtUp, setSnapshot, refresh } = useSessionSnapshot(api, id);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [pending, setPending] = useState<Workflow | null>(null); // workflow chosen for a not-yet-created session
  const [draft, setDraft] = useState(() => params.get('draft') ?? '');
  const onRejectFile = useCallback((reason: string, file: File) => toast.error(`${file.name}: ${at(reason, { count: MAX_ATTACHMENTS })}`), [at]);
  const attachments = useAttachments(api.baseUrl, onRejectFile);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(params.get('pick') === '1');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ version: number; canvas: IComfyJson } | null>(null); // the pinned version the save panel works on
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const reconciled = useRef(''); // opId already reconciled by this page
  const migrated = useRef(''); // session id already migrated by this page
  const alive = useRef(true);
  const request = useRef<{ text: string; files: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(false);

  useEffect(() => () => { alive.current = false; }, []);
  const reloadWorkflows = useCallback(() => loadAllWorkflows().then(setWorkflows).catch(() => setWorkflows([])), []);
  useEffect(() => { void reloadWorkflows(); }, [reloadWorkflows, id]);
  useEffect(() => {
    const preset = params.get('workflow');
    if (!id && preset) void loadAllWorkflows().then(list => { const found = list.find(w => w.id === preset); if (found) setPending(found); });
  }, [id, params]);

  const session = snapshot?.session;
  const library = useMemo(() => new LibrarySaveService({ api, files: new ComfyFileService(serverUrl), serverId: serverIdOf(serverUrl), device: isTauriRuntime() ? 'android' : 'browser' }), [api, serverUrl]);
  const savedTarget = useMemo(() => resolveSavedTarget(session?.lastLibrarySave, workflows), [session, workflows]);
  // The snapshot session carries no preview (only the session list computes one), so name new workflows after the first message.
  const firstMessage = useMemo(() => (events.find(e => e.kind === 'user')?.data.text as string | undefined)?.trim().slice(0, 100), [events]);
  const task = snapshot?.tasks.find(t => active.has(t.state));
  useEffect(() => { if (snapshot) setActive(!!task); }, [snapshot, task, setActive]);
  useEffect(() => { if (followLatest.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); else setUnread(true); }, [events.length]);

  // A pre-draft session carries the old one-to-one binding. Turn it into a source reference once, using the mirror
  // evidence this device holds; the library itself is not touched.
  useEffect(() => {
    if (!session || session.workspaceMode !== 'legacy' || migrated.current === session.id) return;
    migrated.current = session.id;
    void (async () => {
      try {
        const latest = session.version > 0 ? (await api.version(session.id, session.version)).canvas : undefined;
        const plan = planLegacyMigration({ session, workflows: await loadAllWorkflows(), latestCanvas: latest, latestGraphHash: await graphHash(latest), serverId: serverIdOf(serverUrl) });
        const { session: next } = await api.update(session.id, plan.patch);
        if (plan.clearBinding) await updateWorkflowAgentBinding(plan.clearBinding, undefined);
        setSnapshot(p => p ? { ...p, session: next } : p);
        await reloadWorkflows();
      } catch (e) { toast.error(at(e instanceof Error ? e.message : '迁移会话失败')); }
    })();
  }, [api, session, serverUrl, setSnapshot, reloadWorkflows, at]);

  // A save another run left unconfirmed (app killed, response lost) is settled by reading the target back, once per op.
  useEffect(() => {
    const op = session?.librarySaveOp;
    if (!session || !op || saving || (op.state !== 'applying' && op.state !== 'reconciling') || reconciled.current === op.opId) return;
    reconciled.current = op.opId;
    void library.reconcile(session).then(next => { setSnapshot(p => p ? { ...p, session: next } : p); void reloadWorkflows(); }).catch(() => { /* shown by the status line; retried on the next open */ });
  }, [session, saving, library, setSnapshot, reloadWorkflows]);

  async function openSave(version: number) {
    if (!session) return;
    await action(async () => { const { canvas } = await api.version(session.id, version); setSaveDraft({ version, canvas }); setSaveOpen(true); });
  }
  async function runSave(request: SaveRequest) {
    if (!session || !saveDraft) return;
    setSaving(true);
    try {
      const next = await library.start(session, request, saveDraft);
      setSnapshot(p => p ? { ...p, session: next } : p);
      await reloadWorkflows();
      const op = next.librarySaveOp;
      if (op?.state === 'succeeded') toast.success(at('已保存到「{{name}}」', { name: op.target.name }));
      else if (op) throw new Error(op.result?.error || at('未能保存到工作流库，草稿已保留'));
    } finally { setSaving(false); }
  }

  // The jump button tracks the scroll position itself, so it is offered whenever the user is reading back through
  // history, not only when a new event arrived while they were away from the bottom.
  const trackScroll = useCallback((el: HTMLElement) => {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    followLatest.current = near;
    setAtBottom(near);
    if (near) setUnread(false);
  }, []);
  const jumpToLatest = useCallback(() => {
    followLatest.current = true;
    setAtBottom(true);
    setUnread(false);
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(at(e instanceof Error ? e.message : '操作失败')); }
    finally { setBusy(false); }
  }

  async function send() {
    const text = draft.trim();
    const files = attachments.uploaded;
    if (!text && !files.length) return;
    if (attachments.uploading || attachments.failed) { toast.error(at(attachments.failed ? '有附件上传失败，请重试或移除' : '附件仍在上传')); return; }
    let target: AgentSession | undefined = session;
    if (!target && id) return; // an existing route whose snapshot has not arrived yet must never lazy-create a session
    if (!target) {
      // A library workflow becomes this session's draft. Only a cloud-synced copy can be cited as the source; a local-only
      // workflow still seeds the canvas but leaves no origin to point back at.
      const sourceRef: SourceRef | undefined = pending?.cloud?.filename
        ? { serverId: serverIdOf(serverUrl), workflowId: pending.id, filename: pending.cloud.filename, name: pending.name, etag: pending.cloud.etag }
        : undefined;
      const created = await api.create(at('新对话'), pending?.workflow_json, sourceRef);
      target = created.session;
    }
    const fileKey = JSON.stringify(files);
    if (!request.current || request.current.text !== text || request.current.files !== fileKey) request.current = { text, files: fileKey, id: crypto.randomUUID() };
    await api.message(target.id, text, request.current.id, files);
    request.current = null; setDraft(''); attachments.clear();
    try { if (!localStorage.getItem(BACKGROUND_HINT_KEY)) { toast.info(at('离开页面后，后台任务继续运行。')); localStorage.setItem(BACKGROUND_HINT_KEY, '1'); } } catch { /* storage unavailable */ }
    if (!session) { setPending(null); if (alive.current) navigate(`/chat/${target.id}`, { replace: true }); }
    else setSnapshot(await api.snapshot(target.id));
  }

  const title = session ? sessionTitle(session, firstMessage || at('新对话')) : pending ? pending.name : at('新对话');
  const sourceName = session?.sourceRef?.name ?? pending?.name;
  const subtitle = [session?.version ? `V${session.version}` : '', sourceName ? at('使用：{{name}}', { name: sourceName }) : '', !session && pending ? `${pending.nodeCount}N` : ''].filter(Boolean).join(' · ') || undefined;
  const chips = [
    { icon: <ImageIcon size={14} strokeWidth={1.8} />, label: at('生成一张图片'), onClick: () => setDraft(at(NEW_CHAT_PRESETS.image)) },
    { icon: <Film size={14} strokeWidth={1.8} />, label: at('生成一段短视频'), onClick: () => setDraft(at(NEW_CHAT_PRESETS.video)) },
    { icon: <Network size={14} strokeWidth={1.8} />, label: at('从我的工作流开始'), onClick: () => setPickerOpen(true) },
  ];
  const canSend = ready && !busy && !task && (!!draft.trim() || attachments.uploaded.length > 0) && !attachments.uploading && !attachments.failed && (!id || !!session);

  const renderContent = (event: AgentEvent) => {
    const data = event.data;
    if (event.kind === 'workflow') return <WorkflowChangeCard key={event.seq} version={data.version} summary={data.summary} operations={data.operations} />;
    if (event.kind === 'result') return <ResultCard key={event.seq} version={data.version} outputs={data.outputs ?? []} baseUrl={api.baseUrl} />;
    if (event.kind === 'context' && data.status === 'compacted') return <p key={event.seq} className="text-xs text-slate-400">{at('已压缩较早上下文，完整聊天记录仍保留')}</p>;
    if (event.kind === 'saved') return <p key={event.seq} className="text-[11px] text-[#4ade80] flex items-center gap-2">✓ {at('版本 {{version}} 已保留', { version: data.version })}<button className="underline text-[#5b8af5]" onClick={() => void openSave(data.version)}>{at('保存到工作流库')}</button></p>;
    if (event.kind === 'execution_error') return <ErrorCard key={event.seq} title="这次生成未成功" detail={data.diagnostic || JSON.stringify(data, null, 2)} />;
    if (event.kind === 'state' && data.state === 'failed') return <NoticeCard key={event.seq} text={data.error || '任务未完成'} />;
    if (event.kind === 'retry') return <RetryNotice key={event.seq} attempt={data.attempt} max={data.maxAttempts} delayMs={data.delayMs} />;
    if (event.kind === 'approval') {
      // One card per held submission: the pending event renders it and later decisions for the same call update its label.
      if (data.status !== 'pending') return null;
      const latest = events.filter(e => e.kind === 'approval' && e.taskId === event.taskId && e.data.callId === data.callId).at(-1)?.data.status as ApprovalStatus;
      const held = latest === 'pending' && task?.id === event.taskId && task.state === 'waiting_user';
      return <ApprovalCard key={event.seq} version={data.version} status={latest} busy={busy}
        onDecide={held && session ? approved => void action(async () => { await api.approve(session.id, task.id, data.callId, approved); setSnapshot(await api.snapshot(session.id)); }) : undefined} />;
    }
    return null;
  };

  return <main className="h-dvh overflow-hidden flex flex-col text-[#e9ebef]" style={{ background: '#0b0c0f' }}>
    <ChatHeader title={title} subtitle={subtitle} onBack={() => navigate('/chats')}
      onOpenCanvas={savedTarget ? () => navigate(`/workflow/${savedTarget.id}`) : undefined}
      onRename={session ? () => setRenameOpen(true) : undefined}
      onHistory={session && snapshot?.versions.length ? () => setHistoryOpen(true) : undefined}
      onDelete={session ? () => setDeleteOpen(true) : undefined}
      confirmPreviews={session?.previewPolicy === 'confirm'}
      onToggleConfirmPreviews={session ? () => void action(async () => {
        const next = session.previewPolicy === 'confirm' ? 'auto' : 'confirm';
        const { session: updated } = await api.update(session.id, { previewPolicy: next });
        setSnapshot(p => p ? { ...p, session: updated } : p);
        toast.success(at(next === 'confirm' ? '已开启生成前确认，助手提交生成前会先询问你。' : '已关闭生成前确认，助手会直接提交生成。'));
      }) : undefined} />
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div onScroll={e => trackScroll(e.currentTarget)} className="w-full max-w-4xl mx-auto flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
        {state === 'no-gateway' && <NoticeCard text="请先连接 Gateway，再使用工作流助手。" action="打开连接设置" onAction={() => navigate('/settings/server')} />}
        {state === 'no-provider' && <NoticeCard text="Gateway 已连接，添加语言模型后即可开始对话。" action="添加模型" onAction={() => navigate('/settings/agent')} />}
        {state === 'error' && <NoticeCard text="暂时无法连接助手。" action="重新检查" onAction={retry} />}
        {error && <NoticeCard text={error} action="重新连接" onAction={refresh} />}
        {pending && !session && <div className="rounded-[10px] border border-white/[0.07] p-3 flex items-center gap-2 text-[12.5px]" style={{ background: '#101217' }}><Network size={15} className="text-[#5b8af5]" />{at('已载入工作流 · {{count}} 个节点', { count: pending.nodeCount })}</div>}
        {!id && !pending && <div className="py-14 flex flex-col items-center text-center gap-3">
          <div className="w-[52px] h-[52px] rounded-[14px] bg-[#3069f0]/12 border border-[#3069f0]/25 flex items-center justify-center"><Bot size={26} strokeWidth={1.8} className="text-[#5b8af5]" /></div>
          <p className="text-[16px] font-semibold">{at('你想创作什么？')}</p>
          <p className="text-[12.5px] text-[#66758a] max-w-[280px] leading-relaxed">{at('直接描述目标。助手会根据已安装的模型选择合适的工作流并生成预览；满意后再保存到工作流库。')}</p>
        </div>}
        {id && <AgentTranscript events={events} tasks={snapshot?.tasks ?? []} caughtUp={caughtUp} renderContent={renderContent} baseUrl={api.baseUrl} />}
        <div ref={bottom} />
      </div>
      {!atBottom && <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto max-w-4xl px-4 flex justify-end">
        <button data-agent-jump-latest onClick={jumpToLatest} aria-label={at('回到最新消息')} title={at('回到最新消息')}
          className="pointer-events-auto relative w-10 h-10 flex items-center justify-center rounded-full border border-white/[0.1] text-[#c8ccd4] shadow-lg shadow-black/40 transition-colors hover:text-white"
          style={{ background: 'rgba(24,27,34,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
          <ChevronDown className="w-[18px] h-[18px]" strokeWidth={2} />
          {unread && <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-[#3069f0] border-2 border-[#181b22]" />}
        </button>
      </div>}
    </div>
    <footer className="shrink-0 border-t border-white/[0.08]" style={{ background: 'rgba(11,12,15,0.95)', paddingBottom: 'var(--nav-bar-inset, env(safe-area-inset-bottom, 0px))' }}>
      <div className="max-w-4xl mx-auto px-3 pt-2.5 pb-3 space-y-2.5">
        {status && <button className="max-w-full flex items-center gap-1.5 text-[11px] text-slate-400" onClick={() => navigate('/settings/agent')} aria-label={at('助手模型')}><Settings2 size={13} className="shrink-0" /><span className="truncate">{status.model ?? at('添加模型')}{status.contextWindow ? ` · ${status.contextWindow.toLocaleString()} tokens` : ''} · {at(status.vision ? '支持图片理解' : '仅文本')}</span></button>}
        {attachments.items.some(a => a.kind === 'image') && status?.vision === false && <p className="text-xs text-amber-300">{at('当前模型仅接收图片路径；如需理解图片内容，请选择支持 Vision 的模型。')}</p>}
        {!id && <div className="flex gap-2 overflow-x-auto scrollbar-hide">{chips.map(chip => <button key={chip.label} onClick={chip.onClick} className="h-[34px] px-3 shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.035] text-[12px] font-medium text-[#c8ccd4] flex items-center gap-1.5">{chip.icon}{chip.label}</button>)}</div>}
        {task && <div role="status" className="h-10 pl-3 pr-1.5 rounded-[10px] border border-[#3069f0]/30 bg-[#3069f0]/10 flex items-center gap-2 text-[12.5px] font-medium text-[#5b8af5]">
          {task.state === 'waiting_user' ? <ShieldCheck size={14} /> : <Loader2 size={14} className="animate-spin" />}<span className="flex-1">{at(task.state === 'running' && events.filter(e => e.taskId === task.id && e.kind === 'context').at(-1)?.data.status === 'compacting' ? '正在压缩上下文' : states[task.state] ?? '正在处理')}</span>
          <button className="h-7 px-2.5 rounded-[7px] border border-white/10 bg-white/5 text-[11.5px] font-semibold text-[#c8ccd4] flex items-center gap-1.5" disabled={busy} onClick={() => void action(async () => { if (session) await api.cancel(session.id, task.id); })}><Square size={10} fill="currentColor" />{at('停止')}</button>
        </div>}
        {session && <DraftStatusLine session={session} saving={saving} canSave={ready && !busy && !saving && !task} onSave={() => void openSave(session.version)} />}
        <ChatComposer value={draft} onChange={setDraft} disabled={!ready} placeholder={ready ? at('描述你想要的效果，或告诉助手如何调整…') : at('等待模型连接')}
          attachments={attachments.items} onAddFiles={attachments.add} onRemoveAttachment={attachments.remove} onRetryAttachment={attachments.retry}
          canSend={canSend} onSend={() => void action(send)} />
      </div>
    </footer>
    <RenameSheet open={renameOpen} onOpenChange={setRenameOpen} initial={title} onSubmit={name => void action(async () => {
      if (!session) return;
      const { session: next } = await api.update(session.id, { name });
      setSnapshot(p => p ? { ...p, session: next } : p);
    })} />
    <WorkflowPickerSheet open={pickerOpen} onOpenChange={setPickerOpen} onPick={setPending} />
    {session && <LibrarySaveSheet open={saveOpen} onOpenChange={setSaveOpen} session={session} draft={saveDraft} service={library} defaultName={title} onViewTarget={workflowId => { const local = workflows.find(w => w.id === workflowId); if (local) navigate(`/workflow/${local.id}`); }} onSave={runSave} />}
    {snapshot && <VersionHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} versions={snapshot.versions} current={snapshot.session.version} busy={busy || !!task} onSave={version => void openSave(version)} onRestore={version => void action(async () => { await api.restore(snapshot.session.id, version, snapshot.session.version); setSnapshot(await api.snapshot(snapshot.session.id)); })} />}
    <SimpleConfirmDialog isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); void action(async () => { if (!session) return; await api.remove(session.id); navigate('/chats', { replace: true }); }); }} title={at('删除会话')} message={at('只删除对话记录和版本历史，工作流库里的工作流会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </main>;
}
