'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeJsonDurably } = require('../lib/durable-json-store');
const { projectMessageForPwa } = require('../lib/reminder-projection');
const {
  createTaskService,
  DELIVERY_WINDOW_MS,
  LEASE_MS,
  migrateTaskWriteSchema,
  RETRY_BACKOFF_MS,
} = require('../lib/task-service');

function baseDatabase() {
  return {
    settings: { discordWebhook: 'fixture-discord-secret' },
    tags: [],
    messages: [],
    reminders: [],
    taskOperations: [],
  };
}

function harness(t, { at = '2026-08-16T12:00:00.000Z', deliverDiscord = async () => ({ ok: true }) } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebrain-task-service-'));
  const file = path.join(directory, 'db.json');
  let database = baseDatabase();
  let clock = new Date(at);
  let sequence = 0;
  writeJsonDurably(file, database);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const service = createTaskService({
    getDatabase: () => database,
    replaceDatabase: (next) => { database = next; },
    persistDatabase: (next) => writeJsonDurably(file, next),
    deliverDiscord,
    now: () => new Date(clock),
    idFactory: () => `fixture-id-${++sequence}`,
  });
  return {
    file,
    service,
    get database() { return database; },
    set database(next) { database = next; },
    advance(milliseconds) { clock = new Date(clock.getTime() + milliseconds); },
    setTime(value) { clock = new Date(value); },
  };
}

test('simple voice-style creation is durable without invented fields', (t) => {
  const h = harness(t);
  const receipt = h.service.createTask({
    idempotencyKey: 'voice-simple-0001',
    origin: 'chatgpt_voice',
    title: 'Buy oat milk',
  });

  assert.equal(receipt.durable, true);
  assert.equal(receipt.task.title, 'Buy oat milk');
  assert.equal(receipt.task.due, null);
  assert.deepEqual(receipt.reminders, []);
  const saved = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(saved.messages[0].text, 'Buy oat milk');
  assert.equal(saved.messages[0].details, null);
  assert.equal(saved.messages[0].researchedBrief, null);
  assert.deepEqual(saved.messages[0].sources, []);
  assert.deepEqual(saved.messages[0].checklist, []);
  assert.equal(saved.taskOperations.length, 1);
});

test('dedicated reminder creation requires a reminder and schedules exactly one durably', (t) => {
  const h = harness(t);
  assert.throws(() => h.service.createReminderTask({
    idempotency_key: 'missing-reminder-01',
    origin: 'chatgpt_voice',
    title: 'Missing reminder',
    timezone: 'America/New_York',
  }), /reminder_at is required/);

  const receipt = h.service.createReminderTask({
    idempotency_key: 'voice-reminder-0001',
    origin: 'chatgpt_voice',
    title: 'Check the oven',
    reminder_at: '2026-08-16T09:15',
    timezone: 'America/New_York',
  });

  assert.equal(receipt.operationType, 'create_reminder_task');
  assert.deepEqual(receipt.task.due, {
    date: '2026-08-16',
    time: '09:15',
    timeZone: 'America/New_York',
    atUtc: '2026-08-16T13:15:00.000Z',
  });
  assert.deepEqual(receipt.task.tags, ['Reminder']);
  assert.equal(receipt.reminders.length, 1);
  assert.equal(receipt.reminders[0].state, 'scheduled');
  assert.equal(receipt.reminders[0].scheduledForUtc, '2026-08-16T13:15:00.000Z');
  assert.equal(receipt.reminders[0].expiresAtUtc, '2026-08-17T13:15:00.000Z');

  const saved = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.reminders.length, 1);
  assert.equal(saved.taskOperations.length, 1);
  assert.equal(saved.taskOperations[0].type, 'create_reminder_task');
});

