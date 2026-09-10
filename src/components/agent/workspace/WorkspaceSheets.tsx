import { useCallback, useState, type ReactNode } from 'react';
import { Check, History, Image as ImageIcon, Film, Network, Settings2 } from 'lucide-react';
import type { Draft, MediaKind, RevisionRef, Asset } from '../../../shared/types/agentWorkspace';
import { SheetFrame } from '../WorkflowPickerSheet';
import { chipButton, accentChip } from '../chatStyles';
import { useAgentText } from '../useAgentText';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspacePage } from './useWorkspacePage';
import { WorkspaceMedia } from './WorkspaceMedia';

export function PageFooter({ loading, error, nextCursor, retry, loadMore }: { loading: boolean; error: string; nextCursor?: number; retry: () => void; loadMore: () => void }) {
  const at = useAgentText();
  return <div className="py-3 text-center text-xs text-slate-400">
    {error && <p role="alert">{at(error)} <button onClick={retry} className="underline">{at('重试')}</button></p>}
    {loading ? at('加载中…') : nextCursor !== undefined ? <button onClick={loadMore} className={chipButton}>{at('加载更多')}</button> : null}
  </div>;
}

export function DraftPicker({ open, onOpenChange, onPick, onHistory, onImport, onManage, onImportRecovery }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (draft: Draft) => void; onHistory: (draft: Draft) => void; onImport: () => void; onManage: (draft: Draft) => void; onImportRecovery: () => void }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  const [kind, setKind] = useState<MediaKind | undefined>();
  const [archived, setArchived] = useState(false);
  const { merge, getWatermark } = view;
  const load = useCallback(async (before: number | undefined, signal: AbortSignal) => {
    const watermark = getWatermark(); const page = await api.drafts(sessionId, { before, kind, archived, limit: 30 }, signal);
    if (!signal.aborted) merge({ drafts: page.items }, watermark); return page;
  }, [api, sessionId, kind, archived, merge, getWatermark]);
  const page = useWorkspacePage(open, load);
  const drafts = page.items.map(item => view.drafts[item.id] ?? item).filter(draft => archived || draft.archivedAt == null);
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('本对话的创作')}>
    <div className="flex gap-2 mb-3">{([undefined, 'image', 'video'] as const).map(value => <button key={value ?? 'all'} className={kind === value ? accentChip : chipButton} onClick={() => setKind(value)}>{at(value === 'image' ? '图片' : value === 'video' ? '视频' : '全部')}</button>)}<span className="flex-1" /><button className={chipButton} onClick={onImport}><Network size={13} />{at('导入工作流')}</button></div>
    <label className="flex items-center gap-2 text-xs text-slate-400 mb-3"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />{at('包含已归档创作')}</label>
    <div className="space-y-2">{drafts.map(draft => {
      const latest = [...Object.values(view.runs).filter(run => run.draftId === draft.id), ...(draft.latestRun ? [draft.latestRun] : [])].sort((a, b) => b.created - a.created)[0];
      const image = latest?.outputAssetIds[0];
      return <div key={draft.id} className="flex items-center gap-2 rounded-xl border border-white/10 p-2">
        <button className="flex-1 flex items-center gap-3 min-w-0 text-left" data-workspace-draft={draft.id} onClick={() => { onPick(draft); onOpenChange(false); }}>
          <span className="w-20 shrink-0">{image ? <WorkspaceMedia assetId={image} compact /> : <span className="h-20 flex justify-center items-center rounded-lg bg-white/5 text-slate-500">{draft.outputKinds.includes('video') ? <Film size={24} /> : <ImageIcon size={24} />}</span>}</span>
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{draft.name}</span><span className="block text-xs text-slate-400">{at('工作流第 {{version}} 版', { version: draft.headRevision })}</span><span className="block text-[11px] text-slate-500">{at(draft.archivedAt != null ? '已归档' : latest && latest.revision === draft.headRevision ? latest.state === 'succeeded' ? '已生成' : '生成记录已保存' : '草稿已修改，尚未生成')}</span></span>
        </button>
        <button className={chipButton} onClick={() => { onHistory(draft); onOpenChange(false); }} aria-label={at('版本历史')}><History size={14} /></button>
        <button className={chipButton} onClick={() => { onManage(draft); onOpenChange(false); }} aria-label={at('管理创作')}><Settings2 size={14} /></button>
      </div>;
    })}</div>
    {!page.loading && !drafts.length && <p className="py-6 text-center text-xs text-slate-500">{at('当前筛选下没有创作')}</p>}
    <PageFooter {...page} />
    <button className={chipButton} onClick={onImportRecovery}>{at('导入恢复备份')}</button>
  </SheetFrame>;
}

