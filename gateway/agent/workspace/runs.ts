import { AgentHttpError, activeStates } from '../store.js';
import { ComfyRequestError } from '../../workflow/comfyAdapter.js';
import { WorkflowError } from '../../workflow/engine.js';
import { AssetService } from './assets.js';
import { compileRun } from './compiler.js';
import { WorkspaceRepository } from './repository.js';
import type { Run } from './types.js';

interface HistoryEntry {
  prompt?: [number, string, unknown, { comfymobile_agent?: { run_id?: string; submission_key?: string; attempt_id?: string } }];
  status?: { completed?: boolean; status_str?: string; messages?: unknown }; outputs?: unknown;
}
interface Queue { queue_running?: HistoryEntry['prompt'][]; queue_pending?: HistoryEntry['prompt'][] }
export interface RunServiceOptions { maxPreviews: number; reconciliationGraceMs?: number; maxWaitMs?: number }

/** GPU lifetime is independent of Task lifetime: cancelled conversations still receive late execution evidence. */
export class RunService {
  private readonly busy = new Map<string, Promise<Run>>();
  constructor(readonly repository: WorkspaceRepository, readonly assets: AssetService, readonly options: RunServiceOptions) {}
  private ownServer(run: Run) {
    if (run.serverId !== this.assets.options.serverId) throw new AgentHttpError(409, '此生成属于另一 ComfyUI 服务器，不能在当前服务器核对或提交');
  }
  private taskAllowsAction(run: Run) {
    if (!run.taskId) throw new AgentHttpError(409, '历史执行没有可恢复的操作任务');
    const task = this.repository.store.task(run.taskId);
    if (!activeStates.includes(task.state) || task.state === 'waiting_user') throw new AgentHttpError(409, '任务已停止或正在等待回答');
  }
  prepare(sessionId: string, runId: string, signal: AbortSignal): Promise<Run> {
    const current = this.repository.run(sessionId, runId);
    const existing = this.busy.get(runId);
    if (existing) return existing;
    const work = this.prepareOne(current, signal).finally(() => this.busy.delete(runId));
    this.busy.set(runId, work);
    return work;
  }
  private async prepareOne(initial: Run, signal: AbortSignal): Promise<Run> {
    this.ownServer(initial);
    if (initial.state !== 'preparing') return initial;
    try {
      this.taskAllowsAction(initial);
      const revision = this.repository.revision(initial.sessionId, initial.draftId, initial.revision);
      const compiled = await compileRun(revision, initial, this.assets, signal);
      signal.throwIfAborted(); this.taskAllowsAction(initial);
      const session = this.repository.session(initial.sessionId);
      this.repository.updateRun(initial.sessionId, initial.id, { executionSnapshot: compiled.executionSnapshot, inputManifest: compiled.inputManifest, approvalDigest: compiled.approvalDigest });
      if (session.previewPolicy === 'confirm') return this.repository.updateRun(initial.sessionId, initial.id, { state: 'awaiting_approval' });
      return this.dispatch(initial.sessionId, initial.id, signal, compiled);
    } catch (error) {
      const run = this.repository.run(initial.sessionId, initial.id);
      if (run.state !== 'preparing') throw error;
      return this.repository.updateRun(initial.sessionId, initial.id, { state: signal.aborted || (run.taskId && !activeStates.includes(this.repository.store.task(run.taskId).state)) ? 'cancelled' : 'failed', completed: Date.now(),
        diagnostic: error instanceof WorkflowError ? error.diagnostics : error instanceof AgentHttpError ? error.message : '生成准备失败，请检查参考素材和服务器' });
    }
  }
  /** Called only for auto policy or for the scheduler's persisted positive approval decision. */
  submit(sessionId: string, runId: string, signal: AbortSignal): Promise<Run> {
    const existing = this.busy.get(runId);
    if (existing) return existing;
    const work = this.dispatch(sessionId, runId, signal).finally(() => this.busy.delete(runId));
    this.busy.set(runId, work);
    return work;
  }
  private async dispatch(sessionId: string, runId: string, signal: AbortSignal, prepared?: Awaited<ReturnType<typeof compileRun>>): Promise<Run> {
    let run = this.repository.run(sessionId, runId);
    this.ownServer(run);
    if (!['preparing', 'awaiting_approval'].includes(run.state)) return run;
    this.taskAllowsAction(run);
    if (run.state === 'awaiting_approval' && !run.approvedAt) throw new AgentHttpError(409, '此生成尚未确认');
    // A confirmation may have waited hours. Re-verify files; only same-digest path repair preserves approval.
    const compiled = prepared ?? await compileRun(this.repository.revision(sessionId, run.draftId, run.revision), run, this.assets, signal);
    if (run.approvalDigest && compiled.approvalDigest !== run.approvalDigest) throw new AgentHttpError(409, '确认内容已经变化，请重新发起生成');
    signal.throwIfAborted();
    let ownsSubmission = false;
    run = this.repository.transaction(() => {
      const fresh = this.repository.run(sessionId, runId);
      if (!['preparing', 'awaiting_approval'].includes(fresh.state)) return fresh;
      this.taskAllowsAction(fresh);
      const task = this.repository.store.task(fresh.taskId!);
      if (task.previews >= this.options.maxPreviews) throw new AgentHttpError(409, '已达到本轮生成次数上限');
      this.repository.store.update({ ...task, previews: task.previews + 1 });
      ownsSubmission = true;
      return this.repository.updateRun(sessionId, runId, { state: 'submitting', submitted: Date.now(), executionSnapshot: compiled.executionSnapshot, inputManifest: compiled.inputManifest, approvalDigest: compiled.approvalDigest });
    });
    // Another concurrent request may already own this submission; only the one transitioning above may POST.
    if (!ownsSubmission) return run;
    try {
      const result = await this.assets.adapter.submit(run.executionSnapshot!.prompt, compiled.info, { clientId: `agent-${run.taskId}`, taskId: run.taskId!, version: run.revision,
        attemptId: run.submissionKey, workflow: run.executionSnapshot!.canvas, sessionId, draftId: run.draftId, runId: run.id }, signal);
      return this.repository.updateRun(sessionId, runId, { state: 'queued', promptId: result.promptId });
    } catch (error) {
      if (error instanceof ComfyRequestError && !error.outcomeUncertain) return this.repository.updateRun(sessionId, runId, { state: 'failed', completed: Date.now(), diagnostic: error.details ?? 'ComfyUI 拒绝生成请求' });
      return this.repository.updateRun(sessionId, runId, { state: 'reconciling', diagnostic: '提交结果尚未确认，正在核对队列与历史' });
    }
  }
  approve(sessionId: string, runId: string, approvalDigest: string, approved: boolean): Run {
    return this.repository.transaction(() => {
      const run = this.repository.run(sessionId, runId);
      if (!run.taskId || !activeStates.includes(this.repository.store.task(run.taskId).state)) throw new AgentHttpError(409, '任务已停止，确认请求已过期');
      if (run.state !== 'awaiting_approval' || run.approvedAt || run.approvalDigest !== approvalDigest) throw new AgentHttpError(409, '该确认请求已过期或已经回答');
      return this.repository.updateRun(sessionId, runId, approved ? { approvedAt: Date.now() } : { state: 'cancelled', completed: Date.now(), diagnostic: '用户跳过此次生成' });
    });
  }
  /** Query only: a recovered submitting Run is reconciled and never resubmitted. */
  async poll(sessionId: string, runId: string, signal?: AbortSignal): Promise<Run> {
    let run = this.repository.run(sessionId, runId);
    if (!['submitting', 'reconciling', 'queued', 'running'].includes(run.state)) return run;
    try { this.ownServer(run); }
    catch (error) { return this.repository.updateRun(sessionId, runId, { state: 'unknown', diagnostic: (error as Error).message }); }
    if (!run.promptId) {
      const [queue, history] = await Promise.all([this.assets.adapter.getQueue(signal) as Promise<Queue>, this.assets.adapter.getRecentHistory(signal) as Promise<Record<string, HistoryEntry>>]);
      const ids = new Set<string>();
      const matches = (entry: HistoryEntry['prompt']) => {
        const metadata = entry?.[3]?.comfymobile_agent;
        return metadata?.submission_key === run.submissionKey || metadata?.attempt_id === run.submissionKey;
      };
      for (const row of [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])]) if (row && matches(row)) ids.add(row[1]);
      for (const [id, entry] of Object.entries(history)) if (matches(entry.prompt)) ids.add(id);
      if (ids.size === 1) run = this.repository.updateRun(sessionId, runId, { state: 'queued', promptId: [...ids][0] });
      else {
        const expired = Date.now() - (run.submitted ?? run.created) >= (this.options.reconciliationGraceMs ?? 30_000);
        return this.repository.updateRun(sessionId, runId, { state: ids.size > 1 || expired ? 'unknown' : 'reconciling', diagnostic: '无法唯一确认提交，请核对该服务器上的生成记录；不会重复提交' });
      }
    }
    const history = await this.assets.adapter.getHistory(run.promptId!, signal) as Record<string, HistoryEntry>;
    const entry = history[run.promptId!];
    if (!entry?.status || (!entry.status.completed && entry.status.status_str !== 'error')) {
      if (Date.now() - (run.submitted ?? run.created) > (this.options.maxWaitMs ?? 24 * 60 * 60_000)) return this.repository.updateRun(sessionId, runId, { state: 'unknown', diagnostic: '长时间未能确认生成完成，请检查服务器历史' });
      return run;
    }
    const success = entry.status.completed === true && entry.status.status_str === 'success';
    return this.repository.transaction(() => {
      const current = this.repository.run(sessionId, runId);
      if (current.state === 'succeeded' || current.state === 'failed') return current;
      const completed = this.repository.updateRun(sessionId, runId, { state: success ? 'succeeded' : 'failed', completed: Date.now(), ...(success ? {} : { diagnostic: entry.status?.messages }) });
      return success ? this.assets.registerOutputs(sessionId, runId, entry.outputs) : completed;
    });
  }
  async pollActive(signal?: AbortSignal) {
    for (const run of this.repository.activeRuns()) {
      if (this.busy.has(run.id)) continue;
      try { await this.poll(run.sessionId, run.id, signal); } catch { /* Transient read failures retain the same Run for a later poll. */ }
    }
  }
}
