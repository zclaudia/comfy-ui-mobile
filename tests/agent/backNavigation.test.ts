import test from 'node:test';
import assert from 'node:assert/strict';
import { backTarget } from '../../src/components/navigation/backNavigation';

test('backTarget pops history only when the app navigated here itself', () => {
  assert.deepEqual(backTarget(3, '/'), { kind: 'history' });
  assert.deepEqual(backTarget(1, '/workflows'), { kind: 'history' });
});

test('backTarget lands on the fallback when the page was the entry point', () => {
  assert.deepEqual(backTarget(0, '/'), { kind: 'path', path: '/' });
  assert.deepEqual(backTarget(undefined, '/chains'), { kind: 'path', path: '/chains' });
  assert.deepEqual(backTarget(null, '/'), { kind: 'path', path: '/' });
  assert.deepEqual(backTarget('2', '/'), { kind: 'path', path: '/' });
});
