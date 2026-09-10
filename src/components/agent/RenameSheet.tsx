import { useEffect, useState } from 'react';
import { useAgentText } from './useAgentText';
import { SheetFrame } from './WorkflowPickerSheet';

export function RenameSheet({ open, onOpenChange, initial, onSubmit, title = '重命名', label = '新的会话名' }: { open: boolean; onOpenChange: (open: boolean) => void; initial: string; onSubmit: (name: string) => void | Promise<boolean | void>; title?: string; label?: string }) {
  const at = useAgentText();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  const trimmed = value.trim();
  return <SheetFrame open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }} title={at(title)}>
    <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (!trimmed || saving) return; setSaving(true); try { if (await onSubmit(trimmed) !== false) onOpenChange(false); } finally { setSaving(false); } }}>
      <input autoFocus disabled={saving} value={value} onChange={e => setValue(e.target.value)} maxLength={100} aria-label={at(label)} className="w-full h-11 px-3 rounded-[10px] border border-white/[0.08] bg-white/[0.045] text-[13px] text-[#e9ebef] focus:outline-none focus:border-[#3069f0]/50" />
      <button type="submit" disabled={!trimmed || saving} className="h-11 w-full rounded-[10px] bg-[#3069f0] text-[13px] font-semibold text-white disabled:opacity-40">{at('保存')}</button>
    </form>
  </SheetFrame>;
}
