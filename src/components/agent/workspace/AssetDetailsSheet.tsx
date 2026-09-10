import { useCallback, useEffect, useState } from 'react';
import type { Run, RevisionRef } from '../../../shared/types/agentWorkspace';
import { SheetFrame } from '../WorkflowPickerSheet';
import { useAgentText } from '../useAgentText';
import { chipButton, accentChip } from '../chatStyles';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspacePage } from './useWorkspacePage';
import { WorkspaceMedia } from './WorkspaceMedia';
import { PageFooter } from './WorkspaceSheets';

export function AssetDetailsSheet({ assetId, onClose, onSelect, onAdjust, onCanvas }: { assetId: string | null; onClose: () => void; onSelect: (id: string) => void; onAdjust: (ref: RevisionRef) => void; onCanvas: (ref: RevisionRef) => void }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  const { merge, getWatermark } = view;
  const [source, setSource] = useState<Run | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    setSource(null); setError(''); if (!assetId) return;
    const controller = new AbortController(); const watermark = getWatermark();
    void api.asset(sessionId, assetId, controller.signal).then(async detail => {
      const draft = detail.sourceRun ? (await api.draft(sessionId, detail.sourceRun.draftId, controller.signal)).draft : undefined;
      if (controller.signal.aborted) return;
      setSource(detail.sourceRun); merge({ assets: [detail.asset], ...(detail.sourceRun ? { runs: [detail.sourceRun] } : {}), ...(draft ? { drafts: [draft] } : {}) }, watermark);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '素材加载失败'); });
    return () => controller.abort();
  }, [api, sessionId, assetId, merge, getWatermark]);
  const load = useCallback((before: number | undefined, signal: AbortSignal) => api.assetUses(sessionId, assetId!, before, signal), [api, sessionId, assetId]);
  const uses = useWorkspacePage(!!assetId, load);
  const loadLibraryUses = useCallback((before: number | undefined, signal: AbortSignal) => api.assetLibraryUses(sessionId, assetId!, before, signal), [api, sessionId, assetId]);
  const libraryUses = useWorkspacePage(!!assetId, loadLibraryUses);
  const asset = assetId ? view.assets[assetId] : undefined;
  return <SheetFrame open={!!assetId} onOpenChange={open => { if (!open) onClose(); }} title={at('素材来源')}>
    {assetId && <WorkspaceMedia assetId={assetId} />}
    {error && <p role="alert" className="text-xs text-amber-300 py-2">{at(error)}</p>}
    {asset?.origin === 'uploaded' && <p className="py-3 text-xs text-slate-400">{at('这是一份上传素材，没有原始生成工作流')}</p>}
    {source && <section className="py-3 space-y-2">
      {source.legacy?.incomplete && <p className="text-xs text-amber-300">{at('旧生成记录缺少完整执行快照；以下仅为当时保存的工作流。')}</p>}
      <p className="text-sm font-medium">{view.drafts[source.draftId]?.name ?? at('生成工作流')} · {at('工作流第 {{version}} 版', { version: source.revision })}</p>
      <div className="flex flex-wrap gap-2"><button className={accentChip} onClick={() => { onAdjust(source); onClose(); }}>{at(source.legacy?.incomplete ? '调整保存的工作流' : '调整原生成方式')}</button><button className={chipButton} onClick={() => onCanvas(source)}>{at('查看当时工作流')}</button></div>
      {!!source.inputs?.length && <><p className="text-xs text-slate-400 pt-2">{at('当次使用的素材')}</p><div className="flex gap-2 overflow-x-auto">{source.inputs.map(input => <button key={input.bindingId} className="w-28 shrink-0 text-left" onClick={() => onSelect(input.assetId)}><WorkspaceMedia assetId={input.assetId} compact /><span className="text-xs text-blue-400">{at('查看这份素材')}</span></button>)}</div></>}
    </section>}
    <section className="border-t border-white/10 mt-3 pt-3"><h3 className="text-sm font-medium mb-2">{at('后续使用')}</h3>
      {uses.items.map(use => <button key={use.id} className="block w-full text-left p-3 rounded-lg border border-white/10 mb-2" onClick={() => { onAdjust(use); onClose(); }}><span className="block text-xs">{use.draftName}</span><span className="text-[11px] text-slate-400">{at('工作流第 {{version}} 版', { version: use.revision })}</span></button>)}
      {!uses.items.length && !uses.loading && <p className="text-xs text-slate-400">{at('尚未被其他工作流引用')}</p>}<PageFooter {...uses} />
    </section>
    <section className="border-t border-white/10 mt-3 pt-3"><h3 className="text-sm font-medium mb-2">{at('工作流库引用记录')}</h3>
      {libraryUses.items.map(use => <div key={use.id} className="p-3 rounded-lg border border-white/10 mb-2">{use.saves.map(save => <p key={save.operationId} className="text-xs mb-1">{save.name} · {at('工作流第 {{version}} 版', { version: save.revision })} · {at(save.state === 'succeeded' ? '已核验保存' : '保存操作保留的引用')}</p>)}</div>)}
      <PageFooter {...libraryUses} />
    </section>
  </SheetFrame>;
}
