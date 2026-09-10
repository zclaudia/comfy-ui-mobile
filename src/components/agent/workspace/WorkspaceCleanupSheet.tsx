import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import type { WorkspaceCleanupOperation, WorkspaceCleanupPlan, WorkspaceSession } from '../../../shared/types/agentWorkspace';
import { SheetFrame } from '../WorkflowPickerSheet';
import { sessionTitle } from '../binding';
import { chipButton } from '../chatStyles';
import { useAgentText } from '../useAgentText';

const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;

/** Confirmation applies to one reviewed plan. Retries keep the original operation identity. */
export function WorkspaceCleanupSheet({ api, session, onClose, onChanged }: { api: WorkspaceApi; session: WorkspaceSession; onClose: () => void; onChanged: () => void }) {
  const at = useAgentText();
  const [preview, setPreview] = useState<{ plan: WorkspaceCleanupPlan; operation?: WorkspaceCleanupOperation }>();
  const [attempt, reload] = useState(0); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const working = useRef(false); const alive = useRef(true); const requestId = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setPreview(undefined); setConfirmed(false); setError('');
    void api.cleanupPreview(session.id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      requestId.current = result.operation?.requestId ?? crypto.randomUUID(); setPreview(result);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '操作失败'); });
    return () => controller.abort();
  }, [api, session.id, attempt]);
  const execute = async () => {
    if (working.current || !preview || !requestId.current || preview.operation?.state === 'completed' || (!preview.operation && (!confirmed || preview.plan.blockers.length))) return;
    working.current = true; setBusy(true); setError('');
    try {
      const { operation } = await api.cleanupExecute(session.id, requestId.current, preview.plan.token);
      if (alive.current) { setPreview({ plan: operation.plan, operation }); onChanged(); }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '操作失败'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const plan = preview?.plan; const operation = preview?.operation;
  const completed = operation?.state === 'completed';
  return <SheetFrame open onOpenChange={open => { if (!open && !working.current) onClose(); }} title={at('永久清理会话')}>
    <div className="space-y-3 text-sm" data-workspace-cleanup={session.id} aria-busy={busy}>
      <p className="font-semibold break-words">{sessionTitle(session, at('新对话'))}</p>
      {!preview && !error && <p role="status">{at('正在计算清理影响')}</p>}
      {plan && <>
        <p className="text-slate-400">{at('将永久删除聊天记录和无入库依赖的创作历史，无法撤销。请先导出需要保留的本机修改。')}</p>
        <dl className="grid grid-cols-2 gap-2 rounded-lg bg-white/5 p-3 text-xs">
          <dt>{at('删除对话记录')}</dt><dd>{plan.total.messages}</dd>
          <dt>{at('删除创作 / 版本 / 生成 / 素材')}</dt><dd>{(['drafts', 'revisions', 'runs', 'assets'] as const).map(key => plan.total[key] - plan.retained[key]).join(' / ')}</dd>
          <dt>{at('预计释放媒体空间')}</dt><dd>{bytes(plan.reclaimableBytes)}</dd>
          <dt>{at('保留共享或入库媒体')}</dt><dd>{bytes(plan.retainedBytes)}</dd>
          <dt>{at('保留来源创作 / 版本 / 生成 / 素材')}</dt><dd>{(['drafts', 'revisions', 'runs', 'assets'] as const).map(key => plan.retained[key]).join(' / ')}</dd>
        </dl>
        <p className="text-xs text-slate-400">{at('入库依赖的素材、工作流参数和来源记录继续保留。ComfyUI 原始输入、输出和用户上传文件不受影响。')}</p>
        {!!plan.libraries.length && <div className="text-xs"><p>{at('保留关联工作流')}</p><ul className="list-disc pl-5">{plan.libraries.map(item => <li className="break-words" key={`${item.serverId}:${item.filename}`}>{item.name}</li>)}</ul></div>}
        {!!(plan.missingBlobs || plan.unknownBlobs) && <p className="text-xs text-amber-300">{at('缺失副本 {{missing}} 个，无法确认可清理的文件 {{unknown}} 个；这些文件不计入预计释放空间。', { missing: plan.missingBlobs, unknown: plan.unknownBlobs })}</p>}
        {!operation && plan.blockers.map(reason => <p key={reason} role="status" className="text-xs text-amber-300">{at(reason)}</p>)}
        {!operation && !plan.blockers.length && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>{at('我已查看影响，确认永久清理此会话')}</span></label>}
        {operation && <p role="status" className={completed ? 'text-green-400' : 'text-amber-300'}>{at(completed ? '清理完成，已释放 {{size}}' : '会话记录已清理，部分媒体副本仍待删除。可继续原清理操作。', { size: bytes(operation.files.filter(file => file.state === 'removed').reduce((sum, file) => sum + file.bytes, 0)) })}</p>}
      </>}
      {error && <p role="alert" className="text-xs text-amber-300">{at(error)}</p>}
      <div className="flex flex-wrap gap-2">
        {!completed && <button className={chipButton} disabled={busy} onClick={() => reload(value => value + 1)}>{at('重新检查清理影响')}</button>}
        {preview && !completed && <button className={`${chipButton} text-red-300`} disabled={busy || (!operation && (!confirmed || !!plan?.blockers.length))} onClick={() => void execute()}>{busy && <Loader2 size={14} className="animate-spin" />}{at(operation ? '继续清理' : '确认永久清理')}</button>}
        <button className={chipButton} disabled={busy} onClick={onClose}>{at('关闭')}</button>
      </div>
    </div>
  </SheetFrame>;
}
