import assert from 'node:assert/strict';
import test from 'node:test';
import { esc, eveningDate, localIsoMinutes, postponedId, reminderId, today, todoId, tomorrow } from '../js/util.js';

test('local dates and evening cutoff around midnight and 04:00', () => {
  const times = [
    [new Date(2030, 11, 31, 23, 59), '2030-12-31T23:59', '2030-12-31', '2031-01-01', '2030-12-31'],
    [new Date(2031, 0, 1, 0, 0), '2031-01-01T00:00', '2031-01-01', '2031-01-02', '2030-12-31'],
    [new Date(2031, 0, 1, 3, 59, 59), '2031-01-01T03:59', '2031-01-01', '2031-01-02', '2030-12-31'],
    [new Date(2031, 0, 1, 4, 0), '2031-01-01T04:00', '2031-01-01', '2031-01-02', '2031-01-01'],
  ];
  for (const [date, iso, current, next, evening] of times) {
    assert.equal(localIsoMinutes(date), iso);
    assert.equal(today(date), current);
    assert.equal(tomorrow(date), next);
    assert.equal(eveningDate(date), evening);
  }
});

test('IDs use integer Unix seconds and the Lab prefixes', () => {
  const date = new Date(1894665600999);
  assert.equal(todoId(date), 'td-1894665600');
  assert.equal(postponedId(date), 'pp-1894665600');
  assert.equal(reminderId(date), 'r-1894665600');
});

test('esc neutralizes HTML text and quoted attribute delimiters', () => {
  assert.equal(esc('<a x="a&b">\'</a>'), '&lt;a x=&quot;a&amp;b&quot;&gt;&#39;&lt;/a&gt;');
});
