import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryCanvasPath, workspaceRecoveryChatPath } from '../../src/components/agent/workspace/canvasNavigation';

test('local recovery navigation retains opened version and isolated copy separately from the saved chat version', () => {
  const draftId = 'a8af9d6c-cdb7-42fc-97fa-7bd04e803956'; const copyId = 'a6ee03fb-812c-433e-9c62-ba5916918540';
  const url = new URL(workspaceRecoveryChatPath('session', { serverId: 'server', sessionId: 'session', draftId, openedRevision: 2, copyId }, 6), 'https://local.invalid');
  assert.equal(url.searchParams.get('sourceRevision'), '6'); assert.equal(url.searchParams.get('localOpenedRevision'), '2');
  assert.equal(url.searchParams.get('localCopy'), copyId);
  const query = new URLSearchParams({ resumeDraft: draftId, resumeRevision: '2', resumeCopy: copyId });
  assert.equal(recoveryCanvasPath('session', query), `/chat/session/drafts/${draftId}/canvas?revision=2&copy=${copyId}`);
  for (const [key, value] of [['resumeDraft', '../foreign'], ['resumeRevision', '0'], ['resumeRevision', '1.5'], ['resumeCopy', 'https://foreign.invalid']] as const) {
    const invalid = new URLSearchParams(query); invalid.set(key, value); assert.equal(recoveryCanvasPath('session', invalid), null);
  }
});
