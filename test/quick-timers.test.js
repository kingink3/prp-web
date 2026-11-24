import test from 'node:test';
import assert from 'node:assert/strict';
import { addQuickTimer, dueReminders, expireQuickTimers, leftMs, removeQuickTimer, toggleQuickTimer } from '../js/quick-timers.js';

test('quick timer: add, pause, resume, ring once, remove', () => {
  let list = addQuickTimer([], ' чай ', '5', 1000);
  assert.equal(list[0].label, 'чай');
  assert.equal(list[0].end, 1000 + 5 * 60_000);
  list = toggleQuickTimer(list, list[0].id, 61_000);           // pause after 1 min
  assert.equal(leftMs(list[0], 999_999), 4 * 60_000);
  list = toggleQuickTimer(list, list[0].id, 100_000);          // resume
  assert.equal(list[0].end, 100_000 + 4 * 60_000);
  let r = expireQuickTimers(list, list[0].end);
  assert.equal(r.rang.length, 1);
  r = expireQuickTimers(r.list, list[0].end + 5000);
  assert.equal(r.rang.length, 0);
  assert.deepEqual(removeQuickTimer(r.list, list[0].id), []);
  assert.equal(addQuickTimer([], '', 'abc', 0)[0].minutes, 10);
});

test('due reminders ring once per id+time and skip old or future ones', () => {
  const rems = [{ id: 'a', at: '2030-01-15T10:00' }, { id: 'b', at: '2030-01-15T12:00' }, { id: 'c', at: '2030-01-15T09:00', done: true }];
  const now = Date.parse('2030-01-15T10:05');
  assert.deepEqual(dueReminders(rems, new Set(), now, '2030-01-15T10:05').map(r => r.id), ['a']);
  assert.deepEqual(dueReminders(rems, new Set(['a@2030-01-15T10:00']), now, '2030-01-15T10:05'), []);
});
