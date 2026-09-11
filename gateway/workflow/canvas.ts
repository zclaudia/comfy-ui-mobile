import { applyPromptPatch, checkedPrompt, isLink, own, WorkflowError } from './engine.js';
import type { InputValue, ObjectInfo, PatchOperation, Prompt } from './engine.js';

export interface CanvasNode {
  id: number; type: string; mode?: number;
  inputs?: { name: string; link: number | null; [key: string]: unknown }[];
  outputs?: { links: number[] | null; [key: string]: unknown }[];
  widgets_values?: unknown[];
  [key: string]: unknown;
}
export interface Canvas {
  version: number; nodes: CanvasNode[];
  links: [number, number, number, number, number, string][];
  [key: string]: unknown;
}
/** Explicit codecs: UI-only widgets (e.g. seed randomization) are intentionally skipped. */
export const coreWidgetLayouts: Record<string, Record<string, number>> = {
  CheckpointLoaderSimple: { ckpt_name: 0 },
  CLIPTextEncode: { text: 0 },
  EmptyLatentImage: { width: 0, height: 1, batch_size: 2 },
  KSampler: { seed: 0, steps: 2, cfg: 3, sampler_name: 4, scheduler: 5, denoise: 6 },
  VAEDecode: {},
  SaveImage: { filename_prefix: 0 },
  LoadImage: { image: 0 },
  UNETLoader: { unet_name: 0, weight_dtype: 1 },
  CLIPLoader: { clip_name: 0, type: 1, device: 2 },
  CLIPLoaderGGUF: { clip_name: 0, type: 1 },
  UnetLoaderGGUF: { unet_name: 0 },
  VAELoader: { vae_name: 0 },
  ModelSamplingAuraFlow: { shift: 0 },
  ConditioningZeroOut: {},
  EmptySD3LatentImage: { width: 0, height: 1, batch_size: 2 },
  LoraLoaderModelOnly: { lora_name: 0, strength_model: 1 },
  MiniMaxH3SigmaShift: { shift_video: 0, shift_audio: 1 },
  MiniMaxH3ImageToVideo: { prompt: 0, width: 1, height: 2, length: 3 },
  MiniMaxH3ReferenceToVideo: { prompt: 0, width: 1, height: 2, length: 3, ref_image_size: 4 },
  BasicGuider: {}, BasicScheduler: { scheduler: 0, steps: 1, denoise: 2 },
  KSamplerSelect: { sampler_name: 0 }, RandomNoise: { noise_seed: 0 },
  SamplerCustomAdvanced: {}, VAEDecodeAudio: {},
  CreateVideo: { fps: 0, bit_depth: 1, color_space: 2 },
  SaveVideo: { filename_prefix: 0, format: 1, codec: 2 },
  LoadAudio: { audio: 0 }, LoadVideo: { file: 0 }, GetVideoComponents: {},
  SaveAudio: { filename_prefix: 0 },
  VAEEncode: {},
  ImageScaleToTotalPixels: { upscale_method: 0, megapixels: 1, resolution_steps: 2 },

};
const isNote = (node: CanvasNode) => ['MarkdownNote', 'Note'].includes(node.type);
export function widgetLayout(node: CanvasNode): Record<string, number> {
  if (node.type === 'KSampler' && typeof node.widgets_values?.[1] === 'number')
    return { seed: 0, steps: 1, cfg: 2, sampler_name: 3, scheduler: 4, denoise: 5 };
  return coreWidgetLayouts[node.type];
}
const optionalWidgets = new Set(['CLIPLoader.device', 'CreateVideo.bit_depth', 'CreateVideo.color_space', 'SaveVideo.codec', 'ImageScaleToTotalPixels.resolution_steps']);
const fail = (message: string): never => { throw new WorkflowError([{ code: 'unsupported_canvas', message }]); };

