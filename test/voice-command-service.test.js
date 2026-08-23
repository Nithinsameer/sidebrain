'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskService } = require('../lib/task-service');
const { createVoiceCommandService } = require('../lib/voice-command-service');

function intent(name, values = {}) {
  return {
    intent: name, taskQuery: null, taskTitle: null, dueDate: null, dueTime: null, timeZone: null,
    targets: [], power: null, brightness: null, rgb: null, colorTemperatureK: null,
    sceneName: null, sceneKind: null, presetName: null, receiptReference: null, clarification: null,
    ...values,
  };
}

function harness({ classifyIntent = null, delegationStatus = null } = {}) {
  let database = {
    settings: {}, tags: [], reminders: [], taskOperations: [], taskDelegations: [], sidebrainLightPresets: [],
    messages: [
      { id: 'a', text: 'Buy milk', task: true, done: false, createdAt: '2026-08-15T10:00:00Z', plannedFor: '2026-08-17', tagIds: [] },
      { id: 'b', text: 'Buy milk for office', task: true, done: false, createdAt: '2026-08-15T11:00:00Z', plannedFor: null, tagIds: [] },
      { id: 'c', text: 'File taxes', task: true, done: false, createdAt: '2026-08-10T11:00:00Z', plannedFor: '2026-08-12', tagIds: [] },
      { id: 'd', text: 'Archive receipts', task: true, done: true, completedAt: '2026-08-14T11:00:00Z', createdAt: '2026-08-10T11:00:00Z', plannedFor: null, tagIds: [] },
    ],
  };
  const taskService = createTaskService({
    getDatabase: () => database, replaceDatabase: (next) => { database = next; }, persistDatabase: () => {},
    deliverDiscord: async () => true, now: () => new Date('2026-08-16T12:00:00Z'),
  });
  const calls = [];
  const lights = [
    { id: 'desk-id', name: 'Computer table', online: true },
    { id: 'bed-id', name: 'Bedside', online: true },
    { id: 'door-id', name: 'Door', online: false },
  ];
  const homeService = {
    listLights: async () => ({ lights }),
    controlLights: async (input) => {
      calls.push(['control', input]);
      const selected = input.target === 'all' ? lights : lights.filter((light) => input.target.includes(light.id));
      return { results: selected.map((light) => ({ light, apiAccepted: light.online, stateConfirmed: light.online, ...(light.online ? {} : { skipped: 'offline' }) })) };
    },
    activatePreset: async (input) => {
      calls.push(['preset', input]);
      return { preset: { name: input.name }, changed: lights.slice(0, 2), results: lights.map((light) => ({ light, apiAccepted: light.online, ...(light.online ? {} : { skipped: 'offline' }) })) };
    },
    activateScene: async (input) => {
      calls.push(['scene', input]);
      return { activated: [{ light: lights[0], apiAccepted: true, stateConfirmed: null }] };
    },
  };
  const delegationService = {
    status: delegationStatus || (() => ({ delegations: [{ taskId: 'delegated', title: 'Ship release', state: 'waiting', waitingReason: 'Approve deployment.' }] })),
  };
  const service = createVoiceCommandService({
    getDatabase: () => database, taskService, homeService, delegationService, classifyIntent,
    now: () => new Date('2026-08-16T12:00:00Z'),
  });
  return { service, calls, getDatabase: () => database };
}

test('voice commands list upcoming and overdue work and create a plain task', async () => {
  const { service, getDatabase } = harness();
  assert.match((await service.execute({ text: 'What is coming up?' })).text, /Buy milk/);
  assert.match((await service.execute({ text: 'What is overdue?' })).text, /File taxes/);
  const created = await service.execute({ text: 'Create task wash the car due tomorrow at 3 PM', timeZone: 'America/New_York' });
  assert.match(created.text, /Created task/);
  assert.equal(getDatabase().messages.find((item) => item.text === 'wash the car').dueTime, '15:00');
});

