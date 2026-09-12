import { useMemo, useState } from 'react';
import { ChevronDown, Film, Image as ImageIcon, Layers } from 'lucide-react';
import type { Draft, Run, RevisionRef } from '../../../shared/types/agentWorkspace';
import { useAgentText } from '../useAgentText';
import { useWorkspace } from './WorkspaceContext';
import { WorkspaceMedia } from './WorkspaceMedia';
import { workspaceSummary, type SummaryDraft } from './summary';

const OPEN_KEY = 'comfy_mobile_workspace_summary_open';
const DRAFT_LIMIT = 8;
const OUTPUT_LIMIT = 12;
const pending = new Set<Run['state']>(['preparing', 'awaiting_approval', 'submitting', 'reconciling', 'queued', 'running']);

function draftState(item: SummaryDraft): { label: string; dot: string } {
  if (item.draft.archivedAt != null) return { label: '已归档', dot: 'bg-slate-600' };
  const run = item.latestRun;
  if (run && pending.has(run.state)) return { label: '正在生成', dot: 'bg-[#5b8af5] animate-pulse' };
  if (run && run.revision === item.draft.headRevision) return run.state === 'succeeded' ? { label: '已生成', dot: 'bg-[#4ade80]' } : { label: '生成记录已保存', dot: 'bg-[#f0a35b]' };
  return { label: '草稿已修改，尚未生成', dot: 'bg-slate-500' };
}

/**
 * A quick read of what this chat has produced: the workflows the agent worked on and the files its runs returned.
 * Everything comes from state the session already polls, so opening it costs no request; the sheets behind
 * "查看全部" remain the paged, complete lists.
 */
export function WorkspaceSummaryBar({ onAdjust, onAsset, onViewDrafts, onViewOutputs }: { onAdjust: (ref: RevisionRef) => void; onAsset: (assetId: string) => void; onViewDrafts: () => void; onViewOutputs: () => void }) {
  const { view } = useWorkspace(); const at = useAgentText();
  const { drafts, runs, snapshot } = view;
  const summary = useMemo(() => workspaceSummary({ drafts, runs, snapshot }), [drafts, runs, snapshot]);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  if (!summary.drafts.length && !summary.outputs.length) return null;
  const toggle = () => setOpen(previous => { const next = !previous; try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ } return next; });
  const shownDrafts = summary.drafts.slice(0, DRAFT_LIMIT);
  const shownOutputs = summary.outputs.slice(0, OUTPUT_LIMIT);
  return <section data-workspace-summary className="shrink-0 border-b border-white/5">
    <button data-workspace-summary-toggle aria-expanded={open} onClick={toggle} className="w-full px-4 py-2 flex items-center gap-2 text-[12px] text-[#c8ccd4]">
      <Layers size={14} className="shrink-0 text-[#5b8af5]" />
      <span className="font-semibold shrink-0">{at('本对话产出')}</span>
      <span className="truncate text-slate-500">{at('工作流 {{drafts}} · 文件 {{files}}', { drafts: `${summary.drafts.length}${summary.moreDrafts ? '+' : ''}`, files: `${summary.outputs.length}${summary.moreOutputs ? '+' : ''}` })}</span>
      <span className="flex-1" />
      <ChevronDown size={16} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="px-4 pb-3 space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1.5"><p className="text-[11px] text-slate-500">{at('操作过的工作流')}</p><span className="flex-1" /><button className="text-[11px] text-[#5b8af5]" onClick={onViewDrafts}>{at('查看全部')}</button></div>
        {shownDrafts.length ? <div className="flex gap-2 overflow-x-auto scrollbar-hide">{shownDrafts.map(item => {
          const state = draftState(item);
          return <button key={item.draft.id} data-workspace-summary-draft={item.draft.id} onClick={() => onAdjust({ draftId: item.draft.id, revision: item.draft.headRevision })}
            className="w-[168px] shrink-0 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-left">
            <span className="flex items-center gap-1.5">{draftIcon(item.draft)}<span className="truncate text-[12px] font-medium">{item.draft.name}</span></span>
            <span className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400"><span className={`w-1.5 h-1.5 shrink-0 rounded-full ${state.dot}`} /><span className="truncate">{at(state.label)}{item.outputCount ? ` · ${at('{{count}} 个文件', { count: item.outputCount })}` : ''}</span></span>
            <span className="block truncate text-[10px] text-slate-500">{at('工作流第 {{version}} 版', { version: item.draft.headRevision })}</span>
          </button>;
        })}</div> : <p className="text-[11px] text-slate-500">{at('还没有导入或创建工作流')}</p>}
      </div>
      <div>
        <div className="flex items-center gap-2 mb-1.5"><p className="text-[11px] text-slate-500">{at('产出文件')}</p><span className="flex-1" /><button className="text-[11px] text-[#5b8af5]" onClick={onViewOutputs}>{at('查看全部')}</button></div>
        {shownOutputs.length ? <div className="flex gap-2 overflow-x-auto scrollbar-hide">{shownOutputs.map(assetId => <button key={assetId} data-workspace-summary-output={assetId} className="w-20 shrink-0" aria-label={at('查看来源')} onClick={() => onAsset(assetId)}><WorkspaceMedia assetId={assetId} compact /></button>)}</div>
          : <p className="text-[11px] text-slate-500">{at('本对话还没有生成文件')}</p>}
      </div>
    </div>}
  </section>;
}

function draftIcon(draft: Draft) {
  return draft.outputKinds.includes('video') ? <Film size={12} className="shrink-0 text-slate-400" /> : <ImageIcon size={12} className="shrink-0 text-slate-400" />;
}
