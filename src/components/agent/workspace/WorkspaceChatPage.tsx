import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, ChevronDown, Layers, Loader2, Network, Plus, Settings2, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentEvent, AgentStatus } from '../../../infrastructure/api/AgentApi';
import { ComfyFileService } from '../../../infrastructure/api/ComfyFileService';
import { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import type { Asset, Draft, RequestContext, RevisionRef, Run, WorkspaceSession } from '../../../shared/types/agentWorkspace';
import type { Workflow } from '../../../shared/types/app/IComfyWorkflow';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import { loadAllWorkflows } from '@/infrastructure/storage/IndexedDBWorkflowService';
import { ChatComposer } from '../ChatComposer';
import { ChatHeader } from '../ChatHeader';
import { NoticeCard, RetryNotice } from '../ChatCards';
import { RenameSheet } from '../RenameSheet';
import { SheetFrame, WorkflowPickerSheet } from '../WorkflowPickerSheet';
import { AgentTranscript } from '../transcript/AgentTranscript';
import { useAgentText } from '../useAgentText';
import { useAttachments } from '../useAttachments';
import { GalleryAttachPicker } from '../GalleryAttachPicker';
import { MAX_ATTACHMENTS } from '../attachments';
import { NEW_CHAT_PRESETS, sessionTitle } from '../binding';
import { accentChip, chipButton } from '../chatStyles';
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot';
import { WorkspaceContext } from './WorkspaceContext';
import { messageIdentity, targetContext, videoContext, withReference, workspaceTranscriptEvents } from './state';
import { WorkspaceMedia } from './WorkspaceMedia';
import { AssetPicker, DraftHistory, DraftPicker } from './WorkspaceSheets';
import { RunCard, SelectionCard } from './WorkspaceCards';
import type { RunActions } from './WorkspaceCards';
import { AssetDetailsSheet } from './AssetDetailsSheet';
import { WorkspaceCommands } from './commands';
import { verifiedImportSource } from './importSource';
import { workspaceCanvasPath, recoveryCanvasPath } from './canvasNavigation';
import { WorkspaceLibrarySheet } from './WorkspaceLibrarySheet';
import { DraftManagementSheet } from './DraftManagementSheet';
import { DraftRecoveryImportSheet } from './DraftRecoveryImportSheet';
import { LegacyUserAttachments, LegacyWorkspaceCard } from './LegacyWorkspaceCard';

const activeStates = new Set(['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling']);
export function WorkspaceChatPage({ baseUrl, status }: { baseUrl: string; status: AgentStatus }) {
  const at = useAgentText(); const navigate = useNavigate(); const { id, legacyVersion } = useParams(); const [params] = useSearchParams();
  const api = useMemo(() => new WorkspaceApi(baseUrl, status.serverId), [baseUrl, status.serverId]);
  const view = useWorkspaceSnapshot(api, id); const session = view.snapshot?.session;
  const [text, setText] = useState(() => params.get('draft') ?? ''); const [context, setContext] = useState<RequestContext>({});
  const [busy, setBusy] = useState(false); const working = useRef(false); const alive = useRef(true);
  const [draftsOpen, setDraftsOpen] = useState(false); const [assetsOpen, setAssetsOpen] = useState(false);
  const [replacement, setReplacement] = useState<Run | null>(null); const [history, setHistory] = useState<Draft | null>(null);
  const [source, setSource] = useState<string | null>(null); const [rename, setRename] = useState(false);
  const [picker, setPicker] = useState(params.get('pick') === '1'); const [pendingWorkflow, setPendingWorkflow] = useState<Workflow | null>(null);
  const [fork, setFork] = useState<RevisionRef | null>(null);
  const [managedDraft, setManagedDraft] = useState<Draft | null>(null);
  const [importRecovery, setImportRecovery] = useState(false);
  const [libraryRef, setLibraryRef] = useState<RevisionRef | null>(null);
  const [inspection, setInspection] = useState<{ ref: RevisionRef; canvas: Workflow['workflow_json'] } | null>(null);
  const [legacyError, setLegacyError] = useState('');
  const [createdSession, setCreatedSession] = useState<WorkspaceSession | null>(null);
  const created = useRef<WorkspaceSession | null>(null);
  const imports = useRef(new Map<string, { requestId: string; result?: { draft: Draft } }>());
  const registered = useRef(new Map<string, Asset>());
  const messageRequest = useRef<{ key: string; id: string } | null>(null);
  const commands = useRef(new WorkspaceCommands());
  const attachments = useAttachments(baseUrl, useCallback((reason: string, file?: File) => toast.error(`${file ? `${file.name}: ` : ''}${at(reason, { count: MAX_ATTACHMENTS })}`), [at]));
  const [libraryPicker, setLibraryPicker] = useState(false);
  const scroll = useRef<HTMLDivElement>(null); const [nearBottom, setNearBottom] = useState(true); const follow = useRef(true);
  const setActive = useAgentActivityStore(state => state.setActive);
  const task = view.snapshot?.tasks.find(task => activeStates.has(task.state));
  const sessionId = id ?? createdSession?.id ?? '';
  const localResume = recoveryCanvasPath(sessionId, params);
  const target = context.targetDraftId ? view.drafts[context.targetDraftId] : undefined;
  const events = useMemo(() => workspaceTranscriptEvents(view.events).map(event => event.kind === 'user' && event.data.directRun
    ? { ...event, data: { ...event.data, text: at('按指定工作流版本生成') } } : event), [view.events, at]);
  const { merge, getWatermark } = view;
  const oldVersion = legacyVersion ?? params.get('legacyVersion') ?? params.get('version');
  useEffect(() => {
    setLegacyError('');
    if (!id || oldVersion == null) return;
    const version = Number(oldVersion); const controller = new AbortController();
    if (!Number.isSafeInteger(version) || version < 1) { setLegacyError('无效的草稿版本链接'); return; }
    void api.legacyVersion(id, version, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setInspection({ ref: result.reference, canvas: result.revision.canvas });
      }
    }).catch(error => { if (!controller.signal.aborted) setLegacyError(error instanceof Error ? error.message : '操作失败'); });
    return () => controller.abort();
  }, [api, id, oldVersion, at, navigate]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (task) setActive(true); }, [task, setActive]);
  useEffect(() => { if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [events.length, task?.state]);
  useEffect(() => {
    const draftId = params.get('targetDraft'); const revision = Number(params.get('sourceRevision'));
    if (!id || !draftId || !Number.isSafeInteger(revision) || revision < 1) return;
    const controller = new AbortController(); const watermark = getWatermark();
    void Promise.all([api.draft(id, draftId, controller.signal), api.revision(id, draftId, revision, controller.signal)]).then(([{ draft }]) => {
      if (controller.signal.aborted) return;
      merge({ drafts: [draft] }, watermark); setContext(targetContext({ draftId, revision }));
      const opened = Number(params.get('localOpenedRevision'));
      const resume = new URLSearchParams({ resumeDraft: draft.id, resumeRevision: String(opened), ...(params.get('localCopy') ? { resumeCopy: params.get('localCopy')! } : {}) });
      navigate(`/chat/${id}${opened <= draft.headRevision && recoveryCanvasPath(id, resume) ? `?${resume}` : ''}`, { replace: true });
    }).catch(error => { if (!controller.signal.aborted) toast.error(at(error instanceof Error ? error.message : '操作失败')); });
    return () => controller.abort();
  }, [api, id, params, merge, getWatermark, navigate, at]);
  useEffect(() => {
    const workflowId = params.get('workflow'); if (!workflowId || id) return;
    let cancelled = false; void loadAllWorkflows().then(workflows => { if (!cancelled) setPendingWorkflow(workflows.find(workflow => workflow.id === workflowId) ?? null); });
    return () => { cancelled = true; };
  }, [params, id]);

  async function action(fn: () => Promise<void>) {
    if (working.current) return false;
    working.current = true; setBusy(true);
    try { await fn(); return true; } catch (error) { if (alive.current) toast.error(at(error instanceof Error ? error.message : '操作失败')); return false; }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function ensureSession() {
    if (session) return session;
    if (id) throw new Error('请等待会话加载完成');
    if (!created.current) { created.current = (await api.create(at('新对话'))).session; if (alive.current) setCreatedSession(created.current); }
    return created.current;
  }
  async function importWorkflow(targetSession: WorkspaceSession, workflow: Workflow) {
    const key = `${targetSession.id}:${workflow.id}`;
    const receipt = imports.current.get(key) ?? { requestId: crypto.randomUUID(), result: undefined }; imports.current.set(key, receipt);
    if (!receipt.result) {
      const remote = workflow.cloud?.filename ? await new ComfyFileService(baseUrl).downloadWorkflow(workflow.cloud.filename) : { success: false };
      const sourceRef = verifiedImportSource(workflow, status.serverId, remote);
      receipt.result = await api.importDraft(targetSession.id, workflow.name, workflow.workflow_json, [], receipt.requestId, sourceRef);
    }
    return receipt.result.draft;
  }
  async function send(override?: { text: string; context: RequestContext }) {
    if (!status.providerReady || task) return;
    if (attachments.uploading || attachments.failed) throw new Error(attachments.failed ? '有附件上传失败，请重试或移除' : '附件仍在上传');
    const message = override?.text ?? (text.trim() || (attachments.items.length ? at('我上传了这些素材。') : ''));
    if (!message) return;
    let selectedContext = structuredClone(override?.context ?? context);
    if ((selectedContext.selectedAssetIds?.length ?? 0) + attachments.items.length > 8) throw new Error('本轮参考素材不能超过 8 个');
    if (override && alive.current) { setText(message); setContext(selectedContext); }
    const targetSession = await ensureSession();
    if (pendingWorkflow) {
      const draft = await importWorkflow(targetSession, pendingWorkflow);
      selectedContext = { ...selectedContext, targetDraftId: draft.id, sourceRevision: draft.headRevision };
    }
    const fileIds = attachments.items.map(item => item.id);
    const key = messageIdentity(message, selectedContext, fileIds);
    if (messageRequest.current?.key !== key) messageRequest.current = { key, id: crypto.randomUUID() };
    for (const item of attachments.items) {
      if (!item.uploaded) throw new Error('附件仍在上传');
      let asset = registered.current.get(item.id);
      if (!asset) { asset = (await api.registerAsset(targetSession.id, item.uploaded, item.id)).asset; registered.current.set(item.id, asset); }
      selectedContext = withReference(selectedContext, asset.id);
    }
    await api.message(targetSession.id, message, messageRequest.current.id, selectedContext);
    messageRequest.current = null;
    if (!alive.current) return;
    setText(''); setContext({}); setPendingWorkflow(null); attachments.clear(); registered.current.clear();
    follow.current = true; setNearBottom(true);
    if (!id) navigate(`/chat/${targetSession.id}`, { replace: true }); else view.refresh();
  }
  function adjust(ref: RevisionRef) { setContext(previous => ({ ...previous, ...targetContext(ref) })); }
  function reference(asset: Asset) { try { setContext(withReference(context, asset.id)); } catch (error) { toast.error(at((error as Error).message)); } }
  async function inspect(ref: RevisionRef) { const revision = await api.revision(sessionId, ref.draftId, ref.revision); setInspection({ ref, canvas: revision.canvas }); }
  const actions: RunActions = {
    onAdjust: adjust, onReference: reference, onVideo: asset => void action(() => send({ text: at('用这张图片生成一段短视频。'), context: videoContext(asset) })),
    onRerun: run => void action(async () => { await commands.current.run(`generate:${run.draftId}:${run.revision}`, { draftId: run.draftId, revision: run.revision }, (input, requestId) => api.generate(sessionId, input.draftId, input.revision, requestId)); adjust(run); view.refresh(); }),
    onFork: setFork, onCanvas: ref => void action(() => inspect(ref)), onSource: setSource,
    onReplaceImage: run => { setReplacement(run); setAssetsOpen(true); },
    onApprove: (run, approved) => void action(async () => { await api.approve(sessionId, run.taskId!, run.id, run.approvalDigest!, approved); view.refresh(); }),
  };
  const canSend = status.providerReady && !busy && !task && !session?.archivedAt && target?.archivedAt == null && (!!text.trim() || attachments.items.length > 0) && !attachments.uploading && !attachments.failed && (!id || !!session);
  const title = session ? sessionTitle(session, view.events.find(event => event.kind === 'user')?.data.text || at('新对话')) : at('新对话');
  const renderContent = (event: AgentEvent) => {
    if (event.kind === 'run_state') return <RunCard runId={String(event.data.run.id)} actions={actions} busy={busy} />;
    if (event.kind === 'selection_requested') return <SelectionCard questionId={String(event.data.selection.id)} busy={busy} onAnswer={(selection, indices, answer) => void action(async () => { await api.answer(sessionId, selection.id, selection.taskId, indices, answer); view.refresh(); })} />;
    if (event.kind === 'draft_created') return <p className="text-xs text-slate-400">{at('已创建：{{name}}', { name: event.data.draft.name })}</p>;
    if (event.kind === 'revision_created') return <button className="text-xs text-slate-400 text-left" onClick={() => adjust({ draftId: String(event.data.draftId), revision: Number(event.data.revision) })}>{view.drafts[String(event.data.draftId)]?.name} · {at('工作流第 {{version}} 版', { version: Number(event.data.revision) })} · {at(String(event.data.summary))}</button>;
    if (event.kind === 'context' && event.data.status === 'compacted') return <p className="text-xs text-slate-500">{at('已压缩较早上下文，完整聊天记录仍保留')}</p>;
    if (event.kind === 'retry') return <RetryNotice attempt={event.data.attempt} max={event.data.maxAttempts} delayMs={event.data.delayMs} />;
    if (event.data.workspaceLegacy || ['workflow', 'result', 'execution_error', 'saved', 'approval'].includes(event.kind)) return <LegacyWorkspaceCard event={event} actions={actions} busy={busy || !!task} />;
    return null;
  };

  return <WorkspaceContext.Provider value={{ api, sessionId, view }}><main className="h-dvh flex flex-col overflow-hidden text-[#e9ebef] bg-[#0b0c0f]" data-workspace-chat>
    <ChatHeader title={title} onBack={() => navigate('/chats')} onRename={session ? () => setRename(true) : undefined} onHistory={target ? () => setHistory(target) : undefined}
      onOpenCanvas={target ? () => navigate(workspaceCanvasPath(sessionId, { draftId: target.id, revision: context.sourceRevision ?? target.headRevision })) : undefined}
      onSaveToLibrary={target ? () => setLibraryRef({ draftId: target.id, revision: context.sourceRevision ?? target.headRevision }) : undefined}
      confirmPreviews={session?.previewPolicy === 'confirm'} onToggleConfirmPreviews={session ? () => void action(async () => { await api.update(session.id, { previewPolicy: session.previewPolicy === 'confirm' ? 'auto' : 'confirm' }); view.refresh(); }) : undefined} />
    {session && <div className="shrink-0 px-4 py-2 border-b border-white/5 flex gap-2 items-center"><button data-workspace-open-drafts className={chipButton} onClick={() => setDraftsOpen(true)}><Layers size={14} />{at('创作')} <span className="text-slate-500">{view.snapshot?.drafts.items.length}{view.snapshot?.drafts.nextCursor ? '+' : ''}</span></button><button className={chipButton} onClick={() => { setReplacement(null); setAssetsOpen(true); }}><Plus size={13} />{at('参考素材')}</button><span className="flex-1" /><span className="text-[11px] text-slate-500">{at('草稿自动保存')}</span></div>}
    <div className="relative flex-1 min-h-0">
      <div ref={scroll} className="h-full overflow-y-auto overscroll-contain max-w-4xl mx-auto px-4 py-4 space-y-4" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; setNearBottom(follow.current); }}>
        {view.error && <NoticeCard text={view.error} action="重试" onAction={view.refresh} />}
        {legacyError && <NoticeCard text={legacyError} action="返回聊天" onAction={() => navigate(`/chat/${id}`, { replace: true })} />}
        {!status.providerReady && <NoticeCard text="Gateway 已连接，添加语言模型后即可开始对话。" action="添加模型" onAction={() => navigate('/settings/agent')} />}
        {session?.archivedAt && <NoticeCard text="此会话已归档" action="恢复会话" onAction={() => void action(async () => { await api.update(session.id, { archivedAt: null }); view.refresh(); })} />}
        {!id && <div className="flex flex-col items-center py-12 text-center gap-3"><Bot size={36} className="text-blue-400" /><h2 className="text-base font-semibold">{at('你想创作什么？')}</h2><p className="text-xs text-slate-400 max-w-xs">{at('在同一对话中生成图片、制作视频，也可以随时回头调整。')}</p><div className="flex flex-wrap justify-center gap-2"><button className={chipButton} onClick={() => setText(at(NEW_CHAT_PRESETS.image))}>{at('生成一张图片')}</button><button className={chipButton} onClick={() => setText(at(NEW_CHAT_PRESETS.video))}>{at('生成一段短视频')}</button><button className={chipButton} onClick={() => setPicker(true)}>{at('从我的工作流开始')}</button></div></div>}
        {!!id && <AgentTranscript events={events} tasks={view.snapshot?.tasks ?? []} caughtUp={view.caughtUp} renderContent={renderContent} baseUrl={baseUrl} renderUserAttachments={event => <LegacyUserAttachments event={event} onSource={setSource} />} renderUserContext={event => {
          const sent = event.data.context as RequestContext | undefined;
          return sent ? <div className="space-y-2 mb-2">{sent.targetDraftId && <p className="text-[11px] text-slate-400">{at('本次调整')}：{view.drafts[sent.targetDraftId]?.name ?? at('工作流')}{sent.sourceRevision && ` · ${at('工作流第 {{version}} 版', { version: sent.sourceRevision })}`}</p>}{!!sent.selectedAssetIds?.length && <div className="flex gap-2 overflow-x-auto">{sent.selectedAssetIds.map(assetId => <button key={assetId} className="w-24 shrink-0" onClick={() => setSource(assetId)}><WorkspaceMedia assetId={assetId} compact /></button>)}</div>}</div> : null;
        }} />}
      </div>
      {!nearBottom && <button aria-label={at('回到最新消息')} className="absolute right-4 bottom-3 rounded-full p-2 bg-[#1b2130] border border-white/10 shadow-lg" onClick={() => { follow.current = true; setNearBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ChevronDown size={20} /></button>}
    </div>
    <footer className="shrink-0 border-t border-white/10 bg-[#0b0c0f]" style={{ paddingBottom: 'var(--nav-bar-inset, env(safe-area-inset-bottom, 0px))' }}><div className="max-w-4xl mx-auto px-3 py-3 space-y-2">
      <button className="flex items-center gap-1.5 text-[11px] text-slate-400" onClick={() => navigate('/settings/agent')}><Settings2 size={12} />{status.model ?? at('添加模型')} · {at(status.vision ? '支持图片理解' : '仅文本')}</button>
      {localResume && <div className="rounded-lg p-2 border border-amber-400/30 text-xs space-y-2"><p>{at('此设备保留了画布工作副本，聊天生成使用服务器已保存的版本。')}</p><button className={chipButton} onClick={() => navigate(localResume)}>{at('打开本机草稿')}</button><button className={`${chipButton} ml-2`} onClick={() => navigate(`/chat/${sessionId}`, { replace: true })}>{at('关闭提示')}</button></div>}
      {pendingWorkflow && <div className="flex items-center text-xs gap-2 p-2 rounded-lg bg-white/5"><Network size={14} />{pendingWorkflow.name}<button disabled={busy} className="ml-auto" aria-label={at('移除')} onClick={() => setPendingWorkflow(null)}><X size={14} /></button></div>}
      {context.targetDraftId && <div className="flex items-center text-xs gap-2 p-2 rounded-lg border border-blue-500/20 bg-blue-500/5" data-workspace-target><span className="text-slate-400">{at('本次调整')}：</span><span className="truncate">{target?.name ?? at('工作流')} · {at('工作流第 {{version}} 版', { version: context.sourceRevision ?? target?.headRevision ?? 1 })}</span><button disabled={busy} className="ml-auto shrink-0" aria-label={at('清除调整对象')} onClick={() => setContext(previous => ({ selectedAssetIds: previous.selectedAssetIds }))}><X size={14} /></button></div>}
      {target?.archivedAt != null && <div className="text-xs text-amber-300 flex flex-wrap items-center gap-2"><span>{at('此创作已归档，请恢复或清除调整对象后继续。')}</span><button className={chipButton} onClick={() => setManagedDraft(target)}>{at('管理创作')}</button></div>}
      {!!context.selectedAssetIds?.length && <div data-workspace-references><p className="text-[11px] text-slate-400 mb-1">{at('参考素材')}</p><div className="flex gap-2 overflow-x-auto">{context.selectedAssetIds.map(assetId => <div key={assetId} className="w-20 shrink-0 relative"><WorkspaceMedia assetId={assetId} compact /><button disabled={busy} className="absolute top-0 right-0 rounded-full bg-black/70 p-1" aria-label={at('移除参考素材')} onClick={() => setContext(previous => ({ ...previous, selectedAssetIds: previous.selectedAssetIds?.filter(id => id !== assetId) }))}><X size={12} /></button></div>)}</div></div>}
      {task && <div className="flex items-center gap-2 p-2 rounded-xl bg-blue-500/10 text-blue-400 text-xs" role="status"><Loader2 size={14} className="animate-spin" /><span className="flex-1">{at(task.workspace?.waitingReason?.type === 'selection' ? '等待选择' : task.state === 'waiting_user' ? '等待你确认生成' : task.state === 'waiting_comfy' ? 'ComfyUI 正在生成' : '正在处理')}</span><button className={chipButton} disabled={busy} onClick={() => void action(async () => { await api.cancel(sessionId, task.id); view.refresh(); })}><Square size={10} />{at('停止')}</button></div>}
      <ChatComposer value={text} onChange={setText} disabled={!status.providerReady || busy || !!session?.archivedAt} placeholder={at('描述你想要的效果，或告诉助手如何调整…')} attachments={attachments.items} onAddFiles={attachments.add} onPickFromLibrary={!status.providerReady || busy || !!session?.archivedAt ? undefined : () => setLibraryPicker(true)} onRemoveAttachment={attachments.remove} onRetryAttachment={attachments.retry} canSend={canSend} onSend={() => void action(() => send())} />
      {libraryPicker && <GalleryAttachPicker title={at('从相册选择')} onClose={() => setLibraryPicker(false)} onPick={path => { if (attachments.addServerFile(path)) toast.success(at('已添加到附件')); }} />}
    </div></footer>
    <DraftPicker open={draftsOpen} onOpenChange={setDraftsOpen} onPick={draft => adjust({ draftId: draft.id, revision: draft.headRevision })} onHistory={setHistory} onImport={() => { setDraftsOpen(false); setPicker(true); }} onManage={setManagedDraft} onImportRecovery={() => { setDraftsOpen(false); setImportRecovery(true); }} />
    {importRecovery && <DraftRecoveryImportSheet serverId={status.serverId ?? ''} onClose={() => setImportRecovery(false)} onImported={identity => navigate(workspaceCanvasPath(sessionId, { draftId: identity.draftId, revision: identity.openedRevision }, identity.copyId))} />}
    {managedDraft && <DraftManagementSheet key={managedDraft.id} draft={managedDraft} onClose={() => setManagedDraft(null)} disabled={busy || !!task || !!session?.archivedAt} />}
    <AssetPicker open={assetsOpen} onOpenChange={open => { setAssetsOpen(open); if (!open) setReplacement(null); }} kind={replacement ? 'image' : undefined} selected={context.selectedAssetIds} onPick={asset => {
      if (replacement) { const run = replacement; setAssetsOpen(false); setReplacement(null); void action(() => send({ text: at('用选中的新图片更新这个视频，保留动作和其他参数。'), context: { ...targetContext(run), selectedAssetIds: [asset.id] } })); }
      else if (context.selectedAssetIds?.includes(asset.id)) setContext(previous => ({ ...previous, selectedAssetIds: previous.selectedAssetIds?.filter(id => id !== asset.id) })); else reference(asset);
    }} />
    <DraftHistory draft={history ? view.drafts[history.id] ?? history : null} onClose={() => setHistory(null)} onContinue={adjust} busy={busy || !!task} onCanvas={ref => void action(() => inspect(ref))} onFork={(draft, revision) => setFork({ draftId: draft.id, revision })} onRestore={(draft, revision) => void action(async () => { const result = await commands.current.run(`restore:${draft.id}:${revision}`, { source: revision, head: draft.headRevision }, (input, requestId) => api.restore(sessionId, draft.id, input.source, input.head, requestId)); adjust(result.revision); setHistory(null); view.refresh(); })} />
    <AssetDetailsSheet assetId={source} onClose={() => setSource(null)} onSelect={setSource} onAdjust={adjust} onCanvas={ref => void action(() => inspect(ref))} />
    {libraryRef && <WorkspaceLibrarySheet reference={libraryRef} serverId={status.serverId ?? ''} onClose={() => setLibraryRef(null)} />}
    <RenameSheet open={rename} onOpenChange={setRename} initial={title} onSubmit={name => action(async () => { await api.update(sessionId, { name }); view.refresh(); })} />
    <RenameSheet title="另做一个方向" label="创作名称" open={!!fork} onOpenChange={open => { if (!open) setFork(null); }} initial={fork ? `${view.drafts[fork.draftId]?.name ?? at('创作')} · ${at('另一方向')}` : ''} onSubmit={name => action(async () => { if (!fork) return; const watermark = view.getWatermark(); const result = await commands.current.run(`fork:${fork.draftId}:${fork.revision}:${name}`, { ...fork, name }, (input, requestId) => api.fork(sessionId, input.draftId, input.revision, input.name, requestId)); view.merge({ drafts: [result.draft] }, watermark); adjust({ draftId: result.draft.id, revision: result.revision.revision }); setFork(null); setHistory(null); view.refresh(); })} />
    <WorkflowPickerSheet open={picker} onOpenChange={setPicker} onPick={workflow => {
      if (!session) { setPendingWorkflow(workflow); return; }
      void action(async () => { const watermark = view.getWatermark(); const draft = await importWorkflow(session, workflow); imports.current.delete(`${session.id}:${workflow.id}`); view.merge({ drafts: [draft] }, watermark); adjust({ draftId: draft.id, revision: draft.headRevision }); view.refresh(); });
    }} />
    <SheetFrame open={!!inspection} onOpenChange={open => { if (!open) { setInspection(null); if (oldVersion != null) navigate(`/chat/${id}`, { replace: true }); } }} title={at('当时的工作流（只读）')}>
      {inspection && <button className={`${accentChip} mb-3`} onClick={() => navigate(workspaceCanvasPath(sessionId, inspection.ref))}>{at('打开草稿画布')}</button>}
      {inspection && <div className="space-y-3"><p className="text-sm">{view.drafts[inspection.ref.draftId]?.name} · {at('工作流第 {{version}} 版', { version: inspection.ref.revision })}</p><p className="text-xs text-slate-400">{at('此处展示固定版本，继续调整会创建新版本。')}</p><div className="space-y-2">{inspection.canvas.nodes.map(node => <div key={node.id} className="p-2 rounded-lg border border-white/10 text-xs"><p>{node.title ?? node.type}</p><p className="text-[11px] text-slate-500 break-words">{(node.widgets_values ?? []).filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).startsWith('asset:') ? at('已关联参考素材') : String(value)).join(' · ')}</p></div>)}</div><button className={accentChip} onClick={() => { adjust(inspection.ref); setInspection(null); }}>{at('继续调整')}</button></div>}
    </SheetFrame>
  </main></WorkspaceContext.Provider>;
}
