'use strict';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const MAX_TASKS = 100;
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
  MAX_DAYS,
  MAX_TASKS,
  dayInTimeZone,
  projectUpcomingTasks,
};
