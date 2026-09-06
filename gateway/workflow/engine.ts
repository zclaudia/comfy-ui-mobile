/** Browser-independent, conservative ComfyUI API graph operations. */
export type Literal = string | number | boolean;
export type Link = [string, number];
export type InputValue = Literal | Link;
export interface PromptNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: Record<string, unknown>;
}
export type Prompt = Record<string, PromptNode>;
export type InputDefinition = [string | Literal[], {
  min?: number; max?: number; forceInput?: boolean; [key: string]: unknown;
}?];
export interface NodeDefinition {
  input?: { required?: Record<string, InputDefinition>; optional?: Record<string, InputDefinition> };
  output: string[];
  output_node?: boolean;
}
export type ObjectInfo = Record<string, NodeDefinition>;
export interface Diagnostic { code: string; message: string; nodeId?: string; input?: string }
export class WorkflowError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => d.message).join('; '));
    this.name = 'WorkflowError';
  }
}
export const own = (object: object, key: string): boolean => Object.hasOwn(object, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isLink = (value: unknown): value is Link => Array.isArray(value)
  && value.length === 2 && typeof value[0] === 'string'
  && Number.isSafeInteger(value[1]) && value[1] >= 0;
const safeKey = (key: string) => key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key);
const compatible = (output: string, input: string) => output === input || output === '*' || input === '*';

/** Does not submit /prompt or run node-specific Python validation. */
export function validatePrompt(value: unknown, info: ObjectInfo): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const add = (code: string, message: string, nodeId?: string, input?: string) =>
    errors.push({ code, message, nodeId, input });
  if (!record(value) || Object.keys(value).length === 0) {
    return [{ code: 'invalid_prompt', message: 'Expected a non-empty API prompt object' }];
  }
  const dependencies = new Map<string, string[]>();
  let hasOutput = false;
  for (const [id, node] of Object.entries(value)) {
    if (!safeKey(id) || !record(node) || typeof node.class_type !== 'string' || !record(node.inputs)) {
      add('invalid_node', 'Expected a node with class_type and inputs', id);
      continue;
    }
    if (!own(info, node.class_type)) {
      add('missing_node', `Node type is not installed: ${node.class_type}`, id);
      continue;
    }
    const schema = info[node.class_type];
    hasOutput ||= schema.output_node === true;
    const definitions = { ...schema.input?.required, ...schema.input?.optional };
    // Resolve only schema-declared V3 autogrow slots; never trust arbitrary dotted names.
    for (const name of Object.keys(node.inputs)) {
      const [group, child, extra] = name.split('.');
      const definition = definitions[group];
      if (extra || !child || definition?.[0] !== 'COMFY_AUTOGROW_V3') continue;
      const options = definition[1] as any;
      const prefix = options?.template?.prefix;
      const index = typeof prefix === 'string' && child.startsWith(prefix) ? child.slice(prefix.length) : '';
      if (!/^(0|[1-9][0-9]*)$/.test(index) || Number(index) >= options.template.max) continue;
      const template = Object.values(options.template?.input?.required ?? {}) as InputDefinition[];
      if (template.length === 1) definitions[name] = template[0];
    }
    for (const name of Object.keys(schema.input?.required ?? {})) {
      if (!own(node.inputs, name)) add('required_input', `Missing required input: ${name}`, id, name);
    }
    dependencies.set(id, []);
    for (const [name, input] of Object.entries(node.inputs)) {
      if (!safeKey(name) || !own(definitions, name)) {
        add('unknown_input', `Unsupported input: ${name}`, id, name);
        continue;
      }
      const [type, options] = definitions[name];
      if (isLink(input)) {
        const [sourceId, slot] = input;
        const source = own(value, sourceId) ? value[sourceId] : undefined;
        if (!record(source) || typeof source.class_type !== 'string') {
          add('missing_source', `Missing source node: ${sourceId}`, id, name);
          continue;
        }
        dependencies.get(id)!.push(sourceId);
        const sourceSchema = own(info, source.class_type) ? info[source.class_type] : undefined;
        if (!sourceSchema) continue; // The source's own diagnostic identifies its missing type.
        const outputType = sourceSchema.output[slot];
        if (typeof outputType !== 'string') add('invalid_slot', `Missing output slot: ${slot}`, id, name);
        else if (!compatible(outputType, Array.isArray(type) ? 'COMBO' : type)) {
          add('incompatible_link', `Cannot connect ${outputType} to ${Array.isArray(type) ? 'COMBO' : type}`, id, name);
        }
        continue;
      }
      if (options?.forceInput) {
        add('link_required', `Input requires a connection: ${name}`, id, name);
      } else if (Array.isArray(type)) {
        if (!type.includes(input as Literal)) add('invalid_choice', `Unavailable value for ${name}`, id, name);
      } else if (type === 'COMBO' || type === 'COMFY_DYNAMICCOMBO_V3') {
        const choices = options?.options;
        if (!Array.isArray(choices) || !choices.some(choice => (typeof choice === 'object' ? choice.key : choice) === input)) add('invalid_choice', `Unavailable value for ${name}`, id, name);
      } else if (type === 'INT' || type === 'FLOAT') {
        if (typeof input !== 'number' || !Number.isFinite(input) || (type === 'INT' && !Number.isSafeInteger(input))) {
          add('invalid_number', `Expected ${type} for ${name}`, id, name);
        } else if ((options?.min !== undefined && input < options.min) || (options?.max !== undefined && input > options.max)) {
          add('out_of_range', `Value outside allowed range for ${name}`, id, name);
        }
      } else if (type === 'STRING' || type === 'BOOLEAN') {
        if (typeof input !== (type === 'STRING' ? 'string' : 'boolean')) add('invalid_literal', `Expected ${type} for ${name}`, id, name);
      } else {
        add('unsupported_literal', `Input ${name} requires a connection or an explicit codec for ${type}`, id, name);
      }
    }
  }
  for (const [id, node] of Object.entries(value)) {
    if (!record(node) || !record(node.inputs)) continue;
    const input = node.inputs;
    if (['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'].includes(String(node.class_type))) {
      for (const axis of ['width', 'height']) if (typeof input[axis] === 'number' && input[axis] % 32 !== 0) add('model_constraint', 'H3 dimensions must be multiples of 32', id, axis);
      if (typeof input.length === 'number' && input.length % 17 !== 5) add('model_constraint', 'H3 frame count must follow 17k+5 (5, 22, 39, 56...)', id, 'length');
    }
  }
  if (!hasOutput) add('missing_output', 'Workflow must contain an installed output node');
  // Iterative topological traversal avoids recursion limits on imported graphs.
  const remaining = new Map([...dependencies].map(([id, deps]) => [id, deps.filter(d => dependencies.has(d)).length]));
  const consumers = new Map<string, string[]>();
  for (const [id, deps] of dependencies) for (const dep of deps) {
    if (dependencies.has(dep)) consumers.set(dep, [...(consumers.get(dep) ?? []), id]);
  }
  const ready = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) for (const consumer of consumers.get(ready[i]) ?? []) {
    const count = remaining.get(consumer)! - 1;
    remaining.set(consumer, count);
    if (count === 0) ready.push(consumer);
  }
  if (ready.length !== dependencies.size) add('cycle', 'Workflow contains a dependency cycle');
  return errors;
}

