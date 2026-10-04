// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, matches, nextRun } from '../cron.js';

const at = (s) => new Date(s);   // local time

test('a plain daily expression', () => {
  const c = parseCron('0 3 * * *');
  assert.ok(matches(c, at('2026-10-04T03:00:00')));
  assert.ok(!matches(c, at('2026-10-04T03:01:00')));
  assert.ok(!matches(c, at('2026-10-04T04:00:00')));
});

test('lists, ranges and steps', () => {
  const c = parseCron('*/15 8-10 * * 1-5');
  assert.ok(matches(c, at('2026-10-05T09:45:00')));      // a Monday
  assert.ok(!matches(c, at('2026-10-04T09:45:00')));     // a Sunday
  assert.ok(!matches(c, at('2026-10-05T09:50:00')));
  assert.ok(matches(parseCron('0,30 * * * *'), at('2026-10-05T01:30:00')));
});

test('Sunday is 0 and 7', () => {
  assert.ok(matches(parseCron('0 5 * * 0'), at('2026-10-04T05:00:00')));
  assert.ok(matches(parseCron('0 5 * * 7'), at('2026-10-04T05:00:00')));
});

test('day of month and day of week: either may match when both are restricted', () => {
  const c = parseCron('0 0 1 * 1');                       // the 1st, or any Monday
  assert.ok(matches(c, at('2026-10-01T00:00:00')));
  assert.ok(matches(c, at('2026-10-05T00:00:00')));
  assert.ok(!matches(c, at('2026-10-06T00:00:00')));
});

test('nextRun finds the next matching minute, also across a month', () => {
  assert.equal(nextRun(parseCron('0 3 * * *'), at('2026-10-04T03:00:00')).getTime(), at('2026-10-05T03:00:00').getTime());
  assert.equal(nextRun(parseCron('30 2 1 * *'), at('2026-10-04T12:00:00')).getTime(), at('2026-11-01T02:30:00').getTime());
  assert.equal(nextRun(parseCron('* * * * *'), at('2026-10-04T12:00:30')).getTime(), at('2026-10-04T12:01:00').getTime());
});

test('wrong expressions are refused with a reason', () => {
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *', '@daily'])
    assert.throws(() => parseCron(bad), Error, bad);
});
