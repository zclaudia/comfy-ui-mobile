import { useState, useSyncExternalStore } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { DraftWorkingCopy, DraftCopyIdentity } from '../../../infrastructure/storage/DraftWorkingCopy';
import { bindingsForCanvas } from '../../../infrastructure/storage/DraftWorkflowStorage';
import type { IComfyJson } from '../../../shared/types/app/IComfyJson';
import type { Revision, RevisionRef } from '../../../shared/types/agentWorkspace';
import { exportRecoveryJson } from '../../../platform/recoveryExport';
import { useWorkspace } from './WorkspaceContext';
import { SheetFrame } from '../WorkflowPickerSheet';
import { useAgentText } from '../useAgentText';
import { accentChip, chipButton } from '../chatStyles';

export function DraftRecoverySheet({ copy, open, onClose, name, capture, checkpoint, onIsolated, onForked, onLeave, onDiscarded, disabled }: {
  copy: DraftWorkingCopy; open: boolean; onClose: () => void; name: string; capture: () => Promise<IComfyJson>; checkpoint: () => Promise<void>;
  onIsolated: (identity: DraftCopyIdentity) => void; onForked: (ref: RevisionRef) => void; onLeave: () => void; onDiscarded: () => void; disabled: boolean;
}) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot);
  const [forkName, setForkName] = useState(`${name} · ${at('另一方向')}`); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [remote, setRemote] = useState<Revision>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const perform = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); } };
  const draftId = copy.recoverySnapshot().record.identity.draftId;
  const discarded = copy.recoverySnapshot().record.discarded;
  return <SheetFrame open={open} onOpenChange={value => { if (!value && !busy) onClose(); }} title={at('恢复草稿修改')}>
    <div className="space-y-3 text-sm">
      <p>{name} · {at('基于第 {{version}} 版继续', { version: state.sourceRevision })}</p>
      {state.recovering && <p className="text-xs text-blue-300">{at('恢复内容已保存在本机，等待确认同步')}</p>}
      {state.discarding && <p className="text-xs text-amber-300">{at('正在核对放弃操作，本机内容保留，暂不继续编辑或同步。')}</p>}
      {discarded?.savedRevision && <p>{at('原保存已完成，第 {{version}} 版仍保留在历史中。', { version: discarded.savedRevision })}</p>}
      {discarded?.forkedTo && <button className={chipButton} onClick={() => onForked(discarded.forkedTo!)}>{at('打开已另存的创作')}</button>}
      <p className="text-xs text-amber-300">{at(state.memoryOnly ? '最新修改尚未写入本机，请先导出备份或另存。' : '本地修改仍然保留，不会自动覆盖服务器的新版本。')}</p>
      {!!(error || state.error) && <p role="alert" className="text-xs text-red-300">{at(error || (state.error instanceof Error ? state.error.message : '操作失败'))}</p>}
      {busy && <Loader2 className="animate-spin" size={18} />}
      <div className="flex flex-wrap gap-2">
        <button className={chipButton} disabled={busy} onClick={() => void perform(async () => {
          const recovery = copy.recoverySnapshot(); recovery.local.canvas = await capture();
          await exportRecoveryJson(`draft-recovery-${draftId}.json`, JSON.stringify(recovery, null, 2));
        })}><Download size={14} />{at('导出恢复备份')}</button>
        {!state.discarding && !state.forking && !state.forkedTo && <button className={chipButton} disabled={busy || disabled} onClick={() => void perform(async () => { await checkpoint(); await copy.confirmRecovery(); if (state.rejected) await copy.repairRejected(at('画布修改')); else await copy.flush(at('画布修改')); view.refresh(); onClose(); })}>{at(state.recovering ? '确认并同步恢复内容' : state.rejected ? '保存修正后的内容' : '重试同步')}</button>}
        <button className={chipButton} disabled={busy} onClick={() => void perform(async () => { const { draft } = await api.draft(sessionId, draftId); setRemote(await api.revision(sessionId, draftId, draft.headRevision)); })}>{at('查看服务器版本')}</button>
      </div>
      {remote && <section className="p-3 rounded-lg border border-white/10 space-y-2"><p>{at('服务器第 {{version}} 版（只读）', { version: remote.revision })}</p><div className="max-h-48 overflow-y-auto space-y-2">{remote.canvas.nodes.map(node => <p key={node.id} className="text-xs break-words">{node.title ?? node.type} · {(node.widgets_values ?? []).filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).startsWith('asset:') ? at('已关联参考素材') : String(value)).join(' · ')}</p>)}</div></section>}
      {!state.discarding && !state.forking && !state.forkedTo && <div className="space-y-2 border-t border-white/10 pt-3">
        <p className="text-xs text-slate-400">{at('另存会保留当前本地画布和参考素材，原创作保持不变。')}</p>
        <input aria-label={at('创作名称')} maxLength={100} className="w-full rounded-lg p-3 bg-white/5 border border-white/10" value={forkName} onChange={event => setForkName(event.target.value)} />
        <button className={accentChip} disabled={busy || !forkName.trim()} onClick={() => void perform(async () => {
          // A failed checkpoint retains the exact editor snapshot in memory. The isolated slot never overwrites another editor.
          const canvas = await capture(); const bindings = bindingsForCanvas(canvas, copy.content().bindings);
          try { await copy.checkpoint({ canvas, bindings }); } catch { /* isolateForFork saves the staged snapshot under a fresh local key. */ }
          onIsolated(await copy.isolateForFork(forkName.trim()));
        })}>{at('另存本地修改为新创作')}</button>
      </div>}
      {state.forking && !state.discarding && <button className={accentChip} disabled={busy || disabled} onClick={() => void perform(async () => { await copy.confirmRecovery(); onForked(await copy.resumeFork(input => api.forkLocal(sessionId, draftId, input))); })}>{at('继续本地另存操作')}</button>}
      {state.forkedTo && <button className={accentChip} onClick={() => onForked(state.forkedTo!)}>{at('打开已另存的创作')}</button>}
      <div className="space-y-2 border-t border-white/10 pt-3">
        <button className={chipButton} disabled={busy || state.syncing || disabled} onClick={() => setConfirmDiscard(true)}>{at(state.discarding ? '继续核对放弃操作' : '放弃本机修改')}</button>
        {confirmDiscard && <section className="space-y-2 rounded-lg border border-amber-400/30 p-3">
          <p>{at('将放弃此副本尚未同步的节点参数、连线和参考素材选择，并采用服务器当前版本。可先导出恢复备份。')}</p>
          <p className="text-xs text-slate-400">{at('已提交的版本和另存创作会保留；未提交的原请求将取消，不会生成图片或视频。')}</p>
          <button className={accentChip} disabled={busy || state.syncing || disabled} onClick={() => void perform(async () => {
            // Capture without flushing; a failed checkpoint remains staged and must still be recoverable.
            if (!state.discarding) {
              const canvas = await capture();
              // A graph with invalid bindings must still be discardable; this checkpoint is never executed.
              await copy.checkpoint({ canvas, bindings: copy.content().bindings });
            }
            await copy.discardLocal(record => api.discardLocal(sessionId, draftId, { ...(record.pending ? { pending: record.pending } : {}), ...(record.fork ? { fork: record.fork.request } : {}) }));
            onDiscarded();
          })}>{at('确认放弃并打开服务器版本')}</button>
          <button className={chipButton} disabled={busy} onClick={() => setConfirmDiscard(false)}>{at('取消')}</button>
        </section>}
      </div>
      <button className={chipButton} disabled={busy || state.memoryOnly || state.syncing} onClick={() => void perform(async () => { if (!state.discarding) await checkpoint(); onLeave(); })}>{at('返回聊天并保留本地修改')}</button>
    </div>
  </SheetFrame>;
}