test('Reminder tag is reused and dedicated reminder writes are idempotent', (t) => {
  const h = harness(t);
  h.database.tags.push({
    id: 'existing-reminder-tag', name: 'Reminder', color: 'amber', keywords: [], parent: null,
  });
  const request = {
    idempotency_key: 'reminder-idempotent-01',
    origin: 'chatgpt_voice',
    title: 'Leave for practice',
    reminder_at: '2026-08-16T10:00',
    timezone: 'America/New_York',
  };
  const first = h.service.createReminderTask(request);
  const repeated = h.service.createReminderTask({ ...request });
  assert.deepEqual(repeated, first);
  assert.deepEqual(first.task.tags, ['Reminder']);
  assert.equal(h.database.tags.filter((tag) => tag.name.toLowerCase() === 'reminder').length, 1);
  assert.equal(h.database.messages.length, 1);
  assert.equal(h.database.reminders.length, 1);
  assert.equal(h.database.taskOperations.length, 1);
  h.service.setTaskCompletion({
    idempotencyKey: 'reminder-complete-01',
    origin: 'chatgpt',
    taskId: first.task.id,
    completed: true,
  });
  const byTaskId = h.service.getTaskReceipt({ taskId: first.task.id });
  assert.equal(byTaskId.operationType, 'create_reminder_task');
  assert.equal(byTaskId.reminders[0].state, 'cancelled');
  assert.throws(() => h.service.createReminderTask({ ...request, title: 'Changed title' }), (error) => {
    assert.equal(error.code, 'idempotency_conflict');
    return true;
  });
});

test('dedicated reminder survives receipt, replay, PWA projection, and its scheduled delivery attempt', async (t) => {
  let deliveries = 0;
  const h = harness(t, {
    deliverDiscord: async () => { deliveries += 1; return { ok: true }; },
  });
  const request = {
    idempotency_key: 'reminder-lifecycle-01',
    origin: 'chatgpt_voice',
    title: 'Lifecycle reminder',
    reminder_at: '2026-08-16T09:15',
    timezone: 'America/New_York',
  };
  const created = h.service.createReminderTask(request);
  const persistedBeforeReads = fs.readFileSync(h.file, 'utf8');

  assert.equal(h.service.getTaskReceipt({ taskId: created.task.id }).reminders[0].state, 'scheduled');
  assert.deepEqual(h.service.createReminderTask({ ...request }), created);
  const pwaTask = projectMessageForPwa(h.database, h.database.messages[0]);
  assert.equal(pwaTask.discordReminders[0].status, 'scheduled');
  assert.equal(fs.readFileSync(h.file, 'utf8'), persistedBeforeReads);

  h.setTime('2026-08-16T13:15:00.000Z');
  const delivery = await h.service.runReminderCycle();
  assert.equal(delivery.delivered, 1);
  assert.equal(deliveries, 1);
  assert.equal(h.database.reminders[0].state, 'delivered');
  assert.equal(h.database.reminders[0].attempts, 1);
  assert.equal(h.database.reminders[0].cancellationReason, null);
});

test('dedicated reminder creation rejects past, invalid-zone, DST-gap, and DST-fold moments', (t) => {
  const h = harness(t);
  const base = { origin: 'chatgpt_voice', title: 'Invalid reminder' };
  assert.throws(() => h.service.createReminderTask({
    ...base, idempotency_key: 'past-reminder-0001',
    reminder_at: '2026-08-16T07:59', timezone: 'America/New_York',
  }), /must be in the future/);
  assert.throws(() => h.service.createReminderTask({
    ...base, idempotency_key: 'zone-reminder-0001',
    reminder_at: '2026-08-17T09:00', timezone: 'Not\/A_Zone',
  }), /valid IANA timezone/);
  assert.throws(() => h.service.createReminderTask({
    ...base, idempotency_key: 'gap-reminder-00001',
    reminder_at: '2027-03-14T02:30', timezone: 'America/New_York',
  }), /does not exist/);
  assert.throws(() => h.service.createReminderTask({
    ...base, idempotency_key: 'fold-reminder-0001',
    reminder_at: '2026-11-01T01:30', timezone: 'America/New_York',
  }), /ambiguous/);
});

