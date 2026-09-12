import { useCallback, useEffect, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Film, Loader2, MoreHorizontal, Pencil, ShieldCheck } from 'lucide-react';
import type { Asset, RevisionRef, Run, Selection } from '../../../shared/types/agentWorkspace';
import { useAgentText } from '../useAgentText';
import { accentChip, chipButton } from '../chatStyles';
import { WorkspaceMedia } from './WorkspaceMedia';
import { useWorkspaceAsset } from './useWorkspaceAsset';
import { useWorkspaceDraft } from './useWorkspaceDraft';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspacePage } from './useWorkspacePage';
import { PageFooter } from './WorkspaceSheets';

const runLabels: Record<Run['state'], string> = { preparing: '正在准备参考素材', awaiting_approval: '等待你确认生成', submitting: '正在提交生成', reconciling: '正在核对提交状态', queued: '生成任务已排队', running: '正在生成', succeeded: '生成完成', failed: '这次生成未成功', cancelled: '此次生成已取消', unknown: '提交结果仍需核对' };
export interface RunActions {
  onAdjust: (ref: RevisionRef) => void; onReference: (asset: Asset) => void; onVideo: (asset: Asset) => void;
  onRerun: (run: Run) => void; onFork: (ref: RevisionRef) => void; onCanvas: (ref: RevisionRef) => void;
  onSource: (assetId: string) => void; onReplaceImage: (run: Run) => void; onApprove: (run: Run, approved: boolean) => void;
}

