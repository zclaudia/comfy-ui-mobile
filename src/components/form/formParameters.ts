/**
 * Builds the IProcessedParameter shape WidgetValueEditor expects from a live
 * widget. This mirrors NodeDetailModal's own widget mapping so the form and the
 * node panel render the same control for the same widget — including the seed's
 * paired control_after_generate.
 */

import type { IProcessedParameter } from '@/shared/types/comfy/IComfyObjectInfo';
import type { MobileFormField } from '@/shared/types/app/IMobileForm';
import type { FormNodeLike, FormWidgetLike } from '@/shared/utils/mobileForm';

const SEED_WIDGETS = new Set(['seed', 'noise_seed']);

export const widgetIndexOf = (node: FormNodeLike | undefined, name: string): number => {
  const widgets = (typeof node?.getWidgets === 'function' ? node.getWidgets() : []) || [];
  return widgets.findIndex((widget) => widget?.name === name);
};

export const toProcessedParameter = (
  node: FormNodeLike | undefined,
  widget: FormWidgetLike,
  field?: MobileFormField,
): IProcessedParameter => {
  const widgets = (typeof node?.getWidgets === 'function' ? node.getWidgets() : []) || [];
  const index = widgets.findIndex((candidate) => candidate?.name === widget.name);

  let controlAfterGenerate: IProcessedParameter['controlAfterGenerate'];
  if (SEED_WIDGETS.has(String(widget.name)) && widget.options?.control_after_generate) {
    const control = widgets.find((candidate) => candidate?.name === 'control_after_generate');
    controlAfterGenerate = {
      enabled: true,
      value: (control?.value as string) || 'fixed',
      options: ['fixed', 'increment', 'decrement', 'randomize'],
    };
  }

  return {
    name: String(widget.name),
    type: widget.type as IProcessedParameter['type'],
    value: widget.value,
    description: widget.options?.tooltip,
    possibleValues: widget.options?.values,
    validation: {
      // A field-level range overrides the node's own bounds; the form is where
      // a user narrows a control to a range they actually use.
      min: field?.range?.min ?? widget.options?.min,
      max: field?.range?.max ?? widget.options?.max,
      step: field?.range?.step ?? widget.options?.step,
    },
    required: !widget.options?.optional,
    widgetIndex: index >= 0 ? index : 0,
    config: {},
    controlAfterGenerate,
    label: field?.label || widget.options?.label,
  } as IProcessedParameter;
};

/** Widgets a node exposes that the form may bind to. */
export const bindableWidgets = (node: FormNodeLike | undefined): FormWidgetLike[] => {
  const widgets = (typeof node?.getWidgets === 'function' ? node.getWidgets() : []) || [];
  return widgets.filter((widget) => {
    if (!widget?.name || widget.name === 'control_after_generate') return false;
    const input = node?.inputs?.find((candidate) => candidate?.name === widget.name);
    return !(input && input.link !== null && input.link !== undefined);
  });
};
