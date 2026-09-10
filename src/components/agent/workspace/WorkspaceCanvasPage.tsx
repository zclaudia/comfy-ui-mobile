import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { History, ImagePlus, Loader2, Play, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import WorkflowEditor from '../../workflow/WorkflowEditor';
import type { WorkflowEditorHandle, WorkflowEditorIntegration } from '../../workflow/WorkflowEditorStorage';
import { useCanvasV2Store } from '../../../ui/store/canvasV2Store';
import { AgentApi } from '../../../infrastructure/api/AgentApi';
import { comfyAuthenticatedFetch } from '../../../infrastructure/auth/ComfyAuthService';
import type { IObjectInfo } from '../../../shared/types/comfy/IComfyObjectInfo';
import { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import { DraftWorkingCopy } from '../../../infrastructure/storage/DraftWorkingCopy';
import { IndexedDBDraftCopyStore } from '../../../infrastructure/storage/IndexedDBDraftCopyStore';
import { bindDraftAsset, bindingsForCanvas, draftLoaderInputs, DraftWorkflowStorage } from '../../../infrastructure/storage/DraftWorkflowStorage';
import type { Asset, Draft, RevisionRef } from '../../../shared/types/agentWorkspace';
import type { IComfyJson } from '../../../shared/types/app/IComfyJson';
import { useAgentText } from '../useAgentText';
import { ChatHeader } from '../ChatHeader';
import { SheetFrame } from '../WorkflowPickerSheet';
import { uploadAttachment } from '../useAttachments';
import { rejectReason } from '../attachments';
import { accentChip, chipButton } from '../chatStyles';
import { WorkspaceContext } from './WorkspaceContext';
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot';
import { AssetPicker, DraftHistory } from './WorkspaceSheets';
import { WorkspaceMedia } from './WorkspaceMedia';
import { WorkspaceCommands } from './commands';
import { workspaceCanvasPath, workspaceRecoveryChatPath } from './canvasNavigation';
import { WorkspaceLibrarySheet } from './WorkspaceLibrarySheet';
import { DraftRecoverySheet } from './DraftRecoverySheet';
import { loadDraftCanvas } from '../../../infrastructure/storage/DraftCanvasLoader';
import { offlineShellSnapshot, subscribeOfflineShell } from '../../../platform/offlineShell';

const copies = new IndexedDBDraftCopyStore();
const activeStates = new Set(['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling']);

interface LoadedCanvas {
  copy: DraftWorkingCopy; storage: DraftWorkflowStorage; api: WorkspaceApi; serverId: string;
  objectInfo: IObjectInfo; initiallyOffline: boolean; lease: { verified: boolean }; warning?: string;
}
export function WorkspaceCanvasPage({ baseUrl }: { baseUrl: string }) {
  const { sessionId = '', draftId = '' } = useParams(); const [params] = useSearchParams();
  const requested = Number(params.get('revision')); const navigate = useNavigate(); const at = useAgentText();
  const textRef = useRef(at); textRef.current = at;
  const copyId = params.get('copy') ?? undefined;
  const statusApi = useMemo(() => new AgentApi(baseUrl), [baseUrl]);
  const [loaded, setLoaded] = useState<LoadedCanvas>();
  const [error, setError] = useState(''); const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoaded(undefined); setError('');
    void (async () => {
      if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('无效的草稿版本链接');
      if (copyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copyId)) throw new Error('无效的草稿版本链接');
      const cached = await loadDraftCanvas(copies, baseUrl, { sessionId, draftId, openedRevision: requested, ...(copyId ? { copyId } : {}) }, {
        status: signal => statusApi.status(signal), api: serverId => new WorkspaceApi(baseUrl, serverId),
        objectInfo: async signal => {
          const response = await comfyAuthenticatedFetch(`${baseUrl.replace(/\/$/, '')}/object_info`, { signal });
          if (!response.ok) throw new Error('无法读取节点参数定义');
          const info = await response.json(); if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('无法读取节点参数定义');
          return info as IObjectInfo;
        },
      }, controller.signal);
      controller.signal.throwIfAborted();
      const identity = { serverId: cached.serverId, sessionId, draftId, openedRevision: requested, ...(copyId ? { copyId } : {}) };
      const api = new WorkspaceApi(baseUrl, cached.serverId); const lease = { verified: cached.online };
      const copy = await DraftWorkingCopy.open(copies, identity, cached.revision, cached.draft.headRevision, input => {
        if (!lease.verified) return Promise.reject(new Error('请先重新连接并核对服务器'));
        return api.saveRevision(sessionId, draftId, input);
      });
      if (!controller.signal.aborted) setLoaded({ copy, storage: new DraftWorkflowStorage(copy, cached.draft, identity, () => textRef.current('画布修改')),
        api, serverId: cached.serverId, lease, objectInfo: cached.objectInfo, initiallyOffline: !cached.online, warning: cached.warning });
    })().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '操作失败'); });
    return () => controller.abort();
  }, [statusApi, baseUrl, sessionId, draftId, requested, copyId, attempt]);
  if (!loaded) return <main className="h-dvh bg-[#0b0c0f] text-slate-200"><ChatHeader title={at('草稿画布')} onBack={() => navigate(`/chat/${sessionId}`)} /><div className="p-6 text-sm">{error ? <><p role="alert">{at(error)}</p><button className={chipButton} onClick={() => retry(value => value + 1)}>{at('重试')}</button></> : <Loader2 className="animate-spin" />}</div></main>;
  return <DraftCanvasSession key={loaded.storage.id} sessionId={sessionId} {...loaded} onDiscarded={() => retry(value => value + 1)} />;
}

