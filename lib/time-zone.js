'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatterCache = new Map();

function validDay(value) {
  if (!DAY_RE.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function validTime(value) {
  return TIME_RE.test(value || '');
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localMinuteAt(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function localDateTimeToUtc(date, time, timeZone) {
  if (!validDay(date)) throw new Error('invalid date');
  if (!validTime(time)) throw new Error('invalid time');
  if (!validTimeZone(timeZone)) throw new Error('invalid timeZone');

  const target = `${date}T${time}`;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const approximate = Date.UTC(year, month - 1, day, hour, minute);
  const matches = [];

  // IANA offsets range from UTC-12 to UTC+14. Scanning a bounded 36-hour
  // minute window lets us reject both nonexistent and repeated local minutes
  // without guessing at DST transitions or relying on the host timezone.
  for (let offsetMinutes = -18 * 60; offsetMinutes <= 18 * 60; offsetMinutes += 1) {
    const candidate = new Date(approximate + offsetMinutes * 60_000);
    if (localMinuteAt(candidate, timeZone) === target) matches.push(candidate);
    if (matches.length > 1) break;
  }

  if (matches.length === 0) throw new Error('local time does not exist in the requested timeZone');
  if (matches.length > 1) throw new Error('local time is ambiguous in the requested timeZone');
  return matches[0].toISOString();
}

module.exports = {
  DAY_RE,
  TIME_RE,
  localDateTimeToUtc,
  validDay,
  validTime,
  validTimeZone,
};
