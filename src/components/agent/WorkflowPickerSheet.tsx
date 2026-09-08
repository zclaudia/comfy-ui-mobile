import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, X } from 'lucide-react';
import { loadAllWorkflows } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { useAgentText } from './useAgentText';

export function SheetFrame({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  const at = useAgentText();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
    <Dialog.Content className="fixed z-[101] inset-x-0 bottom-0 max-h-[80dvh] rounded-t-2xl border-t border-white/10 text-[#e9ebef] flex flex-col" style={{ background: '#0f1116', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2"><Dialog.Title className="font-semibold text-[14px] flex-1">{title}</Dialog.Title><Dialog.Close className="p-2" aria-label={at('关闭')}><X size={18} /></Dialog.Close></div>
      <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function WorkflowPickerSheet({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (workflow: Workflow) => void }) {
  const at = useAgentText();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  useEffect(() => { if (open) void loadAllWorkflows().then(list => setWorkflows(list.filter(w => w.isValid))).catch(() => setWorkflows([])); }, [open]);
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('选择工作流')}>
    {!workflows.length && <p className="py-8 text-center text-[12px] text-[#66758a]">{at('工作流库是空的')}</p>}
    <div className="space-y-2">{workflows.map(w => <button key={w.id} data-agent-pick={w.name} onClick={() => { onPick(w); onOpenChange(false); }} className="w-full flex items-center gap-3 p-3 rounded-[10px] border border-white/[0.07] text-left" style={{ background: '#101217' }}>
      <FileText size={18} strokeWidth={1.6} className="shrink-0 text-white/30" />
      <span className="flex-1 min-w-0"><span className="block text-[13px] font-semibold truncate">{w.name}</span><span className="block font-mono text-[10px] text-[#565d6b] mt-0.5">{w.nodeCount}N</span></span>
    </button>)}</div>
  </SheetFrame>;
}