export function AssetPicker({ open, onOpenChange, onPick, kind, selected = [], header }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (asset: Asset) => void; kind?: MediaKind; selected?: string[]; header?: ReactNode }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText(); const { merge, getWatermark } = view;
  const load = useCallback(async (before: number | undefined, signal: AbortSignal) => { const watermark = getWatermark(); const result = await api.assets(sessionId, { before, kind, limit: 20 }, signal); if (!signal.aborted) merge({ assets: result.items }, watermark); return result; }, [api, sessionId, kind, merge, getWatermark]);
  const page = useWorkspacePage(open, load);
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('选择参考素材')}>
    {header && <div className="mb-3">{header}</div>}
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{page.items.map(item => {
      const asset = view.assets[item.id] ?? item; const run = asset.sourceRunId ? view.runs[asset.sourceRunId] : undefined;
      const source = run ? view.drafts[run.draftId] : undefined;
      return <button key={asset.id} className={`min-w-0 p-2 rounded-xl border text-left ${selected.includes(asset.id) ? 'border-blue-400 bg-blue-500/10' : 'border-white/10'}`} onClick={() => onPick(asset)} data-workspace-pick-asset={asset.id}>
        <WorkspaceMedia assetId={asset.id} compact />
        <span className="flex items-center gap-1 mt-1 text-xs truncate">{selected.includes(asset.id) && <Check size={12} />}{source?.name ?? asset.name}</span>
        <span className="block text-[10px] text-slate-400">{at('素材 {{index}}', { index: asset.displayOrdinal })} · {new Date(asset.created).toLocaleString()}</span>
      </button>;
    })}</div>
    {!page.loading && !page.items.length && <p className="py-6 text-xs text-center text-slate-500">{at('暂无可选素材')}</p>}
    <PageFooter {...page} />
  </SheetFrame>;
}

export function DraftHistory({ draft, onClose, onContinue, onRestore, onFork, onCanvas, busy }: { draft: Draft | null; onClose: () => void; onContinue: (ref: RevisionRef) => void; onRestore: (draft: Draft, revision: number) => void; onFork: (draft: Draft, revision: number) => void; onCanvas: (ref: RevisionRef) => void; busy: boolean }) {
  const { api, sessionId, view } = useWorkspace(); const at = useAgentText();
  draft = draft ? view.drafts[draft.id] ?? draft : null;
  const draftId = draft?.id;
  const load = useCallback((before: number | undefined, signal: AbortSignal) => api.revisions(sessionId, draftId!, { before, limit: 30 }, signal), [api, sessionId, draftId]);
  const page = useWorkspacePage(!!draft, load);
  return <SheetFrame open={!!draft} onOpenChange={open => { if (!open) onClose(); }} title={`${draft?.name ?? ''} · ${at('版本历史')}`}>
    <div className="divide-y divide-white/10">{page.items.map(version => <article className="py-3 space-y-2" key={version.revision}>
      <p className="text-sm font-medium">{at('工作流第 {{version}} 版', { version: version.revision })}{version.revision === draft?.headRevision && <span className="text-blue-400 text-xs ml-2">{at('当前版本')}</span>}</p>
      <p className="text-xs text-slate-400">{at(version.summary)}</p>
      {version.sourceRevision && version.sourceRevision !== version.previousHeadRevision && <p className="text-[11px] text-slate-500">{at('基于第 {{version}} 版继续', { version: version.sourceRevision })}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={accentChip} onClick={() => { onContinue(version); onClose(); }}>{at('继续调整')}</button>
        <button className={chipButton} onClick={() => onCanvas(version)}>{at('查看工作流')}</button>
        <button className={chipButton} disabled={busy || draft?.archivedAt != null || version.revision === draft?.headRevision} onClick={() => onRestore(draft!, version.revision)}>{at('恢复此版本')}</button>
        <button className={chipButton} disabled={busy} onClick={() => onFork(draft!, version.revision)}>{at('另做一个方向')}</button>
      </div>
    </article>)}</div><PageFooter {...page} />
  </SheetFrame>;
}