/** Version 0.4 core-node subset only. Imported metadata stays in the original canvas. */
export function canvasToPrompt(canvas: Canvas, info: ObjectInfo, validate = true): Prompt {
  if (canvas.version !== 0.4 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.links)
    || canvas.subgraphs || canvas.definitions) fail('Only flat version 0.4 workflows are supported');
  const nodes = new Map<number, CanvasNode>();
  for (const node of canvas.nodes) {
    if (!Number.isSafeInteger(node.id) || node.id < 0 || nodes.has(node.id)) fail('Invalid or duplicate canvas node ID');
    if ((!own(coreWidgetLayouts, node.type) && !isNote(node)) || (node.mode !== undefined && node.mode !== 0)) fail(`Unsupported node or execution mode: ${node.type}`);
    nodes.set(node.id, node);
  }
  const links = new Map<number, Canvas['links'][number]>();
  for (const link of canvas.links) {
    if (!Array.isArray(link) || link.length !== 6 || !link.slice(0, 5).every(n => Number.isSafeInteger(n) && Number(n) >= 0)) fail('Invalid canvas link');
    const [id, source, output, target, input] = link;
    if (links.has(id)) fail('Duplicate canvas link ID');
    const sourceSlot = nodes.get(source)?.outputs?.[output];
    if (!sourceSlot?.links?.includes(id) || nodes.get(target)?.inputs?.[input]?.link !== id) fail('Canvas link and slot references disagree');
    links.set(id, link);
  }
  const prompt: Prompt = {};
  for (const node of canvas.nodes) {
    if (isNote(node)) {
      if ((node.inputs ?? []).some(i => i.link != null) || (node.outputs ?? []).some(o => o.links?.length)) fail('Notes cannot have executable links');
      continue;
    }
    if (node.type === 'SaveVideo' && (node.widgets_values?.length ?? 0) > 3) {
      // Current V3 frontends retain the legacy codec input and also serialize
      // the nested format.codec default. Both represent auto encoding here.
      const autoDefaults = node.widgets_values?.length === 4 && node.widgets_values.slice(1).every(value => value === 'auto')
        && node.inputs?.some(input => input.name === 'format.codec' && input.link == null)
        && node.inputs?.some(input => input.name === 'codec' && input.link == null);
      if (!autoDefaults) fail('Advanced SaveVideo encoding widgets require an explicit codec; use auto encoding');
    }
    const inputs: Record<string, InputValue> = {};
    const names = new Set<string>();
    for (const [slot, input] of (node.inputs ?? []).entries()) {
      if (typeof input.name !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(input.name)) fail('Invalid canvas input name');
      if (names.has(input.name)) fail('Duplicate canvas input name');
      names.add(input.name);
      if (input.link !== null && input.link !== undefined) {
        const link = links.get(input.link);
        if (!link || link[3] !== node.id || link[4] !== slot) fail('Missing or inconsistent canvas input link');
        inputs[input.name] = [String(link![1]), link![2]];
      }
    }
    for (const [slot, output] of (node.outputs ?? []).entries()) for (const id of output.links ?? []) {
      const link = links.get(id);
      if (!link || link[1] !== node.id || link[2] !== slot) fail('Missing or inconsistent canvas output link');
    }
    for (const [name, index] of Object.entries(widgetLayout(node))) {
      if (!own(inputs, name)) {
        if ((!node.widgets_values || index >= node.widgets_values.length) && optionalWidgets.has(`${node.type}.${name}`)) continue;
        if (!node.widgets_values || index >= node.widgets_values.length) fail(`Missing widget ${name} on ${node.type}`);
        inputs[name] = node.widgets_values![index] as InputValue;
      }
    }
    prompt[String(node.id)] = { class_type: node.type, inputs };
  }
  return validate ? checkedPrompt(prompt, info) : prompt;
}

/** Update existing supported canvas nodes; preserve layout, UI-only widgets and metadata.
 * Adding/removing/retyping canvas nodes requires a future template builder.
 */
export function promptToCanvas(original: Canvas, value: Prompt, info: ObjectInfo): Canvas {
  canvasToPrompt(original, info, false); // Existing missing models/invalid values must remain repairable.
  const prompt = checkedPrompt(value, info);
  const canvas = structuredClone(original);
  if (Object.keys(prompt).length !== canvas.nodes.filter(n => !isNote(n)).length || canvas.nodes.filter(n => !isNote(n)).some(n => !own(prompt, String(n.id)) || prompt[String(n.id)].class_type !== n.type)) {
    fail('Canvas node addition, deletion and type changes are not supported yet');
  }
  const nodes = new Map(canvas.nodes.map(n => [String(n.id), n]));
  canvas.links = [];
  for (const node of canvas.nodes) {
    for (const input of node.inputs ?? []) input.link = null;
    for (const output of node.outputs ?? []) output.links = null;
  }
  let linkId = 0;
  for (const node of canvas.nodes.filter(n => !isNote(n))) for (const [name, input] of Object.entries(prompt[String(node.id)].inputs)) {
    if (isLink(input)) {
      const targetSlot = node.inputs?.findIndex(slot => slot.name === name) ?? -1;
      const source = nodes.get(input[0])!;
      const output = source.outputs?.[input[1]];
      if (targetSlot < 0 || !output) fail('Connection requires a canvas slot that does not exist');
      const id = ++linkId;
      node.inputs![targetSlot].link = id;
      (output!.links ??= []).push(id);
      canvas.links.push([id, source.id, input[1], node.id, targetSlot, info[source.type].output[input[1]]]);
    } else {
      const index = widgetLayout(node)[name];
      if (!own(widgetLayout(node), name)) fail(`No widget codec for ${name}`);
      node.widgets_values![index] = input;
    }
  }
  canvas.last_link_id = linkId;
  // Reject changes that cannot be represented losslessly in this codec subset.
  const roundTrip = canvasToPrompt(canvas, info);
  for (const [id, node] of Object.entries(prompt)) {
    const actual = roundTrip[id].inputs;
    if (Object.keys(actual).length !== Object.keys(node.inputs).length
      || Object.entries(node.inputs).some(([name, input]) => JSON.stringify(actual[name]) !== JSON.stringify(input))) {
      fail('Modified prompt cannot be represented by the supported canvas codecs');
    }
  }
  return canvas;
}

/** Commit-ready result: both representations succeed or neither is returned. */
export function applyCanvasPatch(current: { version: number; canvas: Canvas }, baseVersion: number, operations: PatchOperation[], info: ObjectInfo) {
  const prompt = canvasToPrompt(current.canvas, info, false);
  const next = applyPromptPatch({ version: current.version, prompt }, baseVersion, operations, info);
  const canvas = promptToCanvas(current.canvas, next.prompt, info);
  return { ...next, canvas };
}
