/**
 * Suggests a mobile form spec for a workflow.
 *
 * Two steps, because the stack view's heuristic answers only the first one:
 *   1. Node classification — which section a node belongs to. The rules come
 *      from WorkflowStackEditor's `typeGroups`, kept behaviour-compatible.
 *   2. Field selection — which of that node's widgets are worth exposing. A
 *      KSamplerAdvanced has a dozen widgets; a phone form wants three.
 *
 * Same-type nodes sharing a widget name are merged into one linked field, but
 * only when they currently hold the same value: that preserves an author's
 * deliberate difference (a high/low sampler split over step ranges) while
 * capturing the far more common "these two move together".
 */

import {
  MOBILE_FORM_VERSION,
  type MobileFormControl,
  type MobileFormField,
  type MobileFormSection,
  type MobileFormSpec,
  type MobileFormTarget,
} from '@/shared/types/app/IMobileForm';
import {
  createFormId,
  isInputConnected,
  type FormGraphLike,
  type FormNodeLike,
  type FormWidgetLike,
} from '@/shared/utils/mobileForm';

export type FormCategoryId =
  | 'inputs' | 'prompts' | 'models_loras' | 'loaders' | 'samplers' | 'outputs' | 'uncategorized';

/** Section order on the form; deliberately different from the stack view's. */
const CATEGORY_ORDER: FormCategoryId[] = [
  'inputs', 'prompts', 'samplers', 'models_loras', 'loaders', 'outputs', 'uncategorized',
];

const lower = (value: unknown) => String(value || '').toLowerCase();

const widgetNames = (widgets: FormWidgetLike[]) => widgets.map((widget) => lower(widget.name));

/** Node classification — mirrors WorkflowStackEditor's precedence (P1…P7). */
export const classifyNode = (node: FormNodeLike, widgets: FormWidgetLike[]): FormCategoryId => {
  const type = lower(node.type);
  const names = widgetNames(widgets);
  const hasAnyWidget = (candidates: string[]) =>
    names.some((name) => candidates.some((candidate) => name.includes(candidate)));

  // P1 Models and LoRAs
  const hasModelOutput = node.outputs?.some((output) => String(output?.type || '').toUpperCase() === 'MODEL');
  if (type.includes('unet') || type.includes('lora')
    || (type.includes('sampling') && names.some((name) => name.includes('shift')))
    || (type.includes('loader') && hasModelOutput)) {
    return 'models_loras';
  }
  // P2 Loaders
  if (type.includes('load') && !hasAnyWidget(['image', 'video'])) return 'loaders';
  // P3 Image and video inputs
  if (hasAnyWidget(['image', 'video', 'width', 'height', 'length'])) return 'inputs';
  // P4 Prompts
  const title = lower(node.title);
  const isPromptType = type.includes('multiline') || type.includes('prompt')
    || type.includes('string') || title.includes('prompt');
  const hasTextValueWidget = hasAnyWidget(['text', 'value']);
  const first = widgets[0];
  const singleWidgetIsPrompt = widgets.length === 1
    && ['text', 'value'].includes(lower(first?.name))
    && String(first?.type || '').toUpperCase() === 'STRING';
  if ((isPromptType && hasTextValueWidget) || singleWidgetIsPrompt) return 'prompts';
  // P5 Samplers
  if (type.includes('sampler') || names.some((name) => name.includes('seed'))) return 'samplers';
  // P6 Outputs
  if (type.includes('save') || type.includes('vfi')
    || names.some((name) => name.includes('filename') || name === 'save_output')) {
    return 'outputs';
  }
  return 'uncategorized';
};

/** Widgets exposed by default, per section. Everything else is opt-in. */
const DEFAULT_WIDGETS: Record<FormCategoryId, string[]> = {
  inputs: ['image', 'video', 'width', 'height', 'length', 'batch_size'],
  prompts: ['text', 'prompt', 'value', 'positive', 'negative'],
  models_loras: ['ckpt_name', 'unet_name', 'lora_name', 'model_name', 'strength_model', 'strength', 'shift'],
  loaders: ['ckpt_name', 'vae_name', 'clip_name', 'model_name', 'lora_name', 'style_model_name'],
  samplers: ['seed', 'noise_seed', 'steps', 'cfg', 'denoise'],
  outputs: ['filename_prefix', 'fps', 'format'],
  uncategorized: [],
};

const isMultilineString = (widget: FormWidgetLike): boolean =>
  String(widget.type || '').toUpperCase() === 'STRING' && widget.options?.multiline === true;

/** Control hint. `auto` defers to the existing widget registry. */
export const suggestControl = (category: FormCategoryId, widget: FormWidgetLike): MobileFormControl => {
  const name = lower(widget.name);
  const type = String(widget.type || '').toUpperCase();
  if (name === 'seed' || name === 'noise_seed') return 'seed';
  if (isMultilineString(widget)) return 'textarea';
  if (category === 'inputs' && (name === 'image' || name.endsWith('_image'))) return 'image';
  if (category === 'inputs' && (name === 'video' || name.endsWith('_video'))) return 'video';
  if (type === 'BOOLEAN') return 'toggle';
  if (type === 'COMBO') return 'select';
  if (type === 'FLOAT') return 'slider';
  if (type === 'INT') return 'stepper';
  return 'auto';
};

