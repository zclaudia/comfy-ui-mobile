import type { Canvas } from '../../workflow/canvas.js';
import { applyCanvasPatch, canvasToPrompt, widgetLayout } from '../../workflow/canvas.js';
import type { Diagnostic, ObjectInfo, PatchOperation, Prompt } from '../../workflow/engine.js';
import { WorkflowError } from '../../workflow/engine.js';
import { createModelWorkflow, modelTemplates } from '../modelProfiles.js';
import type { ModelWorkflowOptions } from '../modelProfiles.js';
import { modelProfileData } from '../modelProfileData.js';
import { textToImage } from '../templates.js';
import { AgentHttpError } from '../store.js';
import type { SourceRef } from '../store.js';
import { assetToken, canonicalCanvas, draftDiagnostics, draftObjectInfo, loaderInputs } from './compiler.js';
import { WorkspaceRepository } from './repository.js';
import type { WriteIdentity } from './repository.js';
import type { AssetBinding, MediaKind } from './types.js';

export interface BindingChange { nodeId: string; inputName: string; assetId: string | null }
export interface TemplateInput extends Omit<ModelWorkflowOptions, 'profileId' | 'referenceImage' | 'referenceAudio' | 'referenceVideo'> {
  templateId: string; checkpoint?: string; references?: BindingChange[];
}
export interface EditInput {
  draftId: string; expectedHeadRevision: number; sourceRevision: number; summary: string;
  operations?: PatchOperation[]; bindingChanges?: BindingChange[];
}
const supportedReferenceOptions = { LoadImage: 'referenceImage', LoadAudio: 'referenceAudio', LoadVideo: 'referenceVideo' } as const;

/** Workflow editing is synchronous and transactional. Asset I/O only occurs when preparing a Run. */
export class WorkspaceWorkflows {
  constructor(readonly repository: WorkspaceRepository) {}

