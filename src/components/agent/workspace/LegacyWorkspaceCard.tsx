import type { AgentEvent } from '../../../infrastructure/api/AgentApi';
import type { LegacyWorkspaceEvent } from '../../../shared/types/agentWorkspace';
import { useAgentText } from '../useAgentText';
import { chipButton } from '../chatStyles';
import type { RunActions } from './WorkspaceCards';
import { WorkspaceMedia } from './WorkspaceMedia';

/** Historical cards use server-verified migration refs. Unmapped filenames are labels, never media identities. */
export function LegacyWorkspaceCard({ event, actions, busy }: { event: AgentEvent; actions: RunActions; busy: boolean }) {
  const at = useAgentText(); const legacy = event.data.workspaceLegacy as LegacyWorkspaceEvent | undefined;
  const ref = legacy?.reference;
  const names = Array.isArray(event.data.outputs) ? event.data.outputs.map((output: { filename?: unknown }) => typeof output?.filename === 'string' ? output.filename : '').filter(Boolean) : [];
  return <section className="rounded-xl border border-white/10 p-3 space-y-2" data-workspace-legacy-event={event.seq}>
    <p className="text-xs text-slate-400">{at('旧会话记录')}{ref && <> · {at('工作流第 {{version}} 版', { version: ref.revision })}</>}</p>
    {typeof event.data.summary === 'string' && <p className="text-xs">{at(event.data.summary)}</p>}
    {(!ref || legacy?.incomplete) && <p className="text-xs text-amber-300">{at('旧记录缺少完整来源，只展示已确认的对应关系。')}</p>}
    {event.kind === 'execution_error' && <p className="text-xs text-amber-300">{at('这次生成未成功')}</p>}
    {event.kind === 'approval' && <p className="text-xs text-slate-400">{at('这是历史确认记录，不会重新提交生成。')}</p>}
    {names.length > 0 && <p className="text-xs text-slate-500 break-words">{names.join(' · ')}</p>}
    {!!legacy?.outputs.length && <div className="grid gap-2 sm:grid-cols-2">{legacy.outputs.map(output => <button key={output.index} onClick={() => actions.onSource(output.assetId)}><WorkspaceMedia assetId={output.assetId} /></button>)}</div>}
    {ref && <div className="flex flex-wrap gap-2">
      <button className={chipButton} onClick={() => actions.onCanvas(ref)}>{at('查看当时工作流')}</button>
      <button className={chipButton} disabled={busy} onClick={() => actions.onAdjust(ref)}>{at('继续调整')}</button>
      <button className={chipButton} disabled={busy} onClick={() => actions.onFork(ref)}>{at('另做一个方向')}</button>
    </div>}
  </section>;
}

export function LegacyUserAttachments({ event, onSource }: { event: AgentEvent; onSource: (id: string) => void }) {
  const at = useAgentText(); const legacy = event.data.workspaceLegacy as LegacyWorkspaceEvent | undefined;
  if (!legacy) return null;
  return <div className="space-y-2 mb-2">
    {!!legacy.attachments.length && <div className="flex gap-2 overflow-x-auto">{legacy.attachments.map(item => <button className="w-24 shrink-0" key={item.index} onClick={() => onSource(item.assetId)}><WorkspaceMedia assetId={item.assetId} compact /></button>)}</div>}
    {legacy.incomplete && <p className="text-xs text-amber-300">{at('部分旧附件没有可确认的素材映射，请重新上传所需文件。')}</p>}
  </div>;
}
