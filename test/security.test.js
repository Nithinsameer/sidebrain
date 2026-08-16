'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SECRET_VALUES = {
  captureToken: 'test-capture-token-7b4b8f5f',
  openaiKey: 'test-openai-key-e62f8fb2',
  ntfyTopic: 'test-ntfy-topic-557c01b5',
  discordWebhook: 'https://discord.invalid/api/webhooks/test-secret',
  discordBotToken: 'test-discord-bot-token-f4e9d5b0',
  discordCaptureChannel: 'test-discord-channel-683902',
  telegramToken: 'test-telegram-token-b7dc3f15',
  telegramChatId: 'test-telegram-chat-58310',
};

let serverProcess;
let temporaryDataDirectory;
let temporaryMcpRuntimeDirectory;
let baseUrl;
let serverOutput = '';

function testDatabase() {
  return {
    settings: {
      theme: 'dark',
      font: 'courier',
      compact: false,
      hideTagNav: false,
      groupByTime: true,
      boardColumns: [],
      aiBaseUrl: 'https://api.example.invalid/v1',
      aiModel: 'test-model',
      digestHour: null,
      circSeeded: true,
      discordLastMsgId: 'internal-message-id',
      ...SECRET_VALUES,
    },
    automations: [],
    circulations: [],
    tags: [{ id: 'test-tag', name: 'test', color: 'sky', keywords: [], parent: null }],
    habits: { '2026-01-01': { gym: true } },
    messages: [{
      id: 'existing-note',
      text: 'Existing test note',
      createdAt: '2026-01-01T12:00:00.000Z',
      pinned: false,
      tagIds: [],
      files: [],
      list: false,
      checked: [],
      task: false,
      done: false,
      operationId: 'internal-message-operation-27d41c',
      plannedFor: null,
      dueTime: null,
      taskNotified: false,
      parentId: null,
      canvas: { on: false, x: 40, y: 40 },
    }],
    reminders: [{
      id: 'existing-reminder',
      text: 'Existing test reminder',
      due: '2099-01-01T12:00:00.000Z',
      done: false,
      createdAt: '2026-01-01T12:00:00.000Z',
    }, {
      id: 'internal-discord-reminder',
      taskId: 'existing-note',
      text: 'Internal Discord reminder',
      due: '2099-01-02T12:00:00.000Z',
      scheduledForUtc: '2099-01-02T12:00:00.000Z',
      displayDate: '2099-01-02',
      displayTime: '07:00',
      displayTimeZone: 'America/New_York',
      channel: 'discord',
      state: 'scheduled',
      attempts: 0,
      leaseToken: 'internal-lease-secret-96c1',
      done: false,
    }],
    taskOperations: [{
      id: 'internal-operation',
      idempotencyKey: 'internal-idempotency-secret-402d',
      payloadHash: 'internal-payload-hash',
    }],
  };
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start\n${serverOutput}`)), 5000);
    const inspect = (chunk) => {
      serverOutput += chunk.toString();
      const match = serverOutput.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    serverProcess.stdout.on('data', inspect);
    serverProcess.stderr.on('data', inspect);
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before becoming ready (${code})\n${serverOutput}`));
    });
  });
}

test.before(async () => {
  temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebrain-security-test-'));
  temporaryMcpRuntimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-'));
  fs.writeFileSync(
    path.join(temporaryDataDirectory, 'db.json'),
    JSON.stringify(testDatabase(), null, 2),
  );

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      SIDEBRAIN_DATA_DIR: temporaryDataDirectory,
      SIDEBRAIN_LISTEN_HOST: '127.0.0.1',
      SIDEBRAIN_MCP_RUNTIME_DIR: temporaryMcpRuntimeDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = await waitForServer();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit');
  }
  if (temporaryDataDirectory) fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
  if (temporaryMcpRuntimeDirectory) fs.rmSync(temporaryMcpRuntimeDirectory, { recursive: true, force: true });
});

test('GET /api/state preserves application data while redacting secret settings', async () => {
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  const serialized = JSON.stringify(state);

  assert.equal(state.settings.theme, 'dark');
  assert.equal(state.messages[0].id, 'existing-note');
  assert.equal('operationId' in state.messages[0], false);
  assert.deepEqual(state.messages[0].discordReminders, [{
    status: 'scheduled',
    scheduledForUtc: '2099-01-02T12:00:00.000Z',
    displayDate: '2099-01-02',
    displayTime: '07:00',
    displayTimeZone: 'America/New_York',
    cancellationReason: null,
  }]);
  assert.equal(state.reminders[0].id, 'existing-reminder');
  assert.equal(state.reminders.length, 1);
  assert.equal(state.habits['2026-01-01'].gym, true);
  assert.equal('discordLastMsgId' in state.settings, false);
  assert.equal('taskOperations' in state, false);
  assert.equal(serialized.includes('internal-lease-secret-96c1'), false);
  assert.equal(serialized.includes('internal-idempotency-secret-402d'), false);
  assert.equal(serialized.includes('Internal Discord reminder'), false);
  assert.equal(serialized.includes('internal-message-operation-27d41c'), false);

  for (const [key, value] of Object.entries(SECRET_VALUES)) {
    assert.equal(key in state.settings, false, `${key} must not be returned`);
    assert.equal(state.settings[`${key}Configured`], true);
    assert.equal(serialized.includes(value), false, `${key} value must not occur in the response`);
  }
});

test('PATCH /api/settings returns configured flags instead of secret values', async () => {
  const replacementKey = 'test-replacement-openai-key-c99a0e7d';
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'light', openaiKey: replacementKey }),
  });
  assert.equal(response.status, 200);
  const settings = await response.json();
  const serialized = JSON.stringify(settings);

  assert.equal(settings.theme, 'light');
  assert.equal(settings.openaiKeyConfigured, true);
  assert.equal('openaiKey' in settings, false);
  assert.equal(serialized.includes(replacementKey), false);

  for (const value of Object.values(SECRET_VALUES)) {
    assert.equal(serialized.includes(value), false);
  }
});

test('capture rejects query credentials and accepts the Authorization header', async () => {
  const queryResponse = await fetch(
    `${baseUrl}/api/capture?token=${encodeURIComponent(SECRET_VALUES.captureToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'query credential must fail', raw: true }),
    },
  );
  assert.equal(queryResponse.status, 400);
  assert.deepEqual(await queryResponse.json(), {
    error: 'capture token must be sent in the Authorization header',
  });

  const headerResponse = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET_VALUES.captureToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: 'header credential succeeds', raw: true, tagIds: ['test-tag'] }),
  });
  assert.equal(headerResponse.status, 201);
  assert.equal((await headerResponse.json()).text, 'header credential succeeds');
});

test('startup logs do not contain configured credentials', () => {
  for (const [key, value] of Object.entries(SECRET_VALUES)) {
    assert.equal(serverOutput.includes(value), false, `${key} must not occur in startup logs`);
  }
  assert.match(serverOutput, /voice capture: Bearer token required/);
});
