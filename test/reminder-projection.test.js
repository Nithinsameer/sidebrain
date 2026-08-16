'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { projectTaskReminders } = require('../lib/reminder-projection');

test('PWA reminder projection exposes every safe status and excludes internals', () => {
  const secret = 'private-lease-token-71d2f4';
  const states = [
    ['scheduled', 0, 'scheduled'],
    ['leased', 1, 'scheduled'],
    ['leased', 2, 'retrying'],
    ['retry_wait', 2, 'retrying'],
    ['delivered', 1, 'delivered'],
    ['dead_letter', 9, 'failed'],
    ['cancelled', 0, 'cancelled'],
  ];
  const database = {
    reminders: states.map(([state, attempts], index) => ({
      id: `reminder-${index}`,
      taskId: 'task-1',
      channel: 'discord',
      state,
      attempts,
      scheduledForUtc: `2026-08-17T1${index}:00:00.000Z`,
      displayDate: '2026-08-17',
      displayTime: `${String(10 + index).padStart(2, '0')}:00`,
      displayTimeZone: 'America/New_York',
      text: 'private reminder message',
      leaseToken: secret,
      lastFailureCode: 'private-failure-detail',
      webhook: 'https://discord.invalid/private',
      cancellationReason: state === 'cancelled' ? 'task_completed' : null,
    })),
  };

  const projection = projectTaskReminders(database, 'task-1');
  assert.deepEqual(projection.map((reminder) => reminder.status), states.map((entry) => entry[2]));
  assert.deepEqual(Object.keys(projection[0]).sort(), [
    'cancellationReason', 'displayDate', 'displayTime', 'displayTimeZone', 'scheduledForUtc', 'status',
  ]);
  assert.equal(projection.at(-1).cancellationReason, 'task_completed');
  const serialized = JSON.stringify(projection);
  for (const excluded of [secret, 'private reminder message', 'private-failure-detail', 'discord.invalid']) {
    assert.equal(serialized.includes(excluded), false);
  }
});

test('PWA task text cannot trigger completion and the checkbox is guarded against duplicate writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /<button type="button" class="box task-toggle" data-taskdone/);
  assert.doesNotMatch(source, /<div[^>]+data-taskdone/);
  assert.match(source, /e\.target\.closest\('\[data-taskdone\]'\)/);
  assert.match(source, /taskCompletionPending\.has\(m\.id\)/);
  assert.match(source, /e\.target\.closest\('\.todo-item\[data-line\]'\)/);
});
