import type { AssetBinding, Draft, Revision, RevisionRef } from '../../shared/types/agentWorkspace';
import type { IComfyJson } from '../../shared/types/app/IComfyJson';

export interface DraftContent { canvas: IComfyJson; bindings: AssetBinding[] }
export interface DraftCopyIdentity { serverId: string; sessionId: string; draftId: string; openedRevision: number; copyId?: string }
export interface DraftLocalForkRequest extends DraftContent { requestId: string; sourceRevision: number; name: string }
export interface DraftSaveRequest extends DraftContent {
  requestId: string; expectedHeadRevision: number; sourceRevision: number; summary: string;
}
export interface DraftCopyRecord {
  key: string; epoch: number; identity: DraftCopyIdentity;
  sourceRevision: number; expectedHeadRevision: number;
  base: DraftContent; local: DraftContent; pending?: DraftSaveRequest;
  rejected?: { requestId: string; status: number; message: string };
  rejectedRequests?: { request: DraftSaveRequest; status: number; message: string }[];
  fork?: { request: DraftLocalForkRequest; result?: RevisionRef };
  recovery?: { importedAt: number; reviewRequired: boolean };
  discard?: { requestedAt: number };
  discarded?: { at: number; savedRevision?: number; forkedTo?: RevisionRef };
}
export interface DraftDiscardResult { revision: Revision; savedRevision?: number; forkedTo?: RevisionRef }
export interface DraftCopyStore {
  read(key: string): Promise<DraftCopyRecord | undefined>;
  /** Commit only if no other editor has written since our last read. */
  compareAndSwap(key: string, expectedEpoch: number | undefined, next: DraftCopyRecord): Promise<void>;
}
export class DraftCopyConflict extends Error {
  constructor() { super('This draft working copy changed in another editor'); this.name = 'DraftCopyConflict'; }
}
export const draftCopyKey = (identity: DraftCopyIdentity) => JSON.stringify([
  identity.serverId, identity.sessionId, identity.draftId, identity.openedRevision,
  ...(identity.copyId ? [identity.copyId] : []),
]);
const clone = <T>(value: T): T => structuredClone(value);
// Object insertion order is not a document change. Array order (including nodes/widgets) is.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sameDraftContent = (a: DraftContent, b: DraftContent) =>
  canonical({ canvas: a.canvas, bindings: a.bindings }) === canonical({ canvas: b.canvas, bindings: b.bindings });
/** Graph serializers can expose logging Proxies. Persist the wire JSON, never a runtime wrapper. */
export const draftContentSnapshot = (content: DraftContent): DraftContent => JSON.parse(JSON.stringify({ canvas: content.canvas, bindings: content.bindings }));

export interface DraftCopyStatus {
  sourceRevision: number; expectedHeadRevision: number; dirty: boolean;
  pending: boolean; syncing: boolean; memoryOnly: boolean; rejected: boolean; recovering: boolean; discarding: boolean; forking: boolean; forkedTo?: RevisionRef; error?: unknown;
}

/** A durable local document plus an immutable outbox. Never writes the workflow library.
 * Local writes remain possible while the network is awaiting an acknowledgement.
 * A lost reply replays the original request before sending any newer edits.
 */
export class DraftWorkingCopy {
  private record: DraftCopyRecord;
  private localQueue: Promise<unknown> = Promise.resolve();
  private flight?: Promise<number>;
  private forkFlight?: Promise<RevisionRef>;
  private discardFlight?: Promise<DraftDiscardResult>;
  private retired = false;
  private staged?: DraftContent;
  private syncError?: unknown;
  private listeners = new Set<() => void>();
  private status: DraftCopyStatus;

  private constructor(private store: DraftCopyStore, record: DraftCopyRecord,
    private send: (request: DraftSaveRequest) => Promise<{ revision: Revision }>) {
    this.record = clone(record);
    this.status = this.makeStatus(false);
  }

