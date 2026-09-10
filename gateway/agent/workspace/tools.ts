import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { AgentHttpError } from '../store.js';
import type { Task } from '../store.js';
import { canvasToPrompt, coreWidgetLayouts } from '../../workflow/canvas.js';
import { WorkflowError } from '../../workflow/engine.js';
import type { ObjectInfo } from '../../workflow/engine.js';
import { WorkspaceRuntime } from './runtime.js';
import { runSummary } from './types.js';
import type { Operation } from './types.js';

const id = z.string().uuid();
const revision = z.number().int().positive();
const short = z.string().trim().min(1).max(100);
const page = { before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional() };
const kind = z.enum(['image', 'video', 'audio', 'file']);
const bindingChange = z.object({ nodeId: short, inputName: short, assetId: id.nullable() }).strict();
const template = {
  templateId: short, text: z.string().max(8000), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  frames: z.number().int().positive().optional(), seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  modelVariant: z.enum(['q5', 'q6']).optional(), checkpoint: z.string().max(500).optional(), filenamePrefix: z.string().max(300).optional(),
  references: z.array(bindingChange).max(8).optional(),
};
const patch = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_input'), nodeId: short, input: short, value: z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.tuple([short, z.number().int().nonnegative()])]) }).strict(),
  z.object({ op: z.literal('remove_input'), nodeId: short, input: short }).strict(),
]);
const bounded = (value: unknown, limit = 4000) => { const json = JSON.stringify(value); return json && json.length > limit ? `${json.slice(0, limit)}…` : value; };

export function operationSummary(operation: Operation) {
  const result = operation.result as { draft?: { id: string }; revision?: { draftId: string; revision: number } | number; runId?: string; draftId?: string } | undefined;
  return { id: operation.id, stepKey: operation.stepKey, kind: operation.kind, targetDraftId: operation.targetDraftId, dependsOn: operation.dependsOn, repairOf: operation.repairOf, state: operation.state,
    result: result ? { draftId: result.draft?.id ?? (typeof result.revision === 'object' ? result.revision.draftId : result.draftId), revision: typeof result.revision === 'object' ? result.revision.revision : result.revision, runId: result.runId } : undefined, error: operation.error };
}

