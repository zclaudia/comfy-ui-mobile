import { useRef, useState } from 'react';
import type { Draft } from '../../../shared/types/agentWorkspace';
import { SheetFrame } from '../WorkflowPickerSheet';
import { accentChip, chipButton } from '../chatStyles';
import { useAgentText } from '../useAgentText';
import { useWorkspace } from './WorkspaceContext';

/** Metadata changes leave revisions, generated results, bindings and library files intact. */
export function DraftManagementSheet({ draft, onClose, disabled }: { draft: Draft; onClose: () => void; disabled: boolean }) {
  const at = useAgentText(); const { api, sessionId, view } = useWorkspace();
  const current = view.drafts[draft.id] ?? draft;
  const [name, setName] = useState(draft.name);
  const [busy, setBusy] = useState(false); const working = useRef(false);
  const [error, setError] = useState('');
  async function update(patch: { name?: string; archivedAt?: number | null }) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); setError('');
    const watermark = view.getWatermark();
    try {
      const result = await api.updateDraft(sessionId, draft.id, patch);
      view.merge({ drafts: [result.draft] }, watermark); view.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { working.current = false; setBusy(false); }
  }
  const unavailable = busy || disabled;
  return <SheetFrame open onOpenChange={open => { if (!open && !working.current) onClose(); }} title={at('管理创作')}>
    <div className="space-y-4" data-workspace-manage-draft={draft.id}>
      <p className="text-sm break-words">{current.name} · {at('工作流第 {{version}} 版', { version: current.headRevision })}{current.archivedAt != null && ` · ${at('已归档')}`}</p>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (name.trim() && name.trim() !== current.name) void update({ name: name.trim() }); }}>
        <label className="block text-xs text-slate-400" htmlFor="workspace-draft-name">{at('创作名称')}</label>
        <input id="workspace-draft-name" value={name} onChange={event => setName(event.target.value)} disabled={unavailable} maxLength={100} className="w-full h-11 rounded-lg border border-white/10 bg-white/5 px-3 text-sm outline-none focus:border-blue-400" />
        <button type="submit" className={accentChip} disabled={unavailable || !name.trim() || name.trim() === current.name}>{at('保存名称')}</button>
      </form>
      <div className="border-t border-white/10 pt-3 space-y-2">
        <p className="text-xs text-slate-400">{at('归档后可从创作列表恢复；历史结果、参考素材和已保存的工作流仍然保留。')}</p>
        <button className={chipButton} disabled={unavailable} onClick={() => void update({ archivedAt: current.archivedAt != null ? null : Date.now() })}>{at(current.archivedAt != null ? '恢复创作' : '归档创作')}</button>
      </div>
      {disabled && <p role="status" className="text-xs text-amber-300">{at('会话归档或任务进行中，暂时不能修改创作。')}</p>}
      {error && <p role="alert" className="text-xs text-amber-300">{at(error)}</p>}
    </div>
  </SheetFrame>;
}
