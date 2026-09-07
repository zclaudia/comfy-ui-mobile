import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENTS, attachmentKind, formatBytes, rejectReason } from '../../src/components/agent/attachments';

test('attachmentKind uses the MIME type and falls back to the extension', () => {
  assert.equal(attachmentKind({ name: 'a.bin', type: 'image/png' }), 'image');
  assert.equal(attachmentKind({ name: 'IMG_0001.HEIC', type: '' }), 'image');
  assert.equal(attachmentKind({ name: 'clip.mov', type: '' }), 'video');
  assert.equal(attachmentKind({ name: 'voice.m4a' }), 'audio');
  assert.equal(attachmentKind({ name: 'notes.txt', type: 'text/plain' }), 'file');
});

test('rejectReason enforces the count, size and media-type limits', () => {
  assert.equal(rejectReason({ name: 'a.png', size: 10, type: 'image/png' }, 0), null);
  assert.equal(rejectReason({ name: 'a.png', size: 10, type: 'image/png' }, MAX_ATTACHMENTS), '最多添加 {{count}} 个附件');
  assert.equal(rejectReason({ name: 'a.png', size: 201 * 1024 * 1024, type: 'image/png' }, 0), '文件过大，单个附件不能超过 200MB');
  assert.equal(rejectReason({ name: 'a.pdf', size: 10, type: 'application/pdf' }, 0), '仅支持图片、视频和音频');
});

test('formatBytes picks a readable unit', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024 + 200_000), '3.2 MB');
});