test('interpreted reminders are not written until an opaque spoken confirmation succeeds', async () => {
  const { service, getDatabase } = harness();
  const proposed = await service.execute({ text: 'Remind me to call Mom tomorrow at 9 AM', timeZone: 'America/New_York' });
  assert.equal(proposed.status, 'confirmation_required');
  assert.match(proposed.text, /Monday, August 17, 2026 at 9:00 AM Eastern/);
  assert.equal(getDatabase().reminders.length, 0);
  assert.equal(proposed.text.includes(proposed.confirmationToken), false);
  const created = await service.execute({ confirmationToken: proposed.confirmationToken, confirmationResponse: 'Yes, do it' });
  assert.match(created.text, /Created the reminder/);
  assert.equal(getDatabase().reminders.length, 1);
  const replay = await service.execute({ confirmationToken: proposed.confirmationToken, confirmationResponse: 'yes' });
  assert.equal(replay.errorCode, 'confirmation_expired');
  assert.equal(getDatabase().reminders.length, 1);
});

test('ambiguous completion selects and confirms one task in the second spoken turn; reopening also confirms', async () => {
  const { service, getDatabase } = harness();
  const ambiguous = await service.execute({ text: 'Complete task buy milk' });
  assert.equal(ambiguous.status, 'confirmation_required');
  assert.equal(getDatabase().messages.filter((item) => item.done).length, 1);
  const completed = await service.execute({ confirmationToken: ambiguous.confirmationToken, confirmationResponse: 'Buy milk' });
  assert.equal(completed.text, 'Completed Buy milk.');
  assert.equal(getDatabase().messages.find((item) => item.id === 'a').done, true);

  const reopen = await service.execute({ text: 'Reopen task archive receipts' });
  assert.equal(reopen.status, 'confirmation_required');
  await service.execute({ confirmationToken: reopen.confirmationToken, confirmationResponse: 'yes' });
  assert.equal(getDatabase().messages.find((item) => item.id === 'd').done, false);
});

test('AI-classified natural speech can set combined warm white and brightness through one bounded adapter', async () => {
  const classifyIntent = async () => intent('control_lights', {
    targets: ['Computer table'], brightness: 10, colorTemperatureK: 2700,
  });
  const { service, calls } = harness({ classifyIntent });
  const result = await service.execute({ text: 'Could you make my desk a very dim warm white?' });
  assert.match(result.text, /Computer table/);
  assert.match(result.text, /Computer table is now at 10 percent warm white/);
  assert.deepEqual(calls, [['control', { target: ['desk-id'], settings: { brightness: 10, colorTemperatureK: 2700, power: true } }]]);
});

test('light inventory and presets return short, honest partial results for offline bulbs', async () => {
  const { service, calls } = harness();
  const inventory = await service.execute({ text: 'What lights are online?' });
  assert.match(inventory.text, /Computer table and Bedside are online/);
  assert.match(inventory.text, /Door is offline/);
  const preset = await service.execute({ text: 'Activate Wind Down preset' });
  assert.match(preset.text, /Door is offline/);
  assert.deepEqual(calls[0], ['preset', { name: 'Wind Down' }]);
});

test('multi-light controls continue online bulbs and report an offline target honestly', async () => {
  const { service, calls } = harness({ classifyIntent: async () => intent('control_lights', { targets: ['Computer table', 'Door'], power: false }) });
  const result = await service.execute({ text: 'Turn off the desk and door lights' });
  assert.match(result.text, /Computer table is now off/);
  assert.match(result.text, /Door is offline/);
  assert.deepEqual(calls[0], ['control', { target: ['desk-id', 'door-id'], settings: { power: false } }]);
});