const shouldExpose = (category: FormCategoryId, widget: FormWidgetLike): boolean => {
  const name = lower(widget.name);
  if (!name || name === 'control_after_generate') return false;
  // A prompt node's whole point is its text; accept any multiline string there.
  if (category === 'prompts' && isMultilineString(widget)) return true;
  return DEFAULT_WIDGETS[category].some((candidate) => name === candidate);
};

/** Group titles are the author's own labelling, so they beat category names. */
const groupTitleFor = (graph: FormGraphLike, node: FormNodeLike): { id: string; title: string } | null => {
  const groups = graph._groups || [];
  const pos = node.pos;
  if (!pos || pos.length < 2) return null;
  for (const group of groups) {
    const bounding = group.bounding;
    if (!bounding || bounding.length < 4) continue;
    const [x, y, width, height] = bounding;
    if (pos[0] >= x && pos[0] <= x + width && pos[1] >= y && pos[1] <= y + height) {
      const title = String(group.title || '').trim();
      if (!title) continue;
      return { id: `group:${group.id ?? title}`, title };
    }
  }
  return null;
};

const sameValue = (a: any, b: any): boolean => {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

export interface SuggestOptions {
  /** Reads through any unsaved modifications, so merging sees current values. */
  getValue?: (nodeId: number, widget: string, fallback: any) => any;
  /** Skips muted/bypassed nodes when true (the default). */
  skipInactive?: boolean;
}

interface Candidate {
  node: FormNodeLike;
  widget: FormWidgetLike;
  category: FormCategoryId;
  sectionId: string;
  sectionTitle: string;
  order: number;
  value: any;
}

export const suggestFormSpec = (
  graph: FormGraphLike | null | undefined,
  options: SuggestOptions = {},
): MobileFormSpec => {
  const nodes = (graph?._nodes || []).filter(Boolean);
  const candidates: Candidate[] = [];

  nodes.forEach((node, index) => {
    if (options.skipInactive !== false && node.mode === 2) return; // muted
    const widgets = (typeof node.getWidgets === 'function' ? node.getWidgets() : []) || [];
    if (!widgets.length) return;
    const category = classifyNode(node, widgets);
    const group = graph ? groupTitleFor(graph, node) : null;
    for (const widget of widgets) {
      if (!widget?.name) continue;
      if (isInputConnected(node, widget.name)) continue;
      if (!shouldExpose(category, widget)) continue;
      const value = options.getValue
        ? options.getValue(node.id, widget.name, widget.value)
        : widget.value;
      candidates.push({
        node,
        widget,
        category,
        sectionId: group ? group.id : `cat:${category}`,
        sectionTitle: group ? group.title : '',
        order: index,
        value,
      });
    }
  });

  // Merge same node type + same widget name when the values already agree.
  const merged = new Map<string, { primary: Candidate; linked: Candidate[] }>();
  const standalone: Candidate[] = [];
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.node.type}::${candidate.widget.name}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(candidate);
    else byKey.set(key, [candidate]);
  }
  for (const [key, bucket] of byKey) {
    if (bucket.length === 1) { standalone.push(bucket[0]); continue; }
    const [primary, ...rest] = bucket;
    const agreeing = rest.filter((candidate) => sameValue(candidate.value, primary.value));
    const differing = rest.filter((candidate) => !sameValue(candidate.value, primary.value));
    if (agreeing.length) merged.set(key, { primary, linked: agreeing });
    else standalone.push(primary);
    standalone.push(...differing);
  }

  const toTarget = (candidate: Candidate): MobileFormTarget => ({
    nodeId: candidate.node.id,
    widget: String(candidate.widget.name),
    nodeType: String(candidate.node.type || ''),
  });

  const entries: Array<{ candidate: Candidate; field: MobileFormField }> = [];
  for (const candidate of standalone) {
    entries.push({
      candidate,
      field: {
        id: createFormId('field'),
        target: toTarget(candidate),
        control: suggestControl(candidate.category, candidate.widget),
      },
    });
  }
  for (const { primary, linked } of merged.values()) {
    entries.push({
      candidate: primary,
      field: {
        id: createFormId('field'),
        target: toTarget(primary),
        linked: linked.map(toTarget),
        control: suggestControl(primary.category, primary.widget),
      },
    });
  }

  entries.sort((a, b) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(a.candidate.category) - CATEGORY_ORDER.indexOf(b.candidate.category);
    if (categoryDelta !== 0) return categoryDelta;
    return a.candidate.order - b.candidate.order;
  });

  const sections: MobileFormSection[] = [];
  const sectionIndex = new Map<string, MobileFormSection>();
  for (const entry of entries) {
    const { sectionId, sectionTitle } = entry.candidate;
    let section = sectionIndex.get(sectionId);
    if (!section) {
      section = { id: sectionId, title: sectionTitle, fields: [] };
      sectionIndex.set(sectionId, section);
      sections.push(section);
    }
    section.fields.push(entry.field);
  }

  return {
    version: MOBILE_FORM_VERSION,
    mode: 'auto',
    sections,
    updatedAt: new Date().toISOString(),
  };
};

/** Section id → i18n key suffix, for sections that came from a category. */
export const sectionCategoryId = (sectionId: string): FormCategoryId | null => {
  if (!sectionId.startsWith('cat:')) return null;
  const id = sectionId.slice(4) as FormCategoryId;
  return CATEGORY_ORDER.includes(id) ? id : null;
};