  templates(info: ObjectInfo) {
    return modelTemplates(info).map(template => {
      const profile = modelProfileData.find(profile => profile.id === template.id)!;
      const referenceSlots = Object.entries(profile.prompt as unknown as Prompt).flatMap(([nodeId, node]) => {
        const loader = loaderInputs[node.class_type];
        return loader ? [{ nodeId, inputName: loader.input, kind: loader.kind, role: loader.role }] : [];
      });
      return { ...template, referenceSlots, outputKinds: this.outputKinds(profile.prompt as unknown as Prompt) };
    });
  }
  private outputKinds(prompt: Prompt): MediaKind[] {
    const types = new Set(Object.values(prompt).map(node => node.class_type));
    const kinds: MediaKind[] = [];
    if (types.has('SaveImage')) kinds.push('image');
    if (types.has('SaveVideo')) kinds.push('video');
    if (types.has('SaveAudio') || Object.values(prompt).some(node => node.class_type === 'CreateVideo' && Array.isArray(node.inputs.audio))) kinds.push('audio');
    return kinds;
  }
  private check(sessionId: string, canvas: Canvas, bindings: AssetBinding[], info: ObjectInfo): Diagnostic[] {
    this.repository.validateBindings(sessionId, canvas, bindings);
    const diagnostics = draftDiagnostics(canvas, bindings, info);
    const invalid = diagnostics.filter(d => d.code !== 'unbound_asset');
    if (invalid.length) throw new WorkflowError(invalid);
    return diagnostics;
  }
  private build(sessionId: string, input: TemplateInput, info: ObjectInfo) {
    let canvas: Canvas;
    if (input.templateId === 'basic-text-to-image') {
      if (!input.checkpoint) throw new AgentHttpError(422, '基础文生图模板需要选择已安装的 checkpoint');
      if (input.frames !== undefined || input.modelVariant !== undefined) throw new AgentHttpError(422, '基础文生图模板不接受视频参数');
      canvas = textToImage(info, input.checkpoint, input.text);
      const operations: PatchOperation[] = [];
      for (const [name, value] of [['width', input.width], ['height', input.height]] as const) if (value !== undefined) operations.push({ op: 'set_input', nodeId: '4', input: name, value });
      if (input.seed !== undefined) operations.push({ op: 'set_input', nodeId: '5', input: 'seed', value: input.seed });
      if (input.filenamePrefix !== undefined) operations.push({ op: 'set_input', nodeId: '7', input: 'filename_prefix', value: input.filenamePrefix });
      if (operations.length) canvas = applyCanvasPatch({ canvas, version: 0 }, 0, operations, info).canvas;
    } else {
      const profile = modelProfileData.find(profile => profile.id === input.templateId);
      if (!profile) throw new AgentHttpError(422, '不支持此工作流模板');
      if (input.checkpoint !== undefined) throw new AgentHttpError(422, '此模板不接受 checkpoint 参数');
      const prompt = structuredClone(profile.prompt) as unknown as Prompt;
      const references: Pick<ModelWorkflowOptions, 'referenceImage' | 'referenceAudio' | 'referenceVideo'> = {};
      for (const [nodeId, node] of Object.entries(prompt)) {
        const loader = loaderInputs[node.class_type];
        if (!loader) continue;
        const selected = input.references?.find(ref => ref.nodeId === nodeId && ref.inputName === loader.input);
        const token = selected?.assetId ? assetToken(selected.assetId) : `unbound:${nodeId}:${loader.input}`;
        node.inputs[loader.input] = token;
        references[supportedReferenceOptions[node.class_type as keyof typeof supportedReferenceOptions]] = token;
      }
      canvas = createModelWorkflow(draftObjectInfo(info, prompt), { ...input, ...references, profileId: input.templateId });
    }
    const bound = this.bind(sessionId, canvas, [], input.references ?? []);
    const diagnostics = this.check(sessionId, bound.canvas, bound.bindings, info);
    return { ...bound, diagnostics, outputKinds: this.outputKinds(canvasToPrompt(bound.canvas, info, false)) };
  }
  private bind(sessionId: string, original: Canvas, current: AssetBinding[], changes: BindingChange[]) {
    const canvas = structuredClone(original);
    let bindings = structuredClone(current);
    const seen = new Set<string>();
    for (const change of changes) {
      const key = JSON.stringify([change.nodeId, change.inputName]);
      if (seen.has(key)) throw new AgentHttpError(422, '一次修改不能重复指定同一参考输入');
      seen.add(key);
      const node = canvas.nodes.find(node => String(node.id) === change.nodeId);
      const loader = node && loaderInputs[node.type];
      if (!node || !loader || loader.input !== change.inputName) throw new AgentHttpError(422, '模板中没有该参考输入');
      const prior = bindings.find(b => b.nodeId === change.nodeId && b.inputName === change.inputName);
      bindings = bindings.filter(b => b !== prior);
      if (change.assetId !== null) {
        const asset = this.repository.asset(sessionId, change.assetId);
        if (asset.kind !== loader.kind) throw new AgentHttpError(422, '参考素材类型与模板输入不匹配');
        bindings.push({ id: prior?.id ?? `reference-${change.nodeId}-${change.inputName}`, nodeId: change.nodeId, inputName: change.inputName, role: loader.role, assetId: asset.id });
      } else {
        node.widgets_values ??= [];
        node.widgets_values[widgetLayout(node)[change.inputName]] = `unbound:${change.nodeId}:${change.inputName}`;
      }
    }
    return { canvas: canonicalCanvas(canvas, bindings), bindings };
  }
  create(sessionId: string, input: TemplateInput & { name: string }, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'create_workflow', input, undefined, () => {
      const built = this.build(sessionId, input, info);
      return { ...this.repository.createDraftSnapshot(sessionId, { ...built, name: input.name }, identity.taskId), diagnostics: built.diagnostics };
    });
  }
  edit(sessionId: string, input: EditInput, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'edit_workflow', input, input.draftId, () => {
      const source = this.repository.revision(sessionId, input.draftId, input.sourceRevision);
      for (const operation of input.operations ?? []) {
        if (!['set_input', 'remove_input'].includes(operation.op)) throw new AgentHttpError(422, '添加或删除节点需要使用已适配模板');
        const node = source.canvas.nodes.find(node => String(node.id) === operation.nodeId);
        if ('input' in operation && node && loaderInputs[node.type]?.input === operation.input) throw new AgentHttpError(422, '请通过参考素材绑定修改图片、视频或音频输入');
      }
      if (!(input.operations?.length || input.bindingChanges?.length)) throw new AgentHttpError(422, '请指定要修改的参数或参考素材');
      const bound = this.bind(sessionId, source.canvas, source.bindings, input.bindingChanges ?? []);
      const editableInfo = draftObjectInfo(info, canvasToPrompt(bound.canvas, info, false));
      const canvas = input.operations?.length ? applyCanvasPatch({ canvas: bound.canvas, version: input.sourceRevision }, input.sourceRevision, input.operations, editableInfo).canvas : bound.canvas;
      const diagnostics = this.check(sessionId, canvas, bound.bindings, info);
      const revision = this.repository.commitRevisionSnapshot(sessionId, input.draftId, { ...input, canvas, bindings: bound.bindings }, identity.taskId);
      return { revision, diagnostics };
    });
  }
  replace(sessionId: string, input: TemplateInput & { draftId: string; expectedHeadRevision: number; reason: string }, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'replace_workflow_template', input, input.draftId, () => {
      const built = this.build(sessionId, input, info);
      const revision = this.repository.commitRevisionSnapshot(sessionId, input.draftId, { ...built, expectedHeadRevision: input.expectedHeadRevision, sourceRevision: input.expectedHeadRevision, summary: input.reason }, identity.taskId);
      return { revision, diagnostics: built.diagnostics };
    });
  }
  /** Canvas saves must carry their complete binding state; stale raw paths are never silently treated as a new reference. */
  saveCanvas(sessionId: string, input: { draftId: string; expectedHeadRevision: number; sourceRevision: number; canvas: Canvas; bindings: AssetBinding[]; summary: string }, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'edit_workflow', input, input.draftId, () => {
      const diagnostics = this.check(sessionId, input.canvas, input.bindings, info);
      return { revision: this.repository.commitRevisionSnapshot(sessionId, input.draftId, input, identity.taskId), diagnostics };
    });
  }
  importCanvas(sessionId: string, input: { name: string; canvas: Canvas; bindings: AssetBinding[]; sourceRef?: SourceRef }, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'create_workflow', input, undefined, () => {
      const diagnostics = this.check(sessionId, input.canvas, input.bindings, info);
      const outputKinds = this.outputKinds(canvasToPrompt(input.canvas, info, false));
      return { ...this.repository.createDraftSnapshot(sessionId, { ...input, outputKinds }, identity.taskId), diagnostics };
    });
  }
  /** Fork the user's local edits, while retaining the actual historical base as provenance. */
  forkCanvas(sessionId: string, input: { draftId: string; sourceRevision: number; name: string; canvas: Canvas; bindings: AssetBinding[] }, identity: WriteIdentity, info: ObjectInfo) {
    return this.repository.command(sessionId, identity, 'fork_workflow', { local: true, ...input }, input.draftId, () => {
      this.repository.revision(sessionId, input.draftId, input.sourceRevision);
      const diagnostics = this.check(sessionId, input.canvas, input.bindings, info);
      const outputKinds = this.outputKinds(canvasToPrompt(input.canvas, info, false));
      return { ...this.repository.createDraftSnapshot(sessionId, { name: input.name, canvas: input.canvas, bindings: input.bindings, outputKinds,
        forkedFrom: { draftId: input.draftId, revision: input.sourceRevision }, summary: '保留本地画布修改为另一份创作' }, identity.taskId), diagnostics };
    });
  }
  validate(sessionId: string, draftId: string, revision: number, info: ObjectInfo) {
    const version = this.repository.revision(sessionId, draftId, revision);
    this.repository.validateBindings(sessionId, version.canvas, version.bindings);
    const diagnostics = draftDiagnostics(version.canvas, version.bindings, info);
    for (const binding of version.bindings) {
      const asset = this.repository.asset(sessionId, binding.assetId);
      if (asset.captureState !== 'ready') diagnostics.push({ code: 'asset_unavailable', nodeId: binding.nodeId, input: binding.inputName, message: `Reference asset is ${asset.captureState}` });
    }
    return { draftId, revision, editable: diagnostics.every(d => ['unbound_asset', 'asset_unavailable'].includes(d.code)), executable: diagnostics.length === 0, diagnostics };
  }
}
