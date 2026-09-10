import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Loader2, Save } from 'lucide-react';
import type { Draft, Revision, RevisionRef, WorkspaceLibraryIntent, WorkspaceLibraryOperation } from '../../../shared/types/agentWorkspace';
import { ComfyFileService } from '../../../infrastructure/api/ComfyFileService';
import { sanitizeCloudWorkflowFilename } from '../../../infrastructure/sync/cloudIdentity';
import { WorkspaceLibrarySaveService } from '../../../infrastructure/library/WorkspaceLibrarySaveService';
import { beforeWorkspaceLibraryWrite, cacheWorkspaceLibrarySave } from '../../../infrastructure/library/workspaceLibraryCache';
import { useAgentText } from '../useAgentText';
import { SheetFrame } from '../WorkflowPickerSheet';
import { accentChip, chipButton } from '../chatStyles';
import { useWorkspace } from './WorkspaceContext';
import { WorkspaceMedia } from './WorkspaceMedia';

const labels = { pending: '准备入库', applying: '正在保存到工作流库', reconciling: '正在核对入库结果', succeeded: '已保存到工作流库', conflict: '工作流文件已变化，请另存为新工作流', failed: '入库已取消' } as const;
const terminal = new Set(['succeeded', 'conflict', 'failed']);

/** Mount with a fixed reference. Changing heads while the panel is open never changes what it saves. */
export function WorkspaceLibrarySheet({ reference, serverId, onClose }: { reference: RevisionRef; serverId: string; onClose: () => void }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  const files = useMemo(() => new ComfyFileService(api.baseUrl), [api]);
  const service = useMemo(() => new WorkspaceLibrarySaveService({ api, files, serverId, beforeWrite: beforeWorkspaceLibraryWrite }), [api, files, serverId]);
  const [loaded, setLoaded] = useState<{ draft: Draft; revision: Revision; etags: Map<string, string | undefined> }>();
  const [operation, setOperation] = useState<WorkspaceLibraryOperation | null>(null);
  const [intent, setIntent] = useState<WorkspaceLibraryIntent>();
  const [name, setName] = useState(''); const [asNew, setAsNew] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [attempt, reload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoaded(undefined);
    void Promise.all([api.draft(sessionId, reference.draftId, controller.signal), api.revision(sessionId, reference.draftId, reference.revision, controller.signal), files.listWorkflows(), api.currentLibrarySave(sessionId, controller.signal)])
      .then(([{ draft }, revision, listing, active]) => {
        if (controller.signal.aborted) return;
        if (!listing.success) throw new Error('无法读取服务器工作流列表');
        setLoaded({ draft, revision, etags: new Map(listing.workflows.map(item => [item.filename, item.etag])) });
        setName(draft.name); setAsNew(false);
        if (active.operation) { setOperation(active.operation); setIntent(undefined); }
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '操作失败'); });
    return () => controller.abort();
  }, [api, sessionId, reference.draftId, reference.revision, files, attempt]);
  const perform = async (fn: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { lock.current = false; setBusy(false); view.refresh(); }
  };
  const resume = async (id: string, write: boolean) => {
    const result = await service.resume(sessionId, id, write); setOperation(result);
    if (result.state === 'succeeded') await cacheWorkspaceLibrarySave(result);
  };
  const begin = async (request: WorkspaceLibraryIntent) => {
    setIntent(request);
    const { operation } = await api.beginLibrarySave(sessionId, reference.draftId, request);
    setOperation(operation); setIntent(undefined);
    await resume(operation.id, true);
  };
  const stored = loaded?.draft.lastLibrarySave ?? loaded?.draft.sourceRef;
  const target = stored?.serverId === serverId ? { serverId, workflowId: stored.workflowId, filename: stored.filename, name: stored.name, expectedEtag: stored.etag ?? loaded?.etags.get(stored.filename) } : undefined;
  const exists = target && loaded?.etags.has(target.filename);
  const conflict = !!target && (!exists || !target.expectedEtag || loaded?.etags.get(target.filename) !== target.expectedEtag);
  const identical = !!target && !conflict && loaded?.draft.lastLibrarySave?.revisionDigest === loaded?.revision.digest;
  const trimmed = name.trim(); const taken = !!loaded?.etags.has(sanitizeCloudWorkflowFilename(trimmed));
  const blocked = !!operation && !terminal.has(operation.state);
  const form = !blocked && !intent && (!operation || operation.state !== 'succeeded');
  const request = (mode: 'create' | 'update'): WorkspaceLibraryIntent => ({ requestId: crypto.randomUUID(), revision: reference.revision, mode, startedBy: 'workspace-client',
    target: mode === 'update' ? target! : { serverId, workflowId: crypto.randomUUID(), filename: sanitizeCloudWorkflowFilename(trimmed), name: trimmed } });

  return <SheetFrame open onOpenChange={open => { if (!open && !busy) onClose(); }} title={at('保存到工作流库')}>
    <div className="space-y-3 text-sm">
      <p>{operation ? operation.target.name : loaded?.draft.name} · {at('工作流第 {{version}} 版', { version: operation?.revision ?? reference.revision })}</p>
      <p className="text-xs text-slate-400">{at('保存固定版本及其参考素材，后续草稿修改不会改变本次入库。')}</p>
      {!!operation?.inputManifest?.length && <div className="flex gap-2 overflow-x-auto">{operation.inputManifest.map(input => <div key={input.bindingId} className="w-24 shrink-0"><WorkspaceMedia assetId={input.assetId} compact /></div>)}</div>}
      {operation && <p role="status" className={operation.state === 'succeeded' ? 'text-green-400' : 'text-amber-300'}>{at(labels[operation.state])}</p>}
      {operation?.result?.error && operation.state === 'reconciling' && <p className="text-xs text-slate-400">{at(operation.result.error)}</p>}
      {error && <p role="alert" className="text-xs text-red-300">{at(error)} <button className="underline" disabled={busy} onClick={() => reload(value => value + 1)}>{at('重新检查')}</button></p>}
      {busy && <Loader2 size={18} className="animate-spin" />}
      {blocked && operation && <div className="flex flex-wrap gap-2">
        <button className={accentChip} disabled={busy} onClick={() => void perform(() => resume(operation.id, true))}>{at('继续原入库操作')}</button>
        {operation.state !== 'pending' && <button className={chipButton} disabled={busy} onClick={() => void perform(() => resume(operation.id, false))}>{at('核对入库结果')}</button>}
        {operation.state === 'pending' && <button className={chipButton} disabled={busy} onClick={() => void perform(async () => { setOperation((await api.librarySaveAction(sessionId, operation.id, 'cancel')).operation); })}>{at('取消入库')}</button>}
      </div>}
      {intent && !blocked && <button className={accentChip} disabled={busy} onClick={() => void perform(() => begin(intent))}>{at('重试原保存')}</button>}
      {form && loaded && <>
        {target && conflict && <p className="text-xs text-amber-300">{at('原工作流已变化或不可用，请另存为新工作流。')}</p>}
        {identical && <p className="text-xs text-green-400">{at('已与「{{name}}」一致，无需再次保存。', { name: target!.name })}</p>}
        {target && !conflict && !identical && !asNew && <button className={accentChip} disabled={busy} onClick={() => void perform(() => begin(request('update')))}><Save size={14} />{at('更新「{{name}}」', { name: target.name })}</button>}
        {target && !conflict && !asNew && <button className={chipButton} disabled={busy} onClick={() => setAsNew(true)}>{at('另存为新工作流')}</button>}
        {(!target || conflict || asNew) && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (trimmed && !taken && serverId) void perform(() => begin(request('create'))); }}>
          <input aria-label={at('工作流名称')} maxLength={100} value={name} onChange={event => setName(event.target.value)} className="w-full p-3 rounded-lg bg-white/5 border border-white/10" />
          {taken && <p className="text-xs text-amber-300">{at('同名工作流已存在，请换一个名称')}</p>}
          <button className={accentChip} disabled={busy || !trimmed || taken || !serverId} type="submit"><FolderPlus size={14} />{at('保存为新工作流')}</button>
        </form>}
      </>}
      {!loaded && !error && <p className="text-xs text-slate-400">{at('正在检查工作流库…')}</p>}
    </div>
  </SheetFrame>;
}