export function checkedPrompt(value: unknown, info: ObjectInfo): Prompt {
  const errors = validatePrompt(value, info);
  if (errors.length) throw new WorkflowError(errors);
  return structuredClone(value as Prompt);
}

export interface WorkflowVersion { version: number; prompt: Prompt }
export type PatchOperation =
  | { op: 'add_node'; nodeId: string; node: PromptNode }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'set_input'; nodeId: string; input: string; value: InputValue }
  | { op: 'remove_input'; nodeId: string; input: string };

/** Pure transaction: caller persists with its own compare-and-swap on version. */
export function applyPromptPatch(current: WorkflowVersion, baseVersion: number, operations: PatchOperation[], info: ObjectInfo): WorkflowVersion {
  const fail = (code: string, message: string): never => { throw new WorkflowError([{ code, message }]); };
  if (!Number.isSafeInteger(current.version) || current.version < 0 || current.version >= Number.MAX_SAFE_INTEGER) fail('invalid_version', 'Invalid workflow version');
  if (baseVersion !== current.version) fail('version_conflict', 'Workflow changed; read its latest version before modifying it');
  if (!Array.isArray(operations) || operations.length === 0) fail('invalid_patch', 'Expected a non-empty patch');
  const prompt = structuredClone(current.prompt);
  for (const operation of operations) {
    if (!record(operation) || typeof operation.nodeId !== 'string' || !safeKey(operation.nodeId)) fail('invalid_patch', 'Invalid node ID');
    const id = operation.nodeId;
    if (operation.op === 'add_node') {
      if (own(prompt, id)) fail('duplicate_node', `Node already exists: ${id}`);
      prompt[id] = structuredClone(operation.node);
    } else {
      if (!own(prompt, id)) fail('missing_node', `Node does not exist: ${id}`);
      if (operation.op === 'remove_node') {
        delete prompt[id]; // Dangling connections must be fixed in this same patch.
      } else if (operation.op === 'set_input' || operation.op === 'remove_input') {
        if (typeof operation.input !== 'string' || !safeKey(operation.input)) fail('invalid_patch', 'Invalid input name');
        if (operation.op === 'set_input') prompt[id].inputs[operation.input] = structuredClone(operation.value);
        else delete prompt[id].inputs[operation.input];
      } else fail('invalid_patch', 'Unknown patch operation');
    }
  }
  return { version: current.version + 1, prompt: checkedPrompt(prompt, info) };
}