  static async open(store: DraftCopyStore, identity: DraftCopyIdentity, revision: Revision,
    headRevision: number, send: (request: DraftSaveRequest) => Promise<{ revision: Revision }>) {
    if (revision.sessionId !== identity.sessionId || revision.draftId !== identity.draftId
      || revision.revision !== identity.openedRevision || headRevision < revision.revision) {
      throw new Error('Invalid draft working copy identity');
    }
    const key = draftCopyKey(identity);
    let record = await store.read(key);
    if (!record) {
      if (identity.copyId) throw new Error('本机恢复副本不存在，请重新导入备份');
      const content = clone({ canvas: revision.canvas, bindings: revision.bindings });
      record = { key, epoch: 1, identity, sourceRevision: revision.revision,
        expectedHeadRevision: headRevision, base: content, local: clone(content) };
      try { await store.compareAndSwap(key, undefined, record); }
      catch (error) {
        if (!(error instanceof DraftCopyConflict)) throw error;
        record = await store.read(key);
        if (!record) throw error;
      }
    }
    if (record.key !== key || draftCopyKey(record.identity) !== key) throw new Error('Invalid stored draft identity');
    return new DraftWorkingCopy(store, record, send);
  }

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.status;
  content(): DraftContent { return clone(this.staged ?? this.record.local); }
  /** This is a recovery document, not an executable ComfyUI export. It includes immutable pending requests. */
  recoverySnapshot() { return { format: 'comfy-mobile-draft-recovery', schemaVersion: 1, created: Date.now(), record: clone(this.record), local: this.content(), memoryOnly: !!this.staged }; }

  private makeStatus(syncing: boolean, error?: unknown): DraftCopyStatus {
    error ??= this.syncError;
    return { sourceRevision: this.record.sourceRevision, expectedHeadRevision: this.record.expectedHeadRevision,
      dirty: !sameDraftContent(this.record.base, this.staged ?? this.record.local), pending: !!this.record.pending, syncing,
      memoryOnly: !!this.staged, rejected: !!this.record.rejected, forking: !!this.record.fork && !this.record.fork.result,
      recovering: !!this.record.recovery?.reviewRequired,
      discarding: !!this.record.discard || !!this.discardFlight || this.retired,
      ...(this.record.fork?.result ? { forkedTo: clone(this.record.fork.result) } : {}),
      ...(error || this.record.rejected ? { error: error ?? new Error(this.record.rejected!.message) } : {}) };
  }
  private publish(syncing = !!this.flight, error?: unknown) {
    this.status = this.makeStatus(syncing, error);
    for (const listener of this.listeners) listener();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.localQueue.then(work);
    this.localQueue = next.catch(() => undefined);
    return next;
  }
  private async commit(next: DraftCopyRecord) {
    next.epoch = this.record.epoch + 1;
    await this.store.compareAndSwap(next.key, this.record.epoch, next);
    this.record = clone(next);
    this.publish();
  }

  /** Persist first; a disk failure must not masquerade as an autosave. */
  checkpoint(content: DraftContent): Promise<void> {
    if (this.record.discard || this.discardFlight || this.retired) return Promise.reject(new Error('请先完成放弃本机修改操作'));
    const snapshot = draftContentSnapshot(content);
    this.staged = snapshot;
    this.publish(!!this.flight, this.status.error);
    return this.serial(async () => {
      if (!sameDraftContent(snapshot, this.record.local)) await this.commit({ ...this.record, local: snapshot });
      if (this.staged === snapshot) this.staged = undefined;
      this.publish();
    }).catch(error => { this.publish(!!this.flight, error); throw error; });
  }

  flush(summary: string): Promise<number> {
    if (this.record.discard || this.discardFlight || this.retired) return Promise.reject(new Error('请先完成放弃本机修改操作'));
    if (this.record.recovery?.reviewRequired) return Promise.reject(new Error('请先确认导入的恢复内容'));
    if (this.record.fork) return Promise.reject(new Error('请先完成本地修改另存操作'));
    if (this.flight) return this.flight;
    const run = this.flushPending(summary);
    this.flight = run;
    this.publish(true);
    void run.then(() => { this.flight = undefined; this.syncError = undefined; this.publish(false); }, error => {
      this.flight = undefined; this.syncError = error; this.publish(false, error);
    });
    return run;
  }

