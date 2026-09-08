/**
 * Sequences one explicit "save draft to library" operation: intent to the Gateway, one conditional file write to the
 * ComfyUI extension, outcome back to the Gateway, and the library cache refreshed without marking anything dirty.
 * All decisions are in librarySaveMachine.ts.
 */
import type { AgentApi, AgentSession, LibrarySaveOp } from '@/infrastructure/api/AgentApi';
import { ComfyFileService } from '@/infrastructure/api/ComfyFileService';
import { cacheWorkflowFromCloud, findWorkflowById, loadAllWorkflows, removeWorkflowFromCache } from '@/infrastructure/storage/IndexedDBWorkflowService';
import { removeCloudWorkflowDelete } from '@/infrastructure/sync/CloudWorkflowOutbox';
import { cloudFileContent, readCloudSaveOpId } from '@/infrastructure/sync/cloudIdentity';
import { emitCloudWorkflowsUpdated } from '@/infrastructure/sync/WorkflowSyncEvents';
import { graphHash } from '@/components/agent/graphHash';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { decideAfterReconcile, decideAfterWrite, planSave, saveAvailability, withState, type SaveAvailability, type SaveDecision, type SaveRequest } from './librarySaveMachine';

export interface LibrarySaveDeps {
  api: AgentApi; files: ComfyFileService; serverId: string; device: string;
  now?: () => number; uuid?: () => string;
}

export class LibrarySaveService {
  private readonly now: () => number;
  private readonly uuid: () => string;
  constructor(private readonly deps: LibrarySaveDeps) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
  }

  /** The panel's situation for the given draft canvas, checked against the live server listing. */
  async availability(session: AgentSession, canvas: IComfyJson): Promise<{ availability: SaveAvailability; graphHash: string; remoteFilenames: string[] }> {
    const [hash, listing] = await Promise.all([graphHash(canvas), this.deps.files.listWorkflows()]);
    if (!listing.success) throw new Error(listing.error || '无法读取服务器工作流列表');
    const remoteEtags = new Map(listing.workflows.map(w => [w.filename, w.etag]));
    return { availability: saveAvailability({ session, serverId: this.deps.serverId, graphHash: hash, remoteEtags }), graphHash: hash, remoteFilenames: [...remoteEtags.keys()] };
  }

  /** Runs the whole operation for a fixed draft version. Returns the session as the Gateway last recorded it. */
  async start(session: AgentSession, request: SaveRequest, draft: { version: number; canvas: IComfyJson }): Promise<AgentSession> {
    const id = session.id;
    const hash = await graphHash(draft.canvas);
    let op = planSave({ request, serverId: this.deps.serverId, draftVersion: draft.version, graphHash: hash, opId: this.uuid(), startedBy: this.deps.device, now: this.now() });
    // 1. Intent. The Gateway refuses while another operation is in flight, so two devices never write the same target.
    let current = (await this.deps.api.update(id, { librarySaveOp: op })).session;
    // A pending delete for this filename would erase the file we are about to write on the next sync.
    removeCloudWorkflowDelete(op.target.filename);
    op = withState(op, 'applying', this.now());
    current = (await this.deps.api.update(id, { librarySaveOp: op })).session;
    // 2. One conditional write. Create refuses to overwrite; update demands the etag the user last saw.
    const cached = await this.cachedTarget(op);
    const content = cloudFileContent(draft.canvas, { name: op.target.name, description: cached?.description, tags: cached?.tags, workflowId: op.target.workflowId, saveOpId: op.opId });
    const write = await this.deps.files.saveWorkflow(op.target.filename, content, op.mode === 'create' ? { overwrite: false } : { expectedEtag: op.target.expectedEtag });
    let decision = decideAfterWrite(op, write, this.now());
    if (decision.op.state === 'reconciling') {
      current = (await this.deps.api.update(id, { librarySaveOp: decision.op })).session;
      decision = await this.readBack(decision.op);
    }
    // 3. Outcome, then 4. cache.
    current = (await this.deps.api.update(id, { librarySaveOp: decision.op, ...(decision.lastLibrarySave ? { lastLibrarySave: decision.lastLibrarySave } : {}) })).session;
    if (decision.lastLibrarySave) await this.refreshCache(decision.op, content, decision.lastLibrarySave.etag, write.modified, cached);
    return current;
  }

  /** Finishes an operation another run left in `applying`/`reconciling` (app killed, response lost). */
  async reconcile(session: AgentSession): Promise<AgentSession> {
    const op = session.librarySaveOp;
    if (!op || (op.state !== 'applying' && op.state !== 'reconciling')) return session;
    let current = session;
    if (op.state === 'applying') current = (await this.deps.api.update(session.id, { librarySaveOp: withState(op, 'reconciling', this.now()) })).session;
    const decision = await this.readBack(current.librarySaveOp ?? op);
    current = (await this.deps.api.update(session.id, { librarySaveOp: decision.op, ...(decision.lastLibrarySave ? { lastLibrarySave: decision.lastLibrarySave } : {}) })).session;
    if (decision.lastLibrarySave) {
      const download = await this.deps.files.downloadWorkflow(op.target.filename);
      if (download.success && download.content) await this.refreshCache(decision.op, download.content, decision.lastLibrarySave.etag, download.modified, await this.cachedTarget(decision.op));
    }
    return current;
  }

  private async readBack(op: LibrarySaveOp): Promise<SaveDecision> {
    const download = await this.deps.files.downloadWorkflow(op.target.filename);
    if (!download.success || !download.content) return decideAfterReconcile(op, { found: false }, this.now());
    return decideAfterReconcile(op, { found: true, saveOpId: readCloudSaveOpId(download.content), graphHash: await graphHash(download.content), etag: download.etag }, this.now());
  }

  private async cachedTarget(op: LibrarySaveOp): Promise<Workflow | undefined> {
    return (await findWorkflowById(op.target.workflowId)) ?? (await loadAllWorkflows()).find(w => w.cloud?.filename === op.target.filename);
  }

  /** The library cache learns about the file the way a sync download would: clean, with the server etag, never dirty. */
  private async refreshCache(op: LibrarySaveOp, content: IComfyJson, etag: string, modified: number | undefined, cached: Workflow | undefined) {
    if (cached && cached.id !== op.target.workflowId) await removeWorkflowFromCache(cached.id);
    const at = new Date();
    await cacheWorkflowFromCloud({
      ...(cached ?? {}),
      id: op.target.workflowId, name: op.target.name, workflow_json: content, nodeCount: content.nodes?.length ?? 0,
      createdAt: cached?.createdAt ?? at, modifiedAt: at, isValid: true, author: 'cloud',
      tags: Array.from(new Set([...(cached?.tags ?? []), 'cloud'])),
      cloud: { provider: 'comfyui', filename: op.target.filename, etag, remoteModified: modified, lastSyncedAt: at.toISOString(), dirty: false, saveOpId: op.opId },
    });
    emitCloudWorkflowsUpdated();
  }
}
