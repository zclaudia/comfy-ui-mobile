import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canvasToPrompt, promptToCanvas } from '../../gateway/workflow/canvas';
import type { ObjectInfo } from '../../gateway/workflow/engine';
import { createModelWorkflow } from '../../gateway/agent/modelProfiles';
import { readFormSpec, writeFormSpec } from '@/shared/utils/mobileForm';
import type { MobileFormSpec } from '@/shared/types/app/IMobileForm';

const spec: MobileFormSpec = {
  version: 1,
  mode: 'custom',
  sections: [{
    id: 'group:1',
    title: 'Prompt',
    fields: [{
      id: 'f1',
      target: { nodeId: 5, widget: 'text', nodeType: 'CLIPTextEncode' },
      linked: [{ nodeId: 6, widget: 'text', nodeType: 'CLIPTextEncode' }],
      control: 'textarea',
    }],
  }],
  updatedAt: '2026-09-11T00:00:00.000Z',
};

const objectInfo = (): ObjectInfo =>
  JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));

// A real, executable draft rather than a hand-written canvas: the codec
// validates every value it round-trips.
const canvasFixture = () => createModelWorkflow(objectInfo(), { profileId: 'z-image-turbo', text: 'cat' }) as any;

test('the agent canvas codec carries the form spec through a prompt round trip', () => {
  // The chat draft path is canvas -> prompt -> canvas. The spec lives in
  // `extra`, which promptToCanvas clones rather than rebuilds; this is the
  // guarantee that a form survives being edited from a conversation.
  const info = objectInfo();
  const canvas = writeFormSpec(canvasFixture(), spec);
  const patched = promptToCanvas(canvas, canvasToPrompt(canvas, info), info);

  const restored = readFormSpec(patched);
  assert.equal(restored?.mode, 'custom');
  assert.equal(restored?.sections[0].title, 'Prompt');
  assert.deepEqual(restored?.sections[0].fields[0].linked, [{ nodeId: 6, widget: 'text', nodeType: 'CLIPTextEncode' }]);
});

test('a workflow with no form spec still round-trips, and gains none by accident', () => {
  const info = objectInfo();
  const canvas = canvasFixture();
  const patched = promptToCanvas(canvas, canvasToPrompt(canvas, info), info);
  assert.equal(readFormSpec(patched), null);
});

test('writing a spec leaves the rest of extra, including cloud identity, untouched', () => {
  const canvas = canvasFixture();
  canvas.extra = { ...(canvas.extra || {}), comfy_mobile_cloud: { schema: 1, workflow_id: 'abc' }, ds: { scale: 0.8 } };
  const written = writeFormSpec(canvas, spec);

  assert.deepEqual(written.extra.comfy_mobile_cloud, { schema: 1, workflow_id: 'abc' });
  assert.deepEqual(written.extra.ds, { scale: 0.8 });
  assert.equal(readFormSpec(written)?.sections.length, 1);
});
