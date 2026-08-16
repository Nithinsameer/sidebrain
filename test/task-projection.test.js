'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectUpcomingTasks } = require('../lib/task-projection');

const NOW = new Date('2026-08-16T03:30:00.000Z');

function message(id, overrides = {}) {
  return {
    id,
    text: `Task ${id}`,
    task: true,
    done: false,
    plannedFor: '2026-08-15',
    dueTime: null,
    ...overrides,
  };
}

test('task filtering returns only open scheduled tasks in the bounded window', () => {
  const database = {
    messages: [
      message('overdue', { plannedFor: '2026-08-14' }),
      message('today', { dueTime: '09:30' }),
      message('future', { plannedFor: '2026-08-21' }),
      message('beyond-window', { plannedFor: '2026-08-22' }),
      message('completed', { done: true }),
      message('deleted', { deletedAt: '2026-08-15T00:00:00.000Z' }),
      message('note', { task: false }),
      message('inbox', { plannedFor: null }),
      message('invalid-date', { plannedFor: '2026-02-30' }),
    ],
  };

  const projection = projectUpcomingTasks(database, {
    now: NOW,
    timeZone: 'America/New_York',
    days: 7,
  });

  assert.deepEqual(projection.window, { from: '2026-08-15', through: '2026-08-21' });
  assert.deepEqual(projection.tasks.map((task) => task.id), ['overdue', 'today', 'future']);
  assert.deepEqual(projection.tasks.map((task) => task.timing), ['overdue', 'today', 'upcoming']);
});

test('timezone handling derives today from the requested IANA timezone', () => {
  const database = { messages: [message('boundary')] };

  const newYork = projectUpcomingTasks(database, {
    now: NOW,
    timeZone: 'America/New_York',
    days: 1,
  });
  const tokyo = projectUpcomingTasks(database, {
    now: NOW,
    timeZone: 'Asia/Tokyo',
    days: 1,
  });

  assert.equal(newYork.window.from, '2026-08-15');
  assert.equal(newYork.tasks[0].timing, 'today');
  assert.equal(tokyo.window.from, '2026-08-16');
  assert.equal(tokyo.tasks[0].timing, 'overdue');
  assert.throws(() => projectUpcomingTasks(database, { now: NOW, timeZone: 'Not/A_Zone' }), /invalid timeZone/);
});

test('legacy task mapping recognizes planned records only when task is absent', () => {
  const database = {
    messages: [
      message('legacy', { task: undefined }),
      message('explicitly-not-task', { task: false }),
      message('legacy-unscheduled', { task: undefined, plannedFor: null }),
    ],
  };

  const projection = projectUpcomingTasks(database, {
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.deepEqual(projection.tasks.map((task) => task.id), ['legacy']);
});

test('secret exclusion emits only the safe task projection and redacts title credentials', () => {
  const secrets = {
    settingsSecret: 'settings-secret-77e05f',
    sourceBodySecret: 'source-body-secret-c8a90d',
    uploadSecret: 'upload-secret-b5b79c',
    privateConfigSecret: 'private-config-secret-46a52c',
    titleSecret: 'title-secret-faf851',
    urlSecret: 'url-secret-3d12b8',
  };
  const database = {
    settings: { openaiKey: secrets.settingsSecret },
    uploads: [{ url: secrets.uploadSecret }],
    privateConfiguration: secrets.privateConfigSecret,
    messages: [message('safe-id', {
      text: `Rotate service apiKey=${secrets.titleSecret} https://example.invalid/private?token=${secrets.urlSecret}\n${secrets.sourceBodySecret}`,
      files: [{ url: secrets.uploadSecret }],
      sourceBody: secrets.sourceBodySecret,
      credential: secrets.privateConfigSecret,
      dueTime: '08:45',
    })],
  };

  const projection = projectUpcomingTasks(database, {
    now: NOW,
    timeZone: 'America/New_York',
  });
  const serialized = JSON.stringify(projection);

  assert.deepEqual(Object.keys(projection.tasks[0]).sort(), ['dueDate', 'dueTime', 'id', 'timing', 'title']);
  assert.match(projection.tasks[0].title, /apiKey=\[redacted\]/);
  assert.match(projection.tasks[0].title, /\[link\]/);
  for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false);
});
