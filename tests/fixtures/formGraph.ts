/**
 * Minimal graph doubles for the mobile-form unit tests.
 *
 * These mimic the shape ComfyGraph/ComfyGraphNode expose to the form layer
 * (getNodeById, _nodes, _groups, getWidgets, getWidget, inputs, outputs) without
 * pulling the real browser modules into a node:test process.
 */

import type { FormGraphLike, FormNodeLike, FormWidgetLike } from '@/shared/utils/mobileForm';

export interface WidgetSeed {
  name: string;
  type?: string;
  value?: any;
  options?: FormWidgetLike['options'];
}

export interface NodeSeed {
  id: number;
  type: string;
  title?: string;
  pos?: [number, number];
  mode?: number;
  widgets?: WidgetSeed[];
  /** Widget names whose matching input carries a link. */
  connected?: string[];
  outputs?: Array<{ type: string }>;
}

export interface GroupSeed {
  id: number;
  title: string;
  bounding: [number, number, number, number];
}

export const makeNode = (seed: NodeSeed): FormNodeLike => {
  const widgets: FormWidgetLike[] = (seed.widgets || []).map((widget) => ({
    name: widget.name,
    type: widget.type || 'STRING',
    value: widget.value,
    options: widget.options || {},
  }));
  return {
    id: seed.id,
    type: seed.type,
    title: seed.title,
    pos: seed.pos || [0, 0],
    mode: seed.mode ?? 0,
    inputs: (seed.widgets || []).map((widget) => ({
      name: widget.name,
      link: seed.connected?.includes(widget.name) ? 1 : null,
    })),
    outputs: seed.outputs || [],
    getWidgets: () => widgets,
    getWidget: (name: string) => widgets.find((widget) => widget.name === name) || null,
  };
};

export const makeGraph = (nodeSeeds: NodeSeed[], groups: GroupSeed[] = []): FormGraphLike => {
  const nodes = nodeSeeds.map(makeNode);
  return {
    _nodes: nodes,
    _groups: groups,
    getNodeById: (id: number) => nodes.find((node) => node.id === id) || null,
  };
};

/** Mutable value layer standing in for useWidgetValueEditor's modifications. */
export const makeValueLayer = () => {
  const store = new Map<string, any>();
  const key = (nodeId: number, widget: string) => `${nodeId}:${widget}`;
  return {
    store,
    get: (nodeId: number, widget: string, fallback: any) => {
      const entry = key(nodeId, widget);
      return store.has(entry) ? store.get(entry) : fallback;
    },
    set: (nodeId: number, widget: string, value: any) => { store.set(key(nodeId, widget), value); },
  };
};

/**
 * A trimmed Wan-2.2-shaped graph: two samplers that share step counts, an image
 * input, three prompt nodes inside an author-named group, and two loaders.
 */
export const wanLikeGraph = (): FormGraphLike => makeGraph([
  {
    id: 1,
    type: 'LoadAndResizeImage',
    title: 'IMAGE -> input',
    pos: [0, 0],
    widgets: [
      { name: 'image', type: 'COMBO', value: 'astro.png', options: { values: ['astro.png', 'example.png'] } },
      { name: 'width', type: 'INT', value: 720, options: { min: 64, max: 2048, step: 8 } },
      { name: 'height', type: 'INT', value: 1280, options: { min: 64, max: 2048, step: 8 } },
      { name: 'resize', type: 'BOOLEAN', value: false },
    ],
  },
  {
    id: 2,
    type: 'CLIPTextEncode',
    title: 'Precondition',
    pos: [400, 0],
    widgets: [{ name: 'text', type: 'STRING', value: 'an astronaut', options: { multiline: true } }],
  },
  {
    id: 3,
    type: 'CLIPTextEncode',
    title: 'Main action',
    pos: [400, 60],
    widgets: [{ name: 'text', type: 'STRING', value: 'raises the flag', options: { multiline: true } }],
  },
  {
    id: 4,
    type: 'KSamplerAdvanced',
    title: 'High noise',
    pos: [800, 0],
    widgets: [
      { name: 'noise_seed', type: 'INT', value: 42, options: { control_after_generate: true } },
      { name: 'steps', type: 'INT', value: 20, options: { min: 1, max: 100 } },
      { name: 'cfg', type: 'FLOAT', value: 3.5, options: { min: 0, max: 20, step: 0.1 } },
      { name: 'start_at_step', type: 'INT', value: 0 },
      { name: 'end_at_step', type: 'INT', value: 10 },
    ],
  },
  {
    id: 5,
    type: 'KSamplerAdvanced',
    title: 'Low noise',
    pos: [800, 200],
    widgets: [
      { name: 'noise_seed', type: 'INT', value: 42, options: { control_after_generate: true } },
      { name: 'steps', type: 'INT', value: 20, options: { min: 1, max: 100 } },
      { name: 'cfg', type: 'FLOAT', value: 3.5, options: { min: 0, max: 20, step: 0.1 } },
      { name: 'start_at_step', type: 'INT', value: 10 },
      { name: 'end_at_step', type: 'INT', value: 20 },
    ],
  },
  {
    id: 6,
    type: 'UNETLoader',
    title: 'Model HIGH',
    pos: [0, 400],
    outputs: [{ type: 'MODEL' }],
    widgets: [{ name: 'unet_name', type: 'COMBO', value: 'wan_high.safetensors', options: { values: ['wan_high.safetensors', 'wan_low.safetensors'] } }],
  },
  {
    id: 7,
    type: 'SaveVideo',
    title: 'Save Video',
    pos: [1200, 0],
    widgets: [
      { name: 'filename_prefix', type: 'STRING', value: 'wan/out' },
      { name: 'fps', type: 'FLOAT', value: 16 },
    ],
  },
], [
  { id: 10, title: 'Scenario text', bounding: [380, -40, 300, 200] },
  { id: 11, title: 'High noise', bounding: [780, -40, 300, 160] },
]);
