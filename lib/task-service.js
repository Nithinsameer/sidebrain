'use strict';

const crypto = require('node:crypto');
const { safeTitle } = require('./task-projection');
const {
  localDateTimeToUtc,
  validDay,
  validTime,
  validTimeZone,
} = require('./time-zone');

const ORIGINS = new Set(['chatgpt', 'chatgpt_voice', 'codex', 'pwa', 'apple_shortcut']);
const REMINDER_STATES = new Set([
  'scheduled',
  'leased',
  'retry_wait',
  'delivered',
  'dead_letter',
  'cancelled',
]);
const ACTIVE_REMINDER_STATES = new Set(['scheduled', 'leased', 'retry_wait']);
const MAX_REQUEST_BYTES = 48 * 1024;
const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 60_000;
const RETRY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];

class TaskServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TaskServiceError(code, message);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, name) {
  if (!isObject(value)) fail('invalid_request', `${name} must be an object`);
}

function assertAllowedKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_request', `${name} contains an unsupported field`);
  }
}

function checkRequestSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('invalid_request', 'request must be JSON serializable'); }
  if (Buffer.byteLength(serialized || '') > MAX_REQUEST_BYTES) fail('request_too_large', 'request is too large');
}

function boundedString(value, name, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('invalid_request', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string') fail('invalid_request', `${name} must be a string`);
  const clean = value.trim();
  if (required && !clean) fail('invalid_request', `${name} is required`);
  if (Buffer.byteLength(clean) > maximum) fail('invalid_request', `${name} is too long`);
  if (/[\u0000]/.test(clean)) fail('invalid_request', `${name} contains invalid characters`);
  return clean || null;
}

function normalizeIdempotencyKey(value) {
  const key = boundedString(value, 'idempotencyKey', 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    fail('invalid_request', 'idempotencyKey must be 8-128 safe characters');
  }
  return key;
}

function normalizeOrigin(value) {
  if (!ORIGINS.has(value)) fail('invalid_request', 'invalid origin');
  return value;
}

function normalizeLocalMoment(value, name) {
  assertObject(value, name);
  assertAllowedKeys(value, new Set(['date', 'time', 'timeZone']), name);
  const date = boundedString(value.date, `${name}.date`, 10, { required: true });
  const time = boundedString(value.time, `${name}.time`, 5, { required: true });
  const timeZone = boundedString(value.timeZone, `${name}.timeZone`, 64, { required: true });
  if (!validDay(date)) fail('invalid_request', `${name}.date is invalid`);
  if (!validTime(time)) fail('invalid_request', `${name}.time is invalid`);
  if (!validTimeZone(timeZone)) fail('invalid_request', `${name}.timeZone is invalid`);
  let atUtc;
  try { atUtc = localDateTimeToUtc(date, time, timeZone); }
  catch (error) { fail('invalid_request', `${name}: ${error.message}`); }
  return { date, time, timeZone, atUtc };
}

function normalizeDue(value) {
  if (value === undefined || value === null) return null;
  assertObject(value, 'due');
  assertAllowedKeys(value, new Set(['date', 'time', 'timeZone']), 'due');
  const date = boundedString(value.date, 'due.date', 10, { required: true });
  if (!validDay(date)) fail('invalid_request', 'due.date is invalid');
  const time = boundedString(value.time, 'due.time', 5);
  const timeZone = boundedString(value.timeZone, 'due.timeZone', 64);
  if (!time) {
    if (timeZone) fail('invalid_request', 'due.timeZone is only allowed with due.time');
    return { date, time: null, timeZone: null, atUtc: null };
  }
  if (!timeZone) fail('invalid_request', 'due.timeZone is required when due.time is supplied');
  return normalizeLocalMoment({ date, time, timeZone }, 'due');
}

function normalizeSources(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) fail('invalid_request', 'sources must contain at most 20 items');
  return value.map((source, index) => {
    assertObject(source, `sources[${index}]`);
    assertAllowedKeys(source, new Set(['title', 'url']), `sources[${index}]`);
    const title = boundedString(source.title, `sources[${index}].title`, 300);
    const url = boundedString(source.url, `sources[${index}].url`, 2_000, { required: true });
    let parsed;
    try { parsed = new URL(url); } catch { fail('invalid_request', `sources[${index}].url is invalid`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail('invalid_request', `sources[${index}].url must use HTTP or HTTPS`);
    if (parsed.username || parsed.password) fail('invalid_request', `sources[${index}].url must not contain credentials`);
    return { title, url };
  });
}

function normalizeStringList(value, name, maximumItems, maximumBytes) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail('invalid_request', `${name} must contain at most ${maximumItems} items`);
  }
  return value.map((item, index) => boundedString(
    item,
    `${name}[${index}]`,
    maximumBytes,
    { required: true },
  ));
}

