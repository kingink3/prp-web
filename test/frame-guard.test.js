import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.top = globalThis;
globalThis.self = globalThis;
const { isFramed } = await import('../js/frame-guard.js');

test('not framed when top is self', () => {
  const w = {}; w.top = w; w.self = w;
  assert.equal(isFramed(w), false);
});

test('framed when top differs', () => {
  const w = { top: {}, self: {} };
  assert.equal(isFramed(w), true);
});

test('framed when reading top throws (cross-origin)', () => {
  const w = { self: {} };
  Object.defineProperty(w, 'top', { get() { throw new Error('cross-origin'); } });
  assert.equal(isFramed(w), true);
});
