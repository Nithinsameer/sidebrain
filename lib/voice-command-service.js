'use strict';

const crypto = require('node:crypto');
const { projectFoundTasks, projectUpcomingTasks, safeTitle } = require('./task-projection');
const { validTimeZone } = require('./time-zone');

const COLORS = Object.freeze({
  red: { red: 255, green: 0, blue: 0 }, orange: { red: 255, green: 128, blue: 0 },
  yellow: { red: 255, green: 220, blue: 0 }, green: { red: 0, green: 255, blue: 0 },
  blue: { red: 0, green: 90, blue: 255 }, purple: { red: 128, green: 0, blue: 255 },
  pink: { red: 255, green: 80, blue: 160 }, white: { red: 255, green: 255, blue: 255 },
});

function dayAt(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}
function parseDate(raw, now, timeZone) {
  const value = String(raw || '').trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value === 'today') return dayAt(now, timeZone);
  if (value === 'tomorrow') return addDays(dayAt(now, timeZone), 1);
  return null;
}
function parseTime(raw) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(raw || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59 || hour > (match[3] ? 12 : 23) || hour < 0 || (match[3] && hour < 1)) return null;
  if (match[3]) {
    if (hour === 12) hour = 0;
    if (match[3].toLowerCase() === 'pm') hour += 12;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
function response(text, extra = {}) { return { ok: true, text, ...extra }; }
function errorText(error) {
  const code = String(error?.code || '');
  if (code === 'confirmation_required') return response(error.message, { requiresConfirmation: true });
  if (code === 'govee_not_configured') return response('Govee is not configured yet.');
  return response(`I couldn't do that: ${String(error?.message || 'request failed').slice(0, 180)}`, { ok: false });
}
function targetPhrase(raw) {
  const clean = String(raw || '').trim().replace(/^the\s+/i, '').replace(/\s+lights?$/i, '').trim();
  return !clean || /^(?:all|all the)$/i.test(clean) ? 'all' : clean;
}
function rgbFromName(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (COLORS[clean]) return COLORS[clean];
  const hex = /^#?([0-9a-f]{6})$/i.exec(clean)?.[1];
  if (!hex) return null;
  const numeric = Number.parseInt(hex, 16);
  return { red: numeric >> 16, green: (numeric >> 8) & 255, blue: numeric & 255 };
}

function createVoiceCommandService({ getDatabase, taskService, homeService, delegationService, now = () => new Date() } = {}) {
  if (typeof getDatabase !== 'function' || !taskService || !homeService || !delegationService) throw new TypeError('voice command dependencies are required');

  async function resolveTarget(phrase) {
    if (phrase === 'all') return { target: 'all', label: 'all lights' };
    const listed = await homeService.listLights();
    const query = phrase.toLocaleLowerCase('en-US');
    const exact = listed.lights.filter((light) => light.name.toLocaleLowerCase('en-US') === query || light.id === phrase);
    const matches = exact.length ? exact : listed.lights.filter((light) => light.name.toLocaleLowerCase('en-US').includes(query));
    if (matches.length !== 1) return { ambiguous: true, names: matches.map((light) => light.name).slice(0, 5) };
    return { target: [matches[0].id], label: matches[0].name };
  }
  async function runLightControl(phrase, settings) {
    const resolved = await resolveTarget(targetPhrase(phrase));
    if (resolved.ambiguous) {
      const names = resolved.names.length ? resolved.names.join(', ') : 'no matching lights';
      return response(`Which light? I found ${names}.`, { requiresConfirmation: true, candidates: resolved.names });
    }
    await homeService.controlLights({ target: resolved.target, settings });
    return response(`Done. Updated ${resolved.label}.`);
  }

  async function execute(input) {
    const text = String(input?.text || input?.command || '').trim().replace(/\s+/g, ' ');
    const timeZone = String(input?.timeZone || 'America/New_York');
    if (!text) return response('What should Side Brain do?', { ok: false });
    if (!validTimeZone(timeZone)) return response('Please choose a valid timezone.', { ok: false });
    const instant = now();

    try {
      if (/\b(?:upcoming tasks?|what(?:'s| is) (?:due|coming up)|tasks? (?:due|this week))\b/i.test(text)) {
        const result = projectUpcomingTasks(getDatabase(), { timeZone, days: 7, now: instant });
        if (!result.tasks.length) return response('You have no tasks due in the next seven days.');
        const items = result.tasks.slice(0, 5).map((task) => `${task.title}, ${task.timing === 'today' ? 'today' : task.dueDate}${task.dueTime ? ` at ${task.dueTime}` : ''}`);
        return response(`${result.tasks.length} upcoming. ${items.join('. ')}.`);
      }

      const reminder = /^(?:create (?:a )?(?:discord )?reminder|remind me)\s+(?:to\s+)?(.+?)\s+(?:on\s+)?(\d{4}-\d{2}-\d{2}|today|tomorrow)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(text);
      if (reminder) {
        const date = parseDate(reminder[2], instant, timeZone);
        const time = parseTime(reminder[3]);
        if (!date || !time) return response('Please say an exact date and time for the reminder.', { requiresConfirmation: true });
        const receipt = taskService.createReminderTask({
          idempotency_key: `shortcut:${crypto.randomUUID()}`, origin: 'apple_shortcut', title: reminder[1],
          reminder_at: `${date}T${time}`, timezone: timeZone,
        });
        return response(`Created a Discord reminder for ${receipt.task.title} on ${date} at ${time}.`);
      }
      if (/\b(?:remind|reminder|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b/i.test(text) && /\b(?:remind|reminder)\b/i.test(text)) {
        return response('Please say the reminder with an exact date or today or tomorrow, plus a time.', { requiresConfirmation: true });
      }

      if (/^(?:create|add)(?: a)? task\b/i.test(text) && /\bdue\s+(?:next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)) {
        return response('Please confirm the task with an exact YYYY-MM-DD date.', { requiresConfirmation: true });
      }
      const create = /^(?:create|add)(?: a)? task(?: to)?\s+(.+?)(?:\s+due\s+(\d{4}-\d{2}-\d{2}|today|tomorrow)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?)?$/i.exec(text);
      if (create) {
        const date = create[2] ? parseDate(create[2], instant, timeZone) : null;
        const time = create[3] ? parseTime(create[3]) : null;
        if ((create[2] && !date) || (create[3] && !time)) return response('Please confirm the task with an exact date and time.', { requiresConfirmation: true });
        const receipt = taskService.createTask({
          idempotencyKey: `shortcut:${crypto.randomUUID()}`, origin: 'apple_shortcut', title: create[1],
          due: date ? { date, ...(time ? { time, timeZone } : {}) } : null,
        });
        return response(`Created task: ${receipt.task.title}${date ? `, due ${date}${time ? ` at ${time}` : ''}` : ''}.`);
      }

      const complete = /^(?:find and )?(?:complete|finish|mark done)(?: the)? task\s+(.+)$/i.exec(text);
      if (complete) {
        const found = projectFoundTasks(getDatabase(), { query: complete[1], status: 'open', include_unscheduled: true, limit: 10 });
        const selected = input.selectionId ? found.tasks.filter((task) => task.id === input.selectionId) : found.tasks;
        if (selected.length !== 1) {
          return response(selected.length ? `Which task? ${selected.slice(0, 5).map((task) => task.title).join(', ')}.` : 'I could not find that open task.', {
            requiresConfirmation: selected.length > 1,
            candidates: selected.slice(0, 5).map((task) => ({ id: task.id, title: task.title })),
          });
        }
        if (input.confirmed !== true) {
          return response(`Complete ${selected[0].title}? This will cancel its undelivered reminders.`, {
            requiresConfirmation: true,
            candidates: [{ id: selected[0].id, title: selected[0].title }],
          });
        }
        taskService.setTaskCompletion({
          idempotencyKey: `shortcut:${crypto.randomUUID()}`, origin: 'apple_shortcut', taskId: selected[0].id, completed: true,
        });
        return response(`Completed ${selected[0].title}.`);
      }

      const power = /^turn\s+(.+?)\s+(on|off)$/i.exec(text);
      if (power) return await runLightControl(power[1], { power: power[2].toLowerCase() === 'on' });
      const brightness = /^(?:set|change)\s+(.+?)\s+brightness\s+to\s+(\d{1,3})\s*(?:percent|%)?$/i.exec(text);
      if (brightness) return await runLightControl(brightness[1], { brightness: Number(brightness[2]) });
      const temperature = /^(?:set|change)\s+(.+?)\s+(?:color )?temperature\s+to\s+(\d{4})\s*(?:kelvin|k)?$/i.exec(text);
      if (temperature) return await runLightControl(temperature[1], { colorTemperatureK: Number(temperature[2]) });
      const color = /^(?:set|change)\s+(.+?)\s+color\s+to\s+([#a-z0-9]+)$/i.exec(text);
      if (color) {
        const rgb = rgbFromName(color[2]);
        if (!rgb) return response('Use a named color or a six-digit hex color.', { ok: false });
        return await runLightControl(color[1], { rgb });
      }

      const preset = /^(?:activate|use|set)(?: the)?(?: lights? to)?(?: preset)?\s+(.+?)(?:\s+preset)?$/i.exec(text);
      if (/\bpreset\b/i.test(text) && preset) {
        await homeService.activatePreset({ name: preset[1] });
        return response(`Activated ${preset[1]} preset.`);
      }
      const scene = /^activate(?: the)?\s+(dynamic|diy|snapshot)?\s*scene\s+(.+?)\s+on\s+(.+)$/i.exec(text);
      if (scene) {
        const resolved = await resolveTarget(targetPhrase(scene[3]));
        if (resolved.ambiguous) return response(`Which light? ${resolved.names.join(', ')}.`, { requiresConfirmation: true, candidates: resolved.names });
        await homeService.activateScene({
          target: resolved.target, kind: scene[1]?.toLowerCase(), sceneName: scene[2], confirmed: input.confirmed === true,
        });
        return response(`Activated ${scene[2]} on ${resolved.label}.`);
      }

      const delegated = /^(?:check )?(?:the )?(?:codex|delegated task) status(?: for)?\s*(.*)$/i.exec(text);
      if (delegated) {
        const result = delegationService.status(delegated[1] ? { query: delegated[1] } : {});
        if (!result.delegations.length) return response('I found no matching delegated Codex task.');
        if (result.delegations.length > 1 && delegated[1]) {
          return response(`Which delegated task? ${result.delegations.slice(0, 5).map((item) => item.title).join(', ')}.`, { requiresConfirmation: true });
        }
        const item = result.delegations[0];
        const detail = item.state === 'waiting' && item.waitingReason ? ` It needs: ${item.waitingReason}` : '';
        return response(`${item.title} is ${item.state}.${detail}`);
      }

      return response('I can handle tasks, Discord reminders, lights, presets, scenes, upcoming tasks, and Codex task status. Please try a more specific command.', { ok: false });
    } catch (error) {
      return errorText(error);
    }
  }

  return { execute };
}

module.exports = { COLORS, createVoiceCommandService, parseDate, parseTime };
