'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectFoundTasks, projectUpcomingTasks } = require('../lib/task-projection');

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

test('find_tasks discovers unscheduled tasks and deterministically ranks similar matches', () => {
  const database = {
    messages: [
      message('scheduled-prefix', { text: 'Call dentist about invoice', plannedFor: '2026-08-20', dueTime: '09:30' }),
      message('unscheduled-exact', { text: 'Call dentist', plannedFor: null }),
      message('token-match', { text: 'Dentist call follow-up', plannedFor: null }),
    ],
    reminders: [{ taskId: 'unscheduled-exact', channel: 'discord', state: 'scheduled' }],
  };
  const result = projectFoundTasks(database, { query: 'call dentist' });
  assert.deepEqual(result.tasks.map((task) => task.id), [
    'unscheduled-exact', 'scheduled-prefix', 'token-match',
  ]);
  assert.deepEqual(result.tasks[0], {
    id: 'unscheduled-exact',
    title: 'Call dentist',
    status: 'open',
    dueDate: null,
    dueTime: null,
    remindersPending: true,
  });
  const scheduledOnly = projectFoundTasks(database, {
    query: 'call dentist', include_unscheduled: false,
  });
  assert.deepEqual(scheduledOnly.tasks.map((task) => task.id), ['scheduled-prefix']);
});

test('find_tasks applies completed filtering without mixing statuses', () => {
  const database = {
    messages: [
      message('open', { text: 'Submit expense report', plannedFor: null }),
      message('completed', { text: 'Submit expense report', plannedFor: null, done: true }),
    ],
  };
  assert.deepEqual(projectFoundTasks(database, { query: 'expense' }).tasks.map((task) => task.id), ['open']);
  assert.deepEqual(projectFoundTasks(database, { query: 'expense', status: 'completed' }).tasks.map((task) => task.id), ['completed']);
  assert.deepEqual(projectFoundTasks(database, { query: 'expense', status: 'all' }).tasks.map((task) => task.id), ['open', 'completed']);
});

test('find_tasks enforces result limits and returns an empty safe projection for no match', () => {
  const database = {
    messages: Array.from({ length: 6 }, (_, index) => message(`match-${index}`, {
      text: `Project alpha item ${index}`,
      plannedFor: null,
    })),
  };
  const limited = projectFoundTasks(database, { query: 'project alpha', limit: 2 });
  assert.equal(limited.tasks.length, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(projectFoundTasks(database, { query: 'not present' }), { tasks: [], truncated: false });
  assert.throws(() => projectFoundTasks(database, { query: 'project', limit: 21 }), /limit must be/);
});

test('find_tasks returns only credential-redacted task fields', () => {
  const secret = 'find-title-secret-2a701c';
  const database = {
    settings: { openaiKey: 'find-settings-secret-39e61a' },
    messages: [message('secret-task', {
      text: `Rotate password=${secret} https://example.invalid/private\nprivate-body-4403b2`,
      plannedFor: null,
      researchedBrief: 'private-brief-df12a4',
      sources: [{ url: 'https://example.invalid/source-secret' }],
    })],
    reminders: [{
      taskId: 'secret-task', channel: 'discord', state: 'scheduled', text: 'private-reminder-message-b97c31',
    }],
  };
  const result = projectFoundTasks(database, { query: 'rotate' });
  assert.deepEqual(Object.keys(result.tasks[0]).sort(), [
    'dueDate', 'dueTime', 'id', 'remindersPending', 'status', 'title',
  ]);
  const serialized = JSON.stringify(result);
  assert.match(result.tasks[0].title, /password=\[redacted\]/);
  for (const excluded of [
    secret, 'find-settings-secret-39e61a', 'private-body-4403b2',
    'private-brief-df12a4', 'source-secret', 'private-reminder-message-b97c31',
  ]) {
    assert.equal(serialized.includes(excluded), false);
  }
});
