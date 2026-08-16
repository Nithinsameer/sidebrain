'use strict';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const MAX_TASKS = 100;
const MAX_FIND_QUERY_BYTES = 200;
const MAX_FIND_RESULTS = 20;
const ACTIVE_REMINDER_STATES = new Set(['scheduled', 'leased', 'retry_wait']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validDay(value) {
  if (!DAY_RE.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function dayInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + count));
  return next.toISOString().slice(0, 10);
}

function redactCredentials(value) {
  return value
    .replace(/https?:\/\/[^\s]+/gi, '[link]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[redacted]');
}

function safeTitle(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redactCredentials(firstLine || 'Untitled task').slice(0, 160);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findMatchScore(title, normalizedQuery) {
  const searchable = normalizeSearchText(title);
  if (!searchable) return null;
  if (searchable === normalizedQuery) return 0;
  if (searchable.startsWith(`${normalizedQuery} `)) return 1;
  if (searchable.includes(normalizedQuery)) return 2;
  const words = searchable.split(' ');
  const tokens = normalizedQuery.split(' ');
  if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return 3;
  if (tokens.every((token) => searchable.includes(token))) return 4;
  return null;
}

function projectFoundTasks(database, options = {}) {
  const allowed = new Set(['query', 'status', 'include_unscheduled', 'limit']);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('request must be an object');
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error('request contains an unsupported field');

  const query = typeof options.query === 'string' ? options.query.trim() : '';
  if (!query) throw new Error('query is required');
  if (Buffer.byteLength(query) > MAX_FIND_QUERY_BYTES) throw new Error('query is too long');
  if (/\u0000/.test(query)) throw new Error('query contains invalid characters');
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) throw new Error('query must contain searchable text');

  const status = options.status ?? 'open';
  if (!['open', 'completed', 'all'].includes(status)) throw new Error('status is invalid');
  const includeUnscheduled = options.include_unscheduled ?? true;
  if (typeof includeUnscheduled !== 'boolean') throw new Error('include_unscheduled must be a boolean');
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_FIND_RESULTS}`);
  }

  const reminders = Array.isArray(database?.reminders) ? database.reminders : [];
  const candidates = [];
  for (const message of Array.isArray(database?.messages) ? database.messages : []) {
    const dueDate = validDay(message?.plannedFor) ? message.plannedFor : null;
    const isLegacyTask = message?.task === undefined && !!dueDate;
    if ((message?.task !== true && !isLegacyTask) || message?.deletedAt) continue;
    const completed = !!message.done;
    if (status === 'open' && completed) continue;
    if (status === 'completed' && !completed) continue;
    if (!includeUnscheduled && !dueDate) continue;

    const title = safeTitle(message?.text);
    const matchScore = findMatchScore(title, normalizedQuery);
    if (matchScore === null) continue;
    const id = String(message?.id || '').slice(0, 128);
    candidates.push({
      matchScore,
      id,
      title,
      status: completed ? 'completed' : 'open',
      dueDate,
      dueTime: dueDate && TIME_RE.test(message?.dueTime || '') ? message.dueTime : null,
      remindersPending: reminders.some((reminder) =>
        reminder?.taskId === message?.id &&
        reminder?.channel === 'discord' &&
        ACTIVE_REMINDER_STATES.has(reminder?.state)),
    });
  }

  candidates.sort((left, right) =>
    left.matchScore - right.matchScore ||
    (left.status === right.status ? 0 : left.status === 'open' ? -1 : 1) ||
    compareText(left.dueDate || '9999-99-99', right.dueDate || '9999-99-99') ||
    compareText(left.dueTime || '99:99', right.dueTime || '99:99') ||
    compareText(left.title, right.title) ||
    compareText(left.id, right.id));

  return {
    tasks: candidates.slice(0, limit).map(({ matchScore: _matchScore, ...task }) => task),
    truncated: candidates.length > limit,
  };
}

function projectUpcomingTasks(database, options = {}) {
  const timeZone = String(options.timeZone || '').trim();
  if (!validTimeZone(timeZone)) throw new Error('invalid timeZone');

  const numericDays = Number(options.days ?? DEFAULT_DAYS);
  if (!Number.isInteger(numericDays) || numericDays < 1 || numericDays > MAX_DAYS) {
    throw new Error(`days must be an integer from 1 to ${MAX_DAYS}`);
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('invalid current time');

  const today = dayInTimeZone(now, timeZone);
  const through = addDays(today, numericDays - 1);
  const candidates = [];

  for (const message of Array.isArray(database?.messages) ? database.messages : []) {
    const dueDate = String(message?.plannedFor || '');
    const isLegacyTask = message?.task === undefined && validDay(dueDate);
    if ((message?.task !== true && !isLegacyTask) || message?.done || message?.deletedAt) continue;
    if (!validDay(dueDate) || dueDate > through) continue;

    const dueTime = TIME_RE.test(message?.dueTime || '') ? message.dueTime : null;
    candidates.push({
      id: String(message?.id || '').slice(0, 128),
      title: safeTitle(message?.text),
      dueDate,
      dueTime,
      timing: dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'upcoming',
    });
  }

  candidates.sort((left, right) =>
    left.dueDate.localeCompare(right.dueDate) ||
    String(left.dueTime || '99:99').localeCompare(String(right.dueTime || '99:99')) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id));

  return {
    asOf: now.toISOString(),
    timeZone,
    window: { from: today, through },
    tasks: candidates.slice(0, MAX_TASKS),
    truncated: candidates.length > MAX_TASKS,
  };
}

module.exports = {
  DEFAULT_DAYS,
  MAX_FIND_QUERY_BYTES,
  MAX_FIND_RESULTS,
  MAX_DAYS,
  MAX_TASKS,
  dayInTimeZone,
  projectFoundTasks,
  projectUpcomingTasks,
  redactCredentials,
  safeTitle,
};
