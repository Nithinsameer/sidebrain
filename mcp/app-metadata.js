'use strict';

const APP_METADATA_PROPOSAL = Object.freeze({
  displayName: 'Side Brain Tasks',
  description: 'Sidebrain, also spoken or transcribed as Side Brain or side-brain, is Sameer\u2019s personal task, Discord reminder, Govee lighting, and Codex delegation system.',
  promptTests: Object.freeze([
    Object.freeze({
      prompt: 'Sidebrain, remind me to check the oven at 8:30 PM tonight.',
      expectedTool: 'create_reminder_task',
    }),
    Object.freeze({
      prompt: 'Side Brain, notify me on Discord to call Mom tomorrow at 9 AM.',
      expectedTool: 'create_reminder_task',
    }),
    Object.freeze({
      prompt: 'side-brain, alert me at 4 PM to leave for the appointment.',
      expectedTool: 'create_reminder_task',
    }),
    Object.freeze({
      prompt: 'Sidebrain, add a task to buy oat milk.',
      expectedTool: 'create_task',
    }),
    Object.freeze({
      prompt: 'Add this to my tasks: renew the library card.',
      expectedTool: 'create_task',
    }),
    Object.freeze({
      prompt: 'Remind me at 6 PM to take the bread out of the oven.',
      expectedTool: 'create_reminder_task',
    }),
    Object.freeze({
      prompt: 'Yes, create that reminder.',
      expectedTool: 'create_reminder_task',
      mustNotSelect: 'set_task_completion',
    }),
  ]),
});

module.exports = { APP_METADATA_PROPOSAL };
