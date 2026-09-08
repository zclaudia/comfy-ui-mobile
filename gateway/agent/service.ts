import { collectMediaOutputs } from './media.js';
import { createModelWorkflow, modelTemplates } from './modelProfiles.js';
import { coreWidgetLayouts } from '../workflow/canvas.js';
import { randomUUID } from 'node:crypto';
import { APICallError, generateText, tool, stepCountIs, asSchema } from 'ai';
import { AgentModels, type ModelProfile } from './models.js';
import { compactContext, ContextError, estimateTokens, isContextOverflow } from './context.js';
import type { ImagePart, LanguageModel, ModelMessage, ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { AgentStore, AgentHttpError, activeStates, describeAttachments } from './store.js';
import type { Attachment, Task, State, SessionWorkflow, PreviewPolicy } from './store.js';
import { canvasToPrompt, applyCanvasPatch } from '../workflow/canvas.js';
import type { Canvas } from '../workflow/canvas.js';
import { WorkflowError, validatePrompt } from '../workflow/engine.js';
import type { ObjectInfo, PatchOperation } from '../workflow/engine.js';
import { ComfyAdapter, ComfyRequestError } from '../workflow/comfyAdapter.js';
import { textToImage } from './templates.js';
import { assistantSystem, auditorSystem, completionCheck, stepState } from './prompts.js';

export interface AgentConfig {
  agentStorePath: string; comfyUrl: string; comfyAuthToken?: string;
  agentContextWindow?: number; agentMaxOutputTokens?: number;
  agentModel?: string; agentBaseUrl?: string; agentApiKey?: string; agentVision?: boolean;
  agentMaxSteps?: number; agentMaxPreviews?: number; agentTimeoutMs?: number; agentPollMs?: number;
  /** Default per-call bound; a model profile's stepTimeoutSeconds overrides it. */
  agentStepTimeoutMs?: number;
  /** Model calls in flight at once across sessions. A session is always serial. */
  agentConcurrency?: number;
  /** Transient provider failures (429, 5xx, network, timeout) re-queue the step this many times with growing delay. */
  agentRetries?: number; agentRetryDelayMs?: number;
}
const inputValue = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.tuple([z.string(), z.number().int().nonnegative()])]);
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_input'), nodeId: z.string(), input: z.string(), value: inputValue }).strict(),
  z.object({ op: z.literal('remove_input'), nodeId: z.string(), input: z.string() }).strict(),
]);
const terminal = (task: Task) => !activeStates.includes(task.state);
/** Providers accept these raster formats as image input; anything else (SVG, HEIC, TIFF) stays a path-only reference. */
const visionMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const extensionMediaType: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_VISION_IMAGES = 4;
/** Most providers cap a single image near 5 MB and the whole request well under 32 MB of base64; larger files stay path-only. */
const MAX_VISION_BYTES = 5 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 16 * 1024 * 1024;
const truncate = (data: unknown, size = 12000): string => { const text = JSON.stringify(data) ?? 'null'; return text.length <= size ? text : `${text.slice(0, size)}… [truncated]`; };
/** Tool arguments and results are replayed to every client that opens the session, so keep the value itself while it is
 *  small and degrade to a truncated string once it is not. The transcript renders either shape. */
const payload = (data: unknown, size = 4000): unknown => { const text = JSON.stringify(data) ?? 'null'; return text.length <= size ? data : `${text.slice(0, size)}… [truncated]`; };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Only failures that happened before any tool ran are safe to replay: the provider rejected or never answered the request. */
function isTransient(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable || [408, 409, 429].includes(error.statusCode ?? 0) || (error.statusCode ?? 0) >= 500;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  return error.name === 'TypeError' && /fetch|network|socket|ECONN|EAI_AGAIN/i.test(`${error.message} ${(error as { cause?: { code?: string } }).cause?.code ?? ''}`);
}

interface Running { sessionId: string; controller: AbortController; done: Promise<void> }