function DraftCanvasSession({ api, sessionId, serverId, copy, storage, objectInfo, initiallyOffline, lease, warning, onDiscarded }: LoadedCanvas & { sessionId: string; onDiscarded: () => void }) {
  const at = useAgentText(); const navigate = useNavigate(); const view = useWorkspaceSnapshot(api, sessionId);
  const { refresh } = view;
  const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot);
  const preferredOfficial = useCanvasV2Store(value => value.officialCanvasEnabled); const official = preferredOfficial && !initiallyOffline;
  const [connected, setConnected] = useState(!initiallyOffline); const [connectionError, setConnectionError] = useState(initiallyOffline ? warning ?? '' : ''); const reconnecting = useRef(false);
  const alive = useRef(true); useEffect(() => { alive.current = true; lease.verified = !initiallyOffline; return () => { alive.current = false; lease.verified = false; }; }, [lease, initiallyOffline]);
  const reconnect = useCallback(async () => {
    if (reconnecting.current) return;
    reconnecting.current = true;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const status = await new AgentApi(api.baseUrl).status(controller.signal);
      if (status.agentSchemaVersion !== 2 || status.serverId !== serverId) throw new Error('服务器身份已变化，本机草稿保持离线');
      await api.draft(sessionId, storage.draft.id, controller.signal);
      if (alive.current) { lease.verified = true; setConnected(true); setConnectionError(''); refresh(); }
    } catch (error) { if (alive.current) { lease.verified = false; setConnected(false); setConnectionError(error instanceof Error ? error.message : '连接中断，正在重试'); } }
    finally { clearTimeout(timer); reconnecting.current = false; }
  }, [api, sessionId, serverId, storage.draft.id, lease, refresh]);
  useEffect(() => { window.addEventListener('online', reconnect); return () => window.removeEventListener('online', reconnect); }, [reconnect]);
  useEffect(() => {
    if (view.error) { lease.verified = false; setConnected(false); }
    else if (view.snapshot && !lease.verified) void reconnect();
  }, [view.error, view.snapshot, lease, reconnect]);
  const editor = useRef<WorkflowEditorHandle>(null); const fileInput = useRef<HTMLInputElement>(null);
  const commands = useRef(new WorkspaceCommands()); const inFlight = useRef(false);
  const [busy, setBusy] = useState(false); const [inputsOpen, setInputsOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string>(); const [historyOpen, setHistoryOpen] = useState(false);
  const [libraryRef, setLibraryRef] = useState<RevisionRef | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(() => copy.getSnapshot().recovering || copy.getSnapshot().discarding || copy.getSnapshot().forking || !!copy.getSnapshot().forkedTo);
  const [loaderCanvas, setLoaderCanvas] = useState<IComfyJson>(() => copy.content().canvas);
  const draft = view.drafts[storage.draft.id] ?? storage.draft;
  const task = view.snapshot?.tasks.find(task => activeStates.has(task.state));
  const unavailable = !connected || !!view.error || !!task || !!view.snapshot?.session.archivedAt || !!draft.archivedAt || !view.snapshot;
  const onError = useCallback((error: unknown) => { toast.error(at(error instanceof Error ? error.message : '操作失败')); if (copy.getSnapshot().error) setRecoveryOpen(true); }, [at, copy]);
  const leave = useCallback((ref: RevisionRef) => navigate(`/chat/${sessionId}?targetDraft=${encodeURIComponent(ref.draftId)}&sourceRevision=${ref.revision}`), [navigate, sessionId]);
  const action = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await fn(); } catch (error) { onError(error); } finally { inFlight.current = false; setBusy(false); }
  };
  const writeUnavailable = unavailable || state.recovering || state.discarding || state.forking || !!state.forkedTo;
  const latest = useRef({ unavailable: writeUnavailable, draft, action, leave, onError, view }); latest.current = { unavailable: writeUnavailable, draft, action, leave, onError, view };
  const capture = async () => editor.current ? editor.current.capture() : copy.content().canvas;
  const checkpoint = async () => storage.checkpoint(await capture());
  const openForked = useCallback((ref: RevisionRef) => navigate(workspaceCanvasPath(sessionId, ref)), [navigate, sessionId]);
  const triedFork = useRef(false);
  useEffect(() => {
    if (state.forking && !state.recovering && !state.discarding && !unavailable && !triedFork.current) {
      triedFork.current = true;
      void latest.current.action(async () => openForked(await copy.resumeFork(input => api.forkLocal(sessionId, storage.draft.id, input))));
    }
  }, [copy, state.forking, state.recovering, state.discarding, unavailable, api, sessionId, storage.draft.id, openForked]);
  useEffect(() => {
    const sync = () => {
      const current = copy.getSnapshot();
      if (!latest.current.unavailable && !current.rejected && !current.memoryOnly && (current.dirty || current.pending)) void latest.current.action(async () => { await copy.flush(at('画布修改')); latest.current.view.refresh(); });
    };
    if (!unavailable && !copy.getSnapshot().error) sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [copy, unavailable, at]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (copy.getSnapshot().memoryOnly) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [copy]);

  const save = async () => {
    if (latest.current.unavailable) throw new Error('请等待当前任务结束后保存');
    if (editor.current) await storage.checkpoint(await editor.current.capture());
    await copy.flush(at('画布修改')); view.refresh();
  };
  const pickAsset = async (asset: Asset, nodeId: string) => {
    if (!editor.current) return;
    const canvas = await editor.current.capture();
    const next = bindDraftAsset({ canvas, bindings: copy.content().bindings }, nodeId, asset, sessionId);
    next.bindings = bindingsForCanvas(next.canvas, next.bindings);
    await copy.checkpoint(next);
    await editor.current.reload(next.canvas);
    setLoaderCanvas(next.canvas); setSelectedNode(undefined);
    if (!latest.current.unavailable) await copy.flush(at('画布修改'));
    view.refresh();
  };
  const openInputs = async () => {
    if (editor.current) setLoaderCanvas(await editor.current.capture());
    setInputsOpen(true);
  };
  const actionsRef = useRef({ save, openInputs }); actionsRef.current = { save, openInputs };
  const integration = useMemo<WorkflowEditorIntegration>(() => ({
    storage, hasUnsavedChanges: state.dirty || state.pending || state.memoryOnly,
    loadObjectInfo: async () => objectInfo, forceMobileCanvas: initiallyOffline,
    onError: error => latest.current.onError(error),
    checkpoint: async canvas => {
      await storage.checkpoint(canvas);
      if (!latest.current.unavailable && !copy.getSnapshot().error && (copy.getSnapshot().dirty || copy.getSnapshot().pending)) {
        await copy.flush(at('画布修改')); latest.current.view.refresh();
      }
    },
    exit: async canvas => {
      try {
        if (canvas) await storage.checkpoint(canvas);
        if (!latest.current.unavailable) await copy.flush(at('画布修改'));
        latest.current.leave({ draftId: storage.draft.id, revision: copy.getSnapshot().sourceRevision });
      } catch (error) { setRecoveryOpen(true); latest.current.onError(error); }
    },
    execute: async canvas => latest.current.action(async () => {
      if (latest.current.unavailable) throw new Error('请等待当前任务结束后保存');
      await storage.checkpoint(canvas); const revision = await copy.flush(at('画布修改'));
      await commands.current.run(`generate:${storage.draft.id}:${revision}`, { revision }, (input, requestId) => api.generate(sessionId, storage.draft.id, input.revision, requestId));
      latest.current.leave({ draftId: storage.draft.id, revision });
    }),
    openHistory: () => setHistoryOpen(true),
    renderActions: execute => <CanvasActions copy={copy} disabled={latest.current.unavailable} busy={inFlight.current}
      connection={{ online: connected, warning: connectionError || (!initiallyOffline ? warning : undefined), reconnect }}
      onSave={() => void latest.current.action(actionsRef.current.save)} onGenerate={() => void execute()}
      onInputs={() => void latest.current.action(actionsRef.current.openInputs)} onHistory={() => setHistoryOpen(true)}
      onRecovery={() => setRecoveryOpen(true)}
      onLibrary={() => void latest.current.action(async () => { await actionsRef.current.save(); setLibraryRef({ draftId: storage.draft.id, revision: copy.getSnapshot().sourceRevision }); })} />,
    renderParameter: (nodeId, inputName) => {
      const node = copy.content().canvas.nodes.find(node => Number(node.id) === nodeId);
      if (!node || draftLoaderInputs[node.type]?.inputName !== inputName) return undefined;
      const binding = copy.content().bindings.find(binding => binding.nodeId === String(nodeId) && binding.inputName === inputName);
      return <button className="w-full text-left p-2 rounded-lg border border-blue-400/30 text-xs" onClick={() => setSelectedNode(String(nodeId))}>{binding ? <WorkspaceMedia assetId={binding.assetId} compact /> : at('待关联输入')}<span className="block mt-1">{at('选择参考素材')}</span></button>;
    },
  }), [storage, copy, api, sessionId, objectInfo, initiallyOffline, connected, connectionError, warning, reconnect, state.dirty, state.pending, state.memoryOnly, at]);
  const selectedLoader = selectedNode ? (loaderCanvas.nodes.find(node => String(node.id) === selectedNode) ?? copy.content().canvas.nodes.find(node => String(node.id) === selectedNode)) : undefined;
  const selectedKind = selectedLoader ? draftLoaderInputs[selectedLoader.type]?.kind : undefined;
  const navigateCanvas = async (ref: RevisionRef) => { if (editor.current) await storage.checkpoint(await editor.current.capture()); navigate(workspaceCanvasPath(sessionId, ref)); };

  return <WorkspaceContext.Provider value={{ api, sessionId, view }}><div data-workspace-canvas className="h-dvh">
    <div inert={state.discarding || state.forking || !!state.forkedTo} className="h-full"><WorkflowEditor key={`${storage.id}:${official ? 'official' : 'mobile'}`} integration={integration} editorRef={editor} /></div>
    {(state.discarding || state.forking || state.forkedTo) && <button className={`${accentChip} fixed bottom-6 left-4 z-50`} onClick={() => setRecoveryOpen(true)}>{at('恢复草稿修改')}</button>}
    <DraftRecoverySheet copy={copy} open={recoveryOpen} onClose={() => setRecoveryOpen(false)} name={draft.name} capture={capture} checkpoint={checkpoint} disabled={unavailable || busy}
      onIsolated={identity => navigate(workspaceCanvasPath(sessionId, { draftId: identity.draftId, revision: identity.openedRevision }, identity.copyId))}
      onForked={openForked} onDiscarded={() => { toast.success(at('已采用服务器版本，已提交的历史和另存创作仍保留')); onDiscarded(); }} onLeave={() => navigate(workspaceRecoveryChatPath(sessionId, copy.recoverySnapshot().record.identity, copy.getSnapshot().sourceRevision))} />
    {libraryRef && <WorkspaceLibrarySheet reference={libraryRef} serverId={serverId} onClose={() => setLibraryRef(null)} />}
    <SheetFrame open={inputsOpen} onOpenChange={setInputsOpen} title={at('参考素材')}>
      <div className="space-y-3">{loaderCanvas.nodes.filter(node => draftLoaderInputs[node.type]).map(node => {
        const binding = copy.content().bindings.find(binding => binding.nodeId === String(node.id));
        return <div key={node.id} className="rounded-xl p-3 border border-white/10 space-y-2"><p className="text-sm">{node.title ?? node.type} · {node.id}</p>{binding ? <WorkspaceMedia assetId={binding.assetId} compact /> : <p className="text-xs text-amber-300">{at('待关联输入')}</p>}<button className={chipButton} disabled={busy} onClick={() => { setInputsOpen(false); setSelectedNode(String(node.id)); }}>{at('选择参考素材')}</button></div>;
      })}</div>
      {!loaderCanvas.nodes.some(node => draftLoaderInputs[node.type]) && <p className="text-xs text-slate-400">{at('此工作流没有需要关联的媒体输入')}</p>}
    </SheetFrame>
    <AssetPicker open={!!selectedNode} onOpenChange={open => { if (!open && !busy) setSelectedNode(undefined); }} kind={selectedKind}
      onPick={asset => { if (selectedNode) void action(() => pickAsset(asset, selectedNode)); }}
      header={<button className={chipButton} disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={14} />{at('上传素材')}</button>} />
    <input ref={fileInput} type="file" className="hidden" accept={selectedKind === 'image' ? 'image/*' : selectedKind === 'audio' ? 'audio/*' : 'video/*'} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; const nodeId = selectedNode;
      if (!file || !nodeId) return;
      void action(async () => { const reason = rejectReason(file, 0); if (reason) throw new Error(reason); const uploaded = await uploadAttachment(api.baseUrl, file); const { asset } = await api.registerAsset(sessionId, uploaded, crypto.randomUUID()); await pickAsset(asset, nodeId); });
    }} />
    <DraftHistory draft={historyOpen ? { ...draft, headRevision: Math.max(draft.headRevision, state.expectedHeadRevision) } : null} onClose={() => setHistoryOpen(false)} busy={busy || unavailable}
      onCanvas={ref => void action(() => navigateCanvas(ref))} onContinue={ref => void action(() => navigateCanvas(ref))}
      onRestore={(draft: Draft, revision: number) => void action(async () => { await save(); const head = (await api.draft(sessionId, draft.id)).draft.headRevision; const result = await commands.current.run(`restore:${draft.id}:${revision}`, { revision, head }, (input, requestId) => api.restore(sessionId, draft.id, input.revision, input.head, requestId)); navigate(workspaceCanvasPath(sessionId, result.revision)); })}
      onFork={(draft, revision) => void action(async () => { if (editor.current) await storage.checkpoint(await editor.current.capture()); const result = await commands.current.run(`fork:${draft.id}:${revision}`, { revision, name: `${draft.name} · ${at('另一方向')}` }, (input, requestId) => api.fork(sessionId, draft.id, input.revision, input.name, requestId)); navigate(workspaceCanvasPath(sessionId, result.revision)); })} />
  </div></WorkspaceContext.Provider>;
}

