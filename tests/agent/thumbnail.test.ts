import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailKind } from '../../src/components/agent/binding';

test('thumbnailKind trusts the gateway kind and otherwise reads the extension', () => {
  assert.equal(thumbnailKind({ filename: 'x.bin', subfolder: '', type: 'output', kind: 'video' }), 'video');
  assert.equal(thumbnailKind({ filename: 'clip.MP4', subfolder: '', type: 'output' }), 'video');
  assert.equal(thumbnailKind({ filename: 'voice.wav', subfolder: '', type: 'output' }), 'audio');
  assert.equal(thumbnailKind({ filename: 'frame.png', subfolder: '', type: 'output' }), 'image');
});