export class AgentService {
  readonly store: AgentStore;
  readonly adapter: ComfyAdapter;
  private readonly model?: LanguageModel;
  readonly models: AgentModels;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private readonly running = new Map<string, Running>();
  private stopping = false;
  readonly maxSteps: number;
  readonly maxPreviews: number;
  readonly duration: number;
  readonly vision: boolean;
  readonly concurrency: number;
  readonly retries: number;
  readonly retryDelay: number;
  /** Image parts fetched once per task and injected at call time only, so persisted task messages stay text-sized. */
  private readonly images = new Map<string, ImagePart[]>();
  /** Provider tokens ÷ byte estimate per model profile, learned from real calls so compaction triggers at the right point. */
  private ratios: Record<string, number>;
  constructor(readonly config: AgentConfig, dependencies: { model?: LanguageModel; adapter?: ComfyAdapter } = {}) {
    if (/(sk-|sess-|Bearer\s)/i.test(config.agentModel ?? '')) throw new Error('Model configuration appears to contain a credential');
    this.store = new AgentStore(config.agentStorePath);
    const adopted = this.store.adoptLegacyDeviceSessions();
    if (adopted) console.log(`[agent] adopted ${adopted} per-device session(s) into the shared namespace`);
    this.adapter = dependencies.adapter ?? new ComfyAdapter(config);
    this.model = dependencies.model;
    this.models = new AgentModels(this.store, config.agentBaseUrl && config.agentModel ? {
      name: config.agentModel, model: config.agentModel, baseUrl: config.agentBaseUrl, apiKey: config.agentApiKey,
      contextWindow: config.agentContextWindow ?? 32768, maxOutputTokens: config.agentMaxOutputTokens ?? 2500, vision: config.agentVision ?? true,
    } : undefined);
    this.ratios = this.store.setting<Record<string, number>>('tokenRatios') ?? {};
    for (const task of this.store.tasks()) if (!task.modelId && this.models.get()) {
      task.modelId = this.models.get()!.id;
      this.store.update(task);
    }
    this.vision = config.agentVision ?? true;
    this.maxSteps = config.agentMaxSteps ?? 12;
    this.maxPreviews = config.agentMaxPreviews ?? 3;
    this.duration = config.agentTimeoutMs ?? 20 * 60_000;
    this.concurrency = clamp(config.agentConcurrency ?? 1, 1, 8);
    this.retries = clamp(config.agentRetries ?? 3, 0, 10);
    this.retryDelay = Math.max(0, config.agentRetryDelayMs ?? 5000);
  }
  status() {
    const profile = this.models.get();
    return { enabled: true, transcriptProtocol: 2, providerReady: !!this.model || !!profile, model: profile?.model ?? (this.model ? this.config.agentModel ?? null : null),
      modelId: profile?.id ?? null, vision: profile?.vision ?? this.vision, contextWindow: profile?.contextWindow ?? 32768,
      maxOutputTokens: profile?.maxOutputTokens ?? 2500, maxSteps: this.maxSteps, maxPreviews: this.maxPreviews, concurrency: this.concurrency };
  }
  private profile(task: Task): ModelProfile | undefined {
    return task.modelId ? this.models.get(task.modelId) : this.models.get();
  }
  private languageModel(profile?: ModelProfile) {
    if (this.model) return this.model;
    if (!profile) throw new AgentHttpError(503, '请先在 App 中配置助手模型');
    return createOpenAICompatible({ name: 'configured-provider', baseURL: profile.baseUrl, apiKey: profile.apiKey || undefined }).chatModel(profile.model);
  }
  private stepTimeout(profile?: ModelProfile) {
    return profile?.stepTimeoutSeconds ? profile.stepTimeoutSeconds * 1000 : this.config.agentStepTimeoutMs ?? 90_000;
  }
  start() {
    for (const task of this.store.tasks()) {
      if (task.state === 'running') this.setState(task, 'queued');
      // Persisted submission intent is reconciled, never blindly re-posted.
      if (task.state === 'waiting_comfy' && !task.execution?.promptId) this.setState(task, 'reconciling');
    }
    this.timer = setInterval(() => { void this.scan(); }, this.config.agentPollMs ?? 1500);
    this.timer.unref();
    void this.scan();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const entry of this.running.values()) entry.controller.abort();
    await this.scanning;
    await Promise.all([...this.running.values()].map(entry => entry.done));
    this.store.close();
  }
  private setState(task: Task, state: State, error?: string) {
    task.state = state; task.error = error;
    if (!activeStates.includes(state)) this.images.delete(task.id);
    this.store.transaction(() => {
      this.store.update(task);
      this.store.event(task.sessionId, task.id, 'state', { state, ...(error ? { error } : {}) });
      if (!activeStates.includes(state) && task.messages.length) this.store.saveContext({ ...task, messages: [...task.messages,
        ...(state === 'completed' ? [] : [{ role: 'user' as const, content: `Previous task ended with state ${state}. ${error ?? ''} Actions without tool evidence are not completed.` }]),
      ] });
    });
  }
  private fresh(task: Task) {
    const current = this.store.task(task.id);
    if (terminal(current) || this.stopping || Date.now() > current.deadline) throw new AgentHttpError(409, '任务已停止或超时');
    return current;
  }
  async createSession(owner: string, name: string, canvas?: Canvas, workflow?: SessionWorkflow) {
    if (canvas) canvasToPrompt(canvas, {}, false); // Structure only: missing model values must be repairable.
    return this.store.create(owner, workflow?.name ?? name, canvas, workflow);
  }
  snapshot(id: string, owner: string, after: number) {
    const session = this.store.session(id, owner);
    const events = this.store.events(id, after);
    return { session, versions: this.store.versions(id), tasks: this.store.tasks(id).map(({ messages: _, ...task }) => task), events, cursor: events.at(-1)?.seq ?? after, hasMore: events.length === 200 };
  }
  enqueue(id: string, owner: string, requestId: string, message: string, attachments: Attachment[] = []) {
    this.store.session(id, owner);
    if (!this.model && !this.models.get()) throw new AgentHttpError(503, '请先在 App 中配置助手模型');
    return this.store.enqueue(id, requestId, message, this.duration, attachments, this.models.get()?.id);
  }
  cancel(sessionId: string, owner: string, taskId: string) {
    this.store.session(sessionId, owner);
    const task = this.store.task(taskId);
    if (task.sessionId !== sessionId) throw new AgentHttpError(404, '任务不存在');
    if (!terminal(task)) {
      this.setState(task, 'cancelled');
      this.store.event(sessionId, task.id, 'assistant', { text: '助手任务已停止。已提交的 ComfyUI 生成可能仍在运行；不会发送影响其他任务的全局中断。' });
      this.running.get(task.id)?.controller.abort();
    }
    return { state: 'cancelled' };
  }
  /** The App answers a held submission. The scheduler performs the submission itself so a crash between the decision and the
   *  POST to ComfyUI is recovered like any other queued step instead of being lost with the HTTP request. */
  approve(sessionId: string, owner: string, taskId: string, callId: string, approved: boolean) {
    this.store.session(sessionId, owner);
    const task = this.store.task(taskId);
    if (task.sessionId !== sessionId) throw new AgentHttpError(404, '任务不存在');
    if (task.state !== 'waiting_user' || !task.approval || task.approval.callId !== callId || task.approval.decision) throw new AgentHttpError(409, '没有等待确认的操作');
    const now = Date.now();
    task.approval = { ...task.approval, decision: approved ? 'approved' : 'declined', decided: now };
    // The clock stopped while the user was deciding; give the task back the time it spent waiting.
    if (task.pausedAt) { task.deadline += now - task.pausedAt; task.pausedAt = undefined; }
    this.store.event(sessionId, task.id, 'approval', { callId, version: task.approval.version, status: task.approval.decision });
    this.setState(task, 'queued');
    return { state: task.state };
  }
  restore(id: string, owner: string, version: number, baseVersion: number) {
    this.store.session(id, owner);
    if (this.store.tasks(id).some(t => activeStates.includes(t.state))) throw new AgentHttpError(409, '请先停止当前任务');
    const target = this.store.version(id, version);
    if (!target) throw new AgentHttpError(404, '版本不存在');
    return this.store.transaction(() => {
      const next = this.store.commitVersion(id, baseVersion, target.canvas, `从版本 ${version} 恢复`);
      this.store.event(id, null, 'workflow', { version: next.version, summary: next.summary });
      return { version: next.version };
    });
  }
  updateSession(id: string, owner: string, patch: { name?: string; workflow?: SessionWorkflow | null; previewPolicy?: PreviewPolicy }) {
    this.store.session(id, owner);
    return this.store.updateSession(id, patch);
  }
  deleteSession(id: string, owner: string) {
    this.store.session(id, owner);
    for (const task of this.store.tasks(id)) {
      if (terminal(task)) continue;
      this.setState(task, 'cancelled');
      this.running.get(task.id)?.controller.abort();
    }
    this.store.deleteSession(id);
    return { deleted: true };
  }
  /** The App pushes canvas edits as a new version before the next message so the agent never works on a stale graph. */
  importVersion(id: string, owner: string, canvas: Canvas, baseVersion: number, summary: string) {
    this.store.session(id, owner);
    if (this.store.tasks(id).some(t => activeStates.includes(t.state))) throw new AgentHttpError(409, '请先停止当前任务');
    canvasToPrompt(canvas, {}, false);
    return this.store.transaction(() => {
      const next = this.store.commitVersion(id, baseVersion, canvas, summary);
      this.store.event(id, null, 'workflow', { version: next.version, summary: next.summary, source: 'canvas' });
      return { version: next.version };
    });
  }

  /** One scheduler pass plus every step it started. Tests and shutdown want the steps finished; the interval only scans. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    await this.scan();
    await Promise.all([...this.running.values()].map(entry => entry.done));
  }
  /** Polling is independent of the App connection. Scans never overlap; steps run alongside them up to the concurrency limit. */
  private scan(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.process().catch(() => { /* Individual tasks retain diagnostics; keep scheduler alive. */ }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async process() {
    for (const task of this.store.tasks()) {
      // A step in flight owns its task; touching it here would race the messages that step is about to persist.
      if (this.running.has(task.id) || task.state === 'waiting_user') continue;
      if (Date.now() > task.deadline) { this.setState(task, 'failed', '任务已达到耗时上限；已提交的生成不会重复提交'); continue; }
      if (task.state === 'waiting_comfy' || task.state === 'reconciling') {
        try { await this.checkExecution(task); }
        catch { /* Temporary ComfyUI outages are retried only as reads until the deadline. */ }
      }
    }
    if ((!this.model && !this.models.get()) || this.stopping) return;
    const busySessions = new Set([...this.running.values()].map(entry => entry.sessionId));
    for (const task of this.store.tasks()) {
      if (this.running.size >= this.concurrency) break;
      if (task.state !== 'queued' || this.running.has(task.id) || busySessions.has(task.sessionId) || (task.notBefore ?? 0) > Date.now()) continue;
      busySessions.add(task.sessionId);
      const controller = new AbortController();
      const entry: Running = { sessionId: task.sessionId, controller, done: Promise.resolve() };
      this.running.set(task.id, entry);
      entry.done = this.runStep(task, controller).catch(() => { /* runStep records its own outcome */ }).finally(() => { this.running.delete(task.id); });
    }
  }

  private async checkExecution(task: Task) {
    const execution = task.execution;
    if (!execution) { this.setState(task, 'failed', '缺少执行记录'); return; }
    if (!execution.promptId) {
      const queue = await this.adapter.getQueue() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
      this.fresh(task);
      const matches = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].filter(row => (row[3] as any)?.comfymobile_agent?.attempt_id === execution.attempt);
      // A completed task may have already left the queue.
      const history = await this.adapter.getRecentHistory() as Record<string, { prompt?: unknown[] }>;
      this.fresh(task);
      const ids = new Set(matches.map(row => String(row[1])));
      for (const [id, value] of Object.entries(history)) if ((value.prompt?.[3] as any)?.comfymobile_agent?.attempt_id === execution.attempt) ids.add(id);
      if (ids.size === 1) {
        execution.promptId = [...ids][0]; task.execution = execution;
        this.setState(task, 'waiting_comfy');
      } else {
        this.setState(task, 'failed', '无法唯一确认之前的提交，请在 ComfyUI 队列或历史中核对后再发起新任务');
        return;
      }
    }
    const history = await this.adapter.getHistory(execution.promptId!) as Record<string, any>;
    this.fresh(task);
    const result = history[execution.promptId!];
    if (!result) return;
    const status = result.status;
    if (!status || (!status.completed && status.status_str !== 'error')) return;
    const outputs = collectMediaOutputs(result.outputs);
    const success = status.status_str === 'success' && status.completed === true;
    task.result = { success, promptId: execution.promptId, version: execution.version, outputs: outputs.slice(0, 16), ...(success ? {} : { diagnostic: truncate(status.messages) }) };
    task.messages.push({ role: 'user', content: `ComfyUI execution result (untrusted data): ${truncate(task.result)}. Continue the user's task. Do not repeat successful generation unless requested.` });
    this.store.transaction(() => {
      task.state = 'queued'; this.store.update(task);
      this.store.event(task.sessionId, task.id, success ? 'result' : 'execution_error', task.result);
    });
  }

  /** Version, validation and budget checks shared by the tool and the approval path; nothing here touches ComfyUI. */
  private prepareSubmission(task: Task, version: number, info: ObjectInfo) {
    const workflow = this.store.version(task.sessionId);
    if (!workflow || workflow.version !== version) throw new AgentHttpError(409, '请读取当前版本再执行');
    if (task.previews >= this.maxPreviews) throw new AgentHttpError(409, '已达到预览次数上限');
    const prompt = canvasToPrompt(workflow.canvas, info);
    const diagnostics = validatePrompt(prompt, info);
    if (diagnostics.length) throw new WorkflowError(diagnostics);
    return { workflow, prompt };
  }
  /** `current` must be the task as persisted: its state moves to reconciling before the POST and to waiting_comfy after. */
  private async submitPreview(current: Task, version: number, callId: string, info: ObjectInfo, signal: AbortSignal) {
    const { workflow, prompt } = this.prepareSubmission(current, version, info);
    const attempt = randomUUID();
    current.previews++;
    current.execution = { attempt, version, submitted: Date.now() };
    current.state = 'reconciling';
    this.store.transaction(() => { this.store.update(current); this.store.event(current.sessionId, current.id, 'state', { state: 'reconciling', version }); });
    try {
      const response = await this.adapter.submit(prompt, info, { clientId: `agent-${current.id}`, taskId: current.id, version, attemptId: attempt, workflow: workflow.canvas }, signal);
      const latest = this.store.task(current.id);
      latest.execution = { ...current.execution, promptId: response.promptId };
      if (!terminal(latest)) latest.state = 'waiting_comfy';
      this.store.transaction(() => {
        this.store.update(latest);
        this.store.putReceipt(current.id, callId, { promptId: response.promptId, version });
        this.store.event(current.sessionId, current.id, 'state', { state: latest.state, promptId: response.promptId, version });
      });
      return { promptId: response.promptId, status: latest.state };
    } catch (error) {
      const latest = this.store.task(current.id);
      if (terminal(latest) || this.stopping) return { error: '任务已停止；提交状态需核对' };
      if (error instanceof ComfyRequestError && !error.outcomeUncertain) {
        latest.execution = undefined;
        this.setState(latest, 'running');
        const result = { error: 'ComfyUI 拒绝提交', diagnostic: truncate(error.details) };
        this.store.event(current.sessionId, current.id, 'execution_error', result);
        return result;
      }
      return { status: 'reconciling', message: '提交结果不确定，后台将核对队列与历史，不会直接重试' };
    }
  }

  private tools(task: Task, info: ObjectInfo, signal: AbortSignal): ToolSet {
    const execute = <T>(name: string, fn: (args: T, callId: string) => unknown | Promise<unknown>) => async (args: T, options: { toolCallId: string }) => {
      const callId = options.toolCallId;
      this.store.event(task.sessionId, task.id, 'tool_started', { callId, name, args: payload(args) });
      let result: unknown;
      try {
        const current = this.fresh(task);
        if (current.state !== 'running') throw new AgentHttpError(409, '任务正在等待执行，暂不接受其他操作');
        const receipt = this.store.receipt(task.id, callId);
        result = receipt !== undefined ? receipt : await fn(args, callId);
      } catch (error) {
        if (error instanceof WorkflowError) result = { error: 'workflow_validation', diagnostics: error.diagnostics };
        else if (error instanceof AgentHttpError) result = { error: error.message };
        else result = { error: `工具 ${name} 执行失败` };
      }
      const diagnostics = result && typeof result === 'object' && 'diagnostics' in result && Array.isArray(result.diagnostics) ? result.diagnostics.slice(0, 8).map(d => ({ code: String(d.code ?? '').slice(0, 100), message: String(d.message ?? '').slice(0, 300) })) : [];
      const isError = diagnostics.length > 0 || !!(result && typeof result === 'object' && 'error' in result);
      this.store.event(task.sessionId, task.id, 'tool_finished', { callId, name, isError, result: payload(result), ...(diagnostics.length ? { diagnostics } : {}), ...(isError ? { errorMessage: `工具 ${name} 未完成，请查看诊断或助手说明` } : {}) });
      return result;
    };
    const mutation = (name: string, args: unknown, callId: string, fn: () => unknown) => this.store.transaction(() => {
      this.fresh(task);
      const result = fn();
      this.store.putReceipt(task.id, callId, result);
      this.store.event(task.sessionId, task.id, 'tool', { callId, name, args, result });
      return result;
    });
    return {
      inspect_environment: tool({ description: 'List installed supported node types and available checkpoint model choices. Model names do not prove architecture compatibility.', inputSchema: z.object({}).strict(), execute: execute('inspect_environment', async () => ({
        nodeTypes: Object.keys(info).filter(name => Object.hasOwn(coreWidgetLayouts, name)),
        checkpoints: info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [],
        templates: modelTemplates(info),
        models: Object.fromEntries(['UNETLoader','UnetLoaderGGUF','CLIPLoader','CLIPLoaderGGUF','VAELoader','LoraLoaderModelOnly'].filter(name => info[name]).map(name => [name, info[name].input?.required])),
      })) }),
      get_node_schema: tool({ description: 'Read installed node input and output schema.', inputSchema: z.object({ name: z.string().max(200) }).strict(), execute: execute('get_node_schema', async ({ name }: { name: string }) => Object.hasOwn(info, name) ? info[name] : { error: '节点未安装' }) }),
      search_templates: tool({ description: 'List reviewed templates.', inputSchema: z.object({}).strict(), execute: execute('search_templates', async () => [...modelTemplates(info), { id: 'basic-text-to-image', description: 'Classic checkpoint text-to-image, 512px, CLIP + VAE + KSampler. Requires a compatible checkpoint; does not support Flux or separate loaders.' }]) }),
      create_model_workflow: tool({ description: 'Create an empty session from a reviewed Z-Image Turbo or MiniMax H3 template. Inspect available templates first. Reference assets must be explicitly provided by the user. Does not execute.', inputSchema: z.object({
        profileId:z.string(), text:z.string().min(1).max(8000), width:z.number().int().positive().optional(), height:z.number().int().positive().optional(), frames:z.number().int().positive().optional(), seed:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        referenceImage:z.string().max(500).optional(),referenceAudio:z.string().max(500).optional(),referenceVideo:z.string().max(500).optional(),modelVariant:z.enum(['q5','q6']).optional(),filenamePrefix:z.string().max(300).optional(),
      }).strict(), execute: execute('create_model_workflow', (args: Parameters<typeof createModelWorkflow>[1], callId) => mutation('create_model_workflow', args, callId, () => {
        const session=this.store.session(task.sessionId);
        if(session.version!==0) throw new AgentHttpError(409,'当前会话已有工作流，请修改现有版本');
        const canvas=createModelWorkflow(info,args);
        const version=this.store.commitVersion(session.id,0,canvas,`创建 ${args.profileId} 工作流`);
        this.store.event(session.id,task.id,'workflow',{version:version.version,summary:version.summary});
        return {version:version.version,profileId:args.profileId};
      })) }),
      create_from_template: tool({ description: 'Initialize an empty session from the reviewed basic text-to-image template.', inputSchema: z.object({ checkpoint: z.string().max(500), text: z.string().max(8000) }).strict(), execute: execute('create_from_template', ({ checkpoint, text }: { checkpoint: string; text: string }, callId) => mutation('create_from_template', { checkpoint, text }, callId, () => {
        const session = this.store.session(task.sessionId);
        if (session.version !== 0) throw new AgentHttpError(409, '当前会话已有工作流，请修改现有版本');
        const canvas = textToImage(info, checkpoint, text);
        canvasToPrompt(canvas, info);
        const version = this.store.commitVersion(session.id, 0, canvas, '创建基础文生图工作流');
        this.store.event(session.id, task.id, 'workflow', { version: version.version, summary: version.summary });
        return { version: version.version };
      })) }),
      get_workflow: tool({ description: 'Read current workflow with its version.', inputSchema: z.object({}).strict(), execute: execute('get_workflow', async () => {
        const version = this.store.version(task.sessionId);
        return version ? { version: version.version, prompt: canvasToPrompt(version.canvas, info, false) } : { version: 0, prompt: null };
      }) }),
      apply_workflow_patch: tool({ description: 'Atomically edit parameters or reconnect existing nodes. Use the current baseVersion. No arbitrary node creation/deletion; use reviewed templates to initialize sessions.', inputSchema: z.object({ baseVersion: z.number().int().nonnegative(), summary: z.string().min(1).max(300), operations: z.array(operation).min(1).max(40) }).strict(), execute: execute('apply_workflow_patch', (args: { baseVersion: number; summary: string; operations: PatchOperation[] }, callId) => mutation('apply_workflow_patch', args, callId, () => {
        const current = this.store.version(task.sessionId);
        if (!current) throw new AgentHttpError(409, '请先创建工作流');
        const next = applyCanvasPatch(current, args.baseVersion, args.operations, info);
        const version = this.store.commitVersion(task.sessionId, args.baseVersion, next.canvas, args.summary);
        this.store.event(task.sessionId, task.id, 'workflow', { version: version.version, summary: version.summary, operations: args.operations });
        return { version: version.version };
      })) }),
      validate_workflow: tool({ description: 'Validate the current workflow without submitting GPU work.', inputSchema: z.object({}).strict(), execute: execute('validate_workflow', async () => {
        const version = this.store.version(task.sessionId);
        return version ? { version: version.version, diagnostics: validatePrompt(canvasToPrompt(version.canvas, info, false), info) } : { error: '没有工作流' };
      }) }),
      save_workflow_version: tool({ description: 'Mark an existing version as saved for reuse.', inputSchema: z.object({ version: z.number().int().positive() }).strict(), execute: execute('save_workflow_version', ({ version }: { version: number }, callId) => mutation('save_workflow_version', { version }, callId, () => { this.store.saveVersion(task.sessionId, version); this.store.event(task.sessionId, task.id, 'saved', { version }); return { saved: true, version }; })) }),
      get_run: tool({ description: 'Read the last execution result for this task.', inputSchema: z.object({}).strict(), execute: execute('get_run', async () => this.store.task(task.id).result ?? { status: 'not_run' }) }),
      submit_preview: tool({ description: 'Submit the current version to ComfyUI. This uses GPU resources and suspends the agent until completion. Call alone, never alongside mutation tools. The user may have to confirm it in the App first; then the result says so and you must wait.', inputSchema: z.object({ version: z.number().int().positive() }).strict(), execute: execute('submit_preview', async ({ version }: { version: number }, callId) => {
        const current = this.fresh(task);
        if (this.store.session(task.sessionId).previewPolicy === 'confirm') {
          // Validate before asking so the user is never asked to approve a submission that would be rejected anyway.
          this.prepareSubmission(current, version, info);
          current.approval = { callId, version, requested: Date.now() };
          current.pausedAt = Date.now();
          this.setState(current, 'waiting_user');
          this.store.event(task.sessionId, task.id, 'approval', { callId, version, status: 'pending' });
          return { status: 'awaiting_user', version, message: 'The user must confirm this preview in the App before it runs. Stop here and wait; do not call other tools or submit again.' };
        }
        return this.submitPreview(current, version, callId, info, signal);
      }) }),
    };
  }

  /** Attach the task's uploaded images to its own user message. Fetch failures degrade to the path-only text; they never fail the task. */
  private async withVision(messages: ModelMessage[], task: Task, signal: AbortSignal, vision: boolean): Promise<ModelMessage[]> {
    const refs = (task.attachments ?? []).filter(a => a.kind === 'image').slice(0, MAX_VISION_IMAGES);
    if (!vision || !refs.length) return messages;
    let parts = this.images.get(task.id);
    if (!parts) {
      parts = [];
      let total = 0;
      for (const ref of refs) {
        try {
          const file = await this.adapter.getFile(ref, signal, MAX_VISION_BYTES);
          if (total + file.bytes.byteLength > MAX_VISION_TOTAL_BYTES) { console.warn('[agent] attachment skipped for vision: request image budget reached', { taskId: task.id }); continue; }
          const mediaType = visionMediaTypes.has(file.mediaType) ? file.mediaType : extensionMediaType[ref.filename.split('.').at(-1)?.toLowerCase() ?? ''];
          if (mediaType) { parts.push({ type: 'image', image: file.bytes, mediaType }); total += file.bytes.byteLength; }
        } catch (error) {
          console.warn('[agent] attachment not readable for vision', { taskId: task.id, status: error instanceof ComfyRequestError ? error.status : 0 });
        }
      }
      this.images.set(task.id, parts);
    }
    if (!parts.length) return messages;
    const own = describeAttachments(task.message, task.attachments);
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && messages[i].content === own) { index = i; break; }
    if (index < 0) return messages;
    return messages.map((m, i) => i === index ? { role: 'user', content: [{ type: 'text', text: own }, ...parts!] } : m);
  }

  /** Blend the provider's real input count into the per-profile estimate multiplier. Small calls and image calls are skipped: they say little about text density. */
  private calibrate(profile: ModelProfile | undefined, estimated: number, actual: number, hasImages: boolean) {
    if (!profile || hasImages || actual < 1000 || estimated <= 0) return;
    const previous = this.ratios[profile.id] ?? 1;
    const next = clamp(previous * 0.7 + (actual / estimated) * 0.3, 0.4, 2.5);
    if (Math.abs(next - previous) < 0.01) return;
    this.ratios[profile.id] = Number(next.toFixed(3));
    this.store.setSetting('tokenRatios', this.ratios);
  }

  private stepSignal(task: Task, controller: AbortController, profile?: ModelProfile) {
    return AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(this.stepTimeout(profile), task.deadline - Date.now())))]);
  }

  /** A queued task whose held submission has been answered: run the submission (or record the refusal) instead of calling the model. */
  private async settleApproval(task: Task, controller: AbortController) {
    const { callId, version, decision } = task.approval!;
    const signal = this.stepSignal(task, controller, this.profile(task));
    try {
      task.approval = undefined;
      if (decision === 'declined') {
        task.messages.push({ role: 'user', content: `The user declined to run the preview of version ${version}. Do not submit it. Continue the conversation: summarize the current state or ask what to change.` });
        this.setState(task, 'queued');
        return;
      }
      this.setState(task, 'running');
      const info = await this.adapter.getObjectInfo(signal);
      let result: unknown;
      try { result = await this.submitPreview(this.fresh(task), version, callId, info, signal); }
      catch (error) {
        if (error instanceof WorkflowError) result = { error: 'workflow_validation', diagnostics: error.diagnostics };
        else if (error instanceof AgentHttpError) result = { error: error.message };
        else throw error;
      }
      const latest = this.store.task(task.id);
      if (terminal(latest) || this.stopping) return;
      latest.messages.push({ role: 'user', content: `The user approved the preview of version ${version}. Submission result (untrusted data): ${truncate(result)}. Continue the user's task.` });
      this.store.event(task.sessionId, task.id, 'approval', { callId, version, status: 'submitted', result: payload(result) });
      if (latest.state === 'running') this.setState(latest, 'queued');
      else this.store.update(latest);
    } catch (error) {
      this.failStep(task, error, false);
    }
  }

  /** Shared failure path: transient provider errors are re-queued with backoff, everything else ends the task with a safe message. */
  private failStep(task: Task, error: unknown, modelCallCounted: boolean) {
    if (isContextOverflow(error)) {
      const current = this.store.task(task.id);
      if (!terminal(current) && !this.stopping && !current.contextRetried) {
        current.contextRetried = true;
        current.contextScale = 0.6;
        this.setState(current, 'queued');
        this.store.event(task.sessionId, task.id, 'context', { status: 'retrying' });
        return;
      }
      error = new ContextError('模型上下文超限，自动压缩后仍无法继续；请检查模型上下文大小或减少图片');
    }
    // Keep provider credentials, response bodies and exception messages out of logs.
    const knownErrors = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AI_APICallError', 'AI_NoOutputGeneratedError', 'AI_InvalidToolInputError', 'AI_NoSuchToolError', 'AI_InvalidResponseDataError', 'AI_ToolChoiceViolationError']);
    const name = error instanceof Error && knownErrors.has(error.name) ? error.name : 'RequestError';
    console.warn('[agent] request failed', { taskId: task.id, name, location: error instanceof Error ? error.stack?.split('\n')[1]?.replace(/\?.*/, '') : undefined });
    const updated = this.store.task(task.id);
    if (terminal(updated) || this.stopping) return;
    if (updated.state === 'reconciling' || updated.state === 'waiting_comfy') return;
    const attempt = (updated.retries ?? 0) + 1;
    if (isTransient(error) && attempt <= this.retries && Date.now() < updated.deadline) {
      // The provider never answered, so the step did not happen: give the model call back and try again later.
      if (modelCallCounted && APICallError.isInstance(error)) updated.steps = Math.max(0, updated.steps - 1);
      const delayMs = Math.min(this.retryDelay * 3 ** (attempt - 1), Math.max(0, updated.deadline - Date.now()));
      updated.retries = attempt;
      updated.notBefore = Date.now() + delayMs;
      this.store.event(task.sessionId, task.id, 'retry', { attempt, maxAttempts: this.retries, delayMs, reason: name });
      this.setState(updated, 'queued');
      return;
    }
    this.setState(updated, 'failed', error instanceof WorkflowError || error instanceof ContextError ? error.message
      : isTransient(error) ? '模型服务暂时不可用，多次重试后仍失败，请稍后再试' : '模型或 ComfyUI 请求失败，请检查 Gateway 配置与连接后重试');
  }

  private async runStep(task: Task, controller: AbortController) {
    if (task.approval?.decision) return this.settleApproval(task, controller);
    if (task.steps >= this.maxSteps) { this.setState(task, 'failed', '已达到模型调用次数上限，请查看结果后继续'); return; }
    const profile = this.profile(task);
    const signal = this.stepSignal(task, controller, profile);
    try {
      task.steps++;
      task.notBefore = undefined;
      this.setState(task, 'running');
      const info = await this.adapter.getObjectInfo(signal);
      this.fresh(task);
      const latest = this.store.session(task.sessionId);
      const current = this.store.version(task.sessionId);
      let messages = task.messages.length ? task.messages : this.store.recentMessages(task.sessionId);
      const model = this.languageModel(profile);
      const vision = profile?.vision ?? this.vision;
      const contextWindow = profile?.contextWindow ?? this.config.agentContextWindow ?? 32768;
      const maxOutputTokens = profile?.maxOutputTokens ?? this.config.agentMaxOutputTokens ?? 2500;
      const audit = profile?.completionAudit ?? true;
      const completionReview = task.awaitingCompletion ?? (task.messages.at(-1)?.role === 'user' && typeof task.messages.at(-1)?.content === 'string' && String(task.messages.at(-1)?.content).startsWith('Internal completion check'));
      const tools = this.tools(task, info, signal);
      // Stable prefix: system text and tool schemas never change within a profile, so provider caches keep them across steps.
      const settings = {
        model, maxRetries: 0, maxOutputTokens, abortSignal: signal,
        system: completionReview ? auditorSystem : assistantSystem(vision),
        tools: { ...tools, ...(completionReview ? { finish_response: tool({
          description: 'Submit the final user-facing answer only when the latest request is satisfied or genuinely blocked. This tool does not execute or modify a workflow. If an action remains, call the actual action tool instead.',
          inputSchema: z.object({ answer: z.string().min(1).max(12000) }).strict(),
          execute: async ({ answer }: { answer: string }) => ({ answer }),
        }) } : {}) },
        toolChoice: completionReview ? 'required' as const : 'auto' as const, stopWhen: stepCountIs(1),
      };
      // Volatile state rides at the end of the conversation, outside the cached prefix, and is rebuilt every step rather than persisted.
      const state: ModelMessage = { role: 'user', content: stepState({
        version: latest.version, workflow: current ? truncate(canvasToPrompt(current.canvas, info, false), 24000) : null, result: truncate(task.result),
        remainingSteps: this.maxSteps - task.steps, remainingPreviews: this.maxPreviews - task.previews, confirmPreviews: latest.previewPolicy === 'confirm',
      }) };
      // Include tool JSON schemas, system text, state message, output reservation and image headroom in every step's budget.
      const scale = profile ? this.ratios[profile.id] ?? 1 : 1;
      const estimate = (value: unknown) => Math.ceil(estimateTokens(value) * scale);
      const schema = await Promise.all(Object.entries(settings.tools).map(async ([name, value]) => ({ name, description: value.description, schema: await asSchema(value.inputSchema).jsonSchema })));
      const imageCount = vision ? Math.min(MAX_VISION_IMAGES, task.attachments?.filter(a => a.kind === 'image').length ?? 0) : 0;
      const imageReserve = imageCount * 4096;
      const fixed = estimate(settings.system) + estimate(schema) + estimate(state) + maxOutputTokens + imageReserve + 1024;
      const budget = Math.floor(contextWindow * 0.85 * (task.contextScale ?? 1)) - fixed;
      const before = estimate(messages);
      if (budget < 2000) throw new ContextError('模型上下文不足以容纳工作流和工具，请增大上下文窗口或降低输出上限');
      const prepared = await compactContext({ messages, ownMessage: describeAttachments(task.message, task.attachments), budget, model, signal, maxOutputTokens, scale,
        onStart: () => this.store.event(task.sessionId, task.id, 'context', { status: 'compacting', beforeTokens: before, contextWindow }),
        onSummary: (inputTokens, outputTokens) => {
          this.fresh(task);
          this.store.event(task.sessionId, task.id, 'usage', { inputTokens, outputTokens, purpose: 'compaction', step: task.steps });
        },
      });
      messages = prepared.messages;
      const fresh = this.fresh(task);
      fresh.messages = messages;
      fresh.awaitingCompletion = completionReview;
      this.store.update(fresh);
      if (prepared.compacted) this.store.event(task.sessionId, task.id, 'context', { status: 'compacted', beforeTokens: before, afterTokens: estimate(messages), contextWindow });
      const sent = await this.withVision(messages, task, signal, vision);
      const result = await generateText({ ...settings, messages: [...sent, state] });
      const updated = this.store.task(task.id);
      if (terminal(updated) || this.stopping) return;
      const estimatedInput = estimateTokens(settings.system) + estimateTokens(schema) + estimateTokens(messages) + estimateTokens(state);
      this.calibrate(profile, estimatedInput, result.usage.inputTokens ?? 0, sent !== messages);
      if (completionReview && !result.toolCalls.length) {
        this.setState(updated, 'failed', '模型未返回要求的操作或完成确认，请重试当前请求');
        return;
      }
      updated.messages = [...messages, ...result.response.messages];
      updated.awaitingCompletion = false;
      updated.retries = undefined;
      const finalResponse = result.toolResults.find(item => item?.toolName === 'finish_response') as { output?: { answer?: string } } | undefined;
      const finalAnswer = finalResponse?.output?.answer;
      const finishOnly = typeof finalAnswer === 'string' && result.toolCalls.length === 1;
      // A text-only response can be an acknowledgement rather than completion. Profiles that opt in review it once
      // against the actual tool evidence before exposing it as final; strong tool-calling models skip the extra call.
      const reviewCompletion = audit && !result.toolCalls.length && !!result.text.trim() && !updated.completionChecked;
      if (reviewCompletion) {
        updated.completionChecked = true;
        updated.awaitingCompletion = true;
        updated.messages.push({ role: 'user', content: completionCheck(describeAttachments(task.message, task.attachments)) });
      }
      this.store.transaction(() => {
        this.store.update(updated);
        this.store.event(task.sessionId, task.id, 'usage', { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0, step: task.steps, contextWindow, modelId: profile?.id ?? null, estimatedInputTokens: Math.ceil(estimatedInput * scale) + imageReserve, tokenScale: scale });
        if (finishOnly) this.store.event(task.sessionId, task.id, 'assistant', { text: finalAnswer });
        else if (result.text.trim() && !reviewCompletion) this.store.event(task.sessionId, task.id, 'assistant', { text: result.text });
      });
      if (updated.state === 'waiting_comfy' || updated.state === 'reconciling' || updated.state === 'waiting_user') return;
      if (finishOnly) this.setState(updated, 'completed');
      else if (result.toolCalls.length || reviewCompletion) this.setState(updated, 'queued');
      else if (!result.text.trim()) this.setState(updated, 'failed', '模型没有返回有效回答');
      else this.setState(updated, 'completed');
    } catch (error) {
      const updated = this.store.task(task.id);
      if (updated.state === 'waiting_user') return; // the held submission is intact; nothing to fail
      this.failStep(task, error, true);
    }
  }
}