export function workspaceTools(runtime: WorkspaceRuntime, task: Task, info: ObjectInfo, signal: AbortSignal): ToolSet {
  const repo = runtime.repository;
  // SDK tool calls may be delivered in parallel. Serialize to make graph changes and suspensions deterministic.
  let tail = Promise.resolve();
  const execute = <T>(name: string, fn: (args: T) => unknown | Promise<unknown>) => (args: T, options: { toolCallId: string }) => {
    const work = tail.then(async () => {
      const callId = options.toolCallId;
      runtime.store.event(task.sessionId, task.id, 'tool_started', { callId, name, args: bounded(args) });
      let result: unknown;
      try {
        signal.throwIfAborted();
        const current = runtime.store.task(task.id);
        if (current.state !== 'running' || Date.now() > current.deadline) throw new AgentHttpError(409, '任务已暂停或停止，请等待当前操作完成');
        result = await fn(args);
      } catch (error) {
        result = error instanceof WorkflowError ? { error: 'workflow_validation', diagnostics: error.diagnostics }
          : error instanceof AgentHttpError ? { error: error.message } : { error: `工具 ${name} 执行失败` };
      }
      const isError = !!(result && typeof result === 'object' && 'error' in result);
      runtime.store.event(task.sessionId, task.id, 'tool_finished', { callId, name, result: bounded(result), isError });
      return result;
    });
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
  const identity = (operationId: string) => ({ taskId: task.id, operationId });
  const mark = (draftId: string, sourceRevision: number) => runtime.target(task.id, { targetDraftId: draftId, sourceRevision });
  return {
    inspect_environment: tool({ description: 'Read reviewed workspace capabilities, not the complete server installation. editableNodeTypes contains only installed nodes supported by this workspace codec. An omitted node may still be installed: use get_node_schema to check its exact name. Templates list supported reference slots; absence of a template does not prove a model architecture or server node is unavailable.', inputSchema: z.object({}).strict(), execute: execute('inspect_environment', () => ({ editableNodeTypes: Object.keys(info).filter(name => Object.hasOwn(coreWidgetLayouts, name)), installedNodeTypeCount: Object.keys(info).length, scope: 'Reviewed workspace capabilities only. Use get_node_schema to verify installation of an unlisted node; unsupported here does not mean uninstalled.', checkpoints: info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [], templates: runtime.workflows.templates(info) })) }),
    get_node_schema: tool({ description: 'Read exact installation and workspace codec support alongside a node schema. workspaceEditable applies to supported parameter edits; it does not establish that a complete masked-edit template is available.', inputSchema: z.object({ name: short }).strict(), execute: execute('get_node_schema', ({ name }: { name: string }) => Object.hasOwn(info, name) ? { name, installed: true, workspaceEditable: Object.hasOwn(coreWidgetLayouts, name), schema: info[name] } : { name, installed: false, workspaceEditable: false, error: '节点未安装' }) }),
    search_templates: tool({ description: 'List reviewed creation templates and reference slots. Unbound drafts can be saved, but require selected assets before execution.', inputSchema: z.object({}).strict(), execute: execute('search_templates', () => [...runtime.workflows.templates(info), { id: 'basic-text-to-image', description: 'Classic checkpoint + CLIP/VAE/KSampler. Requires a compatible installed checkpoint.', referenceSlots: [] }]) }),
    plan_operations: tool({ description: 'Persist steps before mutation. create_workflow omits targetDraftId; all other kinds require an existing targetDraftId. For a new creation, plan and execute create_workflow first, then plan generation using its returned draftId. Dependencies use earlier stepKeys, not future draft IDs. Reuse operationId for the same action; repairOf names a failed stepKey. Never repeat completed generation as a new step.', inputSchema: z.object({ steps: z.array(z.object({ stepKey: short, kind: z.enum(['create_workflow', 'edit_workflow', 'fork_workflow', 'replace_workflow_template', 'restore_workflow', 'submit_preview']), targetDraftId: id.optional(), dependsOn: z.array(short).max(24).optional(), repairOf: short.optional() }).strict()).min(1).max(24) }).strict(), execute: execute('plan_operations', (args: { steps: Parameters<typeof repo.plan>[2] }) => repo.plan(task.sessionId, task.id, args.steps).map(operationSummary)) }),
    list_drafts: tool({ description: 'Find independent creations in this conversation, newest first. Filter by name or output kind to resolve the user target. More results are available via nextCursor.', inputSchema: z.object({ ...page, archived: z.boolean().optional(), kind: kind.optional(), name: short.optional() }).strict(), execute: execute('list_drafts', (args: Parameters<typeof repo.drafts>[1]) => repo.drafts(task.sessionId, args)) }),
    get_workflow: tool({ description: 'Read an explicitly identified draft and its logical prompt with asset bindings. Omitted revision means this draft head; it never means another conversation-wide current workflow.', inputSchema: z.object({ draftId: id, revision: revision.optional() }).strict(), execute: execute('get_workflow', (args: { draftId: string; revision?: number }) => {
      const version = repo.revision(task.sessionId, args.draftId, args.revision);
      return { draft: repo.draft(task.sessionId, args.draftId), revision: version.revision, summary: version.summary, bindings: version.bindings, prompt: canvasToPrompt(version.canvas, info, false) };
    }) }),
    list_versions: tool({ description: 'Read paginated history for one draft. An old sourceRevision can be edited while expectedHeadRevision checks the actual current head.', inputSchema: z.object({ draftId: id, ...page }).strict(), execute: execute('list_versions', (args: { draftId: string; before?: number; limit?: number }) => repo.revisions(task.sessionId, args.draftId, args)) }),
    list_assets: tool({ description: 'Find exact uploaded or generated assets and stable displayOrdinal within a generation batch. Use asset IDs as references, never filenames or a floating latest-result pointer.', inputSchema: z.object({ ...page, kind: kind.optional(), runId: id.optional(), draftId: id.optional() }).strict(), execute: execute('list_assets', (args: Parameters<typeof repo.assets>[1]) => repo.assets(task.sessionId, args)) }),
    get_asset: tool({ description: 'Read an asset and the exact source Run. To edit the original generation use that Run draft/revision; uploaded assets have no original workflow.', inputSchema: z.object({ assetId: id }).strict(), execute: execute('get_asset', ({ assetId }: { assetId: string }) => { const asset = repo.asset(task.sessionId, assetId); return { asset, sourceRun: asset.sourceRunId ? runSummary(repo.run(task.sessionId, asset.sourceRunId)) : null, provenance: runtime.assetProvenance(task.sessionId, assetId) }; }) }),
    list_runs: tool({ description: 'List generation attempts for this conversation or one draft. Versions and attempts are different identities.', inputSchema: z.object({ ...page, draftId: id.optional() }).strict(), execute: execute('list_runs', (args: Parameters<typeof repo.runs>[1]) => { const result = repo.runs(task.sessionId, args); return { ...result, items: result.items.map(runSummary) }; }) }),
    get_run: tool({ description: 'Read exact inputs and up to 16 outputs of an identified generation; list_assets with runId retrieves further outputs. Follow input asset IDs to find the original image even after newer images exist.', inputSchema: z.object({ runId: id }).strict(), execute: execute('get_run', ({ runId }: { runId: string }) => { const run = repo.run(task.sessionId, runId); return { ...runSummary(run), inputManifest: run.inputManifest.map(({ bindingId, assetId, blobDigest }) => ({ bindingId, assetId, blobDigest })) }; }) }),
    create_workflow: tool({ description: 'Create an independent draft from a reviewed template, preserving existing image/video drafts. Bind references using selected asset IDs and template reference slots. Does not generate.', inputSchema: z.object({ ...template, name: short, operationId: id }).strict(), execute: execute('create_workflow', (args: Parameters<WorkspaceRuntime['workflows']['create']>[1] & { operationId: string }) => {
      const { operationId, ...input } = args; const result = runtime.workflows.create(task.sessionId, input, identity(operationId), info);
      mark(result.draft.id, result.revision.revision); return { draftId: result.draft.id, revision: result.revision.revision, diagnostics: result.diagnostics };
    }) }),
    edit_workflow: tool({ description: 'Edit a specific draft, using sourceRevision as the content base and expectedHeadRevision for conflict detection. Change references only via bindingChanges. Preserves old revisions and outputs; does not generate.', inputSchema: z.object({ draftId: id, sourceRevision: revision, expectedHeadRevision: revision, summary: z.string().trim().min(1).max(300), operations: z.array(patch).max(40).optional(), bindingChanges: z.array(bindingChange).max(8).optional(), operationId: id }).strict(), execute: execute('edit_workflow', (args: Parameters<WorkspaceRuntime['workflows']['edit']>[1] & { operationId: string }) => {
      runtime.assertHistoricalInputBase(task.id, args.draftId, args.sourceRevision);
      const { operationId, ...input } = args; const result = runtime.workflows.edit(task.sessionId, input, identity(operationId), info);
      mark(input.draftId, result.revision.revision); return { draftId: input.draftId, revision: result.revision.revision, diagnostics: result.diagnostics };
    }) }),
    fork_workflow: tool({ description: 'Create another independently editable direction from a fixed historical revision. Use when the user wants to keep developing both directions, not for every parameter change.', inputSchema: z.object({ sourceDraftId: id, sourceRevision: revision, name: short, operationId: id }).strict(), execute: execute('fork_workflow', (args: { sourceDraftId: string; sourceRevision: number; name: string; operationId: string }) => {
      runtime.assertHistoricalInputBase(task.id, args.sourceDraftId, args.sourceRevision);
      const result = repo.fork(task.sessionId, args.sourceDraftId, args.sourceRevision, args.name, identity(args.operationId));
      mark(result.draft.id, result.revision.revision); return { draftId: result.draft.id, revision: result.revision.revision, forkedFrom: result.draft.forkedFrom };
    }) }),
    restore_workflow: tool({ description: 'Explicitly restore an old revision as a new head, without generation. For editing an old result directly, edit_workflow avoids an unnecessary intermediate restore.', inputSchema: z.object({ draftId: id, sourceRevision: revision, expectedHeadRevision: revision, operationId: id }).strict(), execute: execute('restore_workflow', (args: { draftId: string; sourceRevision: number; expectedHeadRevision: number; operationId: string }) => {
      runtime.assertHistoricalInputBase(task.id, args.draftId, args.sourceRevision);
      const result = repo.restore(task.sessionId, args.draftId, args.sourceRevision, args.expectedHeadRevision, identity(args.operationId));
      mark(args.draftId, result.revision); return { draftId: args.draftId, revision: result.revision };
    }) }),
    replace_workflow_template: tool({ description: 'Replace the template of a specified creation only when the user requests rebuilding it. Image-to-video normally creates a separate draft. Preserves history; does not generate.', inputSchema: z.object({ ...template, draftId: id, expectedHeadRevision: revision, reason: z.string().trim().min(1).max(300), operationId: id }).strict(), execute: execute('replace_workflow_template', (args: Parameters<WorkspaceRuntime['workflows']['replace']>[1] & { operationId: string }) => {
      runtime.assertHistoricalInputBase(task.id, args.draftId, args.expectedHeadRevision);
      const { operationId, ...input } = args; const result = runtime.workflows.replace(task.sessionId, input, identity(operationId), info);
      mark(input.draftId, result.revision.revision); return { draftId: input.draftId, revision: result.revision.revision, diagnostics: result.diagnostics };
    }) }),
    validate_workflow: tool({ description: 'Distinguish editable structure from executable state. Missing reference assets prevent execution without preventing draft editing.', inputSchema: z.object({ draftId: id, revision }).strict(), execute: execute('validate_workflow', (args: { draftId: string; revision: number }) => runtime.workflows.validate(task.sessionId, args.draftId, args.revision, info)) }),
    submit_preview: tool({ description: 'Generate a pinned draft revision once. Uses GPU resources. Call alone when authorized by the current request, and wait for its result or approval. A ready output asset can then be used by later steps.', inputSchema: z.object({ draftId: id, revision, operationId: id }).strict(), execute: execute('submit_preview', (args: { draftId: string; revision: number; operationId: string }) => runtime.submit(task.id, args.draftId, args.revision, args.operationId, signal)) }),
    request_selection: tool({ description: 'Persist a clarification when multiple targets/references are reasonable or missing information prevents action. Supply exact candidate IDs, or no candidates for free text. Pauses the task; stop calling tools and await the answer. Keep requestId stable when replaying.', inputSchema: z.object({ requestId: short, question: z.string().trim().min(1).max(1000), candidates: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('asset'), assetId: id }).strict(), z.object({ type: z.literal('draft'), draftId: id, revision: revision.optional() }).strict()])).max(12), multiple: z.boolean().optional() }).strict(), execute: execute('request_selection', (args: Parameters<WorkspaceRuntime['selections']['request']>[2]) => runtime.selections.request(task.sessionId, task.id, args)) }),
  };
}