export function RunCard({ runId, actions, busy }: { runId: string; actions: RunActions; busy: boolean }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  const { merge, getWatermark } = view;
  const run = view.runs[runId]; const draft = run ? view.drafts[run.draftId] : undefined;
  useEffect(() => {
    if (run && draft) return;
    const controller = new AbortController(); const watermark = getWatermark();
    void (async () => {
      const current = run ?? (await api.run(sessionId, runId, controller.signal)).run;
      const found = draft ?? (await api.draft(sessionId, current.draftId, controller.signal)).draft;
      if (!controller.signal.aborted) merge({ drafts: [found], runs: [current] }, watermark);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [api, sessionId, runId, run, draft, merge, getWatermark]);
  const load = useCallback(async (after: number | undefined, signal: AbortSignal) => { const watermark = getWatermark(); const page = await api.runAssets(sessionId, runId, after, signal); if (!signal.aborted) merge({ assets: page.items }, watermark); return page; }, [api, sessionId, runId, merge, getWatermark]);
  const page = useWorkspacePage(run?.state === 'succeeded', load);
  if (!run) return <p role="status" className="text-xs text-slate-400">{at('正在读取生成记录')}</p>;
  const task = view.snapshot?.tasks.find(task => task.id === run.taskId);
  const cannotStart = busy || !!view.snapshot?.session.archivedAt || view.snapshot?.tasks.some(task => ['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling'].includes(task.state));
  const paused = task?.workspace?.waitingReason;
  const canApprove = !busy && run.state === 'awaiting_approval' && !run.approvedAt && paused?.type === 'preview_approval' && paused.runId === run.id && task?.state === 'waiting_user';
  const inputs = run.inputs ?? run.inputManifest ?? [];
  const pending = ['preparing', 'submitting', 'reconciling', 'queued', 'running'].includes(run.state);
  const outputs = page.items.length ? page.items : run.outputAssetIds.flatMap(id => view.assets[id] ? [view.assets[id]] : []);
  return <section data-workspace-run={run.id} className="rounded-xl border border-white/10 bg-black/10 p-3 space-y-3">
    <header className="flex items-start gap-2">
      <div className="flex-1 min-w-0"><p className="text-sm font-semibold truncate">{draft?.name ?? at('生成记录')}</p><p className="text-[11px] text-slate-400">{at('工作流第 {{version}} 版', { version: run.revision })}{run.generation !== undefined && <> · {at('第 {{count}} 次生成', { count: run.generation })}</>}</p></div>
      <Dropdown.Root><Dropdown.Trigger asChild><button className={chipButton} aria-label={at('更多')}><MoreHorizontal size={16} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content align="end" className="z-[110] p-1 min-w-44 rounded-xl border border-white/10 bg-[#14161c] text-xs text-slate-200 shadow-xl">
        {[{ label: '查看当时工作流', disabled: false, action: () => actions.onCanvas(run) }, { label: '按原参数再生成', disabled: cannotStart || draft?.archivedAt != null, action: () => actions.onRerun(run) }, { label: '另做一个方向', disabled: cannotStart, action: () => actions.onFork(run) }].map(item => <Dropdown.Item key={item.label} disabled={item.disabled} className="px-3 py-2.5 rounded-lg outline-none data-[highlighted]:bg-white/10 data-[disabled]:opacity-40" onSelect={item.action}>{at(item.label)}</Dropdown.Item>)}
      </Dropdown.Content></Dropdown.Portal></Dropdown.Root>
    </header>
    <p role="status" className={`flex items-center gap-2 text-xs ${run.state === 'failed' || run.state === 'unknown' ? 'text-amber-300' : 'text-slate-400'}`}>{pending && <Loader2 size={13} className="animate-spin" />}{at(runLabels[run.state])}{task?.state === 'cancelled' && run.state === 'succeeded' && <span> · {at('助手停止后完成')}</span>}</p>
    {!!inputs.length && <div><p className="text-[11px] text-slate-500 mb-1">{at('本次使用的素材')}</p><div className="flex gap-2 overflow-x-auto">{inputs.map(input => <button className="w-24 shrink-0 text-left" key={input.bindingId} onClick={() => actions.onSource(input.assetId)} aria-label={at('查看来源')}><WorkspaceMedia assetId={input.assetId} compact /></button>)}</div></div>}
    {run.preview && <p className="text-[11px] text-slate-400">{run.preview.width && run.preview.height ? `${run.preview.width} × ${run.preview.height}` : ''}{run.preview.frames ? ` · ${at('{{count}} 帧', { count: run.preview.frames })}` : ''}{run.preview.fps ? ` · ${run.preview.fps} fps` : ''}</p>}
    {run.state === 'awaiting_approval' && <div className="rounded-xl border border-blue-400/30 bg-blue-500/10 p-3 space-y-2">
      <p className="text-xs flex gap-2 items-center"><ShieldCheck size={14} />{at(run.approvedAt ? '已确认，等待提交' : '确认后将使用此版本和以上素材生成')}</p>
      {!run.approvedAt && <div className="flex gap-2"><button data-workspace-approve className={accentChip} disabled={!canApprove} onClick={() => actions.onApprove(run, true)}>{at('确认生成')}</button><button className={chipButton} disabled={!canApprove} onClick={() => actions.onApprove(run, false)}>{at('跳过此次生成')}</button></div>}
    </div>}
    {run.state === 'succeeded' && <>
      <div className={`grid gap-4 ${outputs.length > 1 ? 'sm:grid-cols-2' : ''}`}>{outputs.map(asset => <article key={asset.id} className="min-w-0 space-y-2">
        <WorkspaceMedia assetId={asset.id} />
        <div className="flex flex-wrap gap-1.5">
          <button className={chipButton} onClick={() => actions.onAdjust(run)}><Pencil size={12} />{at('继续调整')}</button>
          <button className={chipButton} onClick={() => actions.onReference(asset)}>{at('用作参考')}</button>
          {asset.kind === 'image' && <button className={accentChip} disabled={cannotStart} onClick={() => actions.onVideo(asset)}><Film size={12} />{at('生成视频')}</button>}
          <button className={chipButton} onClick={() => actions.onSource(asset.id)}>{at('查看来源')}</button>
          {asset.kind === 'video' && inputs.some(input => view.assets[input.assetId]?.kind === 'image') && <button className={chipButton} disabled={cannotStart || draft?.archivedAt != null} onClick={() => actions.onReplaceImage(run)}>{at('用新图更新')}</button>}
        </div>
      </article>)}</div>
      {!outputs.length && !page.loading && <p className="text-xs text-slate-400">{at('此次生成没有可展示的素材')}</p>}
      {run.outputsIncomplete && <p className="text-xs text-amber-300">{at('部分输出尚未完整登记')}</p>}
      <PageFooter {...page} />
    </>}
    {(run.state === 'failed' || run.state === 'unknown') && run.diagnostic != null && <p className="text-xs text-amber-300 whitespace-pre-wrap break-words">{at(typeof run.diagnostic === 'string' ? run.diagnostic : JSON.stringify(run.diagnostic))}</p>}
    {run.state !== 'succeeded' && <button className={chipButton} onClick={() => actions.onAdjust(run)}>{at('调整此工作流')}</button>}
  </section>;
}

function CandidateAsset({ assetId }: { assetId: string }) {
  const { asset } = useWorkspaceAsset(assetId);
  return <><WorkspaceMedia assetId={assetId} compact /><span className="block mt-1 truncate text-xs">{asset?.name}</span></>;
}
function CandidateDraft({ draftId, revision }: { draftId: string; revision?: number }) {
  const at = useAgentText(); const { draft, error } = useWorkspaceDraft(draftId);
  return <span className="block text-xs">{draft?.name ?? at(error || '加载中…')}{revision && <span className="block text-slate-400">{at('工作流第 {{version}} 版', { version: revision })}</span>}</span>;
}
export function SelectionCard({ questionId, busy, onAnswer }: { questionId: string; busy: boolean; onAnswer: (selection: Selection, selectedIndices: number[], answer: string) => void }) {
  const { view } = useWorkspace(); const at = useAgentText(); const selection = view.questions[questionId];
  const [indices, setIndices] = useState<number[]>([]); const [answer, setAnswer] = useState('');
  if (!selection) return null;
  const task = view.snapshot?.tasks.find(task => task.id === selection.taskId);
  const reason = task?.workspace?.waitingReason;
  const pending = selection.state === 'pending' && task?.state === 'waiting_user' && reason?.type === 'selection' && reason.questionId === selection.id;
  const selected = selection.state === 'answered' ? selection.selectedIndices ?? [] : indices;
  return <section className="rounded-xl border border-blue-400/30 bg-blue-500/5 p-3 space-y-3" data-workspace-selection={questionId}>
    <p className="text-sm font-medium">{selection.question}</p>
    <div className="grid grid-cols-2 gap-2">{selection.candidates.map((candidate, index) => <button key={index} disabled={!pending || busy} aria-pressed={selected.includes(index)} className={`rounded-xl border p-2 text-left min-w-0 ${selected.includes(index) ? 'border-blue-400 bg-blue-500/15' : 'border-white/10'}`} onClick={() => setIndices(previous => selection.multiple ? previous.includes(index) ? previous.filter(i => i !== index) : [...previous, index] : [index])}>
      {candidate.type === 'asset' ? <CandidateAsset assetId={candidate.assetId} /> : <CandidateDraft draftId={candidate.draftId} revision={candidate.revision} />}
    </button>)}</div>
    {pending ? <><textarea className="w-full rounded-lg border border-white/10 bg-black/20 p-2 text-xs outline-none focus:border-blue-400" value={answer} onChange={event => setAnswer(event.target.value)} maxLength={4000} placeholder={at('也可以补充说明')} aria-label={at('补充说明')} /><button className={accentChip} disabled={busy || (!indices.length && !answer.trim())} onClick={() => onAnswer(selection, indices, answer.trim())}>{at('确认选择')}</button></>
      : <p className="text-xs text-slate-400">{selection.state === 'answered' ? selection.answer || at('已回答') : at('此问题已停止等待')}</p>}
  </section>;
}
