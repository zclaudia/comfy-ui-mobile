/**
 * Migrating a pre-draft session: the Gateway only knows the old `legacyWorkflow` binding, while the evidence of what was
 * last mirrored (`Workflow.agent`) lives in this device's IndexedDB. So the first new client to open a legacy session
 * turns the binding into a source reference, and into a library-save record when the library copy still matches the
 * session's latest version. Everything is kept; nothing is created in the library.
 */
import type { AgentSession, SessionPatch, SessionWorkflowRef } from '../../infrastructure/api/AgentApi';
import type { Workflow } from '../../shared/types/app/IComfyWorkflow';

/** The pre-draft canvas hash (64-bit FNV over sorted nodes/links). Kept only to read old `agent.mirroredHash` values. */
export function legacyHashCanvas(canvas: unknown): string {
  const graph = { nodes: (canvas as { nodes?: unknown })?.nodes ?? [], links: (canvas as { links?: unknown })?.links ?? [] };
  const text = JSON.stringify(graph, (_key, value) => (value && typeof value === 'object' && !Array.isArray(value)) ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, (value as Record<string, unknown>)[k]])) : value);
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0; }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

const resolveLegacy = (ref: SessionWorkflowRef | undefined, workflows: Workflow[]) =>
  ref ? workflows.find(w => w.id === ref.id) ?? (ref.filename ? workflows.find(w => w.cloud?.filename === ref.filename) : undefined) : undefined;

export interface MigrationPlan { patch: SessionPatch; clearBinding?: string }

export function planLegacyMigration({ session, workflows, latestCanvas, latestGraphHash, serverId, now = Date.now() }: {
  session: AgentSession; workflows: Workflow[]; latestCanvas: unknown; latestGraphHash: string; serverId: string; now?: number;
}): MigrationPlan {
  const patch: SessionPatch = { workspaceMode: 'draft' };
  const bound = resolveLegacy(session.legacyWorkflow, workflows);
  // A library copy bound to another session, or without a cloud file, cannot be cited across devices.
  if (!bound || !bound.cloud?.filename || bound.agent?.sessionId !== session.id) return { patch };
  patch.sourceRef = { serverId, workflowId: bound.id, filename: bound.cloud.filename, name: bound.name, etag: bound.cloud.etag };
  const untouched = session.version > 0 && bound.agent.mirroredHash === legacyHashCanvas(latestCanvas);
  if (untouched) {
    patch.lastLibrarySave = { serverId, workflowId: bound.id, filename: bound.cloud.filename, name: bound.name, draftVersion: bound.agent.mirroredVersion, graphHash: latestGraphHash, etag: bound.cloud.etag ?? '', opId: 'legacy', at: now };
  }
  return { patch, clearBinding: bound.id };
}
