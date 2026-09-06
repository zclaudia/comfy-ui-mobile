import { useEffect, useState } from 'react';
import { useAgentText } from './useAgentText';
import { SheetFrame } from './WorkflowPickerSheet';

export function RenameSheet({ open, onOpenChange, initial, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; initial: string; onSubmit: (name: string) => void }) {
  const at = useAgentText();
  const [value, setValue] = useState(initial);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  const trimmed = value.trim();
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('重命名')}>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (trimmed) { onSubmit(trimmed); onOpenChange(false); } }}>
      <input autoFocus value={value} onChange={e => setValue(e.target.value)} maxLength={100} aria-label={at('新的会话名')} className="w-full h-11 px-3 rounded-[10px] border border-white/[0.08] bg-white/[0.045] text-[13px] text-[#e9ebef] focus:outline-none focus:border-[#3069f0]/50" />
      <button type="submit" disabled={!trimmed} className="h-11 w-full rounded-[10px] bg-[#3069f0] text-[13px] font-semibold text-white disabled:opacity-40">{at('保存')}</button>
    </form>
  </SheetFrame>;
}
