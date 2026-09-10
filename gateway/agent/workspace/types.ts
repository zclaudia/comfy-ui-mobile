import type { Canvas } from '../../workflow/canvas.js';
import type { Prompt } from '../../workflow/engine.js';
import type { MediaRef, PreviewPolicy, SourceRef, LibrarySaveState } from '../store.js';

export const WORKSPACE_SCHEMA_VERSION = 2;
export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export interface RevisionRef { draftId: string; revision: number }
export interface RequestContext {
  targetDraftId?: string;
  sourceRevision?: number;
  selectedAssetIds?: string[];
  replyToEventSeq?: number;
  action?: 'edit_source' | 'use_reference' | 'generate_video' | 'rerun' | 'fork';
}
export interface WorkspaceTaskState {
  schemaVersion: 2; requestContext: RequestContext;
  /** Explicit canvas/result action; completion never resumes the language model. */
  directRun?: true;
  resolvedTargets?: RequestContext;
  activeRunId?: string;
  waitingReason?: { type: 'selection'; questionId: string } | { type: 'preview_approval'; runId: string };
}
export interface WorkspaceSession {
  id: string; owner: string; name: string; created: number; schemaVersion: 2;
  defaultContext?: RequestContext; previewPolicy?: PreviewPolicy; archivedAt?: number; deletedAt?: number;
}
export interface AssetBinding { id: string; nodeId: string; inputName: string; role: string; assetId: string }
export interface Draft {
  id: string; sessionId: string; name: string; headRevision: number; outputKinds: MediaKind[];
  created: number; updated: number; archivedAt?: number; forkedFrom?: RevisionRef; sourceRef?: SourceRef;
  legacy?: boolean; lastLibrarySave?: DraftLibrarySave;
}
export interface Revision extends RevisionRef {
  sessionId: string; canvas: Canvas; bindings: AssetBinding[]; digest: string; summary: string;
  sourceRevision?: number; previousHeadRevision?: number; createdByTaskId?: string; created: number;
  retained?: boolean;
}
export interface InputManifestEntry {
  bindingId: string; assetId: string; blobDigest: string; serverId: string;
  materializedRef: MediaRef & { type: 'input' };
}
export interface ExecutionSnapshot { prompt: Prompt; canvas: Canvas; environment: Record<string, unknown> }
export type RunState = 'preparing' | 'awaiting_approval' | 'submitting' | 'reconciling' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Run extends RevisionRef {
  id: string; sessionId: string; taskId?: string; operationId?: string; serverId: string; generation?: number;
  state: RunState; submissionKey: string; promptId?: string; inputManifest: InputManifestEntry[];
  executionSnapshot?: ExecutionSnapshot; approvalDigest?: string; approvedAt?: number;
  outputAssetIds: string[]; outputsIncomplete?: boolean; rawOutputs?: unknown;
  created: number; submitted?: number; completed?: number; diagnostic?: unknown;
  legacy?: { incomplete: boolean; eventSeqs: number[]; attemptId?: string };
}
/** Events and model state carry identities and progress; full execution snapshots are fetched on demand. */
export function runSummary(run: Run) {
  const prompt = Object.values(run.executionSnapshot?.prompt ?? {});
  const dimensions = prompt.find(node => typeof node.inputs.width === 'number' && typeof node.inputs.height === 'number')?.inputs;
  const frames = prompt.find(node => typeof node.inputs.length === 'number')?.inputs.length;
  const fps = prompt.find(node => node.class_type === 'CreateVideo')?.inputs.fps;
  return { id: run.id, sessionId: run.sessionId, taskId: run.taskId, draftId: run.draftId, revision: run.revision, generation: run.generation,
    ...(dimensions || frames || fps ? { preview: { width: dimensions?.width, height: dimensions?.height, frames, fps } } : {}),
    state: run.state, promptId: run.promptId, outputAssetIds: run.outputAssetIds.slice(0, 16), outputCount: run.outputAssetIds.length,
    inputs: run.inputManifest.map(input => ({ bindingId: input.bindingId, assetId: input.assetId })),
    approvalDigest: run.approvalDigest, approvedAt: run.approvedAt, created: run.created, submitted: run.submitted, completed: run.completed,
    ...(run.legacy ? { legacy: { incomplete: run.legacy.incomplete, eventSeqs: run.legacy.eventSeqs } } : {}),
    outputsIncomplete: run.outputsIncomplete, diagnostic: typeof run.diagnostic === 'string' ? run.diagnostic.slice(0, 1000) : run.diagnostic ? JSON.stringify(run.diagnostic).slice(0, 1000) : undefined };
}
export type CaptureState = 'pending_capture' | 'capturing' | 'ready' | 'missing' | 'capture_failed' | 'remote_only';
export interface Asset {
  id: string; sessionId: string; kind: MediaKind; name: string; origin: 'generated' | 'uploaded';
  sourceRunId?: string; outputLocator?: string; sourceMessageSeq?: number;
  displayOrdinal: number; captureState: CaptureState; blobDigest?: string;
  metadata: { mediaType?: string; size?: number; width?: number; height?: number; duration?: number };
  created: number; captured?: number; error?: string;
  legacy?: { resultSeq?: number; outputIndex?: number; unverified: boolean };
}
export interface AssetLocation {
  id: string; assetId: string; serverId: string; role: 'source' | 'input'; ref: MediaRef;
  verifiedDigest?: string; verifiedAt?: number; unavailableAt?: number;
}
export interface Materialization {
  assetId: string; blobDigest: string; serverId: string; loaderKind: string;
  state: 'pending' | 'preparing' | 'ready' | 'failed'; ref?: MediaRef & { type: 'input' }; error?: string; updated: number;
}
export type OperationKind = 'create_workflow' | 'edit_workflow' | 'fork_workflow' | 'replace_workflow_template' | 'restore_workflow' | 'submit_preview';
export interface OperationPlan { stepKey: string; kind: OperationKind; targetDraftId?: string; dependsOn?: string[]; repairOf?: string }
export interface Operation extends OperationPlan {
  id: string; sessionId: string; taskId: string; dependsOn: string[];
  state: 'planned' | 'running' | 'completed' | 'failed'; requestDigest?: string; result?: unknown; error?: string; created: number;
}
export interface Selection {
  id: string; sessionId: string; taskId: string; requestId: string; question: string;
  candidates: ({ type: 'asset'; assetId: string } | { type: 'draft'; draftId: string; revision?: number })[];
  state: 'pending' | 'answered' | 'cancelled'; multiple: boolean; selectedIndices?: number[]; answer?: string; created: number; answeredAt?: number;
}
export interface DraftLibrarySave {
  opId: string; draftId: string; revision: number; revisionDigest: string; exportGraphHash: string;
  serverId: string; workflowId: string; filename: string; name: string; etag: string; at: number;
}
export interface LibrarySaveOperation {
  id: string; sessionId: string; draftId: string; revision: number; revisionDigest: string; exportGraphHash?: string;
  requestDigest: string; contentDigest?: string; content?: Canvas; inputManifest?: InputManifestEntry[];
  mode: 'create' | 'update'; state: LibrarySaveState;
  target: { serverId: string; workflowId: string; filename: string; name: string; expectedEtag?: string };
  startedBy: string; created: number; updated: number; result?: { etag?: string; error?: string };
}
export interface Page<T> { items: T[]; nextCursor?: number }
