/**
 * Read, write and resolve the mobile form spec.
 *
 * Storage: `workflow_json.extra.comfy_mobile_form`. `extra` is the only place a
 * custom key survives being opened and saved by the desktop ComfyUI frontend,
 * which is a normal step in this project's cloud-sync loop. The cloud sync
 * metadata (`extra.comfy_mobile_cloud`) already sets that precedent.
 *
 * Everything here is pure: no React, no DOM, no ComfyGraph import. Callers pass
 * a minimal graph-like object so the module stays unit-testable.
 */

import {
  MOBILE_FORM_VERSION,
  type MobileFormControl,
  type MobileFormField,
  type MobileFormSection,
  type MobileFormSpec,
  type MobileFormTarget,
  type ResolvedField,
  type ResolvedSection,
  type ResolvedTarget,
} from '@/shared/types/app/IMobileForm';

export const FORM_EXTRA_KEY = 'comfy_mobile_form';

/** The subset of ComfyGraph the form layer needs. */
export interface FormGraphLike {
  getNodeById(id: number): FormNodeLike | null | undefined;
  _nodes?: FormNodeLike[];
  _groups?: Array<{ id?: number | string; title?: string; bounding?: number[] }>;
}

export interface FormNodeLike {
  id: number;
  type?: string;
  title?: string;
  pos?: number[];
  size?: number[];
  mode?: number;
  inputs?: Array<{ name?: string; link?: number | null }>;
  outputs?: Array<{ type?: string; links?: number[] | null }>;
  getWidgets?: () => FormWidgetLike[];
  getWidget?: (name: string) => FormWidgetLike | null;
}

export interface FormWidgetLike {
  name?: string;
  type?: string;
  value?: any;
  options?: {
    min?: number;
    max?: number;
    step?: number;
    values?: (string | number)[];
    multiline?: boolean;
    tooltip?: string;
    label?: string;
    optional?: boolean;
    control_after_generate?: boolean;
  };
}

/** Reads a widget value through the caller's modification layer, if any. */
export type FormValueReader = (nodeId: number, widget: string, fallback: any) => any;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let idCounter = 0;

