import { useTranslation } from 'react-i18next';
import { FolderInput, RotateCcw } from 'lucide-react';
import type { AgentVersion } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';
import { SheetFrame } from './WorkflowPickerSheet';
import { chipButton } from './chatStyles';

export function VersionHistorySheet({ open, onOpenChange, versions, current, busy, onRestore, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; versions: AgentVersion[]; current: number; busy: boolean; onRestore: (version: number) => void; onSave?: (version: number) => void }) {
  const at = useAgentText();
  const { i18n } = useTranslation();
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('版本历史（{{count}}）', { count: versions.length })}>
    <div className="divide-y divide-white/[0.05]">{versions.map(v => <div key={v.version} className="py-3 flex items-center gap-3">
      <span className="font-mono text-[10px] text-[#5b8af5] w-8 shrink-0">V{v.version}</span>
      <span className="flex-1 min-w-0"><span className="block text-[12.5px] truncate">{at(v.summary)}</span><span className="block font-mono text-[10px] text-[#565d6b] mt-0.5">{new Date(v.created).toLocaleString(i18n.resolvedLanguage || 'en')}</span></span>
      {onSave && <button className={chipButton} disabled={busy} aria-label={at('保存到工作流库')} onClick={() => { onSave(v.version); onOpenChange(false); }}><FolderInput size={13} /></button>}
      <button className={chipButton} disabled={busy || v.version === current} onClick={() => { onRestore(v.version); onOpenChange(false); }}><RotateCcw size={13} />{at('回到这个版本')}</button>
    </div>)}</div>
  </SheetFrame>;
}
