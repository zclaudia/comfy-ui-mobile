import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareExecutionModifications } from '@/shared/utils/executionModifications';
import type { MobileFormSpec } from '@/shared/types/app/IMobileForm';
import { makeValueLayer, wanLikeGraph } from '../fixtures/formGraph';

/** Stands in for autoChangeSeed: gives every named seed its own random value. */
const seedProcessor = (targets: Array<{ nodeId: number; widget: string }>, values: number[]) =>
  (async (_workflow: any, _metadata: any, editor: any) => {
    targets.forEach((target, index) => {
      editor.setWidgetValue(target.nodeId, target.widget, values[index]);
    });
    return targets.map((target) => ({ nodeId: target.nodeId })) as any;
  }) as any;

const linkedSeedSpec: MobileFormSpec = {
  version: 1,
  mode: 'custom',
  sections: [{
    id: 's1',
    title: 'Sampling',
    fields: [{
      id: 'seed',
      target: { nodeId: 4, widget: 'noise_seed', nodeType: 'KSamplerAdvanced' },
      linked: [{ nodeId: 5, widget: 'noise_seed', nodeType: 'KSamplerAdvanced' }],
    }],
  }],
  updatedAt: '2026-09-11T00:00:00.000Z',
};

const base = () => new Map<number, Record<string, any>>();

test('a seed generated during the call reaches the submitted graph', async () => {
  // The regression this guards: the editor built its execution graph from
  // React state captured at render, so the seed it had just randomized was not
  // in it — every run shipped the previous run's seed.
  const values = makeValueLayer();
  const result = await prepareExecutionModifications({
    base: base(),
    readBase: values.get,
    writeThrough: values.set,
    workflow: {} as any,
    nodeMetadata: null,
    graph: wanLikeGraph(),
    formSpec: null,
    autoSeed: seedProcessor([{ nodeId: 4, widget: 'noise_seed' }], [777]),
  });

  assert.equal(result.seedChanges, 1);
  assert.equal(result.modifications.get(4)?.noise_seed, 777, 'the submitted map carries the new seed');
  assert.equal(values.get(4, 'noise_seed', null), 777, 'and the UI shows the same value');
});

test('linked seeds are unified after randomization, so one field means one seed', async () => {
  const values = makeValueLayer();
  const result = await prepareExecutionModifications({
    base: base(),
    readBase: values.get,
    writeThrough: values.set,
    workflow: {} as any,
    nodeMetadata: null,
    graph: wanLikeGraph(),
    formSpec: linkedSeedSpec,
    // Seed processing hands each sampler its own number, as the real one does.
    autoSeed: seedProcessor(
      [{ nodeId: 4, widget: 'noise_seed' }, { nodeId: 5, widget: 'noise_seed' }],
      [111, 222],
    ),
  });

  assert.equal(result.linkedWrites, 1);
  assert.equal(result.modifications.get(4)?.noise_seed, 111);
  assert.equal(result.modifications.get(5)?.noise_seed, 111, 'the linked sampler follows the primary');
});

test('existing unsaved edits are carried into the run and never mutated in place', async () => {
  const values = makeValueLayer();
  const existing = new Map<number, Record<string, any>>([[4, { steps: 30 }]]);
  const result = await prepareExecutionModifications({
    base: existing,
    readBase: values.get,
    writeThrough: values.set,
    workflow: {} as any,
    nodeMetadata: null,
    graph: wanLikeGraph(),
    formSpec: null,
    autoSeed: seedProcessor([{ nodeId: 4, widget: 'noise_seed' }], [5]),
  });

  assert.equal(result.modifications.get(4)?.steps, 30, 'unsaved edits survive');
  assert.equal(result.modifications.get(4)?.noise_seed, 5);
  assert.deepEqual(existing.get(4), { steps: 30 }, 'the caller\'s own map is untouched');
});

test('a failing seed processor does not block the run', async () => {
  const values = makeValueLayer();
  const result = await prepareExecutionModifications({
    base: base(),
    readBase: values.get,
    writeThrough: values.set,
    workflow: null,
    nodeMetadata: null,
    graph: wanLikeGraph(),
    formSpec: linkedSeedSpec,
    autoSeed: (async () => { throw new Error('metadata missing'); }) as any,
  });

  assert.equal(result.seedChanges, 0);
  // Linked unification still runs: the two samplers start out equal in the
  // fixture, so there is nothing to write, and the run proceeds.
  assert.equal(result.linkedWrites, 0);
  assert.ok(result.modifications instanceof Map);
});