export const createFormId = (prefix: string): string => {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${random}`;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const asTarget = (value: any): MobileFormTarget | null => {
  if (!value || typeof value !== 'object') return null;
  const nodeId = Number(value.nodeId);
  const widget = typeof value.widget === 'string' ? value.widget : '';
  if (!Number.isFinite(nodeId) || !widget) return null;
  const target: MobileFormTarget = {
    nodeId,
    widget,
    nodeType: typeof value.nodeType === 'string' ? value.nodeType : '',
  };
  if (typeof value.subgraphId === 'string') target.subgraphId = value.subgraphId;
  return target;
};

const CONTROLS: MobileFormControl[] = [
  'auto', 'text', 'textarea', 'number', 'slider', 'stepper', 'select', 'toggle', 'seed', 'image', 'video',
];

const asField = (value: any): MobileFormField | null => {
  if (!value || typeof value !== 'object') return null;
  const target = asTarget(value.target);
  if (!target) return null;
  const field: MobileFormField = {
    id: typeof value.id === 'string' && value.id ? value.id : createFormId('field'),
    target,
  };
  const linked = Array.isArray(value.linked)
    ? (value.linked.map(asTarget).filter(Boolean) as MobileFormTarget[])
    : [];
  // A target may not be linked to itself, and duplicates would write twice.
  const deduped = linked.filter((candidate, index) =>
    !targetsEqual(candidate, target)
    && linked.findIndex((other) => targetsEqual(other, candidate)) === index);
  if (deduped.length) field.linked = deduped;
  if (typeof value.label === 'string' && value.label) field.label = value.label;
  if (typeof value.hint === 'string' && value.hint) field.hint = value.hint;
  if (typeof value.control === 'string' && CONTROLS.includes(value.control as MobileFormControl)) {
    field.control = value.control as MobileFormControl;
  }
  if (value.range && typeof value.range === 'object') {
    const range: NonNullable<MobileFormField['range']> = {};
    for (const key of ['min', 'max', 'step'] as const) {
      const number = Number(value.range[key]);
      if (Number.isFinite(number)) range[key] = number;
    }
    if (Object.keys(range).length) field.range = range;
  }
  return field;
};

const asSection = (value: any): MobileFormSection | null => {
  if (!value || typeof value !== 'object') return null;
  const fields = Array.isArray(value.fields)
    ? (value.fields.map(asField).filter(Boolean) as MobileFormField[])
    : [];
  return {
    id: typeof value.id === 'string' && value.id ? value.id : createFormId('section'),
    title: typeof value.title === 'string' ? value.title : '',
    ...(value.collapsed === true ? { collapsed: true } : {}),
    fields,
  };
};

/**
 * Tolerant parse. Anything unrecognisable yields null so the caller falls back
 * to a fresh suggestion rather than rendering a broken form; a spec written by
 * a newer app version is also refused rather than half-read.
 */
export const normalizeFormSpec = (value: any): MobileFormSpec | null => {
  if (!value || typeof value !== 'object') return null;
  if (Number(value.version) !== MOBILE_FORM_VERSION) return null;
  if (!Array.isArray(value.sections)) return null;
  const sections = value.sections.map(asSection).filter(Boolean) as MobileFormSection[];
  return {
    version: MOBILE_FORM_VERSION,
    mode: value.mode === 'custom' ? 'custom' : 'auto',
    sections,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
};

/** Reads the spec stored on a workflow JSON, or null when there is none. */
export const readFormSpec = (workflowJson: any): MobileFormSpec | null => {
  const raw = workflowJson?.extra?.[FORM_EXTRA_KEY];
  return normalizeFormSpec(raw);
};

/** Returns a copy of the workflow JSON carrying the spec. Never mutates its input. */
export const writeFormSpec = <T extends { extra?: any }>(workflowJson: T, spec: MobileFormSpec): T => ({
  ...workflowJson,
  extra: {
    ...(workflowJson?.extra || {}),
    [FORM_EXTRA_KEY]: { ...spec, version: MOBILE_FORM_VERSION },
  },
});

/** Returns a copy of the workflow JSON with the spec removed. */
export const clearFormSpec = <T extends { extra?: any }>(workflowJson: T): T => {
  const extra = { ...(workflowJson?.extra || {}) };
  delete extra[FORM_EXTRA_KEY];
  return { ...workflowJson, extra };
};

export const touchSpec = (spec: MobileFormSpec, mode: MobileFormSpec['mode'] = 'custom'): MobileFormSpec => ({
  ...spec,
  mode,
  updatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------

export const targetsEqual = (a: MobileFormTarget, b: MobileFormTarget): boolean =>
  a.nodeId === b.nodeId && a.widget === b.widget;

export const fieldTargets = (field: MobileFormField): MobileFormTarget[] =>
  [field.target, ...(field.linked || [])];

export const allTargets = (spec: MobileFormSpec | null): MobileFormTarget[] =>
  (spec?.sections || []).flatMap((section) => section.fields.flatMap(fieldTargets));

/** The field that already exposes this widget, if any (primary or linked). */
export const findFieldForTarget = (
  spec: MobileFormSpec | null,
  target: MobileFormTarget,
): { section: MobileFormSection; field: MobileFormField; isPrimary: boolean } | null => {
  for (const section of spec?.sections || []) {
    for (const field of section.fields) {
      if (targetsEqual(field.target, target)) return { section, field, isPrimary: true };
      if ((field.linked || []).some((linked) => targetsEqual(linked, target))) {
        return { section, field, isPrimary: false };
      }
    }
  }
  return null;
};

export const isInputConnected = (node: FormNodeLike | null | undefined, widgetName: string): boolean => {
  if (!node?.inputs) return false;
  const input = node.inputs.find((candidate) => candidate?.name === widgetName);
  return !!input && input.link !== null && input.link !== undefined;
};

const readWidget = (node: FormNodeLike | null | undefined, name: string): FormWidgetLike | undefined => {
  if (!node) return undefined;
  if (typeof node.getWidget === 'function') {
    const widget = node.getWidget(name);
    if (widget) return widget;
  }
  const widgets = typeof node.getWidgets === 'function' ? node.getWidgets() : [];
  return (widgets || []).find((candidate) => candidate?.name === name);
};

export const resolveTarget = (
  graph: FormGraphLike | null | undefined,
  target: MobileFormTarget,
  getValue?: FormValueReader,
): ResolvedTarget => {
  const node = graph?.getNodeById?.(target.nodeId);
  if (!node) return { target, problem: 'missing-node' };
  // An empty stored nodeType predates the check; treat it as "unknown, allow".
  if (target.nodeType && node.type && node.type !== target.nodeType) {
    return { target, problem: 'type-changed', node };
  }
  const widget = readWidget(node, target.widget);
  if (!widget) return { target, problem: 'missing-widget', node };
  if (isInputConnected(node, target.widget)) {
    return { target, problem: 'connected', node, widget };
  }
  const value = getValue ? getValue(target.nodeId, target.widget, widget.value) : widget.value;
  return { target, node, widget, value };
};

const sameValue = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  // Widget values are scalars in practice; a structural compare keeps arrays
  // (some custom nodes) from reporting a permanent mismatch.
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

export const deriveLabel = (resolved: ResolvedTarget, fallbackWidget: string): string => {
  const node = resolved.node;
  const title = node?.title || node?.type || '';
  const widgetLabel = resolved.widget?.options?.label || resolved.target?.widget || fallbackWidget;
  return title ? `${title} · ${widgetLabel}` : widgetLabel;
};

export const resolveField = (
  graph: FormGraphLike | null | undefined,
  field: MobileFormField,
  getValue?: FormValueReader,
): ResolvedField => {
  const primary = resolveTarget(graph, field.target, getValue);
  const linked = (field.linked || []).map((target) => resolveTarget(graph, target, getValue));
  const usable = !primary.problem;
  const inconsistent = usable
    && linked.some((entry) => !entry.problem && !sameValue(entry.value, primary.value));
  return {
    field,
    primary,
    linked,
    usable,
    inconsistent,
    label: field.label || deriveLabel(primary, field.target.widget),
  };
};

export const resolveSpec = (
  graph: FormGraphLike | null | undefined,
  spec: MobileFormSpec | null,
  getValue?: FormValueReader,
): ResolvedSection[] =>
  (spec?.sections || []).map((section) => ({
    section,
    fields: section.fields.map((field) => resolveField(graph, field, getValue)),
  }));

/** Fields a viewer can actually operate; the form view hides the rest. */
export const usableFieldCount = (sections: ResolvedSection[]): number =>
  sections.reduce((total, section) => total + section.fields.filter((field) => field.usable).length, 0);

// ---------------------------------------------------------------------------
// Linking rules
// ---------------------------------------------------------------------------

const normalizeType = (widget: FormWidgetLike | undefined): string =>
  String(widget?.type || '').toUpperCase();

export type LinkRejection = 'same-target' | 'type-mismatch' | 'options-mismatch' | 'unresolved' | 'already-linked';

/**
 * Two widgets may be linked when they carry the same value kind. COMBO also
 * needs overlapping options, otherwise writing the primary value would push an
 * invalid choice into the other node.
 */
export const canLinkTargets = (
  primary: ResolvedTarget,
  candidate: ResolvedTarget,
): { ok: true } | { ok: false; reason: LinkRejection } => {
  if (targetsEqual(primary.target, candidate.target)) return { ok: false, reason: 'same-target' };
  if (primary.problem || candidate.problem) return { ok: false, reason: 'unresolved' };
  const primaryType = normalizeType(primary.widget);
  const candidateType = normalizeType(candidate.widget);
  if (primaryType !== candidateType) return { ok: false, reason: 'type-mismatch' };
  if (primaryType === 'COMBO') {
    const a = new Set<string>(((primary.widget?.options?.values || []) as (string | number)[]).map(String));
    const b: string[] = ((candidate.widget?.options?.values || []) as (string | number)[]).map(String);
    if (a.size && b.length && !b.some((value) => a.has(value))) {
      return { ok: false, reason: 'options-mismatch' };
    }
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Spec editing (pure; each helper returns a new spec)
// ---------------------------------------------------------------------------

const mapSections = (
  spec: MobileFormSpec,
  fn: (section: MobileFormSection) => MobileFormSection,
): MobileFormSpec => touchSpec({ ...spec, sections: spec.sections.map(fn) });

export const updateField = (
  spec: MobileFormSpec,
  fieldId: string,
  fn: (field: MobileFormField) => MobileFormField,
): MobileFormSpec => mapSections(spec, (section) => ({
  ...section,
  fields: section.fields.map((field) => (field.id === fieldId ? fn(field) : field)),
}));

export const removeField = (spec: MobileFormSpec, fieldId: string): MobileFormSpec =>
  mapSections(spec, (section) => ({
    ...section,
    fields: section.fields.filter((field) => field.id !== fieldId),
  }));

/** Moves a field one slot within its section. Section order is left alone. */
export const moveField = (spec: MobileFormSpec, fieldId: string, delta: -1 | 1): MobileFormSpec =>
  mapSections(spec, (section) => {
    const index = section.fields.findIndex((field) => field.id === fieldId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= section.fields.length) return section;
    const fields = [...section.fields];
    [fields[index], fields[next]] = [fields[next], fields[index]];
    return { ...section, fields };
  });

export const DEFAULT_SECTION_ID = 'unsorted';

/** Appends a field for one widget, creating the catch-all section if needed. */
export const addTargetToSpec = (
  spec: MobileFormSpec,
  target: MobileFormTarget,
  options?: { sectionId?: string; sectionTitle?: string; control?: MobileFormControl },
): MobileFormSpec => {
  if (findFieldForTarget(spec, target)) return spec;
  const field: MobileFormField = {
    id: createFormId('field'),
    target,
    ...(options?.control ? { control: options.control } : {}),
  };
  const sectionId = options?.sectionId || DEFAULT_SECTION_ID;
  const existing = spec.sections.find((section) => section.id === sectionId);
  if (existing) {
    return mapSections(spec, (section) => (section.id === sectionId
      ? { ...section, fields: [...section.fields, field] }
      : section));
  }
  return touchSpec({
    ...spec,
    sections: [...spec.sections, {
      id: sectionId,
      title: options?.sectionTitle || '',
      fields: [field],
    }],
  });
};

export const linkTargetToField = (
  spec: MobileFormSpec,
  fieldId: string,
  target: MobileFormTarget,
): MobileFormSpec => {
  // Linking a widget that another field already exposes would give it two
  // writers; drop the standalone field first.
  const owner = findFieldForTarget(spec, target);
  let next = spec;
  if (owner && owner.field.id !== fieldId) {
    next = owner.isPrimary && (owner.field.linked || []).length === 0
      ? removeField(next, owner.field.id)
      : next;
  }
  return updateField(next, fieldId, (field) => (
    fieldTargets(field).some((existing) => targetsEqual(existing, target))
      ? field
      : { ...field, linked: [...(field.linked || []), target] }
  ));
};

export const unlinkTargetFromField = (
  spec: MobileFormSpec,
  fieldId: string,
  target: MobileFormTarget,
): MobileFormSpec => updateField(spec, fieldId, (field) => {
  const linked = (field.linked || []).filter((entry) => !targetsEqual(entry, target));
  const next: MobileFormField = { ...field };
  if (linked.length) next.linked = linked;
  else delete next.linked;
  return next;
});

export const renameSection = (spec: MobileFormSpec, sectionId: string, title: string): MobileFormSpec =>
  mapSections(spec, (section) => (section.id === sectionId ? { ...section, title } : section));

/** Removes a section, folding its fields into the previous one (or the next). */
export const removeSection = (spec: MobileFormSpec, sectionId: string): MobileFormSpec => {
  const index = spec.sections.findIndex((section) => section.id === sectionId);
  if (index < 0) return spec;
  const doomed = spec.sections[index];
  const sections = spec.sections.filter((_, position) => position !== index);
  if (!sections.length) return touchSpec({ ...spec, sections: [] });
  const hostIndex = index > 0 ? index - 1 : 0;
  sections[hostIndex] = { ...sections[hostIndex], fields: [...sections[hostIndex].fields, ...doomed.fields] };
  return touchSpec({ ...spec, sections });
};

/** Drops every field whose primary target no longer resolves. */
export const pruneBrokenFields = (
  graph: FormGraphLike | null | undefined,
  spec: MobileFormSpec,
): MobileFormSpec => mapSections(spec, (section) => ({
  ...section,
  fields: section.fields.filter((field) => !resolveTarget(graph, field.target).problem),
}));

// ---------------------------------------------------------------------------
// Writing values
// ---------------------------------------------------------------------------

export type FormValueWriter = (nodeId: number, widget: string, value: any) => void;

/**
 * Writes a field's value to the primary target and every resolvable linked one.
 * Unresolved links are skipped rather than throwing: the form stays usable when
 * one of several linked nodes was deleted.
 */
export const writeFieldValue = (
  graph: FormGraphLike | null | undefined,
  field: MobileFormField,
  value: any,
  setValue: FormValueWriter,
): MobileFormTarget[] => {
  const written: MobileFormTarget[] = [];
  for (const target of fieldTargets(field)) {
    if (resolveTarget(graph, target).problem) continue;
    setValue(target.nodeId, target.widget, value);
    written.push(target);
  }
  return written;
};

/**
 * Mirrors a write on one target onto the rest of its field.
 *
 * This is the hook the form view wraps its widget editor with, so every path
 * inside WidgetValueEditor (edit-and-save, direct toggles, combo picks) fans
 * out without each control having to know about linking. Returns the targets
 * that were additionally written.
 */
export const fanOutLinkedWrite = (
  graph: FormGraphLike | null | undefined,
  spec: MobileFormSpec | null,
  nodeId: number,
  widget: string,
  value: any,
  setValue: FormValueWriter,
): MobileFormTarget[] => {
  const owner = findFieldForTarget(spec, { nodeId, widget, nodeType: '' });
  if (!owner?.field.linked?.length) return [];
  const written: MobileFormTarget[] = [];
  for (const target of fieldTargets(owner.field)) {
    if (target.nodeId === nodeId && target.widget === widget) continue;
    if (resolveTarget(graph, target).problem) continue;
    setValue(target.nodeId, target.widget, value);
    written.push(target);
  }
  return written;
};

/**
 * Re-applies each linked field's primary value across its targets.
 *
 * Called right before execution, AFTER seed processing: `autoChangeSeed` gives
 * every seed widget its own random number, so linked seeds would otherwise
 * diverge in the submitted prompt.
 */
export const applyLinkedFields = (
  graph: FormGraphLike | null | undefined,
  spec: MobileFormSpec | null,
  getValue: FormValueReader,
  setValue: FormValueWriter,
): number => {
  let writes = 0;
  for (const section of spec?.sections || []) {
    for (const field of section.fields) {
      if (!field.linked?.length) continue;
      const primary = resolveTarget(graph, field.target, getValue);
      if (primary.problem) continue;
      for (const target of field.linked) {
        const resolved = resolveTarget(graph, target, getValue);
        if (resolved.problem) continue;
        if (sameValue(resolved.value, primary.value)) continue;
        setValue(target.nodeId, target.widget, primary.value);
        writes += 1;
      }
    }
  }
  return writes;
};