test('additive migration preserves legacy tasks and reminders', (t) => {
  const h = harness(t);
  delete h.database.taskOperations;
  h.database.messages.push({
    id: 'legacy-task', text: 'Legacy planned item', task: true, done: false,
    plannedFor: '2026-08-19', dueTime: null, tagIds: [],
  });
  h.database.reminders.push({
    id: 'legacy-reminder', text: 'Legacy reminder', due: '2026-08-19T12:00:00.000Z', done: false,
  });
  migrateTaskWriteSchema(h.database);
  const receipt = h.service.setTaskCompletion({
    idempotencyKey: 'legacy-complete-01', origin: 'chatgpt', taskId: 'legacy-task', completed: true,
  });
  assert.equal(receipt.task.completed, true);
  assert.equal(h.database.reminders[0].id, 'legacy-reminder');
  assert.equal(h.database.reminders[0].state, undefined);
  assert.equal(h.database.taskOperations.length, 1);
});

test('researched creation stores rich data but returns only a safe receipt', (t) => {
  const h = harness(t);
  const receipt = h.service.createTask({
    idempotencyKey: 'research-task-0001',
    origin: 'chatgpt',
    title: 'Compare local backup options',
    details: 'Focus on recovery time.',
    researchedBrief: 'A private researched body that should not be echoed.',
    sources: [{ title: 'Reference', url: 'https://example.com/research' }],
    checklist: ['Compare restore tests', 'Document retention'],
    tags: ['research', '#infra'],
  });

  assert.equal(receipt.task.detailsStored, true);
  assert.equal(receipt.task.researchedBriefStored, true);
  assert.equal(receipt.task.sourceCount, 1);
  assert.equal(receipt.task.checklistCount, 2);
  assert.deepEqual(receipt.task.tags, ['research', 'infra']);
  assert.equal(JSON.stringify(receipt).includes('private researched body'), false);
  assert.equal(h.database.messages[0].researchedBrief.includes('private researched body'), true);
});

test('date-only tasks stay date-only and timed tasks preserve timezone plus exact UTC', (t) => {
  const h = harness(t);
  const dateOnly = h.service.createTask({
    idempotencyKey: 'date-only-task-01', origin: 'chatgpt', title: 'File paperwork',
    due: { date: '2026-08-20' },
  });
  assert.deepEqual(dateOnly.task.due, { date: '2026-08-20', time: null, timeZone: null, atUtc: null });

  const timed = h.service.createTask({
    idempotencyKey: 'timed-task-00001', origin: 'chatgpt', title: 'Call the clinic',
    due: { date: '2026-08-20', time: '09:30', timeZone: 'America/New_York' },
    discordReminders: [{ date: '2026-08-20', time: '09:00', timeZone: 'America/New_York' }],
    followUp: {
      date: '2026-08-22',
      notification: { time: '10:00', timeZone: 'America/New_York' },
    },
  });
  assert.equal(timed.task.due.atUtc, '2026-08-20T13:30:00.000Z');
  assert.equal(timed.task.due.timeZone, 'America/New_York');
  assert.equal(timed.reminders[0].scheduledForUtc, '2026-08-20T13:00:00.000Z');
  assert.equal(timed.reminders[0].expiresAtUtc, '2026-08-21T13:00:00.000Z');
  assert.equal(timed.reminders[0].displayTimeZone, 'America/New_York');
  assert.equal(timed.task.followUpDate, '2026-08-22');
  assert.equal(timed.reminders[1].scheduledForUtc, '2026-08-22T14:00:00.000Z');
  assert.equal(h.database.reminders[1].kind, 'follow_up');
});

test('timezone validation rejects missing zones and both DST gap and fold ambiguity', (t) => {
  const h = harness(t);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'missing-zone-0001', origin: 'chatgpt', title: 'Invalid',
    due: { date: '2026-08-20', time: '09:30' },
  }), /timeZone is required/);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'dst-gap-task-001', origin: 'chatgpt', title: 'Gap',
    due: { date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' },
  }), /does not exist/);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'dst-fold-task-01', origin: 'chatgpt', title: 'Fold',
    due: { date: '2026-11-01', time: '01:30', timeZone: 'America/New_York' },
  }), /ambiguous/);
  const valid = h.service.createTask({
    idempotencyKey: 'dst-valid-task-1', origin: 'chatgpt', title: 'After spring shift',
    due: { date: '2026-03-08', time: '03:30', timeZone: 'America/New_York' },
  });
  assert.equal(valid.task.due.atUtc, '2026-03-08T07:30:00.000Z');
});

