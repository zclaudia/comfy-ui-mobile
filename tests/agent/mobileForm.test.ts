import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTargetToSpec,
  applyLinkedFields,
  canLinkTargets,
  clearFormSpec,
  DEFAULT_SECTION_ID,
  findFieldForTarget,
  linkTargetToField,
  moveField,
  normalizeFormSpec,
  pruneBrokenFields,
  readFormSpec,
  removeField,
  removeSection,
  resolveField,
  resolveSpec,
  resolveTarget,
  unlinkTargetFromField,
  usableFieldCount,
  writeFieldValue,
  writeFormSpec,
} from '@/shared/utils/mobileForm';
import type { MobileFormSpec } from '@/shared/types/app/IMobileForm';
import { makeGraph, makeValueLayer, wanLikeGraph } from '../fixtures/formGraph';

const spec = (fields: any[]): MobileFormSpec => ({
  version: 1,
  mode: 'custom',
  sections: [{ id: 's1', title: 'Section', fields }],
  updatedAt: '2026-09-11T00:00:00.000Z',
});

test('the spec round-trips through extra, where a desktop ComfyUI save preserves it', () => {
  const source = spec([{ id: 'f1', target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' } }]);
  const json = writeFormSpec({ nodes: [], extra: { ds: { scale: 1 } } } as any, source);

  assert.deepEqual((json as any).extra.ds, { scale: 1 }, 'unrelated extra keys survive the write');
  assert.equal(readFormSpec(json)?.sections[0].fields[0].target.widget, 'steps');
  assert.equal(readFormSpec(clearFormSpec(json)), null);
  assert.equal(readFormSpec({ nodes: [] }), null, 'a workflow without a spec reads as null');
});

test('a spec from a newer version or a corrupt one is refused rather than half-read', () => {
  assert.equal(normalizeFormSpec({ version: 2, sections: [] }), null);
  assert.equal(normalizeFormSpec({ version: 1, sections: 'nope' }), null);
  assert.equal(normalizeFormSpec(null), null);
  assert.equal(normalizeFormSpec({ version: 1, sections: [] })?.mode, 'auto');
});

test('parsing drops unusable fields and self-referential links instead of throwing', () => {
  const parsed = normalizeFormSpec({
    version: 1,
    mode: 'custom',
    sections: [{
      id: 's1',
      title: 'x',
      fields: [
        { id: 'ok', target: { nodeId: 4, widget: 'steps', nodeType: 'K' }, linked: [
          { nodeId: 4, widget: 'steps', nodeType: 'K' },   // itself
          { nodeId: 5, widget: 'steps', nodeType: 'K' },
          { nodeId: 5, widget: 'steps', nodeType: 'K' },   // duplicate
        ] },
        { id: 'bad', target: { nodeId: 'x', widget: '' } },
        { id: 'bad2' },
      ],
    }],
  });
  const fields = parsed!.sections[0].fields;
  assert.equal(fields.length, 1, 'fields without a resolvable target are dropped');
  assert.deepEqual(fields[0].linked, [{ nodeId: 5, widget: 'steps', nodeType: 'K' }]);
});

test('a target resolves only when its node, type, widget and free input all hold', () => {
  const graph = wanLikeGraph();
  assert.equal(resolveTarget(graph, { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' }).value, 20);
  assert.equal(resolveTarget(graph, { nodeId: 99, widget: 'steps', nodeType: 'K' }).problem, 'missing-node');
  assert.equal(resolveTarget(graph, { nodeId: 4, widget: 'steps', nodeType: 'KSampler' }).problem, 'type-changed');
  assert.equal(resolveTarget(graph, { nodeId: 4, widget: 'nope', nodeType: 'KSamplerAdvanced' }).problem, 'missing-widget');

  const wired = makeGraph([{ id: 1, type: 'N', widgets: [{ name: 'text' }], connected: ['text'] }]);
  assert.equal(resolveTarget(wired, { nodeId: 1, widget: 'text', nodeType: 'N' }).problem, 'connected');
});

test('a resolved value reads through unsaved edits, not just the stored widget', () => {
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  values.set(4, 'steps', 30);
  const resolved = resolveTarget(graph, { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' }, values.get);
  assert.equal(resolved.value, 30);
});

test('a linked field reports inconsistency instead of silently overwriting a deliberate difference', () => {
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  const field = {
    id: 'f1',
    target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' },
    linked: [{ nodeId: 5, widget: 'steps', nodeType: 'KSamplerAdvanced' }],
  };

  assert.equal(resolveField(graph, field, values.get).inconsistent, false);
  values.set(5, 'steps', 25);
  const drifted = resolveField(graph, field, values.get);
  assert.equal(drifted.inconsistent, true);
  assert.equal(drifted.usable, true, 'an inconsistent field is still usable');
});

test('writing a linked field fans out to every resolvable target and skips the broken ones', () => {
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  const field = {
    id: 'f1',
    target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' },
    linked: [
      { nodeId: 5, widget: 'steps', nodeType: 'KSamplerAdvanced' },
      { nodeId: 99, widget: 'steps', nodeType: 'KSamplerAdvanced' },
    ],
  };
  const written = writeFieldValue(graph, field, 12, values.set);
  assert.deepEqual(written.map((target) => target.nodeId), [4, 5]);
  assert.equal(values.get(4, 'steps', null), 12);
  assert.equal(values.get(5, 'steps', null), 12);
});

test('linked fields are re-unified before execution, which is what keeps paired seeds equal', () => {
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  const linkedSpec = spec([{
    id: 'seed',
    target: { nodeId: 4, widget: 'noise_seed', nodeType: 'KSamplerAdvanced' },
    linked: [{ nodeId: 5, widget: 'noise_seed', nodeType: 'KSamplerAdvanced' }],
  }]);

  // autoChangeSeed randomizes each seed widget independently.
  values.set(4, 'noise_seed', 111);
  values.set(5, 'noise_seed', 222);
  assert.equal(applyLinkedFields(graph, linkedSpec, values.get, values.set), 1);
  assert.equal(values.get(5, 'noise_seed', null), 111);
  assert.equal(applyLinkedFields(graph, linkedSpec, values.get, values.set), 0, 'a second pass writes nothing');
});

test('linking is refused when the two widgets would not accept the same value', () => {
  const graph = wanLikeGraph();
  const at = (nodeId: number, widget: string, nodeType: string) => resolveTarget(graph, { nodeId, widget, nodeType });
  const steps4 = at(4, 'steps', 'KSamplerAdvanced');

  assert.deepEqual(canLinkTargets(steps4, at(5, 'steps', 'KSamplerAdvanced')), { ok: true });
  assert.equal(canLinkTargets(steps4, steps4).ok, false);
  assert.equal((canLinkTargets(steps4, at(4, 'cfg', 'KSamplerAdvanced')) as any).reason, 'type-mismatch');
  assert.equal((canLinkTargets(steps4, at(99, 'steps', 'K')) as any).reason, 'unresolved');

  const combos = makeGraph([
    { id: 1, type: 'A', widgets: [{ name: 'm', type: 'COMBO', value: 'x', options: { values: ['x', 'y'] } }] },
    { id: 2, type: 'B', widgets: [{ name: 'm', type: 'COMBO', value: 'z', options: { values: ['z'] } }] },
    { id: 3, type: 'C', widgets: [{ name: 'm', type: 'COMBO', value: 'y', options: { values: ['y', 'q'] } }] },
  ]);
  const first = resolveTarget(combos, { nodeId: 1, widget: 'm', nodeType: 'A' });
  assert.equal((canLinkTargets(first, resolveTarget(combos, { nodeId: 2, widget: 'm', nodeType: 'B' })) as any).reason, 'options-mismatch');
  assert.equal(canLinkTargets(first, resolveTarget(combos, { nodeId: 3, widget: 'm', nodeType: 'C' })).ok, true);
});

test('pinning a widget twice is a no-op, and pinning one already linked finds its owner', () => {
  let current = spec([]);
  const target = { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' };
  current = addTargetToSpec(current, target);
  const afterFirst = JSON.stringify(current.sections);
  current = addTargetToSpec(current, target);
  assert.equal(JSON.stringify(current.sections), afterFirst);
  assert.equal(current.sections.find((section) => section.id === DEFAULT_SECTION_ID)?.fields.length, 1);

  const linkedTarget = { nodeId: 5, widget: 'steps', nodeType: 'KSamplerAdvanced' };
  const fieldId = current.sections.find((section) => section.id === DEFAULT_SECTION_ID)!.fields[0].id;
  current = linkTargetToField(current, fieldId, linkedTarget);
  const owner = findFieldForTarget(current, linkedTarget);
  assert.equal(owner?.isPrimary, false);
  assert.equal(owner?.field.id, fieldId);
});

test('linking absorbs a standalone field so one widget never has two writers', () => {
  let current: MobileFormSpec = { version: 1, mode: 'custom', sections: [], updatedAt: '2026-09-11T00:00:00.000Z' };
  current = addTargetToSpec(current, { nodeId: 4, widget: 'steps', nodeType: 'K' });
  current = addTargetToSpec(current, { nodeId: 5, widget: 'steps', nodeType: 'K' });
  const unsorted = () => current.sections.find((section) => section.id === DEFAULT_SECTION_ID)!;
  assert.equal(unsorted().fields.length, 2, 'pinned widgets land in the catch-all section');
  const primary = unsorted().fields[0];
  current = linkTargetToField(current, primary.id, { nodeId: 5, widget: 'steps', nodeType: 'K' });

  assert.equal(unsorted().fields.length, 1, 'the absorbed standalone field is gone');
  assert.equal(unsorted().fields[0].linked?.length, 1);

  current = unlinkTargetFromField(current, primary.id, { nodeId: 5, widget: 'steps', nodeType: 'K' });
  assert.equal(unsorted().fields[0].linked, undefined);
});

test('field and section editing keeps the rest of the spec intact', () => {
  let current = spec([
    { id: 'a', target: { nodeId: 1, widget: 'w1', nodeType: 'N' } },
    { id: 'b', target: { nodeId: 2, widget: 'w2', nodeType: 'N' } },
  ]);
  current = moveField(current, 'b', -1);
  assert.deepEqual(current.sections[0].fields.map((field) => field.id), ['b', 'a']);
  assert.deepEqual(moveField(current, 'b', -1).sections[0].fields.map((f) => f.id), ['b', 'a'], 'moving past the edge is a no-op');

  current = removeField(current, 'b');
  assert.deepEqual(current.sections[0].fields.map((field) => field.id), ['a']);

  const two: MobileFormSpec = {
    ...current,
    sections: [current.sections[0], { id: 's2', title: 'Second', fields: [{ id: 'c', target: { nodeId: 3, widget: 'w3', nodeType: 'N' } }] }],
  };
  const folded = removeSection(two, 's2');
  assert.equal(folded.sections.length, 1);
  assert.deepEqual(folded.sections[0].fields.map((field) => field.id), ['a', 'c'], 'a removed section folds into the previous one');
});

test('a deleted node leaves the form usable and the broken field prunable', () => {
  const graph = wanLikeGraph();
  const withGhost = spec([
    { id: 'live', target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' } },
    { id: 'ghost', target: { nodeId: 404, widget: 'steps', nodeType: 'KSamplerAdvanced' } },
  ]);
  const sections = resolveSpec(graph, withGhost);
  assert.equal(usableFieldCount(sections), 1);
  assert.equal(sections[0].fields[1].usable, false);
  assert.equal(sections[0].fields[1].primary.problem, 'missing-node');

  assert.deepEqual(pruneBrokenFields(graph, withGhost).sections[0].fields.map((f) => f.id), ['live']);
});

test('a field label falls back to the node title and widget name', () => {
  const graph = wanLikeGraph();
  const resolved = resolveField(graph, { id: 'f', target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' } });
  assert.equal(resolved.label, 'High noise · steps');
  const named = resolveField(graph, { id: 'f', label: '总步数', target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' } });
  assert.equal(named.label, '总步数');
});

test('a write on any target of a linked field mirrors onto its siblings', async () => {
  const { fanOutLinkedWrite } = await import('@/shared/utils/mobileForm');
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  const linked = spec([{
    id: 'f1',
    target: { nodeId: 4, widget: 'steps', nodeType: 'KSamplerAdvanced' },
    linked: [{ nodeId: 5, widget: 'steps', nodeType: 'KSamplerAdvanced' }],
  }]);

  // Editing through the linked sibling propagates back to the primary.
  const written = fanOutLinkedWrite(graph, linked, 5, 'steps', 7, values.set);
  assert.deepEqual(written.map((target) => target.nodeId), [4]);
  assert.equal(values.get(4, 'steps', null), 7);

  assert.deepEqual(fanOutLinkedWrite(graph, linked, 4, 'cfg', 1, values.set), [], 'an unlinked widget fans out nowhere');
});
