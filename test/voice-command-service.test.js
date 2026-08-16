'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskService } = require('../lib/task-service');
const { createVoiceCommandService } = require('../lib/voice-command-service');

function harness() {
  let database = {
    settings: {}, tags: [], reminders: [], taskOperations: [], taskDelegations: [], sidebrainLightPresets: [],
    messages: [
      { id: 'a', text: 'Buy milk', task: true, done: false, createdAt: '2026-08-15T10:00:00Z', plannedFor: '2026-08-17', tagIds: [] },
      { id: 'b', text: 'Buy milk for office', task: true, done: false, createdAt: '2026-08-15T11:00:00Z', plannedFor: null, tagIds: [] },
    ],
  };
  const taskService = createTaskService({ getDatabase: () => database, replaceDatabase: (next) => { database = next; }, persistDatabase: () => {}, deliverDiscord: async () => true, now: () => new Date('2026-08-16T12:00:00Z') });
  const calls = [];
  const homeService = {
    listLights: async () => ({ lights: [{ id: 'desk-id', name: 'Desk', online: true }] }),
    controlLights: async (input) => { calls.push(['control', input]); },
    activatePreset: async (input) => { calls.push(['preset', input]); },
    activateScene: async (input) => { calls.push(['scene', input]); },
  };
  const delegationService = { status: () => ({ delegations: [{ title: 'Ship release', state: 'waiting', waitingReason: 'Approve deployment.' }] }) };
  const service = createVoiceCommandService({ getDatabase: () => database, taskService, homeService, delegationService, now: () => new Date('2026-08-16T12:00:00Z') });
  return { service, calls, getDatabase: () => database };
}

test('voice commands list and create tasks and exact Discord reminders with concise text', async () => {
  const { service, getDatabase } = harness();
  const upcoming = await service.execute({ text: 'What is coming up?', timeZone: 'America/New_York' });
  assert.match(upcoming.text, /Buy milk/);
  const created = await service.execute({ text: 'Create task wash the car due tomorrow at 3 PM', timeZone: 'America/New_York' });
  assert.match(created.text, /Created task/);
  assert.equal(getDatabase().messages.find((item) => item.text === 'wash the car').dueTime, '15:00');
  const reminder = await service.execute({ text: 'Remind me to call Mom tomorrow at 9 AM', timeZone: 'America/New_York' });
  assert.match(reminder.text, /Discord reminder/);
  assert.equal(getDatabase().reminders.length, 1);
  const ambiguousDate = await service.execute({ text: 'Create task book flights due next Friday', timeZone: 'America/New_York' });
  assert.equal(ambiguousDate.requiresConfirmation, true);
  assert.equal(getDatabase().messages.some((item) => item.text.includes('next Friday')), false);
});

test('voice completion refuses ambiguous matches until a candidate is selected', async () => {
  const { service, getDatabase } = harness();
  const ambiguous = await service.execute({ text: 'Complete task buy milk', timeZone: 'America/New_York' });
  assert.equal(ambiguous.requiresConfirmation, true);
  assert.equal(getDatabase().messages.filter((item) => item.done).length, 0);
  const confirmation = await service.execute({ text: 'Complete task buy milk', selectionId: 'a', timeZone: 'America/New_York' });
  assert.equal(confirmation.requiresConfirmation, true);
  assert.equal(getDatabase().messages.find((item) => item.id === 'a').done, false);
  const completed = await service.execute({ text: 'Complete task buy milk', selectionId: 'a', confirmed: true, timeZone: 'America/New_York' });
  assert.equal(completed.text, 'Completed Buy milk.');
  assert.equal(getDatabase().messages.find((item) => item.id === 'a').done, true);
});

test('voice commands control lights, presets, scenes, and delegated status through narrow adapters', async () => {
  const { service, calls } = harness();
  assert.match((await service.execute({ text: 'Turn desk light off' })).text, /Done/);
  assert.match((await service.execute({ text: 'Set desk light brightness to 35 percent' })).text, /Done/);
  assert.match((await service.execute({ text: 'Set desk light color to purple' })).text, /Done/);
  assert.match((await service.execute({ text: 'Activate Movie preset' })).text, /Activated Movie preset/);
  assert.match((await service.execute({ text: 'Activate dynamic scene Ocean on desk light' })).text, /Activated Ocean/);
  assert.match((await service.execute({ text: 'Check Codex status for ship release' })).text, /is waiting/);
  assert.deepEqual(calls[0], ['control', { target: ['desk-id'], settings: { power: false } }]);
});
