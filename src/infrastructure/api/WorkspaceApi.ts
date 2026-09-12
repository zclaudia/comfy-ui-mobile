import { AgentTransport } from './AgentApi';
import type { AgentAttachment, SourceRef } from './AgentApi';
import type { Asset, AssetBinding, AssetDetail, Draft, MediaKind, Page, RequestContext, Revision, Run, Selection, WorkspaceSession, WorkspaceSnapshot } from '../../shared/types/agentWorkspace';
import type { IComfyJson } from '../../shared/types/app/IComfyJson';
import type { WorkspaceCleanupPlan, WorkspaceCleanupOperation, WorkspaceLibraryIntent, WorkspaceLibraryOperation } from '../../shared/types/agentWorkspace';
import type { DraftDiscardResult, DraftLocalForkRequest, DraftSaveRequest } from '../storage/DraftWorkingCopy';

const segment = encodeURIComponent;
const sessionPath = (id: string) => `/sessions/${segment(id)}`;
const query = (values: object) => { const entries = Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]); return entries.length ? `?${new URLSearchParams(entries)}` : ''; };
export class WorkspaceApi extends AgentTransport {
  constructor(baseUrl: string, expectedServerId?: string) { super(baseUrl, 2, expectedServerId); }
  sessions(options: { before?: number; limit?: number; archived?: boolean; search?: string } = {}, signal?: AbortSignal) { return this.request<Page<WorkspaceSession>>(`/sessions${query(options)}`, {}, signal); }
  create(name: string) { return this.request<{ session: WorkspaceSession }>('/sessions', { body: { name } }); }
  update(id: string, patch: { name?: string; previewPolicy?: 'auto' | 'confirm'; archivedAt?: number | null }) { return this.request<{ session: WorkspaceSession }>(sessionPath(id), { method: 'PATCH', body: patch }); }
  cleanupPreview(id: string, signal?: AbortSignal) { return this.request<{ plan: WorkspaceCleanupPlan; operation?: WorkspaceCleanupOperation }>(`${sessionPath(id)}/cleanup`, {}, signal); }
  cleanupExecute(id: string, requestId: string, planToken: string) { return this.request<{ operation: WorkspaceCleanupOperation }>(`${sessionPath(id)}/cleanup`, { body: { requestId, planToken, confirm: 'delete-chat' } }, undefined, 120_000); }
  snapshot(id: string, after = 0, signal?: AbortSignal) { return this.request<WorkspaceSnapshot>(`${sessionPath(id)}?after=${after}`, {}, signal, 15_000); }
  message(id: string, message: string, requestId: string, context: RequestContext) { return this.request<{ taskId: string; state: string }>(`${sessionPath(id)}/messages`, { body: { message, requestId, context } }); }
  cancel(id: string, taskId: string) { return this.request(`${sessionPath(id)}/cancel`, { body: { taskId } }); }
  drafts(id: string, options: { before?: number; limit?: number; archived?: boolean; kind?: MediaKind; name?: string } = {}, signal?: AbortSignal) { return this.request<Page<Draft>>(`${sessionPath(id)}/drafts${query(options)}`, {}, signal); }
  draft(id: string, draftId: string, signal?: AbortSignal) { return this.request<{ draft: Draft }>(`${sessionPath(id)}/drafts/${segment(draftId)}`, {}, signal); }
  updateDraft(id: string, draftId: string, patch: { name?: string; archivedAt?: number | null }) { return this.request<{ draft: Draft }>(`${sessionPath(id)}/drafts/${segment(draftId)}`, { method: 'PATCH', body: patch }); }
  beginLibrarySave(id: string, draftId: string, intent: WorkspaceLibraryIntent) { return this.request<{ operation: WorkspaceLibraryOperation }>(`${sessionPath(id)}/drafts/${segment(draftId)}/library-saves`, { body: intent }); }
  currentLibrarySave(id: string, signal?: AbortSignal) { return this.request<{ operation: WorkspaceLibraryOperation | null }>(`${sessionPath(id)}/library-saves`, {}, signal); }
  librarySave(id: string, operationId: string) { return this.request<{ operation: WorkspaceLibraryOperation }>(`${sessionPath(id)}/library-saves/${segment(operationId)}`); }
  librarySaveAction(id: string, operationId: string, action: 'prepare' | 'applying' | 'reconcile' | 'cancel') { return this.request<{ operation: WorkspaceLibraryOperation }>(`${sessionPath(id)}/library-saves/${segment(operationId)}/${action}`, { body: {} }, undefined, 120_000); }
  importDraft(id: string, name: string, canvas: IComfyJson, bindings: AssetBinding[], requestId: string, sourceRef?: SourceRef) { return this.request<{ draft: Draft; revision: Revision }>(`${sessionPath(id)}/drafts`, { body: { source: 'canvas', name, canvas, bindings, requestId, ...(sourceRef ? { sourceRef } : {}) } }); }
  revisions(id: string, draftId: string, options: { before?: number; limit?: number } = {}, signal?: AbortSignal) { return this.request<Page<Omit<Revision, 'canvas'>>>(`${sessionPath(id)}/drafts/${segment(draftId)}/versions${query(options)}`, {}, signal); }
  revision(id: string, draftId: string, revision: number, signal?: AbortSignal) { return this.request<Revision>(`${sessionPath(id)}/drafts/${segment(draftId)}/versions/${revision}`, {}, signal); }
  saveRevision(id: string, draftId: string, input: { requestId: string; expectedHeadRevision: number; sourceRevision: number; canvas: IComfyJson; bindings: AssetBinding[]; summary: string }) { return this.request<{ revision: Revision }>(`${sessionPath(id)}/drafts/${segment(draftId)}/versions`, { body: input }); }
  discardLocal(id: string, draftId: string, input: { pending?: DraftSaveRequest; fork?: DraftLocalForkRequest }) { return this.request<DraftDiscardResult>(`${sessionPath(id)}/drafts/${segment(draftId)}/discard-local`, { body: input }); }
  restore(id: string, draftId: string, sourceRevision: number, expectedHeadRevision: number, requestId: string) { return this.request<{ revision: Revision }>(`${sessionPath(id)}/drafts/${segment(draftId)}/restore`, { body: { sourceRevision, expectedHeadRevision, requestId } }); }
  fork(id: string, draftId: string, sourceRevision: number, name: string, requestId: string) { return this.request<{ draft: Draft; revision: Revision }>(`${sessionPath(id)}/drafts/${segment(draftId)}/fork`, { body: { sourceRevision, name, requestId } }); }
  forkLocal(id: string, draftId: string, input: { requestId: string; sourceRevision: number; name: string; canvas: IComfyJson; bindings: AssetBinding[] }) { return this.request<{ draft: Draft; revision: Revision }>(`${sessionPath(id)}/drafts/${segment(draftId)}/fork-local`, { body: input }); }
  assets(id: string, options: { before?: number; limit?: number; kind?: MediaKind; runId?: string; draftId?: string } = {}, signal?: AbortSignal) { return this.request<Page<Asset>>(`${sessionPath(id)}/assets${query(options)}`, {}, signal); }
  asset(id: string, assetId: string, signal?: AbortSignal) { return this.request<AssetDetail>(`${sessionPath(id)}/assets/${segment(assetId)}`, {}, signal); }
  assetLibraryUses(id: string, assetId: string, before?: number, signal?: AbortSignal) { return this.request<Page<{ id: string; serverId: string; workflowId: string; saves: { operationId: string; filename: string; name: string; revision: number; state: WorkspaceLibraryOperation['state'] }[] }>>(`${sessionPath(id)}/assets/${segment(assetId)}/library-uses${query({ before, limit: 30 })}`, {}, signal); }
  assetUses(id: string, assetId: string, before?: number, signal?: AbortSignal) { return this.request<Page<{ id: string; draftId: string; revision: number; bindingId: string; draftName: string; headRevision: number }>>(`${sessionPath(id)}/assets/${segment(assetId)}/uses${query({ before, limit: 30 })}`, {}, signal); }
  registerAsset(id: string, file: AgentAttachment, requestId: string) { return this.request<{ asset: Asset }>(`${sessionPath(id)}/assets`, { body: { requestId, file } }); }
  assetUrl(id: string, assetId: string) { return `${this.baseUrl}/api/gateway/agent${sessionPath(id)}/assets/${segment(assetId)}/content`; }
  runs(id: string, options: { before?: number; limit?: number; draftId?: string } = {}, signal?: AbortSignal) { return this.request<Page<Run>>(`${sessionPath(id)}/runs${query(options)}`, {}, signal); }
  generate(id: string, draftId: string, revision: number, requestId: string) { return this.request<{ taskId: string; state: string; runId: string }>(`${sessionPath(id)}/runs`, { body: { draftId, revision, requestId } }); }
  run(id: string, runId: string, signal?: AbortSignal) { return this.request<{ run: Run }>(`${sessionPath(id)}/runs/${segment(runId)}`, {}, signal); }
  runAssets(id: string, runId: string, after?: number, signal?: AbortSignal) { return this.request<Page<Asset>>(`${sessionPath(id)}/runs/${segment(runId)}/assets${query({ after, limit: 20 })}`, {}, signal); }
  approve(id: string, taskId: string, runId: string, approvalDigest: string, approved: boolean) { return this.request<{ run: Run }>(`${sessionPath(id)}/approve`, { body: { taskId, runId, approvalDigest, approved } }); }
  answer(id: string, questionId: string, taskId: string, selectedIndices: number[], answer?: string) { return this.request<{ selection: Selection }>(`${sessionPath(id)}/selections/${segment(questionId)}/answer`, { body: { taskId, selectedIndices, ...(answer ? { answer } : {}) } }); }
}
