import type { Canvas } from '../../workflow/canvas.js';
import { canvasToPrompt, widgetLayout } from '../../workflow/canvas.js';
import { validatePrompt, WorkflowError } from '../../workflow/engine.js';
import type { ObjectInfo, Diagnostic, Prompt } from '../../workflow/engine.js';
import { attachmentPath } from '../store.js';
import { digest } from './digest.js';
import type { AssetBinding, InputManifestEntry, MediaKind, Revision, Run } from './types.js';
import { AssetService } from './assets.js';

export const loaderInputs: Record<string, { input: string; kind: MediaKind; role: string }> = {
  LoadImage: { input: 'image', kind: 'image', role: 'reference_image' },
  LoadAudio: { input: 'audio', kind: 'audio', role: 'reference_audio' },
  LoadVideo: { input: 'file', kind: 'video', role: 'reference_video' },
};
export const assetToken = (assetId: string) => `asset:${assetId}`;

/** Only media literals are relaxed for editing. Model choices, numeric ranges, links and node support remain checked. */
export function draftObjectInfo(info: ObjectInfo, prompt: Prompt): ObjectInfo {
  const editable = structuredClone(info);
  for (const node of Object.values(prompt)) {
    const loader = loaderInputs[node.class_type];
    if (!loader) continue;
    const value = node.inputs[loader.input];
    if (typeof value !== 'string') continue;
    const definition = editable[node.class_type]?.input?.required?.[loader.input] ?? editable[node.class_type]?.input?.optional?.[loader.input];
    if (!definition) continue;
    if (Array.isArray(definition[0])) { if (!definition[0].includes(value)) definition[0].push(value); }
    else if (definition[0] === 'COMBO') {
      definition[1] ??= {};
      const options = definition[1].options;
      definition[1].options = [...(Array.isArray(options) ? options : []), value];
    }
  }
  return editable;
}

export function canonicalCanvas(canvas: Canvas, bindings: AssetBinding[]): Canvas {
  const result = structuredClone(canvas);
  for (const binding of bindings) {
    const node = result.nodes.find(node => String(node.id) === binding.nodeId);
    if (!node || !loaderInputs[node.type] || widgetLayout(node)[binding.inputName] === undefined) throw new WorkflowError([{ code: 'asset_binding', message: 'Unsupported reference input', nodeId: binding.nodeId, input: binding.inputName }]);
    node.widgets_values ??= [];
    node.widgets_values[widgetLayout(node)[binding.inputName]] = assetToken(binding.assetId);
  }
  return result;
}

export function draftDiagnostics(canvas: Canvas, bindings: AssetBinding[], info: ObjectInfo): Diagnostic[] {
  const prompt = canvasToPrompt(canvas, info, false);
  const diagnostics = validatePrompt(prompt, draftObjectInfo(info, prompt));
  for (const [id, node] of Object.entries(prompt)) {
    const loader = loaderInputs[node.class_type];
    if (!loader) continue;
    const binding = bindings.find(binding => binding.nodeId === id && binding.inputName === loader.input);
    if (!binding) diagnostics.push({ code: 'unbound_asset', message: 'Select a reference asset before running this workflow', nodeId: id, input: loader.input });
    else if (binding.role !== loader.role || node.inputs[loader.input] !== assetToken(binding.assetId)) diagnostics.push({ code: 'asset_binding', message: 'Reference binding and workflow input disagree', nodeId: id, input: loader.input });
  }
  return diagnostics;
}

/** Fixed logical version -> server-specific, verified input files -> immutable execution snapshot. */
export async function compileRun(revision: Revision, run: Run, assets: AssetService, signal: AbortSignal) {
  const info = await assets.adapter.getObjectInfo(signal);
  const diagnostics = draftDiagnostics(revision.canvas, revision.bindings, info);
  if (diagnostics.length) throw new WorkflowError(diagnostics);
  const canvas = structuredClone(revision.canvas);
  const inputManifest: InputManifestEntry[] = [];
  for (const binding of revision.bindings) {
    signal.throwIfAborted();
    const node = canvas.nodes.find(node => String(node.id) === binding.nodeId)!;
    const entry = await assets.materialize(run.sessionId, binding.assetId, node.type, binding.id, signal);
    node.widgets_values![widgetLayout(node)[binding.inputName]] = attachmentPath(entry.materializedRef);
    inputManifest.push(entry);
  }
  // Isolate outputs per physical attempt without changing user seed/sampling parameters.
  for (const node of canvas.nodes) {
    const index = widgetLayout(node)?.filename_prefix;
    if (index === undefined || !node.widgets_values) continue;
    const requested = String(node.widgets_values[index] ?? 'ComfyMobile/Agent');
    node.widgets_values[index] = `${requested}/${run.sessionId}/${run.id}`;
  }
  // Newly uploaded root inputs appear in ComfyUI's schema on the next read.
  const executionInfo = await assets.adapter.getObjectInfo(signal);
  const prompt = canvasToPrompt(canvas, executionInfo);
  const nodeTypes = [...new Set(Object.values(prompt).map(node => node.class_type))];
  const environment = { nodeTypes, schemaDigest: digest(Object.fromEntries(nodeTypes.map(name => [name, executionInfo[name]]))) };
  const approvalDigest = digest({ draftId: revision.draftId, revision: revision.revision, revisionDigest: revision.digest, serverId: run.serverId,
    inputs: inputManifest.map(({ bindingId, assetId, blobDigest }) => ({ bindingId, assetId, blobDigest })) });
  return { executionSnapshot: { canvas, prompt, environment }, inputManifest, approvalDigest, info: executionInfo };
}