  private async flushPending(summary: string): Promise<number> {
    for (;;) {
      const request = await this.serial(async () => {
        if (this.staged) {
          const staged = this.staged;
          await this.commit({ ...this.record, local: staged });
          if (this.staged === staged) this.staged = undefined;
        }
        if (this.record.pending) return clone(this.record.pending);
        if (sameDraftContent(this.record.local, this.record.base)) return undefined;
        const pending: DraftSaveRequest = { ...clone(this.record.local), summary,
          requestId: crypto.randomUUID(), sourceRevision: this.record.sourceRevision,
          expectedHeadRevision: this.record.expectedHeadRevision };
        await this.commit({ ...this.record, pending });
        return clone(pending);
      });
      if (!request) return this.record.sourceRevision;
      let revision: Revision;
      try { ({ revision } = await this.send(clone(request))); }
      catch (error) {
        const status = (error as { status?: number } | null)?.status;
        if (status === 400 || status === 422) {
          await this.serial(async () => {
            if (this.record.pending?.requestId === request.requestId) await this.commit({ ...this.record, rejected: { requestId: request.requestId, status, message: error instanceof Error ? error.message : '草稿内容未通过校验' } });
          });
        }
        throw error;
      }
      // An acknowledgement from a different document is never allowed to advance this buffer.
      if (revision.sessionId !== this.record.identity.sessionId || revision.draftId !== this.record.identity.draftId
        || revision.revision !== request.expectedHeadRevision + 1 || revision.sourceRevision !== request.sourceRevision
        || !sameDraftContent(revision, request)) throw new Error('Invalid draft save acknowledgement');
      await this.serial(async () => {
        const record = { ...this.record };
        delete record.pending;
        delete record.rejected;
        await this.commit({ ...record, sourceRevision: revision.revision, expectedHeadRevision: revision.revision,
          base: clone({ canvas: revision.canvas, bindings: revision.bindings }) });
      });
    }
  }

  /** Only a definite validation rejection can be superseded; unknown submissions keep their original identity. */
  async repairRejected(summary: string): Promise<number> {
    if (this.record.discard || this.discardFlight || this.retired) throw new Error('请先完成放弃本机修改操作');
    if (this.flight) await this.flight.catch(() => undefined);
    await this.serial(async () => {
      const { pending, rejected } = this.record;
      if (!pending || rejected?.requestId !== pending.requestId) throw new Error('请先核对原保存结果');
      if (sameDraftContent(this.staged ?? this.record.local, pending)) throw new Error('请先修正草稿内容');
      const staged = this.staged;
      const next = { ...this.record, local: staged ?? this.record.local,
        rejectedRequests: [...(this.record.rejectedRequests ?? []), { request: pending, status: rejected.status, message: rejected.message }] };
      delete next.pending; delete next.rejected;
      await this.commit(next); if (this.staged === staged) this.staged = undefined; this.publish();
    });
    return this.flush(summary);
  }

  /** Isolate this editor's content instead of overwriting a newer checkpoint from another editor. */
  async isolateForFork(name: string): Promise<DraftCopyIdentity> {
    if (this.record.discard || this.discardFlight || this.retired) throw new Error('请先完成放弃本机修改操作');
    if (this.flight) await this.flight.catch(() => undefined);
    await this.localQueue;
    const identity = { ...this.record.identity, copyId: crypto.randomUUID() };
    const local = this.content();
    const record: DraftCopyRecord = { ...clone(this.record), key: draftCopyKey(identity), epoch: 1, identity, local,
      fork: { request: { ...local, requestId: crypto.randomUUID(), sourceRevision: this.record.sourceRevision, name } } };
    delete record.recovery;
    await this.store.compareAndSwap(record.key, undefined, record);
    return identity;
  }

