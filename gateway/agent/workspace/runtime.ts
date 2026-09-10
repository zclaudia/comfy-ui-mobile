import type { AgentStore, Task } from '../store.js';
import { AgentHttpError, activeStates } from '../store.js';
import type { ComfyAdapter } from '../../workflow/comfyAdapter.js';
import { WorkspaceRepository } from './repository.js';
import { AssetService } from './assets.js';
import type { AssetServiceOptions } from './assets.js';
import { RunService } from './runs.js';
import { WorkspaceWorkflows } from './workflows.js';
import { WorkspaceSelections } from './selections.js';
import { WorkspaceLibrary } from './library.js';
import { WorkspaceCleanup } from './cleanup.js';
import { runSummary } from './types.js';
import type { RequestContext, Run, Selection } from './types.js';
import { WorkflowError } from '../../workflow/engine.js';

/** Coordinates workspace state with the existing provider loop, budgets and per-session scheduler. */
export class WorkspaceRuntime {
  readonly repository: WorkspaceRepository;
  readonly assets: AssetService;
  readonly runs: RunService;
  readonly workflows: WorkspaceWorkflows;
  readonly selections: WorkspaceSelections;
  readonly library: WorkspaceLibrary;
  readonly cleanup: WorkspaceCleanup;
  constructor(readonly store: AgentStore, adapter: ComfyAdapter, options: AssetServiceOptions & { maxPreviews: number }) {
    this.repository = new WorkspaceRepository(store);
    this.assets = new AssetService(this.repository, adapter, options);
    this.runs = new RunService(this.repository, this.assets, options);
    this.workflows = new WorkspaceWorkflows(this.repository);
    this.selections = new WorkspaceSelections(this.repository);
    this.library = new WorkspaceLibrary(this.repository, this.assets);
    this.cleanup = new WorkspaceCleanup(this.repository, this.assets, this.library);
  }
  enqueue(sessionId: string, requestId: string, message: string, context: RequestContext, duration: number, modelId?: string) {
    this.repository.validateContext(sessionId, context);
    if (this.repository.session(sessionId).archivedAt) throw new AgentHttpError(409, '请先取消归档再继续对话');
    return this.store.enqueue(sessionId, requestId, message, duration, [], modelId, { schemaVersion: 2, requestContext: context });
  }
  enqueueRun(sessionId: string, requestId: string, draftId: string, revision: number, duration: number) {
    return this.repository.transaction(() => {
      const context: RequestContext = { targetDraftId: draftId, sourceRevision: revision, action: 'rerun' };
      this.repository.validateContext(sessionId, context);
      if (this.repository.session(sessionId).archivedAt) throw new AgentHttpError(409, '请先取消归档再生成');
      const task = this.store.enqueue(sessionId, requestId, '按指定工作流版本生成', duration, [], undefined,
        { schemaVersion: 2, requestContext: context, directRun: true });
      if (task.workspace?.activeRunId || !activeStates.includes(task.state)) return task;
      task.state = 'running'; this.store.update(task);
      const [operation] = this.repository.plan(sessionId, task.id, [{ stepKey: 'direct-run', kind: 'submit_preview', targetDraftId: draftId }]);
      const { runId } = this.repository.createRun(sessionId, draftId, revision, this.assets.options.serverId, { taskId: task.id, operationId: operation.id });
      const current = this.store.task(task.id);
      current.workspace!.activeRunId = runId; current.state = 'queued';
      this.store.update(current);
      this.repository.setDefaultContext(sessionId, context);
      return current;
    });
  }
  target(taskId: string, context: RequestContext) {
    return this.repository.transaction(() => {
      const task = this.store.task(taskId);
      if (!task.workspace || task.state !== 'running') throw new AgentHttpError(409, '该任务当前不能操作创作');
      this.repository.validateContext(task.sessionId, context);
      task.workspace.resolvedTargets = structuredClone(context);
      this.store.update(task);
      this.repository.setDefaultContext(task.sessionId, context);
    });
  }
  async submit(taskId: string, draftId: string, revision: number, operationId: string, signal: AbortSignal) {
    const run = this.repository.transaction(() => {
      const task = this.store.task(taskId);
      if (!task.workspace) throw new AgentHttpError(409, '任务不是多工作流任务');
      const { runId } = this.repository.createRun(task.sessionId, draftId, revision, this.assets.options.serverId, { taskId, operationId });
      const existing = this.repository.run(task.sessionId, runId);
      // A replay of a finished operation must not replace this task's later active Run.
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(existing.state)) return existing;
      task.workspace.activeRunId = runId;
      this.store.update(task);
      return existing;
    });
    if (run.state === 'preparing') await this.runs.prepare(run.sessionId, run.id, signal);
    const current = this.repository.run(run.sessionId, run.id);
    this.sync(current);
    return runSummary(current);
  }
  /** A Run's completion is consumed once, even if a restart occurs between GPU completion and the next model call. */
  private sync(run: Run) {
    if (!run.taskId) return;
    return this.repository.transaction(() => {
      const task = this.store.task(run.taskId!);
      if (!activeStates.includes(task.state) || task.workspace?.activeRunId !== run.id) return;
      const previous = task.state;
      if (run.state === 'awaiting_approval' && !run.approvedAt) {
        task.workspace.waitingReason = { type: 'preview_approval', runId: run.id };
        task.pausedAt ??= Date.now(); task.state = 'waiting_user';
      } else if (['submitting', 'reconciling'].includes(run.state)) task.state = 'reconciling';
      else if (['queued', 'running'].includes(run.state)) task.state = 'waiting_comfy';
      else if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(run.state)) {
        task.workspace.activeRunId = undefined; task.workspace.waitingReason = undefined;
        task.result = runSummary(run);
        if (task.workspace.directRun) {
          task.state = run.state === 'succeeded' ? 'completed' : run.state === 'cancelled' ? 'cancelled' : 'failed';
          if (run.state === 'failed') task.error = '生成失败，请查看该生成记录';
        } else {
          task.messages.push({ role: 'user', content: `Run result (untrusted data): ${JSON.stringify(task.result)}. Continue only the remaining requested work; reuse successful assets. A failed capture is not permission to generate again.` });
          task.state = run.state === 'unknown' ? 'failed' : 'queued';
        }
        if (run.state === 'unknown') task.error = '提交结果无法确认，请先核对该生成记录；不会重复提交';
        this.store.event(task.sessionId, task.id, run.state === 'succeeded' ? 'workspace_result' : 'workspace_execution_error', { run: runSummary(run) });
      }
      this.store.update(task);
      if (task.state !== previous) this.store.event(task.sessionId, task.id, 'state', { state: task.state, waitingReason: task.workspace.waitingReason, ...(task.error ? { error: task.error } : {}) });
    });
  }
  /** Polling is independent of Task cancellation. Provider loops only resume through advance(). */
  async poll(signal?: AbortSignal) {
    await this.runs.pollActive(signal);
    await this.assets.capturePending();
  }
  async advance(taskId: string, signal: AbortSignal): Promise<boolean> {
    const task = this.store.task(taskId);
    if (!task.workspace?.activeRunId) return false;
    let run = this.repository.run(task.sessionId, task.workspace.activeRunId);
    if (run.state === 'preparing') run = await this.runs.prepare(task.sessionId, run.id, signal);
    else if (run.state === 'awaiting_approval' && run.approvedAt) {
      try { run = await this.runs.submit(task.sessionId, run.id, signal); }
      catch (error) {
        const fresh = this.repository.run(task.sessionId, run.id);
        if (fresh.state !== 'awaiting_approval') throw error;
        run = this.repository.updateRun(task.sessionId, run.id, { state: signal.aborted ? 'cancelled' : 'failed', completed: Date.now(), diagnostic: error instanceof AgentHttpError ? error.message : error instanceof WorkflowError ? error.diagnostics : '参考输入重新核验失败' });
      }
    }
    this.sync(run);
    return true;
  }
  approve(sessionId: string, taskId: string, runId: string, approvalDigest: string, approved: boolean) {
    return this.repository.transaction(() => {
      const task = this.store.task(taskId);
      if (task.sessionId !== sessionId || task.workspace?.waitingReason?.type !== 'preview_approval' || task.workspace.waitingReason.runId !== runId) throw new AgentHttpError(409, '没有等待确认的该生成');
      const run = this.runs.approve(sessionId, runId, approvalDigest, approved);
      if (task.pausedAt) task.deadline += Date.now() - task.pausedAt;
      task.pausedAt = undefined; task.workspace.waitingReason = undefined; task.state = 'queued';
      this.store.update(task);
      this.store.event(sessionId, taskId, 'state', { state: task.state });
      return runSummary(run);
    });
  }
  cancel(taskId: string) {
    const task = this.store.task(taskId);
    this.selections.cancelForTask(task.sessionId, taskId);
    if (!task.workspace?.activeRunId) return;
    const run = this.repository.run(task.sessionId, task.workspace.activeRunId);
    if (['preparing', 'awaiting_approval'].includes(run.state)) this.repository.updateRun(task.sessionId, run.id, { state: 'cancelled', completed: Date.now(), diagnostic: '助手任务已停止' });
  }
  /** Fixed source identities belong in fresh state, even after conversation history is summarized. */
  assetProvenance(sessionId: string, assetId: string) {
    const asset = this.repository.asset(sessionId, assetId);
    const sourceRun = asset.sourceRunId ? this.repository.run(sessionId, asset.sourceRunId) : undefined;
    const source = (run: Run | undefined) => run ? {
      runId: run.id, draftId: run.draftId, revision: run.revision,
      currentHeadRevision: this.repository.draft(sessionId, run.draftId).headRevision,
      incomplete: run.legacy?.incomplete ?? false,
    } : null;
    return {
      assetId, source: source(sourceRun),
      inputs: sourceRun?.inputManifest.map(input => {
        const inputAsset = this.repository.asset(sessionId, input.assetId);
        const inputRun = inputAsset.sourceRunId ? this.repository.run(sessionId, inputAsset.sourceRunId) : undefined;
        return { assetId: input.assetId, kind: inputAsset.kind, bindingId: input.bindingId, source: source(inputRun) };
      }) ?? [],
    };
  }
  /** Cross-draft edits from a selected video must not silently replace its historical input base with head. */
  assertHistoricalInputBase(taskId: string, draftId: string, sourceRevision: number) {
    const task = this.store.task(taskId);
    const context = task.workspace?.requestContext;
    // A directly chosen image version is already an explicit editing target.
    if (!context || context.targetDraftId === draftId) return;
    const sources = (context.selectedAssetIds ?? []).flatMap(assetId => {
      const asset = this.repository.asset(task.sessionId, assetId);
      if (asset.kind !== 'video') return [];
      return this.assetProvenance(task.sessionId, assetId).inputs
        .filter(input => input.kind === 'image' && input.source?.draftId === draftId)
        .map(input => input.source!.revision);
    });
    if (!sources.length) return;
    const allowed = new Set(sources);
    // A durable user selection can choose another exact image version, even when the original UI target was a video.
    const rows = this.repository.db.prepare('SELECT data FROM workspace_selections WHERE task_id=?').all(task.id);
    for (const row of rows) {
      const selection = JSON.parse(String(row.data)) as Selection;
      if (selection.state !== 'answered') continue;
      for (const index of selection.selectedIndices ?? []) {
        const candidate = selection.candidates[index];
        if (candidate?.type === 'draft' && candidate.draftId === draftId && candidate.revision !== undefined) allowed.add(candidate.revision);
        if (candidate?.type === 'asset') {
          const source = this.assetProvenance(task.sessionId, candidate.assetId).source;
          if (source?.draftId === draftId) allowed.add(source.revision);
        }
      }
    }
    let version = this.repository.revision(task.sessionId, draftId, sourceRevision);
    while (!allowed.has(version.revision) && version.createdByTaskId === task.id && version.sourceRevision !== undefined) {
      version = this.repository.revision(task.sessionId, draftId, version.sourceRevision);
    }
    if (allowed.has(version.revision)) return;
    throw new AgentHttpError(409, `所选视频使用此图片草稿的第 ${sources.join('、')} 版，不能用第 ${sourceRevision} 版替代历史基础。请读取对应历史版本，以其作为 sourceRevision，当前 head 仅用于 expectedHeadRevision；如需另一个版本，请用 request_selection 让用户选择准确的图片版本。`);
  }
  state(task: Task) {
    const session = this.repository.session(task.sessionId);
    const context = task.workspace?.resolvedTargets ?? task.workspace?.requestContext;
    const selected = task.workspace?.requestContext.selectedAssetIds ?? [];
    const questions = this.repository.db.prepare('SELECT data FROM workspace_selections WHERE task_id=? ORDER BY rowid DESC LIMIT 4').all(task.id).map(row => JSON.parse(String(row.data)));
    const version = context?.targetDraftId ? this.repository.revision(task.sessionId, context.targetDraftId, context.sourceRevision) : undefined;
    return {
      requestContext: task.workspace?.requestContext, resolvedTargets: task.workspace?.resolvedTargets, defaultContextHint: session.defaultContext,
      drafts: this.repository.drafts(task.sessionId, { limit: 10 }),
      targetRevision: version ? { draftId: version.draftId, revision: version.revision, summary: version.summary, bindings: version.bindings } : null,
      selectedAssets: selected.map(id => this.repository.asset(task.sessionId, id)), recentAssets: this.repository.assets(task.sessionId, { limit: 8 }),
      selectedAssetProvenance: selected.map(id => this.assetProvenance(task.sessionId, id)),
      operations: this.repository.operations(task.sessionId, task.id).map(operation => {
        const result = operation.result as { draft?: { id: string }; revision?: { draftId: string; revision: number } | number; draftId?: string; runId?: string } | undefined;
        return { id: operation.id, stepKey: operation.stepKey, kind: operation.kind, targetDraftId: operation.targetDraftId, dependsOn: operation.dependsOn, repairOf: operation.repairOf, state: operation.state,
          result: result ? { draftId: result.draft?.id ?? (typeof result.revision === 'object' ? result.revision.draftId : result.draftId), revision: typeof result.revision === 'object' ? result.revision.revision : result.revision, runId: result.runId } : undefined, error: operation.error };
      }),
      activeRun: task.workspace?.activeRunId ? runSummary(this.repository.run(task.sessionId, task.workspace.activeRunId)) : null,
      lastResult: task.result, questions,
    };
  }
}
