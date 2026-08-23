'use strict';

const crypto = require('node:crypto');
const { projectFoundTasks, projectUpcomingTasks, redactCredentials } = require('./task-projection');
const { localDateTimeToUtc, validDay, validTime, validTimeZone } = require('./time-zone');

const COLORS = Object.freeze({
  red: { red: 255, green: 0, blue: 0 }, orange: { red: 255, green: 128, blue: 0 },
  yellow: { red: 255, green: 220, blue: 0 }, green: { red: 0, green: 255, blue: 0 },
  blue: { red: 0, green: 90, blue: 255 }, purple: { red: 128, green: 0, blue: 255 },
  pink: { red: 255, green: 80, blue: 160 }, white: { red: 255, green: 255, blue: 255 },
});
const YES = /^(?:yes|yeah|yep|confirm|confirmed|do it|go ahead|please do|that'?s right|correct)\b/i;
const NO = /^(?:no|nope|cancel|stop|never mind|don'?t|do not)\b/i;
const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

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
function spoken(text, extra = {}) {
  const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 600);
  return { ok: extra.ok !== false, status: extra.status || (extra.ok === false ? 'error' : 'ok'), text: clean, spokenResponse: clean, ...extra };
}
function safeError(error) {
  const code = String(error?.code || '');
  const messages = {
    govee_not_configured: 'Govee is not configured yet.', govee_unauthorized: 'Govee authentication failed.',
    govee_timeout: 'The lights did not respond in time.', govee_unavailable: 'The lights are unavailable right now.',
    not_found: 'I could not find that item.', ambiguous_scene: 'I found more than one matching scene.',
    invalid_state: 'That action is not available in the current state.',
  };
  return spoken(messages[code] || 'Side Brain could not complete that request.', { ok: false, status: 'error', errorCode: code || 'request_failed' });
}
function friendlyMoment(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const dateText = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
  const [hour, minute] = time.split(':').map(Number);
  const timeText = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
  return `${dateText} at ${timeText} ${timeZone === 'America/New_York' ? 'Eastern' : timeZone}`;
}
function normalizeWords(value) {
  return String(value || '').normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim().replace(/\s+/g, ' ');
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
function baseIntent(intent, values = {}) {
  return {
    intent, taskQuery: null, taskTitle: null, dueDate: null, dueTime: null, timeZone: null, targets: [],
    power: null, brightness: null, rgb: null, colorTemperatureK: null, sceneName: null, sceneKind: null,
    presetName: null, receiptReference: null, clarification: null, ...values,
  };
}
function deterministicIntent(text, now, timeZone) {
  if (/\b(?:overdue tasks?|what(?:'s| is) overdue)\b/i.test(text)) return baseIntent('list_overdue_tasks');
  if (/\b(?:upcoming tasks?|what(?:'s| is) (?:due|coming up)|tasks? (?:due|this week))\b/i.test(text)) return baseIntent('list_upcoming_tasks');
  if (/\bwhat lights? (?:are )?online\b|\blist (?:the )?lights\b/i.test(text)) return baseIntent('list_lights');
  const reminder = /^(?:create (?:a )?(?:discord )?reminder|remind me)\s+(?:to\s+)?(.+?)\s+(?:on\s+)?(\d{4}-\d{2}-\d{2}|today|tomorrow)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(text);
  if (reminder) return baseIntent('create_reminder_task', { taskTitle: reminder[1], dueDate: parseDate(reminder[2], now, timeZone), dueTime: parseTime(reminder[3]), timeZone });
  const create = /^(?:create|add)(?: a)? task(?: to)?\s+(.+?)(?:\s+due\s+(\d{4}-\d{2}-\d{2}|today|tomorrow)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?)?$/i.exec(text);
  if (create) return baseIntent('create_task', { taskTitle: create[1], dueDate: create[2] ? parseDate(create[2], now, timeZone) : null, dueTime: create[3] ? parseTime(create[3]) : null, timeZone });
  const complete = /^(?:find and )?(?:complete|finish|mark done)(?: the)? task\s+(.+)$/i.exec(text);
  if (complete) return baseIntent('complete_task', { taskQuery: complete[1] });
  const reopen = /^reopen(?: the)? task\s+(.+)$/i.exec(text);
  if (reopen) return baseIntent('reopen_task', { taskQuery: reopen[1] });
  const find = /^find(?: the)? task\s+(.+)$/i.exec(text);
  if (find) return baseIntent('find_task', { taskQuery: find[1] });
  const power = /^turn\s+(.+?)\s+(on|off)$/i.exec(text);
  if (power) return baseIntent('control_lights', { targets: [targetPhrase(power[1])], power: power[2].toLowerCase() === 'on' });
  const brightness = /^(?:set|change)\s+(.+?)\s+brightness\s+to\s+(\d{1,3})\s*(?:percent|%)?$/i.exec(text);
  if (brightness) return baseIntent('control_lights', { targets: [targetPhrase(brightness[1])], brightness: Number(brightness[2]) });
  const temperature = /^(?:set|change)\s+(.+?)\s+(?:color )?temperature\s+to\s+(\d{4})\s*(?:kelvin|k)?$/i.exec(text);
  if (temperature) return baseIntent('control_lights', { targets: [targetPhrase(temperature[1])], colorTemperatureK: Number(temperature[2]) });
  const color = /^(?:set|change)\s+(.+?)\s+color\s+to\s+([#a-z0-9]+)$/i.exec(text);
  if (color) return baseIntent('control_lights', { targets: [targetPhrase(color[1])], rgb: rgbFromName(color[2]) });
  const preset = /^(?:activate|use|set)(?: the)?(?: lights? to)?(?: preset)?\s+(.+?)(?:\s+preset)?$/i.exec(text);
  if (/\bpreset\b/i.test(text) && preset) return baseIntent('activate_light_preset', { presetName: preset[1] });
  const scene = /^activate(?: the)?\s+(dynamic|diy|snapshot)?\s*scene\s+(.+?)\s+on\s+(.+)$/i.exec(text);
  if (scene) return baseIntent('activate_light_scene', { targets: [targetPhrase(scene[3])], sceneKind: scene[1]?.toLowerCase() || null, sceneName: scene[2] });
  const delegated = /^(?:check )?(?:the )?(?:codex|delegated task) status(?: for)?\s*(.*)$/i.exec(text);
  if (delegated) return baseIntent('codex_status', { taskQuery: delegated[1] || null });
  if (/^what is codex (?:doing|working on)\??$/i.test(text)) return baseIntent('codex_status');
  return null;
}

function createVoiceCommandService({
  getDatabase, taskService, homeService, delegationService, classifyIntent = null,
  now = () => new Date(), confirmationTtlMs = CONFIRMATION_TTL_MS,
} = {}) {
  if (typeof getDatabase !== 'function' || !taskService || !homeService || !delegationService) throw new TypeError('voice command dependencies are required');
  const confirmations = new Map();

  function idempotencyKey() { return `voice:${crypto.randomUUID()}`; }
  function pruneConfirmations(instant) {
    for (const [token, item] of confirmations) if (item.expiresAt <= instant.getTime()) confirmations.delete(token);
  }
  function requireConfirmation(prompt, action, options = null) {
    const token = crypto.randomBytes(24).toString('base64url');
    confirmations.set(token, { prompt, action, options, expiresAt: now().getTime() + confirmationTtlMs });
    return spoken(prompt, { status: 'confirmation_required', confirmation_required: true, requiresConfirmation: true, confirmationToken: token });
  }
  async function continueConfirmation(input, instant) {
    pruneConfirmations(instant);
    const token = String(input?.confirmationToken || '');
    const pending = confirmations.get(token);
    if (!pending) return spoken('That confirmation expired. Please ask again.', { ok: false, status: 'error', errorCode: 'confirmation_expired' });
    const answer = String(input?.confirmationResponse ?? input?.text ?? '').trim();
    if (NO.test(answer)) {
      confirmations.delete(token);
      return spoken('Okay, I cancelled it.');
    }
    if (pending.options) {
      const query = normalizeWords(answer);
      const exact = pending.options.filter((option) => normalizeWords(option.title || option.name) === query);
      const matches = exact.length ? exact : pending.options.filter((option) => {
        const label = normalizeWords(option.title || option.name);
        return label.includes(query) || query.includes(label);
      });
      if (matches.length !== 1) return spoken(pending.prompt, { status: 'confirmation_required', confirmation_required: true, requiresConfirmation: true, confirmationToken: token });
      confirmations.delete(token);
      return pending.action(matches[0]);
    }
    if (!YES.test(answer)) return spoken(`Please say yes to confirm, or no to cancel. ${pending.prompt}`, { status: 'confirmation_required', confirmation_required: true, requiresConfirmation: true, confirmationToken: token });
    confirmations.delete(token);
    return pending.action();
  }

  async function resolveTargets(names) {
    const listed = await homeService.listLights();
    const requested = names.length ? names : [];
    if (requested.length === 1 && targetPhrase(requested[0]) === 'all') return { target: 'all', names: listed.lights.map((light) => light.name) };
    if (!requested.length) return { error: 'Which light should I use?' };
    const selected = [];
    for (const raw of requested) {
      const query = normalizeWords(targetPhrase(raw));
      const exact = listed.lights.filter((light) => normalizeWords(light.name) === query);
      const matches = exact.length ? exact : listed.lights.filter((light) => normalizeWords(light.name).includes(query));
      if (matches.length !== 1) return { error: matches.length ? `Which light did you mean by ${raw}?` : `I could not find a light named ${raw}.` };
      if (!selected.some((item) => item.id === matches[0].id)) selected.push(matches[0]);
    }
    return { target: selected.map((light) => light.id), names: selected.map((light) => light.name) };
  }
  function partialLightText(action, result, fallbackNames) {
    const entries = Array.isArray(result?.results) ? result.results : [];
    const offline = entries.filter((item) => item.skipped === 'offline').map((item) => item.light.name);
    const changed = entries.filter((item) => item.apiAccepted).map((item) => item.light.name);
    const names = entries.length ? changed : fallbackNames;
    const main = names.length ? `${action} ${names.join(' and ')}` : action;
    if (!names.length && offline.length) return `${offline.join(' and ')} ${offline.length === 1 ? 'is' : 'are'} offline, so I could not make that change.`;
    return offline.length ? `${main}. ${offline.join(' and ')} ${offline.length === 1 ? 'is' : 'are'} offline.` : `${main}.`;
  }
  function settingsPhrase(settings) {
    const parts = [];
    if (settings.power === false) return 'off';
    if (settings.brightness !== undefined) parts.push(`at ${settings.brightness} percent`);
    if (settings.colorTemperatureK !== undefined) parts.push(settings.colorTemperatureK <= 3000 ? 'warm white' : `${settings.colorTemperatureK} kelvin white`);
    if (settings.rgb) parts.push('in the requested color');
    if (!parts.length && settings.power === true) return 'on';
    return parts.join(' ');
  }
  function controlLightText(settings, result, fallbackNames) {
    const entries = Array.isArray(result?.results) ? result.results : [];
    const offline = entries.filter((item) => item.skipped === 'offline').map((item) => item.light.name);
    const changed = entries.filter((item) => item.apiAccepted).map((item) => item.light.name);
    const names = entries.length ? changed : fallbackNames;
    if (!names.length && offline.length) return `${offline.join(' and ')} ${offline.length === 1 ? 'is' : 'are'} offline, so I could not change ${offline.length === 1 ? 'it' : 'them'}.`;
    const state = settingsPhrase(settings);
    const main = names.length === 1 ? `${names[0]} is now ${state}` : `${names.join(' and ')} are now ${state}`;
    return offline.length ? `${main}. ${offline.join(' and ')} ${offline.length === 1 ? 'is' : 'are'} offline.` : `${main}.`;
  }
  function taskMatches(query, status) {
    return projectFoundTasks(getDatabase(), { query, status, include_unscheduled: true, limit: 10 }).tasks;
  }
  function selectTask(query, status, verb, action) {
    const matches = taskMatches(query, status);
    if (!matches.length) return spoken(`I could not find that ${status === 'completed' ? 'completed' : 'open'} task.`, { ok: false, status: 'error', errorCode: 'not_found' });
    if (matches.length === 1) return requireConfirmation(`${verb} ${matches[0].title}?`, () => action(matches[0]));
    const options = matches.slice(0, 5);
    return requireConfirmation(`Which task should I ${verb.toLowerCase()}? ${options.map((item) => item.title).join(', ')}.`, action, options);
  }
  function delegationMatches(query) {
    const result = delegationService.status(query ? { query } : {});
    return result.delegations;
  }

  async function executeIntent(intent, timeZone, instant) {
    switch (intent.intent) {
      case 'list_upcoming_tasks':
      case 'list_overdue_tasks': { // projectUpcomingTasks deliberately includes overdue work in the same safe projection.
        const projected = projectUpcomingTasks(getDatabase(), { timeZone, days: 7, now: instant });
        const tasks = intent.intent === 'list_overdue_tasks'
          ? projected.tasks.filter((task) => task.timing === 'overdue')
          : projected.tasks.filter((task) => task.timing !== 'overdue');
        const label = intent.intent === 'list_overdue_tasks' ? 'overdue' : 'coming up';
        if (!tasks.length) return spoken(`You have no tasks ${label}.`);
        const sample = tasks.slice(0, 3).map((task) => task.title).join(', ');
        return spoken(`You have ${tasks.length} ${label === 'overdue' ? `overdue task${tasks.length === 1 ? '' : 's'}` : `task${tasks.length === 1 ? '' : 's'} coming up`}: ${sample}.`);
      }
      case 'create_task': {
        if (!intent.taskTitle) return spoken('What should the task say?', { ok: false, status: 'ambiguous', errorCode: 'missing_title' });
        const due = intent.dueDate ? { date: intent.dueDate, ...(intent.dueTime ? { time: intent.dueTime, timeZone } : {}) } : null;
        const receipt = taskService.createTask({ idempotencyKey: idempotencyKey(), origin: 'apple_shortcut', title: intent.taskTitle, due });
        return spoken(`Created task: ${receipt.task.title}${due ? `, due ${due.date}${due.time ? ` at ${due.time}` : ''}` : ''}.`);
      }
      case 'create_reminder_task': {
        if (!intent.taskTitle || !intent.dueDate || !intent.dueTime) return spoken('Please include what to remember, an exact date, and a time.', { ok: false, status: 'ambiguous', errorCode: 'missing_reminder_time' });
        if (!validDay(intent.dueDate) || !validTime(intent.dueTime)) return spoken('That reminder date or time is invalid. Please say it again.', { ok: false, status: 'ambiguous', errorCode: 'invalid_reminder_time' });
        try { localDateTimeToUtc(intent.dueDate, intent.dueTime, timeZone); }
        catch { return spoken('That local time is unavailable or ambiguous. Please choose another exact time.', { ok: false, status: 'ambiguous', errorCode: 'invalid_reminder_time' }); }
        const moment = friendlyMoment(intent.dueDate, intent.dueTime, timeZone);
        return requireConfirmation(`I understood ${moment}. Should I create the reminder?`, () => {
          const receipt = taskService.createReminderTask({ idempotency_key: idempotencyKey(), origin: 'apple_shortcut', title: intent.taskTitle, reminder_at: `${intent.dueDate}T${intent.dueTime}`, timezone: timeZone });
          return spoken(`Created the reminder for ${receipt.task.title}.`);
        });
      }
      case 'find_task': {
        if (!intent.taskQuery) return spoken('Which task should I find?', { ok: false, status: 'ambiguous' });
        const matches = taskMatches(intent.taskQuery, 'all');
        if (!matches.length) return spoken('I could not find that task.', { ok: false, status: 'error', errorCode: 'not_found' });
        const describe = (task) => spoken(`${task.title} is ${task.status}${task.dueDate ? ` and due ${task.dueDate}${task.dueTime ? ` at ${task.dueTime}` : ''}` : ''}.`);
        if (matches.length === 1) return describe(matches[0]);
        const options = matches.slice(0, 5);
        return requireConfirmation(`Which task did you mean? ${options.map((item) => item.title).join(', ')}.`, describe, options);
      }
      case 'complete_task':
        if (!intent.taskQuery) return spoken('Which task should I complete?', { ok: false, status: 'ambiguous' });
        return selectTask(intent.taskQuery, 'open', 'Complete', (task) => {
          taskService.setTaskCompletion({ idempotencyKey: idempotencyKey(), origin: 'apple_shortcut', taskId: task.id, completed: true });
          return spoken(`Completed ${task.title}.`);
        });
      case 'reopen_task':
        if (!intent.taskQuery) return spoken('Which task should I reopen?', { ok: false, status: 'ambiguous' });
        return selectTask(intent.taskQuery, 'completed', 'Reopen', (task) => {
          taskService.setTaskCompletion({ idempotencyKey: idempotencyKey(), origin: 'apple_shortcut', taskId: task.id, completed: false });
          return spoken(`Reopened ${task.title}.`);
        });
      case 'check_task_receipt': { // Spoken references resolve to a task; internal receipt IDs are never spoken.
        if (!intent.receiptReference && !intent.taskQuery) return spoken('Which task receipt should I check?', { ok: false, status: 'ambiguous' });
        const query = intent.receiptReference || intent.taskQuery;
        const matches = taskMatches(query, 'all');
        const describe = (task) => {
          const receipt = taskService.getTaskReceipt({ taskId: task.id });
          const reminder = receipt.reminders[0];
          return spoken(`${receipt.task.title} is durably stored${reminder ? `, and its reminder is ${reminder.state.replace('_', ' ')}` : ''}.`);
        };
        if (!matches.length) return spoken('I could not find a receipt for that task.', { ok: false, status: 'error', errorCode: 'not_found' });
        if (matches.length === 1) return describe(matches[0]);
        const options = matches.slice(0, 5);
        return requireConfirmation(`Which task receipt did you mean? ${options.map((item) => item.title).join(', ')}.`, describe, options);
      }
      case 'list_lights': {
        const listed = await homeService.listLights();
        const online = listed.lights.filter((light) => light.online === true).map((light) => light.name);
        const offline = listed.lights.filter((light) => light.online === false).map((light) => light.name);
        const unknown = listed.lights.filter((light) => light.online === null).map((light) => light.name);
        const pieces = [online.length ? `${online.join(' and ')} ${online.length === 1 ? 'is' : 'are'} online` : 'No lights are online'];
        if (offline.length) pieces.push(`${offline.join(' and ')} ${offline.length === 1 ? 'is' : 'are'} offline`);
        if (unknown.length) pieces.push(`${unknown.join(' and ')} has unknown status`);
        return spoken(`${pieces.join('. ')}.`);
      }
      case 'control_lights': {
        const resolved = await resolveTargets(intent.targets);
        if (resolved.error) return spoken(resolved.error, { ok: false, status: 'ambiguous', errorCode: 'ambiguous_light' });
        const settings = {};
        if (intent.power !== null) settings.power = intent.power;
        if (intent.brightness !== null) settings.brightness = intent.brightness;
        if (intent.rgb) settings.rgb = intent.rgb;
        if (intent.colorTemperatureK !== null) settings.colorTemperatureK = intent.colorTemperatureK;
        if (!Object.keys(settings).length) return spoken('What should I change about the lights?', { ok: false, status: 'ambiguous' });
        if (settings.power === undefined && (settings.brightness !== undefined || settings.rgb || settings.colorTemperatureK !== undefined)) settings.power = true;
        const result = await homeService.controlLights({ target: resolved.target, settings });
        return spoken(controlLightText(settings, result, resolved.names));
      }
      case 'activate_light_preset': {
        if (!intent.presetName) return spoken('Which preset should I activate?', { ok: false, status: 'ambiguous' });
        const result = await homeService.activatePreset({ name: intent.presetName });
        return spoken(partialLightText(`${result.preset?.name || intent.presetName} was applied to`, result, result.changed?.map((item) => item.name) || []));
      }
      case 'activate_light_scene': {
        if (!intent.sceneName) return spoken('Which scene should I activate?', { ok: false, status: 'ambiguous' });
        const resolved = await resolveTargets(intent.targets);
        if (resolved.error) return spoken(resolved.error, { ok: false, status: 'ambiguous', errorCode: 'ambiguous_light' });
        const run = async (confirmed) => {
          const result = await homeService.activateScene({ target: resolved.target, kind: intent.sceneKind || undefined, sceneName: intent.sceneName, confirmed });
          return spoken(partialLightText(`${intent.sceneName} was activated on`, { results: result.activated }, resolved.names));
        };
        if (/\b(?:alarm|emergency|flash|flashing|lightning|police|strobe)\b/i.test(intent.sceneName)) {
          return requireConfirmation(`${intent.sceneName} may be disruptive. Should I activate it?`, () => run(true));
        }
        return run(false);
      }
      case 'create_codex_task': {
        if (!intent.taskTitle) return spoken('What should Codex work on?', { ok: false, status: 'ambiguous' });
        const receipt = taskService.createTask({ idempotencyKey: idempotencyKey(), origin: 'apple_shortcut', title: intent.taskTitle, tags: ['codex', 'project:mindchuck'] });
        delegationService.status({ query: receipt.task.title });
        return spoken(`Created the Codex task ${receipt.task.title}.`);
      }
      case 'mark_codex_task': {
        if (!intent.taskQuery) return spoken('Which task should Codex take?', { ok: false, status: 'ambiguous' });
        return selectTask(intent.taskQuery, 'open', 'Delegate', (task) => {
          taskService.markTaskForCodex({ idempotencyKey: idempotencyKey(), origin: 'apple_shortcut', taskId: task.id, projectAlias: 'mindchuck' });
          delegationService.status({ query: task.title });
          return spoken(`Marked ${task.title} for Codex.`);
        });
      }
      case 'codex_status': {
        const matches = delegationMatches(intent.taskQuery);
        if (!matches.length) return spoken('I found no matching Codex task.');
        if (matches.length > 1 && intent.taskQuery) return spoken(`Which Codex task did you mean? ${matches.slice(0, 5).map((item) => item.title).join(', ')}.`, { status: 'ambiguous' });
        const item = matches.find((entry) => ['claimed', 'running', 'waiting'].includes(entry.state)) || matches[0];
        if (item.state === 'waiting') return spoken(`Codex is waiting on ${item.title}. It needs ${item.waitingReason || 'your input'}.`);
        if (item.state === 'claimed' || item.state === 'running') return spoken(`Codex is working on ${item.title}.`);
        return spoken(`${item.title} is ${item.state}.`);
      }
      case 'codex_result': {
        const matches = delegationMatches(intent.taskQuery);
        if (matches.length !== 1) return spoken(matches.length ? 'Which completed Codex task did you mean?' : 'I found no matching completed Codex task.', { ok: false, status: 'ambiguous' });
        const database = getDatabase();
        const record = (database.taskDelegations || []).find((item) => item.taskId === matches[0].taskId);
        const note = record?.resultNoteId ? (database.messages || []).find((item) => item.id === record.resultNoteId && item.parentId === record.taskId) : null;
        if (!note) return spoken(`${matches[0].title} does not have a completed summary yet.`);
        const summary = redactCredentials(String(note.text || '').replace(/\s+/g, ' ').trim()).slice(0, 420);
        return spoken(`${matches[0].title}: ${summary}`);
      }
      case 'ambiguous':
        return spoken(intent.clarification || 'I heard more than one possible request. Please say which one you want.', { ok: false, status: 'ambiguous' });
      case 'help':
        return spoken('I can manage tasks and reminders, control your lights and presets, and check Codex work.');
      default:
        return spoken('I cannot do that by voice. I can only use the approved task, light, reminder, and Codex actions.', { ok: false, status: 'unsupported', errorCode: 'unsupported_intent' });
    }
  }

  async function execute(input) {
    const instant = now();
    if (input?.confirmationToken) {
      try { return await continueConfirmation(input, instant); } catch (error) { return safeError(error); }
    }
    const text = String(input?.text || input?.command || '').trim().replace(/\s+/g, ' ').slice(0, 1_000);
    const timeZone = String(input?.timeZone || 'America/New_York');
    if (!text) return spoken('What should Side Brain do?', { ok: false, status: 'ambiguous', errorCode: 'missing_text' });
    if (!validTimeZone(timeZone)) return spoken('Please choose a valid timezone.', { ok: false, status: 'error', errorCode: 'invalid_timezone' });
    try {
      const classified = classifyIntent ? await classifyIntent({ text, now: instant.toISOString(), timeZone }) : null;
      const intent = classified || deterministicIntent(text, instant, timeZone);
      if (!intent) return spoken('I could not match that to an approved Side Brain action. Please try a more specific request.', { ok: false, status: 'unsupported', errorCode: 'unsupported_intent' });
      const selectedTimeZone = intent.timeZone && validTimeZone(intent.timeZone) ? intent.timeZone : timeZone;
      return await executeIntent(intent, selectedTimeZone, instant);
    } catch (error) {
      if (String(error?.code || '') === 'confirmation_required') return spoken('That action needs confirmation. Please ask again and confirm it.', { status: 'confirmation_required', confirmation_required: true, requiresConfirmation: true });
      return safeError(error);
    }
  }

  return { execute };
}

module.exports = { COLORS, createVoiceCommandService, deterministicIntent, parseDate, parseTime };
