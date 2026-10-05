import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './load-ts.mjs';
const { needsUpdate } = await import(await moduleUrl('src/version.ts'));

test('version comparison reloads only a different valid deployed version', () => {
  assert.equal(needsUpdate('current', 'current'), false);
  assert.equal(needsUpdate('current', 'new-release'), true);
  for (const value of [null, undefined, '', 42, {}, 'x'.repeat(128)]) assert.equal(needsUpdate('current', value), false);
});
