import type { IComfyJson } from '../../shared/types/app/IComfyJson';
import type { Workflow } from '../../shared/types/app/IComfyWorkflow';
import { AgentRequestError } from '../../infrastructure/api/AgentRequestError';
import type { AgentSession, SessionWorkflowRef } from '../../infrastructure/api/AgentApi';
import { canvasChangedSinceMirror, hashCanvas, resolveBoundWorkflow, sessionTitle } from './binding';
import { generateUUID } from '../../utils/uuid';

export interface MirrorDeps {
  workflows: () => Promise<Workflow[]>;
  add: (workflow: Workflow) => Promise<void>;
  update: (workflow: Workflow) => Promise<void>;
  bind: (sessionId: string, ref: SessionWorkflowRef) => Promise<unknown>;
  now?: () => Date;
  id?: () => string;
}
export type MirrorResult =
  | { kind: 'updated' | 'created' | 'unchanged'; workflow: Workflow }
  | { kind: 'conflict'; workflow: Workflow }
  | { kind: 'missing' };

const nodeCount = (canvas: IComfyJson) => canvas.nodes?.length ?? 0;

/** Write a session version into the bound library workflow. Creates the workflow for blank sessions. */
export async function mirrorVersion(session: AgentSession, version: number, canvas: IComfyJson, deps: MirrorDeps, options: { fallbackName?: string; recreate?: boolean } = {}): Promise<MirrorResult> {
  const now = deps.now?.() ?? new Date();
  const agent = { sessionId: session.id, mirroredVersion: version, mirroredHash: hashCanvas(canvas) };
  const bound = resolveBoundWorkflow(session.workflow, await deps.workflows());
  if (bound) {
    const sameSession = bound.agent?.sessionId === session.id;
    if (sameSession && (bound.agent?.mirroredVersion ?? 0) >= version) return { kind: 'unchanged', workflow: bound };
    // A canvas edited since the last mirror must not be overwritten; the next message imports it instead.
    if (sameSession && hashCanvas(bound.workflow_json) !== bound.agent!.mirroredHash) return { kind: 'conflict', workflow: bound };
    const workflow: Workflow = { ...bound, workflow_json: canvas, nodeCount: nodeCount(canvas), modifiedAt: now, agent };
    await deps.update(workflow);
    return { kind: 'updated', workflow };
  }
  if (session.workflow && !options.recreate) return { kind: 'missing' };
  const name = sessionTitle(session, options.fallbackName ?? session.name);
  const workflow: Workflow = { id: deps.id?.() ?? generateUUID(), name, workflow_json: canvas, nodeCount: nodeCount(canvas), createdAt: now, modifiedAt: now, isValid: true, agent };
  await deps.add(workflow);
  await deps.bind(session.id, { id: workflow.id, name });
  return { kind: 'created', workflow };
}

export type ImportResult = { kind: 'unchanged' } | { kind: 'imported'; version: number } | { kind: 'unsupported'; message: string };

/** Before a message, push canvas edits so the agent works on what the user sees. 422 means the canvas uses unsupported nodes. */
export async function importCanvasIfChanged(
  session: AgentSession, bound: Workflow | undefined,
  deps: { importVersion: (id: string, canvas: IComfyJson, baseVersion: number, summary: string) => Promise<{ version: number }>; setBinding: (workflowId: string, agent: Workflow['agent']) => Promise<void> },
): Promise<ImportResult> {
  if (!bound || !canvasChangedSinceMirror(bound, session.id)) return { kind: 'unchanged' };
  try {
    const { version } = await deps.importVersion(session.id, bound.workflow_json, session.version, '画布修改');
    await deps.setBinding(bound.id, { sessionId: session.id, mirroredVersion: version, mirroredHash: hashCanvas(bound.workflow_json) });
    return { kind: 'imported', version };
  } catch (error) {
    if (error instanceof AgentRequestError && error.status === 422) return { kind: 'unsupported', message: error.message };
    throw error;
  }
}
