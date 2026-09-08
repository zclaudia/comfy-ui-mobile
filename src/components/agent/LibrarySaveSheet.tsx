import { useEffect, useState } from 'react';
import { Loader2, Save, FolderPlus, Eye } from 'lucide-react';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import type { LibrarySaveService } from '@/infrastructure/library/LibrarySaveService';
import { nameTaken, type SaveAvailability, type SaveRequest } from '@/infrastructure/library/librarySaveMachine';
import { useAgentText } from './useAgentText';
import { SheetFrame } from './WorkflowPickerSheet';
import { accentChip, chipButton } from './chatStyles';

const field = 'w-full h-11 px-3 rounded-[10px] border border-white/[0.08] bg-white/[0.045] text-[13px] text-[#e9ebef] focus:outline-none focus:border-[#3069f0]/60';
const primary = 'h-11 w-full rounded-[10px] bg-[#3069f0] text-[13px] font-semibold text-white disabled:opacity-40 flex items-center justify-center gap-2';

/**
 * The explicit "save to library" panel. It pins one draft version, asks the server what the target looks like right
 * now, and offers exactly the actions that situation allows. Nothing here writes the library on its own.
 */
export function LibrarySaveSheet({ open, onOpenChange, session, draft, service, defaultName, onViewTarget, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; session: AgentSession; draft: { version: number; canvas: IComfyJson } | null;
  service: LibrarySaveService; defaultName: string; onViewTarget?: (workflowId: string) => void; onSave: (request: SaveRequest) => Promise<void>;
}) {
  const at = useAgentText();
  const [state, setState] = useState<{ availability: SaveAvailability; remoteFilenames: string[] } | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState(defaultName);
  const [asNew, setAsNew] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !draft) return;
    setState(null); setError(''); setAsNew(false); setName(defaultName);
    let cancelled = false;
    service.availability(session, draft.canvas)
      .then(result => { if (!cancelled) setState(result); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [open, draft, session, service, defaultName]);

  const submit = async (request: SaveRequest) => {
    setBusy(true);
    try { await onSave(request); onOpenChange(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const trimmed = name.trim();
  const taken = !!state && trimmed.length > 0 && nameTaken(trimmed, state.remoteFilenames);
  const createForm = <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (trimmed && !taken) void submit({ mode: 'create', name: trimmed, workflowId: crypto.randomUUID() }); }}>
    <input value={name} onChange={e => setName(e.target.value)} maxLength={100} aria-label={at('工作流名称')} placeholder={at('工作流名称')} className={field} />
    {taken && <p className="text-[11.5px] text-[#f0a35b]">{at('同名工作流已存在，请换一个名称')}</p>}
    <button type="submit" disabled={busy || !trimmed || taken} className={primary} data-agent-save-create>{busy ? <Loader2 size={15} className="animate-spin" /> : <FolderPlus size={15} />}{at('保存为新工作流')}</button>
  </form>;
  const target = state && 'target' in state.availability ? state.availability.target : undefined;
  const updateButton = target && <button disabled={busy} className={primary} data-agent-save-update onClick={() => void submit({ mode: 'update', target })}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}{at('更新「{{name}}」', { name: target.name })}</button>;
  const saveAsNew = <button data-agent-save-as-new className={chipButton} onClick={() => setAsNew(true)}><FolderPlus size={13} />{at('另存为新工作流')}</button>;

  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('保存到工作流库')}>
    <div className="space-y-3 text-[12.5px] text-[#c8ccd4]">
      {draft && <p className="font-mono text-[10px] text-[#565d6b] tracking-[0.1em] uppercase">{at('将保存版本 {{version}}', { version: draft.version })}</p>}
      {error && <p role="alert" className="text-[12px] text-[#f87c7c]">{error}</p>}
      {!state && !error && <p className="flex items-center gap-2 text-[#8a919e]"><Loader2 size={14} className="animate-spin" />{at('正在检查工作流库…')}</p>}
      {state?.availability.kind === 'busy' && <p className="text-[#f0a35b]">{at('另一设备正在保存这个对话，请稍后再试。')}</p>}
      {state?.availability.kind === 'create' && createForm}
      {state?.availability.kind === 'missing' && target && <>
        <p className="text-[#f0a35b]">{at('「{{name}}」已从服务器删除，可以保存为新工作流。', { name: target.name })}</p>
        {createForm}
      </>}
      {state?.availability.kind === 'conflict' && target && <>
        <p className="text-[#f0a35b]">{at('「{{name}}」已被其他设备修改。为避免覆盖，这里只能另存为新工作流。', { name: target.name })}</p>
        <div className="flex gap-2 flex-wrap">
          {onViewTarget && <button className={accentChip} onClick={() => { onOpenChange(false); onViewTarget(target.workflowId); }}><Eye size={13} />{at('查看当前版本')}</button>}
          {!asNew && saveAsNew}
        </div>
        {asNew && createForm}
      </>}
      {state?.availability.kind === 'identical' && target && <>
        <p className="text-[#4ade80]">{at('已与「{{name}}」一致，无需再次保存。', { name: target.name })}</p>
        {!asNew && saveAsNew}
        {asNew && createForm}
      </>}
      {state?.availability.kind === 'update' && target && <>
        <p className="text-[#8a919e]">{at('更新会影响以后使用「{{name}}」开始的对话；已经开始的对话仍使用各自的草稿。', { name: target.name })}</p>
        {!asNew && <div className="space-y-2">{updateButton}<div>{saveAsNew}</div></div>}
        {asNew && createForm}
      </>}
    </div>
  </SheetFrame>;
}
