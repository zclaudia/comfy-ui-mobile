import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentHttpError, type AgentStore } from './store.js';

const identifier = z.string().trim().min(1).max(200).refine(v => !/(sk-|sess-|Bearer\s)/i.test(v), '模型名称不能包含密钥');
export const modelInput = z.object({
  name: identifier,
  model: identifier,
  baseUrl: z.string().trim().max(2000).url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, '请填写不含密钥或查询参数的 HTTP(S) API 地址'),
  apiKey: z.string().trim().max(4096).optional(),
  contextWindow: z.number().int().min(8192).max(2_000_000),
  maxOutputTokens: z.number().int().min(256).max(128_000),
  vision: z.boolean(),
  /** Review text-only answers with a forced tool call before exposing them. Worth its extra model call only for models that tend to promise instead of act. */
  completionAudit: z.boolean().default(true),
  /** Upper bound for one model call including tool execution. Reasoning models need more than the 90 s default. */
  stepTimeoutSeconds: z.number().int().min(30).max(1800).default(90),
}).strict().refine(v => v.maxOutputTokens <= v.contextWindow / 4, { path: ['maxOutputTokens'], message: '输出上限不能超过上下文窗口的四分之一' });
export type ModelInput = z.infer<typeof modelInput>;
export type ModelInputData = z.input<typeof modelInput>;
/** Profiles saved before a field existed lack it; readers fall back to the schema default. */
export interface ModelProfile extends Omit<ModelInput, 'apiKey' | 'completionAudit' | 'stepTimeoutSeconds'> { id: string; apiKey: string; completionAudit?: boolean; stepTimeoutSeconds?: number }
export interface ModelSettings { models: ModelProfile[]; activeId: string | null }
export const publicModel = ({ apiKey, ...profile }: ModelProfile) => ({ ...profile, hasApiKey: !!apiKey });

/** Credentials stay on the Gateway and are never included in status, snapshots or list responses. */
export class AgentModels {
  private settings: ModelSettings;
  constructor(private store: AgentStore, initial?: ModelInputData) {
    const saved = store.setting<ModelSettings>('models');
    this.settings = saved ?? { models: [], activeId: null };
    if (!saved) {
      if (initial) {
        const profile = { ...modelInput.parse(initial), apiKey: initial.apiKey ?? '', id: randomUUID() };
        this.settings = { models: [profile], activeId: profile.id };
      }
      this.persist();
    }
  }
  private persist() { this.store.setSetting('models', this.settings); }
  list() { return { models: this.settings.models.map(publicModel), activeId: this.settings.activeId }; }
  get(id = this.settings.activeId): ModelProfile | undefined { return this.settings.models.find(m => m.id === id); }
  private editable(id: string) {
    if (this.store.tasks().some(t => t.modelId === id)) throw new AgentHttpError(409, '该模型有运行中的任务，请先等待或停止任务');
  }
  save(input: ModelInputData, id?: string) {
    const parsed = modelInput.parse(input);
    const previous = id ? this.get(id) : undefined;
    if (id && !previous) throw new AgentHttpError(404, '模型不存在');
    if (id) this.editable(id);
    if (!id && this.settings.models.length >= 30) throw new AgentHttpError(400, '最多保存 30 个模型');
    // A retained key may only be used with the original endpoint. An endpoint change requires an explicit new key.
    if (previous && previous.baseUrl !== parsed.baseUrl && parsed.apiKey === undefined && previous.apiKey) throw new AgentHttpError(400, '更改 API 地址时请重新填写密钥');
    const profile = { ...parsed, id: id ?? randomUUID(), apiKey: parsed.apiKey ?? previous?.apiKey ?? '' };
    this.settings.models = [...this.settings.models.filter(m => m.id !== profile.id), profile];
    this.settings.activeId ??= profile.id;
    this.persist();
    return publicModel(profile);
  }
  activate(id: string) {
    if (!this.get(id)) throw new AgentHttpError(404, '模型不存在');
    this.settings.activeId = id;
    this.persist();
    return this.list();
  }
  remove(id: string) {
    if (!this.get(id)) throw new AgentHttpError(404, '模型不存在');
    this.editable(id);
    this.settings.models = this.settings.models.filter(m => m.id !== id);
    if (this.settings.activeId === id) this.settings.activeId = this.settings.models[0]?.id ?? null;
    this.persist();
    return this.list();
  }
}
