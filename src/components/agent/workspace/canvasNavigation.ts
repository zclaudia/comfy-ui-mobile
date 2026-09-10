import type { RevisionRef } from '../../../shared/types/agentWorkspace';
import type { DraftCopyIdentity } from '../../../infrastructure/storage/DraftWorkingCopy';

export const workspaceCanvasPath = (sessionId: string, ref: RevisionRef, copyId?: string) => `/chat/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(ref.draftId)}/canvas?revision=${ref.revision}${copyId ? `&copy=${encodeURIComponent(copyId)}` : ''}`;
export const workspaceRecoveryChatPath = (sessionId: string, identity: DraftCopyIdentity, sourceRevision: number) =>
  `/chat/${encodeURIComponent(sessionId)}?${new URLSearchParams({ targetDraft: identity.draftId, sourceRevision: String(sourceRevision), localOpenedRevision: String(identity.openedRevision), ...(identity.copyId ? { localCopy: identity.copyId } : {}) })}`;
export function recoveryCanvasPath(sessionId: string, params: URLSearchParams) {
  const draftId = params.get('resumeDraft'); const revision = Number(params.get('resumeRevision')); const copyId = params.get('resumeCopy') ?? undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return draftId && uuid.test(draftId) && Number.isSafeInteger(revision) && revision > 0 && (!copyId || uuid.test(copyId)) ? workspaceCanvasPath(sessionId, { draftId, revision }, copyId) : null;
}
