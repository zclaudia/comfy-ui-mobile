import type { AgentEvent, AgentTask, AgentMediaRef, PreviewPolicy, SourceRef } from '../../infrastructure/api/AgentApi';
import type { IComfyJson } from './app/IComfyJson';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export interface Page<T> { items: T[]; nextCursor?: number }
export interface RevisionRef { draftId: string; revision: number }
export interface RequestContext {
  targetDraftId?: string; sourceRevision?: number; selectedAssetIds?: string[]; replyToEventSeq?: number;
  action?: 'edit_source' | 'use_reference' | 'generate_video' | 'rerun' | 'fork';
}
export interface WorkspaceSession {
  id: string; name: string; created: number; schemaVersion: 2; defaultContext?: RequestContext; previewPolicy?: PreviewPolicy; archivedAt?: number; deletedAt?: number;
  lastActivity?: number; lastMessage?: string; preview?: string; active?: boolean; lastState?: string; thumbnailAssetId?: string;
}
export interface Draft {
  id: string; sessionId: string; name: string; headRevision: number; outputKinds: MediaKind[]; created: number; updated: number;
  archivedAt?: number; forkedFrom?: RevisionRef; sourceRef?: SourceRef;
  latestRun?: Run;
  lastLibrarySave?: { opId: string; draftId: string; revision: number; revisionDigest: string; exportGraphHash: string; serverId: string; workflowId: string; filename: string; name: string; etag: string; at: number };
}
export interface AssetBinding { id: string; nodeId: string; inputName: string; role: string; assetId: string }
export interface Revision extends RevisionRef {
  sessionId: string; canvas: IComfyJson; bindings: AssetBinding[]; digest: string; summary: string;
  sourceRevision?: number; previousHeadRevision?: number; createdByTaskId?: string; created: number; retained?: boolean;
}
export interface WorkspaceLibraryOperation extends RevisionRef {
  id: string; sessionId: string; revisionDigest: string; requestDigest: string;
  mode: 'create' | 'update'; state: 'pending' | 'applying' | 'reconciling' | 'succeeded' | 'conflict' | 'failed';
  target: { serverId: string; workflowId: string; filename: string; name: string; expectedEtag?: string };
  content?: IComfyJson; contentDigest?: string; exportGraphHash?: string;
  inputManifest?: Run['inputManifest']; startedBy: string; created: number; updated: number;
  result?: { etag?: string; error?: string };
}
export interface WorkspaceLibraryIntent {
  requestId: string; revision: number; mode: 'create' | 'update'; target: WorkspaceLibraryOperation['target']; startedBy: string;
}
export interface Asset {
  id: string; sessionId: string; kind: MediaKind; name: string; origin: 'generated' | 'uploaded'; sourceRunId?: string; sourceMessageSeq?: number;
  displayOrdinal: number; captureState: 'pending_capture' | 'capturing' | 'ready' | 'missing' | 'capture_failed' | 'remote_only'; blobDigest?: string;
  metadata: { mediaType?: string; size?: number; width?: number; height?: number; duration?: number }; created: number; captured?: number; error?: string;
}
export interface Run extends RevisionRef {
  id: string; sessionId: string; taskId?: string; generation?: number;
  state: 'preparing' | 'awaiting_approval' | 'submitting' | 'reconciling' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  promptId?: string; outputAssetIds: string[]; outputCount?: number; inputs?: { bindingId: string; assetId: string }[];
  inputManifest?: { bindingId: string; assetId: string; blobDigest: string; serverId: string; materializedRef: AgentMediaRef }[];
  approvalDigest?: string; approvedAt?: number; created: number; submitted?: number; completed?: number; outputsIncomplete?: boolean; diagnostic?: unknown;
  preview?: { width?: number; height?: number; frames?: number; fps?: number };
}
export interface Selection {
  id: string; sessionId: string; taskId: string; requestId: string; question: string;
  candidates: ({ type: 'asset'; assetId: string } | { type: 'draft'; draftId: string; revision?: number })[];
  multiple: boolean; state: 'pending' | 'answered' | 'cancelled'; selectedIndices?: number[]; answer?: string; created: number;
}
export interface WorkspaceTask extends AgentTask {
  sessionId: string; previews: number;
  workspace?: { schemaVersion: 2; requestContext: RequestContext; directRun?: true; resolvedTargets?: RequestContext; activeRunId?: string;
    waitingReason?: { type: 'selection'; questionId: string } | { type: 'preview_approval'; runId: string } };
}
export interface WorkspaceSnapshot {
  session: WorkspaceSession; drafts: Page<Draft>; runs: Page<Run>; tasks: WorkspaceTask[]; questions: Selection[];
  events: AgentEvent[]; cursor: number; highWater: number; hasMore: boolean;
}
export interface AssetDetail { asset: Asset; sourceRun: Run | null; previewRef?: AgentMediaRef & { serverId: string } }

export interface WorkspaceCleanupPlan {
  sessionId: string; serverId: string; token: string;
  total: { drafts: number; revisions: number; runs: number; assets: number; messages: number };
  retained: WorkspaceCleanupPlan['total'];
  reclaimableBytes: number; retainedBytes: number; missingBlobs: number; unknownBlobs: number;
  libraries: { name: string; filename: string; serverId: string }[]; blockers: string[];
}
export interface WorkspaceCleanupOperation {
  requestId: string; sessionId: string; state: 'deleting_files' | 'completed'; plan: WorkspaceCleanupPlan;
  files: { digest: string; state: 'pending' | 'removed' | 'missing' | 'protected' | 'failed'; bytes: number; error?: string }[];
  created: number; completed?: number;
}
