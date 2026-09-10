import { useEffect, useRef, useState } from 'react';
import type { Draft } from '../../../shared/types/agentWorkspace';
import type { DraftCopyIdentity } from '../../../infrastructure/storage/DraftWorkingCopy';
import { importDraftRecovery, inspectDraftRecovery, MAX_DRAFT_RECOVERY_BYTES, parseDraftRecovery } from '../../../infrastructure/storage/DraftRecoveryImport';
import type { DraftRecoveryDocument } from '../../../infrastructure/storage/DraftRecoveryImport';
import { IndexedDBDraftCopyStore } from '../../../infrastructure/storage/IndexedDBDraftCopyStore';
import { SheetFrame } from '../WorkflowPickerSheet';
import { accentChip } from '../chatStyles';
import { useAgentText } from '../useAgentText';
import { useWorkspace } from './WorkspaceContext';

export function DraftRecoveryImportSheet({ serverId, onClose, onImported }: { serverId: string; onClose: () => void; onImported: (identity: DraftCopyIdentity) => void }) {
  const at = useAgentText(); const { api, sessionId } = useWorkspace();
  const [preview, setPreview] = useState<{ document: DraftRecoveryDocument; draft: Draft; filename: string }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const store = useRef(new IndexedDBDraftCopyStore());
  const perform = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await fn(); } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '操作失败'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return <SheetFrame open onOpenChange={open => { if (!open && !working.current) onClose(); }} title={at('导入恢复备份')}>
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">{at('选择本对话导出的恢复文件。导入只保存到独立的本机工作副本，确认恢复前不会同步或生成。')}</p>
      <label className="block text-xs">{at('恢复备份文件')}<input type="file" accept=".json,application/json" disabled={busy} className="block mt-2 w-full" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (!file) return;
        void perform(async () => {
          setPreview(undefined);
          if (file.size > MAX_DRAFT_RECOVERY_BYTES) throw new Error('恢复文件不能超过 8 MB');
          const document = parseDraftRecovery(await file.text());
          const draft = await inspectDraftRecovery(document, { serverId, sessionId }, api);
          if (alive.current) setPreview({ document, draft, filename: file.name });
        });
      }} /></label>
      {busy && <p role="status" className="text-xs">{at('正在核对恢复文件')}</p>}
      {error && <p role="alert" className="text-xs text-amber-300">{at(error)}</p>}
      {preview && <section className="space-y-2 p-3 rounded-lg border border-white/10">
        <p className="break-words">{preview.filename}</p><p>{preview.draft.name} · {at('基于第 {{version}} 版继续', { version: preview.document.record.sourceRevision })}</p>
        <p className="text-xs text-slate-400">{at('服务器第 {{version}} 版', { version: preview.draft.headRevision })}</p>
        {preview.document.record.pending && <p className="text-xs text-amber-300">{at('备份包含待核对的保存请求，恢复时会保留原请求和版本条件。')}</p>}
        {preview.document.record.fork && <p className="text-xs text-amber-300">{at('备份包含另存操作，继续时将核对原操作的结果。')}</p>}
        <p className="text-xs text-slate-400">{at('恢复文件不包含媒体字节，参考素材仍需在本对话中可用。')}</p>
        <button className={accentChip} disabled={busy} onClick={() => void perform(async () => {
          const identity = await importDraftRecovery(store.current, preview.document, { serverId, sessionId }, api);
          if (alive.current) onImported(identity);
        })}>{at('导入为本机工作副本')}</button>
      </section>}
    </div>
  </SheetFrame>;
}
