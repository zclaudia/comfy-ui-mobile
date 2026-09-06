import type { Canvas, CanvasNode } from '../workflow/canvas.js';
import { coreWidgetLayouts } from '../workflow/canvas.js';
import type { ObjectInfo, Prompt } from '../workflow/engine.js';
import { checkedPrompt, isLink } from '../workflow/engine.js';

/** Reviewed basic checkpoint template. User/model chooses an installed compatible checkpoint. */
export function textToImage(info: ObjectInfo, checkpoint: string, text: string): Canvas {
  const prompt: Prompt = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'blurry, low quality' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ComfyMobile/Agent' } },
  };
  return canvasFromPrompt(prompt, info);
}

export function canvasFromPrompt(prompt: Prompt, info: ObjectInfo): Canvas {
  checkedPrompt(prompt, info);
  const nodes: CanvasNode[] = Object.entries(prompt).map(([id, node], index) => {
    const widgets: unknown[] = ['KSampler', 'RandomNoise'].includes(node.class_type) ? [0, 'fixed'] : [];
    for (const [name, slot] of Object.entries(coreWidgetLayouts[node.class_type])) if (Object.hasOwn(node.inputs, name)) widgets[slot] = node.inputs[name];
    return {
      id: Number(id), type: node.class_type, pos: [80 + (index % 3) * 370, 80 + Math.floor(index / 3) * 340], size: [320, 260], flags: {}, order: index, mode: 0,
      inputs: Object.keys(node.inputs).map(name => {
        const definition = info[node.class_type].input?.required?.[name] ?? info[node.class_type].input?.optional?.[name];
        const type = definition?.[0];
        return { name, type: Array.isArray(type) ? 'COMBO' : type ?? '*', link: null, ...(!isLink(node.inputs[name]) ? { widget: { name } } : {}) };
      }),
      outputs: info[node.class_type].output.map((type, slot) => ({ name: type, type, slot_index: slot, links: null })),
      properties: { 'Node name for S&R': node.class_type }, widgets_values: widgets,
    };
  });
  const canvas: Canvas = { version: 0.4, nodes, links: [], last_node_id: Math.max(...nodes.map(n => n.id)), last_link_id: 0, groups: [], config: {}, extra: {} };
  let id = 0;
  for (const [target, node] of Object.entries(prompt)) for (const [name, value] of Object.entries(node.inputs)) {
    if (!isLink(value)) continue;
    const source = nodes.find(n => String(n.id) === value[0])!;
    const dest = nodes.find(n => String(n.id) === target)!;
    const slot = dest.inputs!.findIndex(input => input.name === name);
    dest.inputs![slot].link = ++id;
    (source.outputs![value[1]].links ??= []).push(id);
    canvas.links.push([id, source.id, value[1], dest.id, slot, info[source.type].output[value[1]]]);
  }
  canvas.last_link_id = id;
  return canvas;
}