  resumeFork(send: (request: DraftLocalForkRequest) => Promise<{ draft: Draft; revision: Revision }>): Promise<RevisionRef> {
    if (this.record.discard || this.discardFlight || this.retired) return Promise.reject(new Error('请先完成放弃本机修改操作'));
    if (this.record.recovery?.reviewRequired) return Promise.reject(new Error('请先确认导入的恢复内容'));
    if (this.forkFlight) return this.forkFlight;
    const run = this.serial(async () => {
      if (!this.record.fork) throw new Error('没有待完成的本地另存操作');
      if (this.record.fork.result) return clone(this.record.fork.result);
      const request = clone(this.record.fork.request);
      const { draft, revision } = await send(request);
      if (draft.sessionId !== this.record.identity.sessionId || revision.sessionId !== draft.sessionId || draft.id !== revision.draftId || revision.revision !== 1
        || draft.forkedFrom?.draftId !== this.record.identity.draftId || draft.forkedFrom.revision !== request.sourceRevision || !sameDraftContent(revision, request)) throw new Error('本地另存结果与原请求不一致');
      const result = { draftId: draft.id, revision: revision.revision };
      await this.commit({ ...this.record, fork: { request, result } });
      return result;
    });
    this.forkFlight = run;
    void run.then(() => { this.forkFlight = undefined; this.publish(); }, error => { this.forkFlight = undefined; this.publish(false, error); });
    return run;
  }

  /** Import never authorizes network writes. Only an explicit recovery action releases the local hold. */
  async confirmRecovery(): Promise<void> {
    await this.serial(async () => {
      if (this.record.recovery?.reviewRequired) await this.commit({ ...this.record, recovery: { ...this.record.recovery, reviewRequired: false } });
    });
  }

  /** Explicit destructive action: persist a hold before canceling uncertain requests, then adopt a verified server snapshot.
   * Retire this editor instance after success so a delayed autosave cannot restore its discarded canvas.
   */
  discardLocal(resolve: (record: DraftCopyRecord) => Promise<DraftDiscardResult>): Promise<DraftDiscardResult> {
    if (this.discardFlight) return this.discardFlight;
    if (this.retired) return Promise.reject(new Error('请重新打开草稿画布'));
    if (this.flight || this.forkFlight) return Promise.reject(new Error('请等待当前保存结束后再放弃修改'));
    const run = this.serial(async () => {
      const staged = this.staged;
      await this.commit({ ...this.record, local: staged ?? this.record.local,
        discard: this.record.discard ?? { requestedAt: Date.now() } });
      if (this.staged === staged) this.staged = undefined;
      const result = await resolve(clone(this.record));
      const { revision } = result;
      if (revision.sessionId !== this.record.identity.sessionId || revision.draftId !== this.record.identity.draftId
        || revision.revision < this.record.expectedHeadRevision) throw new Error('放弃修改的服务器核对结果不一致');
      const next = { ...this.record, sourceRevision: revision.revision, expectedHeadRevision: revision.revision,
        base: clone({ canvas: revision.canvas, bindings: revision.bindings }), local: clone({ canvas: revision.canvas, bindings: revision.bindings }),
        discarded: { at: Date.now(), ...(result.savedRevision ? { savedRevision: result.savedRevision } : {}), ...(result.forkedTo ? { forkedTo: result.forkedTo } : {}) } };
      delete next.pending; delete next.rejected; delete next.fork; delete next.recovery; delete next.discard;
      await this.commit(next);
      this.retired = true; this.syncError = undefined;
      return result;
    });
    this.discardFlight = run; this.publish();
    void run.then(() => { this.discardFlight = undefined; this.publish(); }, error => {
      this.discardFlight = undefined; this.syncError = error; this.publish(false, error);
    });
    return run;
  }
}
