'use strict';

const { validDay, validTime, validTimeZone } = require('./time-zone');
const { CANCELLATION_REASONS } = require('./task-service');

const PUBLIC_REMINDER_STATES = new Set([
  'scheduled',
  'leased',
  'retry_wait',
  'delivered',
  'dead_letter',
  'cancelled',
]);

function publicReminderStatus(reminder) {
  if (reminder.state === 'retry_wait') return 'retrying';
  if (reminder.state === 'dead_letter') return 'failed';
  if (reminder.state === 'leased') return reminder.attempts > 1 ? 'retrying' : 'scheduled';
  return reminder.state;
}

function projectTaskReminders(database, taskId) {
  return (Array.isArray(database?.reminders) ? database.reminders : [])
    .filter((reminder) =>
      reminder?.taskId === taskId &&
      reminder?.channel === 'discord' &&
      PUBLIC_REMINDER_STATES.has(reminder?.state))
    .sort((left, right) =>
      String(left.scheduledForUtc || '').localeCompare(String(right.scheduledForUtc || '')) ||
      String(left.id || '').localeCompare(String(right.id || '')))
    .map((reminder) => ({
      status: publicReminderStatus(reminder),
      scheduledForUtc: Number.isFinite(Date.parse(reminder.scheduledForUtc))
        ? new Date(reminder.scheduledForUtc).toISOString()
        : null,
      displayDate: validDay(reminder.displayDate) ? reminder.displayDate : null,
      displayTime: validTime(reminder.displayTime) ? reminder.displayTime : null,
      displayTimeZone: validTimeZone(reminder.displayTimeZone) ? reminder.displayTimeZone : null,
      cancellationReason: reminder.state === 'cancelled' && CANCELLATION_REASONS.has(reminder.cancellationReason)
        ? reminder.cancellationReason
        : null,
    }));
}

function projectMessageForPwa(database, message) {
  const { operationId: _operationId, ...applicationMessage } = message || {};
  return {
    ...applicationMessage,
    discordReminders: projectTaskReminders(database, message?.id),
  };
}

module.exports = {
  PUBLIC_REMINDER_STATES,
  projectMessageForPwa,
  projectTaskReminders,
  publicReminderStatus,
};
