/**
 * Builds the widget-modification map a workflow run is submitted with.
 *
 * Pure and browser-free on purpose: this is the part of execution worth unit
 * testing, and it must not drag the API client and its stores into a test
 * process. useWorkflowRunner is the React wrapper around it.
 */

import { autoChangeSeed } from '@/shared/utils/seedProcessing';
import { applyLinkedFields, type FormGraphLike } from '@/shared/utils/mobileForm';

import type { IComfyWorkflow } from '@/shared/types/app/IComfyWorkflow';
import type { MobileFormSpec } from '@/shared/types/app/IMobileForm';
import type { NodeWidgetModifications } from '@/shared/types/widgets/widgetModifications';

/** A modification map that can be read and written synchronously. */
const localModifications = (base: Map<number, NodeWidgetModifications>) => {
  const map = new Map<number, NodeWidgetModifications>();
  base.forEach((values, nodeId) => map.set(nodeId, { ...values }));
  return {
    map,
    has: (nodeId: number, name: string) => {
      const values = map.get(nodeId);
      return !!values && name in values;
    },
    get: (nodeId: number, name: string) => map.get(nodeId)?.[name],
    set: (nodeId: number, name: string, value: any) => {
      const values = map.get(nodeId) || {};
      values[name] = value;
      map.set(nodeId, values);
    },
  };
};

export interface PrepareExecutionInput {
  /** The widget editor's current modifications; never mutated. */
  base: Map<number, NodeWidgetModifications>;
  /** Falls back to the widget editor / graph when the local map has no entry. */
  readBase: (nodeId: number, name: string, fallback: any) => any;
  /** Mirrors every write back into the UI's own state. */
  writeThrough: (nodeId: number, name: string, value: any) => void;
  workflow: IComfyWorkflow | null;
  nodeMetadata: any;
  graph: FormGraphLike | null;
  formSpec: MobileFormSpec | null;
  forceRandomize?: boolean;
  /** Injectable for tests; defaults to the real seed processor. */
  autoSeed?: typeof autoChangeSeed;
}

export interface PreparedExecution {
  modifications: Map<number, NodeWidgetModifications>;
  seedChanges: number;
  linkedWrites: number;
}

/**
 * Builds the modification map a run is submitted with.
 *
 * The map is local and synchronous on purpose. `modifiedWidgetValues` is React
 * state captured at render, so a seed randomized inside this very call was
 * invisible to the graph the editor submitted — each run shipped the previous
 * run's seed. Linked fields are unified last, after seed processing has given
 * every seed widget its own random number.
 */
export const prepareExecutionModifications = async (
  input: PrepareExecutionInput,
): Promise<PreparedExecution> => {
  const local = localModifications(input.base);
  const read = (nodeId: number, name: string, fallback: any) => (
    local.has(nodeId, name) ? local.get(nodeId, name) : input.readBase(nodeId, name, fallback)
  );
  const write = (nodeId: number, name: string, value: any) => {
    local.set(nodeId, name, value);
    input.writeThrough(nodeId, name, value);
  };

  let seedChanges = 0;
  try {
    const seed = input.autoSeed || autoChangeSeed;
    const changes = await seed(
      input.workflow,
      input.nodeMetadata,
      { getWidgetValue: read, setWidgetValue: write },
      input.forceRandomize ?? false,
    );
    seedChanges = changes.length;
  } catch (error) {
    // A workflow with no seeds, or metadata that failed to load, must not block
    // the run; the graph is still submittable as it stands.
    console.error('[WorkflowRunner] seed processing failed', error);
  }

  const linkedWrites = applyLinkedFields(input.graph, input.formSpec, read, write);
  return { modifications: local.map, seedChanges, linkedWrites };
};