function CanvasActions({ copy, disabled, busy, connection, onSave, onGenerate, onInputs, onHistory, onLibrary, onRecovery }: { copy: DraftWorkingCopy; disabled: boolean; busy: boolean; connection: { online: boolean; warning?: string; reconnect: () => void }; onSave: () => void; onGenerate: () => void; onInputs: () => void; onHistory: () => void; onLibrary: () => void; onRecovery: () => void }) {
  const at = useAgentText(); const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot);
  const shell = useSyncExternalStore(subscribeOfflineShell, offlineShellSnapshot);
  return <aside className="fixed z-40 bottom-4 left-3 right-3 sm:right-auto sm:max-w-md p-3 rounded-xl border border-white/10 bg-[#10131b]/95 text-slate-200 shadow-xl space-y-2" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
    {shell !== 'development' && shell !== 'bundled' && <p data-offline-shell={shell} className="text-[11px] text-slate-400">{at(shell === 'ready' ? '离线页面已准备，已缓存的草稿可在断网后重新打开' : shell === 'checking' ? '正在准备离线页面' : '离线页面尚未准备，断网刷新可能无法打开')}</p>}
    {(!connection.online || connection.warning) && <div className="text-xs text-amber-300 space-y-1" role="status">{!connection.online && <p>{at('本机模式：修改只保存在此设备，重新连接后才能同步和生成')}</p>}{connection.warning && <p>{at(connection.warning)}</p>}{!connection.online && <button className={chipButton} onClick={connection.reconnect}>{at('重新连接')}</button>}</div>}
    <p className="text-xs" role="status">{at('工作流第 {{version}} 版', { version: state.sourceRevision })} · {at(state.memoryOnly ? '最新修改尚未写入本机' : state.recovering ? '恢复内容已保存在本机，等待确认同步' : state.syncing ? '正在保存草稿' : state.dirty || state.pending ? '修改已保存在本机，尚未同步' : '草稿已保存')}</p>
    {disabled && !state.recovering && <p className="text-[11px] text-amber-300">{at('暂时只能保存本地修改')}</p>}
    {!!state.error && <p className="text-[11px] text-amber-300" role="alert">{at(state.error instanceof Error ? state.error.message : '操作失败')}</p>}
    <button className={chipButton} disabled={busy} onClick={onRecovery}>{at('恢复草稿修改')}</button>
    <div className="flex flex-wrap gap-2"><button className={accentChip} disabled={disabled || busy || state.syncing} onClick={onGenerate}><Play size={13} />{at('生成')}</button><button className={chipButton} disabled={disabled || busy || state.syncing} onClick={onSave}><Save size={13} />{at(state.error ? '重试保存' : '保存')}</button><button className={chipButton} disabled={busy} onClick={onInputs}><ImagePlus size={13} />{at('参考素材')}</button><button className={chipButton} onClick={onHistory}><History size={13} />{at('版本历史')}</button><button className={chipButton} disabled={disabled || busy || state.syncing} onClick={onLibrary}>{at('保存到工作流库')}</button></div>
  </aside>;
}