test('find, receipt, Codex creation, Codex marking, and completed summaries stay behind bounded services', async () => {
  const classifiers = [
    intent('find_task', { taskQuery: 'file taxes' }),
    intent('create_task', { taskTitle: 'voice-created receipt task' }),
    intent('check_task_receipt', { receiptReference: 'voice-created receipt task' }),
    intent('create_codex_task', { taskTitle: 'Draft a bounded research plan' }),
    intent('mark_codex_task', { taskQuery: 'file taxes' }),
    intent('codex_result', { taskQuery: 'completed research' }),
  ];
  const { service, getDatabase } = harness({
    classifyIntent: async () => classifiers.shift(),
    delegationStatus: ({ query } = {}) => query === 'completed research'
      ? { delegations: [{ taskId: 'codex-complete', title: 'Completed research', state: 'completed' }] }
      : { delegations: [] },
  });
  assert.match((await service.execute({ text: 'find taxes' })).text, /File taxes is open/);
  const taskServiceReceipt = await service.execute({ text: 'Create task voice-created receipt task' });
  assert.match(taskServiceReceipt.text, /Created task/);
  assert.match((await service.execute({ text: 'check its receipt' })).text, /durably stored/);
  assert.match((await service.execute({ text: 'ask Codex to draft a plan' })).text, /Created the Codex task/);
  const codexTask = getDatabase().messages.find((item) => item.text === 'Draft a bounded research plan');
  const tagNames = codexTask.tagIds.map((id) => getDatabase().tags.find((tag) => tag.id === id)?.name);
  assert.deepEqual(new Set(tagNames), new Set(['codex', 'project:mindchuck']));

  const mark = await service.execute({ text: 'give taxes to Codex' });
  assert.equal(mark.status, 'confirmation_required');
  await service.execute({ confirmationToken: mark.confirmationToken, confirmationResponse: 'yes' });
  const fileTaxes = getDatabase().messages.find((item) => item.id === 'c');
  assert.equal(fileTaxes.tagIds.some((id) => getDatabase().tags.find((tag) => tag.id === id)?.name === 'codex'), true);

  getDatabase().messages.push({ id: 'codex-note', parentId: 'codex-complete', text: 'Found the call brief and next steps.', task: false, done: false, tagIds: [] });
  getDatabase().taskDelegations.push({ taskId: 'codex-complete', state: 'completed', resultNoteId: 'codex-note' });
  assert.match((await service.execute({ text: 'read the completed research' })).text, /Found the call brief/);
});

test('disruptive scenes require confirmation while safe scenes and Codex status stay read-only', async () => {
  const classifierResults = [
    intent('activate_light_scene', { targets: ['Computer table'], sceneName: 'Strobe alarm', sceneKind: 'dynamic' }),
    intent('activate_light_scene', { targets: ['Computer table'], sceneName: 'Ocean', sceneKind: 'dynamic' }),
    intent('codex_status', { taskQuery: 'ship release' }),
  ];
  const { service, calls } = harness({ classifyIntent: async () => classifierResults.shift() });
  const disruptive = await service.execute({ text: 'strobe the desk' });
  assert.equal(disruptive.status, 'confirmation_required');
  assert.equal(calls.length, 0);
  await service.execute({ confirmationToken: disruptive.confirmationToken, confirmationResponse: 'yes' });
  assert.equal(calls[0][1].confirmed, true);
  assert.match((await service.execute({ text: 'use ocean' })).text, /Ocean/);
  assert.match((await service.execute({ text: 'what is Codex doing?' })).text, /waiting/);
});

test('adapter failures never speak raw stack traces, credentials, or provider messages', async () => {
  const { service } = harness({ classifyIntent: async () => intent('control_lights', { targets: ['Computer table'], power: true }) });
  const original = service.execute;
  assert.equal(typeof original, 'function');
  // A missing target is rejected with a bounded public response rather than an internal identifier.
  const result = await harness({ classifyIntent: async () => intent('control_lights', { targets: ['secret-device-123'], power: true }) }).service.execute({ text: 'turn it on' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.text.includes('secret-device-123'), true); // The user's own phrase may be repeated.
  assert.equal(result.text.includes('stack'), false);
});