test('idempotency returns the original receipt and rejects payload conflicts', (t) => {
  const h = harness(t);
  const request = { idempotencyKey: 'stable-retry-0001', origin: 'chatgpt', title: 'Retry-safe task' };
  const first = h.service.createTask(request);
  const second = h.service.createTask({ ...request });
  assert.deepEqual(second, first);
  assert.deepEqual(h.service.getTaskReceipt({ idempotencyKey: request.idempotencyKey }), first);
  assert.equal(h.database.messages.length, 1);
  assert.equal(h.database.taskOperations.length, 1);
  assert.throws(() => h.service.createTask({ ...request, title: 'Changed payload' }), (error) => {
    assert.equal(error.code, 'idempotency_conflict');
    return true;
  });
});

test('persistence failure returns no success and leaves in-memory data unchanged', () => {
  let database = baseDatabase();
  const service = createTaskService({
    getDatabase: () => database,
    replaceDatabase: (next) => { database = next; },
    persistDatabase: () => { throw new Error('simulated persistence failure'); },
    deliverDiscord: async () => ({ ok: true }),
  });
  assert.throws(() => service.createTask({
    idempotencyKey: 'failed-write-0001', origin: 'chatgpt', title: 'Must not appear',
  }), /simulated persistence failure/);
  assert.deepEqual(database.messages, []);
  assert.deepEqual(database.taskOperations, []);
});

test('Discord delivery awaits success and retries failures with bounded backoff', async (t) => {
  let succeed = false;
  let calls = 0;
  const h = harness(t, {
    at: '2026-08-16T12:00:00.000Z',
    deliverDiscord: async () => {
      calls += 1;
      if (!succeed) throw new Error('mock Discord failure');
      return { ok: true };
    },
  });
  h.service.createTask({
    idempotencyKey: 'discord-retry-001', origin: 'chatgpt', title: 'Retry reminder',
    discordReminders: [{ date: '2026-08-16', time: '08:00', timeZone: 'America/New_York' }],
  });

  const failed = await h.service.runReminderCycle();
  assert.deepEqual(failed, { recovered: 0, expired: 0, attempted: 1, delivered: 0, failed: 1 });
  assert.equal(h.database.reminders[0].state, 'retry_wait');
  assert.equal(h.database.reminders[0].attempts, 1);
  assert.equal(Date.parse(h.database.reminders[0].nextAttemptAtUtc), Date.parse('2026-08-16T12:00:00.000Z') + RETRY_BACKOFF_MS[0]);

  h.advance(RETRY_BACKOFF_MS[0]);
  succeed = true;
  const delivered = await h.service.runReminderCycle();
  assert.equal(delivered.delivered, 1);
  assert.equal(calls, 2);
  assert.equal(h.database.reminders[0].state, 'delivered');
  assert.equal(h.database.reminders[0].attempts, 2);
});

