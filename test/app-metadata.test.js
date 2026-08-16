'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { APP_METADATA_PROPOSAL } = require('../mcp/app-metadata');

test('app metadata proposes the Side Brain identity and reminder routing prompts', () => {
  assert.equal(APP_METADATA_PROPOSAL.displayName, 'Side Brain Tasks');
  assert.match(APP_METADATA_PROPOSAL.description, /^Sidebrain, also spoken or transcribed as Side Brain or side-brain,/);

  const reminderCases = APP_METADATA_PROPOSAL.promptTests.filter((item) => item.expectedTool === 'create_reminder_task');
  assert.equal(reminderCases.length, 5);
  assert.equal(reminderCases.some((item) => item.prompt.includes('Sidebrain')), true);
  assert.equal(reminderCases.some((item) => item.prompt.includes('Side Brain')), true);
  assert.equal(reminderCases.some((item) => item.prompt.includes('side-brain')), true);
  for (const item of reminderCases) assert.match(item.prompt, /remind|notify|alert|Discord/i);

  const ordinary = APP_METADATA_PROPOSAL.promptTests.find((item) => /add a task/i.test(item.prompt));
  assert.equal(ordinary.expectedTool, 'create_task');

  const indirectTask = APP_METADATA_PROPOSAL.promptTests.find((item) => /add this to my tasks/i.test(item.prompt));
  assert.equal(indirectTask.expectedTool, 'create_task');
  const indirectReminder = APP_METADATA_PROPOSAL.promptTests.find((item) => /^Remind me/i.test(item.prompt));
  assert.equal(indirectReminder.expectedTool, 'create_reminder_task');

  const confirmation = APP_METADATA_PROPOSAL.promptTests.find((item) => item.prompt === 'Yes, create that reminder.');
  assert.equal(confirmation.expectedTool, 'create_reminder_task');
  assert.equal(confirmation.mustNotSelect, 'set_task_completion');
});
