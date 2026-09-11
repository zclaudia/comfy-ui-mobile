/**
 * Mobile form view types.
 *
 * A workflow can carry a "form spec": the small set of inputs worth exposing on
 * a phone. The spec lives in `workflow_json.extra.comfy_mobile_form` — `extra`
 * survives a round trip through the desktop ComfyUI frontend, while root-level
 * custom keys (such as `mobile_ui_metadata`) do not.
 */

export const MOBILE_FORM_VERSION = 1 as const;

/** One widget on one node. Fields bind by widget NAME, never by widgets_values index. */
export interface MobileFormTarget {
  /** Root-graph node id. ComfyGraphNode.id is a number. */
  nodeId: number;
  /** Widget name as reported by ComfyGraphNode.getWidgets(). */
  widget: string;
  /** Node type at the time of binding; a changed type invalidates the target. */
  nodeType: string;
  /** Reserved: subgraph binding is out of scope for the first release. */
  subgraphId?: string;
}

export type MobileFormControl =
  | 'auto'
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'stepper'
  | 'select'
  | 'toggle'
  | 'seed'
  | 'image'
  | 'video';

export interface MobileFormField {
  /** Stable id, independent of the targets (a linked field has several). */
  id: string;
  /** Primary target: the displayed value and the control type come from it. */
  target: MobileFormTarget;
  /** Linked targets: writes fan out to these as well. */
  linked?: MobileFormTarget[];
  /** Overrides the derived `${node.title} · ${widget}` label. */
  label?: string;
  control?: MobileFormControl;
  hint?: string;
  range?: { min?: number; max?: number; step?: number };
}

export interface MobileFormSection {
  id: string;
  title: string;
  collapsed?: boolean;
  fields: MobileFormField[];
}

export interface MobileFormSpec {
  version: typeof MOBILE_FORM_VERSION;
  /**
   * `auto`  — the spec was suggested and is refreshed on every open.
   * `custom`— the user edited it; it is never regenerated behind their back.
   */
  mode: 'auto' | 'custom';
  sections: MobileFormSection[];
  updatedAt: string;
}

/** Why a target cannot be used right now. */
export type MobileFormTargetProblem = 'missing-node' | 'type-changed' | 'missing-widget' | 'connected';

export interface ResolvedTarget {
  target: MobileFormTarget;
  problem?: MobileFormTargetProblem;
  /** Live widget, when the target resolves. */
  widget?: any;
  node?: any;
  value?: any;
}

export interface ResolvedField {
  field: MobileFormField;
  primary: ResolvedTarget;
  linked: ResolvedTarget[];
  /** True when the primary target resolves; the field can then be rendered. */
  usable: boolean;
  /** True when a linked target holds a different value than the primary one. */
  inconsistent: boolean;
  label: string;
}

export interface ResolvedSection {
  section: MobileFormSection;
  fields: ResolvedField[];
}