test('Discord delivery recovers after an outage longer than one hour', async (t) => {
  let succeeding = false;
  const h = harness(t, {
    deliverDiscord: async () => {
      if (!succeeding) throw new Error('outage');
      return { ok: true };
    },
  });
  h.service.createTask({
    idempotencyKey: 'discord-outage-001', origin: 'chatgpt', title: 'Outage reminder',
    discordReminders: [{ date: '2026-08-16', time: '08:00', timeZone: 'America/New_York' }],
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await h.service.runReminderCycle();
    if (attempt < 4) h.advance(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
  }
  assert.equal(h.database.reminders[0].state, 'retry_wait');
  assert.equal(h.database.reminders[0].attempts, 5);
  h.advance(RETRY_BACKOFF_MS[4]);
  succeeding = true;
  const result = await h.service.runReminderCycle();
  assert.equal(result.delivered, 1);
  assert.equal(h.database.reminders[0].state, 'delivered');
  assert.equal(h.database.reminders[0].attempts, 6);
  assert.equal(h.database.reminders[0].lateByMs, 9_750_000);
});

test('Discord retries every six hours and expires at the persisted 24-hour boundary', async (t) => {
  const scheduledAt = Date.parse('2026-08-16T12:00:00.000Z');
  const h = harness(t, { deliverDiscord: async () => { throw new Error('full-day outage'); } });
  h.service.createTask({
    idempotencyKey: 'discord-expiry-001', origin: 'chatgpt', title: 'Expiry reminder',
    discordReminders: [{ date: '2026-08-16', time: '08:00', timeZone: 'America/New_York' }],
  });
  const reminder = () => h.database.reminders[0];
  assert.equal(Date.parse(reminder().expiresAtUtc), scheduledAt + DELIVERY_WINDOW_MS);

  while (reminder().state !== 'dead_letter') {
    const result = await h.service.runReminderCycle();
    if (result.expired) break;
    h.setTime(reminder().nextAttemptAtUtc);
  }

  assert.equal(reminder().state, 'dead_letter');
  assert.equal(reminder().attempts, 9);
  assert.equal(reminder().lastFailureCode, 'delivery_window_expired');
  assert.equal(reminder().nextAttemptAtUtc, null);
  assert.equal(Date.parse(reminder().updatedAt), scheduledAt + DELIVERY_WINDOW_MS);
});

test('restart recovery reclaims expired leases and records late delivery after sleep', async (t) => {
  const h = harness(t, { at: '2026-08-16T15:00:00.000Z' });
  h.service.createTask({
    idempotencyKey: 'restart-lease-001', origin: 'chatgpt', title: 'Recovered reminder',
    discordReminders: [{ date: '2026-08-16', time: '08:00', timeZone: 'America/New_York' }],
  });
  const persisted = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  Object.assign(persisted.reminders[0], {
    state: 'leased',
    attempts: 1,
    leasedAtUtc: '2026-08-16T12:01:00.000Z',
    leaseExpiresAtUtc: new Date(Date.parse('2026-08-16T12:01:00.000Z') + LEASE_MS).toISOString(),
    leaseToken: 'abandoned-lease-token',
  });
  writeJsonDurably(h.file, persisted);
  h.database = JSON.parse(fs.readFileSync(h.file, 'utf8'));

  const result = await h.service.runReminderCycle();
  assert.equal(result.recovered, 1);
  assert.equal(result.delivered, 1);
  assert.equal(h.database.reminders[0].state, 'delivered');
  assert.equal(h.database.reminders[0].lateByMs, 3 * 60 * 60 * 1000);
});

test('completion cancels undelivered reminders and reopening does not re-arm them', (t) => {
  const h = harness(t);
  const created = h.service.createTask({
    idempotencyKey: 'complete-create-01', origin: 'chatgpt_voice', title: 'Submit form',
    discordReminders: [{ date: '2026-08-20', time: '09:00', timeZone: 'America/New_York' }],
  });
  const noOpReopen = h.service.setTaskCompletion({
    idempotencyKey: 'open-noop-change-01', origin: 'pwa',
    taskId: created.task.id, completed: false,
  });
  assert.equal(noOpReopen.task.completed, false);
  assert.equal(noOpReopen.reminders[0].state, 'scheduled');
  assert.equal(h.database.messages[0].reopenedAt, undefined);
  assert.equal(h.database.taskOperations.at(-1).statusChanged, false);
  assert.equal(h.database.taskOperations.at(-1).cancelledReminderCount, 0);

  const completionRequest = {
    idempotencyKey: 'complete-change-01', origin: 'chatgpt_voice',
    taskId: created.task.id, completed: true,
  };
  const completed = h.service.setTaskCompletion(completionRequest);
  assert.equal(completed.task.completed, true);
  assert.equal(completed.reminders[0].state, 'cancelled');
  assert.equal(completed.reminders[0].cancellationReason, 'task_completed');
  const cancellation = h.database.reminders[0];
  const completionOperation = h.database.taskOperations.at(-1);
  assert.equal(cancellation.cancelledByOperationId, completed.operationId);
  assert.equal(cancellation.cancellationOrigin, 'chatgpt_voice');
  assert.equal(completionOperation.requestedCompleted, true);
  assert.equal(completionOperation.resultingCompleted, true);
  assert.equal(completionOperation.statusChanged, true);
  assert.equal(completionOperation.cancelPendingRemindersRequested, true);
  assert.equal(completionOperation.cancelledReminderCount, 1);
  assert.deepEqual(h.service.setTaskCompletion({ ...completionRequest }), completed);
  assert.throws(() => h.service.setTaskCompletion({ ...completionRequest, completed: false }), (error) => {
    assert.equal(error.code, 'idempotency_conflict');
    return true;
  });

  const reopened = h.service.setTaskCompletion({
    idempotencyKey: 'reopen-change-001', origin: 'chatgpt_voice',
    taskId: created.task.id, completed: false,
  });
  assert.equal(reopened.task.completed, false);
  assert.equal(reopened.reminders[0].state, 'cancelled');
  assert.equal(reopened.reminders[0].cancellationReason, 'task_completed');
  assert.equal(h.database.reminders[0].cancelledByOperationId, completed.operationId);
  assert.equal(h.database.taskOperations.at(-1).cancelledReminderCount, 0);
});

test('an existing open task can be durably marked for the approved Codex project', (t) => {
  const h = harness(t);
  const created = h.service.createTask({ idempotencyKey: 'codex-source-task-01', origin: 'apple_shortcut', title: 'Research toll dispute' });
  const receipt = h.service.markTaskForCodex({
    idempotencyKey: 'codex-mark-task-0001', origin: 'apple_shortcut', taskId: created.task.id, projectAlias: 'mindchuck',
  });
  assert.deepEqual(new Set(receipt.task.tags), new Set(['codex', 'project:mindchuck']));
  assert.equal(h.database.taskOperations.at(-1).type, 'mark_task_for_codex');
  assert.throws(() => h.service.markTaskForCodex({
    idempotencyKey: 'codex-mark-task-0002', origin: 'apple_shortcut', taskId: created.task.id, projectAlias: 'arbitrary-path',
  }), (error) => error.code === 'invalid_request');
});

test('receipts exclude credentials, stored bodies, settings, and source URLs', (t) => {
  const h = harness(t);
  h.database.settings.discordWebhook = 'https://discord.com/api/webhooks/private-secret-90210';
  const receipt = h.service.createTask({
    idempotencyKey: 'secret-safe-00001', origin: 'chatgpt',
    title: 'Rotate api_key=top-secret-12345',
    details: 'Bearer private-details-token',
    researchedBrief: 'private-full-brief-body',
    sources: [{ title: 'private-source-title', url: 'https://example.com/private-source-path' }],
  });
  const lookedUp = h.service.getTaskReceipt({ operationId: receipt.operationId });
  const serialized = JSON.stringify(lookedUp);
  for (const secret of [
    'top-secret-12345', 'private-details-token', 'private-full-brief-body',
    'private-source-title', 'private-source-path', 'private-secret-90210',
  ]) assert.equal(serialized.includes(secret), false);
  assert.equal(lookedUp.task.detailsStored, true);
  assert.equal(lookedUp.task.sourceCount, 1);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'source-creds-0001', origin: 'chatgpt', title: 'Bad source',
    sources: [{ url: 'https://user:password@example.com/private' }],
  }), /must not contain credentials/);
});

test('malformed and oversized write requests are rejected', (t) => {
  const h = harness(t);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'unknown-field-01', origin: 'chatgpt', title: 'Invalid', arbitraryPath: '/tmp/private',
  }), /unsupported field/);
  assert.throws(() => h.service.createTask({
    idempotencyKey: 'oversize-task-001', origin: 'chatgpt', title: 'Invalid', details: 'x'.repeat(50 * 1024),
  }), (error) => error.code === 'request_too_large');
  assert.throws(() => h.service.getTaskReceipt({ taskId: 'one', operationId: 'two' }), /exactly one/);
});