function normalizeFollowUp(value) {
  if (value === undefined || value === null) return null;
  assertObject(value, 'followUp');
  assertAllowedKeys(value, new Set(['date', 'notification']), 'followUp');
  const date = boundedString(value.date, 'followUp.date', 10, { required: true });
  if (!validDay(date)) fail('invalid_request', 'followUp.date is invalid');
  if (value.notification === undefined || value.notification === null) return { date, notification: null };
  assertObject(value.notification, 'followUp.notification');
  assertAllowedKeys(value.notification, new Set(['time', 'timeZone']), 'followUp.notification');
  const notification = normalizeLocalMoment({ date, ...value.notification }, 'followUp.notification');
  return { date, notification };
}

function normalizeCreateTask(input) {
  assertObject(input, 'request');
  checkRequestSize(input);
  assertAllowedKeys(input, new Set([
    'idempotencyKey',
    'origin',
    'title',
    'details',
    'researchedBrief',
    'due',
    'discordReminders',
    'followUp',
    'sources',
    'checklist',
    'tags',
  ]), 'request');

  const discordReminders = input.discordReminders === undefined || input.discordReminders === null
    ? []
    : input.discordReminders;
  if (!Array.isArray(discordReminders) || discordReminders.length > 10) {
    fail('invalid_request', 'discordReminders must contain at most 10 items');
  }

  return {
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    origin: normalizeOrigin(input.origin),
    title: boundedString(input.title, 'title', 200, { required: true }),
    details: boundedString(input.details, 'details', 12_000),
    researchedBrief: boundedString(input.researchedBrief, 'researchedBrief', 20_000),
    due: normalizeDue(input.due),
    discordReminders: discordReminders.map((item, index) => normalizeLocalMoment(item, `discordReminders[${index}]`)),
    followUp: normalizeFollowUp(input.followUp),
    sources: normalizeSources(input.sources),
    checklist: normalizeStringList(input.checklist, 'checklist', 50, 500),
    tags: normalizeStringList(input.tags, 'tags', 10, 40).map((tag) => tag.replace(/^#/, '')),
  };
}

function normalizeCompletion(input) {
  assertObject(input, 'request');
  checkRequestSize(input);
  assertAllowedKeys(input, new Set([
    'idempotencyKey',
    'origin',
    'taskId',
    'completed',
    'cancelUndeliveredReminders',
  ]), 'request');
  if (typeof input.completed !== 'boolean') fail('invalid_request', 'completed must be a boolean');
  if (input.cancelUndeliveredReminders !== undefined && typeof input.cancelUndeliveredReminders !== 'boolean') {
    fail('invalid_request', 'cancelUndeliveredReminders must be a boolean');
  }
  return {
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    origin: normalizeOrigin(input.origin),
    taskId: boundedString(input.taskId, 'taskId', 128, { required: true }),
    completed: input.completed,
    cancelUndeliveredReminders: input.cancelUndeliveredReminders !== false,
  };
}

function normalizeReceiptQuery(input) {
  assertObject(input, 'request');
  checkRequestSize(input);
  assertAllowedKeys(input, new Set(['operationId', 'taskId', 'idempotencyKey']), 'request');
  const values = [input.operationId, input.taskId, input.idempotencyKey].filter((value) => value !== undefined && value !== null);
  if (values.length !== 1) fail('invalid_request', 'provide exactly one receipt lookup field');
  if (input.operationId !== undefined) return { operationId: boundedString(input.operationId, 'operationId', 128, { required: true }) };
  if (input.taskId !== undefined) return { taskId: boundedString(input.taskId, 'taskId', 128, { required: true }) };
  return { idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(operationType, normalized) {
  const withoutKey = { ...normalized };
  delete withoutKey.idempotencyKey;
  return crypto.createHash('sha256').update(canonicalJson({ operationType, payload: withoutKey })).digest('hex');
}

function migrateTaskWriteSchema(database) {
  if (!isObject(database)) fail('invalid_database', 'database must be an object');
  if (!Array.isArray(database.messages)) database.messages = [];
  if (!Array.isArray(database.reminders)) database.reminders = [];
  if (!Array.isArray(database.tags)) database.tags = [];
  if (!Array.isArray(database.taskOperations)) database.taskOperations = [];
  for (const reminder of database.reminders) {
    if (reminder?.channel !== 'discord' || !REMINDER_STATES.has(reminder?.state)) continue;
    const scheduledAt = Date.parse(reminder.scheduledForUtc);
    if (!Number.isFinite(Date.parse(reminder.expiresAtUtc)) && Number.isFinite(scheduledAt)) {
      reminder.expiresAtUtc = new Date(scheduledAt + DELIVERY_WINDOW_MS).toISOString();
    }
  }
  return database;
}

function operationForIdempotency(database, idempotencyKey) {
  return database.taskOperations.find((operation) => operation.idempotencyKey === idempotencyKey);
}

function safeReminderProjection(reminder) {
  return {
    id: String(reminder.id || '').slice(0, 128),
    state: REMINDER_STATES.has(reminder.state) ? reminder.state : 'dead_letter',
    scheduledForUtc: reminder.scheduledForUtc || null,
    expiresAtUtc: reminder.expiresAtUtc || null,
    displayTimeZone: reminder.displayTimeZone || null,
    attempts: Number.isInteger(reminder.attempts) ? reminder.attempts : 0,
    nextAttemptAtUtc: reminder.nextAttemptAtUtc || null,
    leaseExpiresAtUtc: reminder.leaseExpiresAtUtc || null,
    deliveredAtUtc: reminder.deliveredAtUtc || null,
    cancelledAtUtc: reminder.cancelledAtUtc || null,
    lateByMs: Number.isFinite(reminder.lateByMs) ? reminder.lateByMs : null,
    failureCode: reminder.lastFailureCode || null,
  };
}

function buildReceipt(database, operation) {
  const task = database.messages.find((message) => message.id === operation.taskId);
  if (!task) fail('not_found', 'task receipt is no longer available');
  const reminders = database.reminders
    .filter((reminder) => reminder.taskId === task.id && reminder.channel === 'discord' && REMINDER_STATES.has(reminder.state))
    .sort((left, right) => String(left.scheduledForUtc).localeCompare(String(right.scheduledForUtc)))
    .map(safeReminderProjection);
  const tagNames = (task.tagIds || []).map((id) => database.tags.find((tag) => tag.id === id)?.name).filter(Boolean);

  return {
    operationId: operation.id,
    operationType: operation.type,
    durable: true,
    createdAt: operation.createdAt,
    origin: operation.origin,
    task: {
      id: String(task.id || '').slice(0, 128),
      title: safeTitle(task.text),
      completed: !!task.done,
      completedAt: task.completedAt || null,
      due: task.plannedFor ? {
        date: task.plannedFor,
        time: validTime(task.dueTime) ? task.dueTime : null,
        timeZone: validTimeZone(task.dueTimeZone) ? task.dueTimeZone : null,
        atUtc: task.dueAtUtc || null,
      } : null,
      detailsStored: !!task.details,
      researchedBriefStored: !!task.researchedBrief,
      sourceCount: Array.isArray(task.sources) ? task.sources.length : 0,
      checklistCount: Array.isArray(task.checklist) ? task.checklist.length : 0,
      tags: tagNames.slice(0, 10).map((tag) => safeTitle(tag)),
      followUpDate: task.followUpDate || null,
    },
    reminders,
  };
}

function tagIdsFor(database, names, now, idFactory) {
  const ids = [];
  for (const rawName of names) {
    const name = rawName.trim().replace(/^#/, '');
    if (!name) continue;
    let tag = database.tags.find((candidate) => String(candidate.name || '').toLowerCase() === name.toLowerCase());
    if (!tag) {
      tag = {
        id: idFactory(),
        name,
        color: 'sky',
        keywords: [],
        parent: null,
        createdAt: now,
      };
      database.tags.push(tag);
    }
    ids.push(tag.id);
  }
  return [...new Set(ids)];
}

function newDiscordReminder({ idFactory, task, operationId, moment, kind, now }) {
  return {
    id: idFactory(),
    taskId: task.id,
    operationId,
    channel: 'discord',
    kind,
    text: kind === 'follow_up' ? `Follow up: ${task.text}` : task.text,
    due: moment.atUtc,
    scheduledForUtc: moment.atUtc,
    expiresAtUtc: new Date(Date.parse(moment.atUtc) + DELIVERY_WINDOW_MS).toISOString(),
    displayDate: moment.date,
    displayTime: moment.time,
    displayTimeZone: moment.timeZone,
    state: 'scheduled',
    attempts: 0,
    nextAttemptAtUtc: moment.atUtc,
    leasedAtUtc: null,
    leaseExpiresAtUtc: null,
    leaseToken: null,
    deliveredAtUtc: null,
    cancelledAtUtc: null,
    lateByMs: null,
    lastFailureCode: null,
    done: false,
    notified: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createTaskService({
  getDatabase,
  replaceDatabase,
  persistDatabase,
  deliverDiscord,
  now = () => new Date(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  if (typeof getDatabase !== 'function') throw new TypeError('getDatabase is required');
  if (typeof replaceDatabase !== 'function') throw new TypeError('replaceDatabase is required');
  if (typeof persistDatabase !== 'function') throw new TypeError('persistDatabase is required');
  if (typeof deliverDiscord !== 'function') throw new TypeError('deliverDiscord is required');
  let reminderRun = null;

  function currentNow() {
    const value = now();
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('invalid service clock');
    return parsed;
  }

  function commit(mutator) {
    const next = structuredClone(getDatabase());
    migrateTaskWriteSchema(next);
    const value = mutator(next);
    persistDatabase(next);
    replaceDatabase(next);
    return value;
  }

  function idempotentResult(operationType, normalized) {
    const database = migrateTaskWriteSchema(structuredClone(getDatabase()));
    const existing = operationForIdempotency(database, normalized.idempotencyKey);
    if (!existing) return null;
    if (existing.payloadHash !== payloadHash(operationType, normalized)) {
      fail('idempotency_conflict', 'idempotency key was already used with a different request');
    }
    return buildReceipt(database, existing);
  }

  function createTask(input) {
    const normalized = normalizeCreateTask(input);
    const repeated = idempotentResult('create_task', normalized);
    if (repeated) return repeated;

    const createdAt = currentNow().toISOString();
    return commit((database) => {
      const operation = {
        id: idFactory(),
        type: 'create_task',
        idempotencyKey: normalized.idempotencyKey,
        payloadHash: payloadHash('create_task', normalized),
        origin: normalized.origin,
        taskId: idFactory(),
        createdAt,
      };
      const task = {
        id: operation.taskId,
        text: normalized.title,
        details: normalized.details,
        researchedBrief: normalized.researchedBrief,
        sources: normalized.sources,
        checklist: normalized.checklist,
        createdAt,
        origin: normalized.origin,
        operationId: operation.id,
        pinned: false,
        tagIds: tagIdsFor(database, normalized.tags, createdAt, idFactory),
        files: [],
        list: false,
        checked: [],
        task: true,
        done: false,
        completedAt: null,
        plannedFor: normalized.due?.date || null,
        dueTime: normalized.due?.time || null,
        dueTimeZone: normalized.due?.timeZone || null,
        dueAtUtc: normalized.due?.atUtc || null,
        taskNotified: true,
        followUpDate: normalized.followUp?.date || null,
        parentId: null,
        canvas: { on: false, x: 40, y: 40 },
      };
      database.messages.unshift(task);
      database.taskOperations.push(operation);

      for (const moment of normalized.discordReminders) {
        database.reminders.push(newDiscordReminder({
          idFactory,
          task,
          operationId: operation.id,
          moment,
          kind: 'task_reminder',
          now: createdAt,
        }));
      }
      if (normalized.followUp?.notification) {
        database.reminders.push(newDiscordReminder({
          idFactory,
          task,
          operationId: operation.id,
          moment: normalized.followUp.notification,
          kind: 'follow_up',
          now: createdAt,
        }));
      }
      return buildReceipt(database, operation);
    });
  }

  function setTaskCompletion(input) {
    const normalized = normalizeCompletion(input);
    const repeated = idempotentResult('set_task_completion', normalized);
    if (repeated) return repeated;
    const changedAt = currentNow().toISOString();

    return commit((database) => {
      const task = database.messages.find((message) => message.id === normalized.taskId && message.task && !message.deletedAt);
      if (!task) fail('not_found', 'task was not found');
      task.done = normalized.completed;
      task.completedAt = normalized.completed ? changedAt : null;
      if (!normalized.completed) task.reopenedAt = changedAt;

      if (normalized.completed && normalized.cancelUndeliveredReminders) {
        for (const reminder of database.reminders) {
          if (reminder.taskId !== task.id || reminder.channel !== 'discord' || !ACTIVE_REMINDER_STATES.has(reminder.state)) continue;
          reminder.state = 'cancelled';
          reminder.cancelledAtUtc = changedAt;
          reminder.nextAttemptAtUtc = null;
          reminder.leasedAtUtc = null;
          reminder.leaseExpiresAtUtc = null;
          reminder.leaseToken = null;
          reminder.done = true;
          reminder.updatedAt = changedAt;
        }
      }

      const operation = {
        id: idFactory(),
        type: 'set_task_completion',
        idempotencyKey: normalized.idempotencyKey,
        payloadHash: payloadHash('set_task_completion', normalized),
        origin: normalized.origin,
        taskId: task.id,
        createdAt: changedAt,
      };
      database.taskOperations.push(operation);
      return buildReceipt(database, operation);
    });
  }

  function getTaskReceipt(input) {
    const query = normalizeReceiptQuery(input);
    const database = migrateTaskWriteSchema(structuredClone(getDatabase()));
    let operation;
    if (query.operationId) operation = database.taskOperations.find((candidate) => candidate.id === query.operationId);
    if (query.idempotencyKey) operation = database.taskOperations.find((candidate) => candidate.idempotencyKey === query.idempotencyKey);
    if (query.taskId) {
      operation = database.taskOperations.find((candidate) => candidate.taskId === query.taskId && candidate.type === 'create_task') ||
        [...database.taskOperations].reverse().find((candidate) => candidate.taskId === query.taskId);
    }
    if (!operation) fail('not_found', 'receipt was not found');
    return buildReceipt(database, operation);
  }

  function reminderEligible(reminder, atMs) {
    const expiresAtMs = Date.parse(reminder.expiresAtUtc);
    if (!Number.isFinite(expiresAtMs) || atMs >= expiresAtMs) return false;
    if (reminder.state === 'scheduled') return Date.parse(reminder.scheduledForUtc) <= atMs;
    if (reminder.state === 'retry_wait') return Date.parse(reminder.nextAttemptAtUtc) <= atMs;
    return false;
  }

  function recoverAndListEligible() {
    const at = currentNow();
    const atIso = at.toISOString();
    const atMs = at.getTime();
    const database = migrateTaskWriteSchema(structuredClone(getDatabase()));
    let recovered = 0;
    let expired = 0;
    let changed = false;
    for (const reminder of database.reminders) {
      if (reminder.channel !== 'discord' || !ACTIVE_REMINDER_STATES.has(reminder.state)) continue;
      const expiresAtMs = Date.parse(reminder.expiresAtUtc);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= atMs) {
        reminder.state = 'dead_letter';
        reminder.nextAttemptAtUtc = null;
        reminder.leasedAtUtc = null;
        reminder.leaseExpiresAtUtc = null;
        reminder.leaseToken = null;
        reminder.lastFailureCode = 'delivery_window_expired';
        reminder.lastFailureAtUtc = atIso;
        reminder.done = true;
        reminder.updatedAt = atIso;
        expired += 1;
        changed = true;
        continue;
      }
      if (reminder.state !== 'leased') continue;
      if (Date.parse(reminder.leaseExpiresAtUtc) > atMs) continue;
      reminder.state = 'retry_wait';
      reminder.nextAttemptAtUtc = atIso;
      reminder.leasedAtUtc = null;
      reminder.leaseExpiresAtUtc = null;
      reminder.leaseToken = null;
      reminder.lastFailureCode = 'lease_expired';
      reminder.updatedAt = atIso;
      recovered += 1;
      changed = true;
    }
    if (changed) {
      persistDatabase(database);
      replaceDatabase(database);
    }
    return {
      recovered,
      expired,
      ids: database.reminders
        .filter((reminder) => reminder.channel === 'discord' && reminderEligible(reminder, atMs))
        .sort((left, right) => String(left.nextAttemptAtUtc || left.scheduledForUtc).localeCompare(String(right.nextAttemptAtUtc || right.scheduledForUtc)))
        .slice(0, 20)
        .map((reminder) => reminder.id),
    };
  }

  function leaseReminder(id) {
    const at = currentNow();
    const atIso = at.toISOString();
    const atMs = at.getTime();
    return commit((database) => {
      const reminder = database.reminders.find((candidate) => candidate.id === id && candidate.channel === 'discord');
      if (!reminder || !reminderEligible(reminder, atMs)) return null;
      reminder.state = 'leased';
      reminder.attempts = (Number.isInteger(reminder.attempts) ? reminder.attempts : 0) + 1;
      reminder.leasedAtUtc = atIso;
      reminder.leaseExpiresAtUtc = new Date(atMs + LEASE_MS).toISOString();
      reminder.leaseToken = idFactory();
      reminder.updatedAt = atIso;
      return structuredClone(reminder);
    });
  }

  function markDelivered(leased) {
    const deliveredAt = currentNow();
    commit((database) => {
      const reminder = database.reminders.find((candidate) => candidate.id === leased.id);
      if (!reminder || reminder.state !== 'leased' || reminder.leaseToken !== leased.leaseToken) return false;
      reminder.state = 'delivered';
      reminder.deliveredAtUtc = deliveredAt.toISOString();
      reminder.lateByMs = Math.max(0, deliveredAt.getTime() - Date.parse(reminder.scheduledForUtc));
      reminder.nextAttemptAtUtc = null;
      reminder.leasedAtUtc = null;
      reminder.leaseExpiresAtUtc = null;
      reminder.leaseToken = null;
      reminder.lastFailureCode = null;
      reminder.done = true;
      reminder.notified = true;
      reminder.updatedAt = deliveredAt.toISOString();
      return true;
    });
  }

  function markFailed(leased, failureCode) {
    const failedAt = currentNow();
    commit((database) => {
      const reminder = database.reminders.find((candidate) => candidate.id === leased.id);
      if (!reminder || reminder.state !== 'leased' || reminder.leaseToken !== leased.leaseToken) return false;
      reminder.lastFailureCode = failureCode;
      reminder.lastFailureAtUtc = failedAt.toISOString();
      reminder.leasedAtUtc = null;
      reminder.leaseExpiresAtUtc = null;
      reminder.leaseToken = null;
      const expiresAtMs = Date.parse(reminder.expiresAtUtc);
      if (!Number.isFinite(expiresAtMs) || failedAt.getTime() >= expiresAtMs) {
        reminder.state = 'dead_letter';
        reminder.nextAttemptAtUtc = null;
        reminder.done = true;
      } else {
        const delay = RETRY_BACKOFF_MS[Math.min(reminder.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
        reminder.state = 'retry_wait';
        reminder.nextAttemptAtUtc = new Date(Math.min(failedAt.getTime() + delay, expiresAtMs)).toISOString();
      }
      reminder.updatedAt = failedAt.toISOString();
      return true;
    });
  }

  async function executeReminderCycle() {
    const { recovered, expired, ids } = recoverAndListEligible();
    let delivered = 0;
    let failed = 0;
    for (const id of ids) {
      const leased = leaseReminder(id);
      if (!leased) continue;
      try {
        const response = await deliverDiscord({
          reminderId: leased.id,
          taskId: leased.taskId,
          title: leased.kind === 'follow_up' ? 'Sidebrain follow-up' : 'Sidebrain reminder',
          body: String(leased.text || '').slice(0, 1_500),
          scheduledForUtc: leased.scheduledForUtc,
        });
        if (!(response === true || response?.ok === true)) throw new Error('delivery rejected');
        markDelivered(leased);
        delivered += 1;
      } catch (error) {
        const failureCode = error?.name === 'AbortError' || /timeout/i.test(String(error?.message || ''))
          ? 'discord_timeout'
          : 'discord_delivery_failed';
        markFailed(leased, failureCode);
        failed += 1;
      }
    }
    return { recovered, expired, attempted: ids.length, delivered, failed };
  }

  function runReminderCycle() {
    if (reminderRun) return reminderRun;
    reminderRun = executeReminderCycle().finally(() => { reminderRun = null; });
    return reminderRun;
  }

  return {
    createTask,
    getTaskReceipt,
    runReminderCycle,
    setTaskCompletion,
  };
}

module.exports = {
  ACTIVE_REMINDER_STATES,
  DELIVERY_WINDOW_MS,
  LEASE_MS,
  ORIGINS,
  REMINDER_STATES,
  RETRY_BACKOFF_MS,
  TaskServiceError,
  createTaskService,
  migrateTaskWriteSchema,
  normalizeCreateTask,
};
