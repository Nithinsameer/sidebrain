'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const FIXED_NOW = '2026-08-16T03:30:00.000Z';
let temporaryDirectory;
let dataDirectory;
let runtimeDirectory;
let socketPath;
let tokenPath;
let serverProcess;
let serverOutput = '';
let baseUrl;

function fixtureDatabase() {
  return {
    settings: {
      captureToken: 'fixture-capture-secret-0d5921',
      openaiKey: '',
      ntfyTopic: 'fixture-topic-secret-4f96ca',
    },
    tags: [],
    messages: [{
      id: 'integration-task',
      text: 'Review Gate 2\nprivate-source-body-a37e16',
      task: true,
      done: false,
      plannedFor: '2026-08-15',
      dueTime: '10:00',
      files: [{ url: '/uploads/private-upload-e214a5' }],
      privateConfiguration: 'private-config-c7b9f2',
    }],
    reminders: [{ text: 'private-reminder-6d8e01' }],
    automations: [{ prompt: 'private-automation-39edcc' }],
    circulations: [],
    habits: {},
  };
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start\n${serverOutput}`)), 5000);
    const inspect = (chunk) => {
      serverOutput += chunk.toString();
      if (serverOutput.includes('private MCP IPC: ready')) {
        clearTimeout(timeout);
        const port = /http:\/\/localhost:(\d+)/.exec(serverOutput)?.[1];
        if (!port) return reject(new Error(`server port was not reported\n${serverOutput}`));
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
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

function ipcRequest(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(response.trim())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

test.before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebrain-mcp-test-'));
  dataDirectory = path.join(temporaryDirectory, 'data');
  runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-'));
  socketPath = path.join(runtimeDirectory, 'readonly.sock');
  tokenPath = path.join(runtimeDirectory, 'readonly.token');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, 'db.json'), JSON.stringify(fixtureDatabase(), null, 2));

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      SIDEBRAIN_DATA_DIR: dataDirectory,
      SIDEBRAIN_LISTEN_HOST: '127.0.0.1',
      SIDEBRAIN_MCP_RUNTIME_DIR: runtimeDirectory,
      SIDEBRAIN_MCP_TEST_NOW: FIXED_NOW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit');
  }
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  if (runtimeDirectory) fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

test('IPC authorization rejects missing and invalid credentials and protects runtime files', async () => {
  assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

  const missing = await ipcRequest({ action: 'get_upcoming_tasks', params: { timeZone: 'America/New_York' } });
  const invalid = await ipcRequest({ action: 'get_upcoming_tasks', authorization: 'wrong', params: { timeZone: 'America/New_York' } });
  assert.deepEqual(missing, { ok: false, error: 'unauthorized' });
  assert.deepEqual(invalid, { ok: false, error: 'unauthorized' });
});

test('authorized IPC is allowlisted to exactly the six task actions', async () => {
  const authorization = fs.readFileSync(tokenPath, 'utf8').trim();
  const unsupported = await ipcRequest({ action: 'read_database', authorization, params: {} });
  assert.deepEqual(unsupported, { ok: false, error: 'unsupported action' });
  const invalidShape = await ipcRequest({ action: 'create_task', authorization, params: [] });
  assert.deepEqual(invalidShape, { ok: false, error: 'invalid request', code: 'invalid_request' });

  const response = await ipcRequest({
    action: 'get_upcoming_tasks',
    authorization,
    params: { timeZone: 'America/New_York', days: 7 },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.tasks, [{
    id: 'integration-task',
    title: 'Review Gate 2',
    dueDate: '2026-08-15',
    dueTime: '10:00',
    timing: 'today',
  }]);

  const malformed = await ipcRequest({
    action: 'create_task', authorization, params: { origin: 'chatgpt', title: 'Missing idempotency key' },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'invalid_request');

  const created = await ipcRequest({
    action: 'create_task',
    authorization,
    params: {
      idempotencyKey: 'ipc-create-task-0001',
      origin: 'chatgpt_voice',
      title: 'Pick up dry cleaning',
      discordReminders: [{ date: '2026-08-20', time: '17:00', timeZone: 'America/New_York' }],
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.result.durable, true);
  assert.equal(created.result.task.title, 'Pick up dry cleaning');
  assert.equal(created.result.reminders[0].state, 'scheduled');

  const reminderTask = await ipcRequest({
    action: 'create_reminder_task',
    authorization,
    params: {
      idempotency_key: 'ipc-voice-reminder-01',
      origin: 'chatgpt_voice',
      title: 'Voice reminder integration',
      reminder_at: '2026-08-16T00:45',
      timezone: 'America/New_York',
    },
  });
  assert.equal(reminderTask.ok, true);
  assert.equal(reminderTask.result.operationType, 'create_reminder_task');
  assert.deepEqual(reminderTask.result.task.tags, ['Reminder']);
  assert.deepEqual(reminderTask.result.task.due, {
    date: '2026-08-16',
    time: '00:45',
    timeZone: 'America/New_York',
    atUtc: '2026-08-16T04:45:00.000Z',
  });
  assert.equal(reminderTask.result.reminders.length, 1);
  assert.equal(reminderTask.result.reminders[0].state, 'scheduled');

  const persistedBeforeReads = fs.readFileSync(path.join(dataDirectory, 'db.json'), 'utf8');
  const replayedReminderTask = await ipcRequest({
    action: 'create_reminder_task',
    authorization,
    params: {
      idempotency_key: 'ipc-voice-reminder-01',
      origin: 'chatgpt_voice',
      title: 'Voice reminder integration',
      reminder_at: '2026-08-16T00:45',
      timezone: 'America/New_York',
    },
  });
  assert.deepEqual(replayedReminderTask.result, reminderTask.result);
  const reminderReceipt = await ipcRequest({
    action: 'get_task_receipt', authorization, params: { taskId: reminderTask.result.task.id },
  });
  assert.equal(reminderReceipt.result.reminders[0].state, 'scheduled');

  const pwaStateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(pwaStateResponse.status, 200);
  const pwaState = await pwaStateResponse.json();
  const pwaReminderTask = pwaState.messages.find((message) => message.id === reminderTask.result.task.id);
  assert.deepEqual(pwaReminderTask.discordReminders, [{
    status: 'scheduled',
    scheduledForUtc: '2026-08-16T04:45:00.000Z',
    displayDate: '2026-08-16',
    displayTime: '00:45',
    displayTimeZone: 'America/New_York',
    cancellationReason: null,
  }]);
  assert.equal(fs.readFileSync(path.join(dataDirectory, 'db.json'), 'utf8'), persistedBeforeReads);
  const serializedPwaTask = JSON.stringify(pwaReminderTask);
  for (const forbidden of ['leaseToken', 'operationId', 'discordWebhook', 'lastFailureCode']) {
    assert.equal(serializedPwaTask.includes(forbidden), false);
  }

  const found = await ipcRequest({
    action: 'find_tasks', authorization, params: { query: 'dry cleaning' },
  });
  assert.equal(found.ok, true);
  assert.deepEqual(found.result.tasks.map((task) => task.id), [created.result.task.id]);
  assert.equal(found.result.tasks[0].remindersPending, true);

  const receipt = await ipcRequest({
    action: 'get_task_receipt', authorization, params: { taskId: created.result.task.id },
  });
  assert.deepEqual(receipt.result, created.result);

  const completed = await ipcRequest({
    action: 'set_task_completion',
    authorization,
    params: {
      idempotencyKey: 'ipc-complete-task-01',
      origin: 'chatgpt_voice',
      taskId: created.result.task.id,
      completed: true,
    },
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.result.task.completed, true);
  assert.equal(completed.result.reminders[0].state, 'cancelled');
});

test('PWA completion cancels Gate 3 reminders and reopening does not re-arm them', async () => {
  const authorization = fs.readFileSync(tokenPath, 'utf8').trim();
  const created = await ipcRequest({
    action: 'create_task',
    authorization,
    params: {
      idempotencyKey: 'pwa-path-create-001',
      origin: 'chatgpt',
      title: 'PWA completion integration',
      discordReminders: [{ date: '2026-08-21', time: '09:00', timeZone: 'America/New_York' }],
    },
  });
  const taskId = created.result.task.id;

  const alreadyOpenResponse = await fetch(`${baseUrl}/api/messages/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: false }),
  });
  assert.equal(alreadyOpenResponse.status, 200);
  const alreadyOpenTask = await alreadyOpenResponse.json();
  assert.equal(alreadyOpenTask.done, false);
  assert.equal(alreadyOpenTask.discordReminders[0].status, 'scheduled');

  const completedResponse = await fetch(`${baseUrl}/api/messages/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(completedResponse.status, 200);
  const completedTask = await completedResponse.json();
  assert.equal(completedTask.id, taskId);
  assert.equal(completedTask.done, true);
  assert.equal('result' in completedTask, false);
  assert.equal('receipt' in completedTask, false);
  assert.equal(completedTask.discordReminders[0].status, 'cancelled');
  assert.equal(completedTask.discordReminders[0].cancellationReason, 'task_completed');

  const cancelledReceipt = await ipcRequest({
    action: 'get_task_receipt', authorization, params: { taskId },
  });
  assert.equal(cancelledReceipt.result.task.completed, true);
  assert.equal(cancelledReceipt.result.reminders[0].state, 'cancelled');
  assert.equal(cancelledReceipt.result.reminders[0].cancellationReason, 'task_completed');

  const reopenedResponse = await fetch(`${baseUrl}/api/messages/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: false }),
  });
  assert.equal(reopenedResponse.status, 200);
  const reopenedTask = await reopenedResponse.json();
  assert.equal(reopenedTask.id, taskId);
  assert.equal(reopenedTask.done, false);
  assert.equal(reopenedTask.discordReminders[0].status, 'cancelled');
  const reopenedReceipt = await ipcRequest({
    action: 'get_task_receipt', authorization, params: { taskId },
  });
  assert.equal(reopenedReceipt.result.task.completed, false);
  assert.equal(reopenedReceipt.result.reminders[0].state, 'cancelled');
});

test('PWA completion remains compatible with legacy tasks', async () => {
  const authorization = fs.readFileSync(tokenPath, 'utf8').trim();
  for (const done of [true, false]) {
    const response = await fetch(`${baseUrl}/api/messages/integration-task`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    assert.equal(response.status, 200);
    const task = await response.json();
    assert.equal(task.id, 'integration-task');
    assert.equal(task.done, done);
  }
  const receipt = await ipcRequest({
    action: 'get_task_receipt', authorization, params: { taskId: 'integration-task' },
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.result.origin, 'pwa');
  assert.equal(receipt.result.task.completed, false);
});

test('a second main process cannot replace an active private socket', async () => {
  const secondDataDirectory = path.join(temporaryDirectory, 'second-data');
  fs.mkdirSync(secondDataDirectory, { recursive: true });
  fs.writeFileSync(path.join(secondDataDirectory, 'db.json'), JSON.stringify(fixtureDatabase()));
  const second = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      SIDEBRAIN_DATA_DIR: secondDataDirectory,
      SIDEBRAIN_LISTEN_HOST: '127.0.0.1',
      SIDEBRAIN_MCP_RUNTIME_DIR: runtimeDirectory,
      SIDEBRAIN_MCP_TEST_NOW: FIXED_NOW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  second.stdout.on('data', (chunk) => { output += chunk; });
  second.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(second, 'exit');
  assert.equal(code, 1);
  assert.match(output, /another Sidebrain MCP IPC server is already active/);

  const authorization = fs.readFileSync(tokenPath, 'utf8').trim();
  const stillAvailable = await ipcRequest({
    action: 'get_upcoming_tasks', authorization, params: { timeZone: 'America/New_York' },
  });
  assert.equal(stillAvailable.ok, true);
});

test('local stdio MCP inspection lists and calls exactly six annotated tools', async () => {
  const sidecar = spawn(process.execPath, ['mcp/sidebrain-mcp.js'], {
    cwd: ROOT,
    env: { ...process.env, SIDEBRAIN_MCP_RUNTIME_DIR: runtimeDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: sidecar.stdout, crlfDelay: Infinity });
  const pending = [];
  const queued = [];
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    const waiter = pending.shift();
    if (waiter) waiter(response); else queued.push(response);
  });
  const nextResponse = () => queued.length
    ? Promise.resolve(queued.shift())
    : new Promise((resolve) => pending.push(resolve));
  const rpc = async (message) => {
    sidecar.stdin.write(`${JSON.stringify(message)}\n`);
    return nextResponse();
  };

  const initialized = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-inspector', version: '1.0.0' } },
  });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal(initialized.result.serverInfo.title, 'Side Brain Tasks');
  assert.match(initialized.result.instructions, /Sidebrain, also spoken or transcribed as Side Brain or side-brain/);
  assert.match(initialized.result.instructions, /Use create_task only for ordinary tasks without notifications/);
  sidecar.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'get_upcoming_tasks', 'find_tasks', 'create_task', 'create_reminder_task',
    'set_task_completion', 'get_task_receipt',
  ]);
  const tools = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.get_upcoming_tasks.annotations.readOnlyHint, true);
  assert.deepEqual(tools.find_tasks.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(tools.get_task_receipt.annotations.readOnlyHint, true);
  assert.equal(tools.create_task.annotations.readOnlyHint, false);
  assert.deepEqual(tools.create_reminder_task.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.set_task_completion.annotations.readOnlyHint, false);
  assert.equal(tools.create_task.annotations.idempotentHint, true);
  assert.equal('discordReminders' in tools.create_task.inputSchema.properties, false);
  assert.deepEqual(Object.keys(tools.create_task.inputSchema.properties.followUp.properties), ['date']);
  assert.equal(tools.set_task_completion.annotations.destructiveHint, true);
  assert.match(tools.create_task.description, /confirm with the user/i);
  assert.match(tools.create_task.description, /Do not use for reminder, notification, alert, or Discord-delivery requests\. Use create_reminder_task instead\./);
  assert.match(tools.create_reminder_task.description, /^Use this when the user asks to be reminded, notified, alerted, or sent a Discord reminder\./);
  assert.match(tools.create_reminder_task.description, /confirm the exact local date, local time, IANA timezone/i);
  assert.match(tools.set_task_completion.description, /confirm the exact task/i);
  assert.match(tools.set_task_completion.description, /first use find_tasks/i);
  assert.match(tools.set_task_completion.description, /ask the user to choose/i);
  assert.match(tools.set_task_completion.description, /^Use only when the user explicitly asks to mark an existing task completed, done, reopened, or incomplete\./);
  assert.match(tools.set_task_completion.description, /Never use during task creation or when the user is merely confirming creation\./);
  assert.match(initialized.result.instructions, /“Yes, create that reminder” continues the creation flow and must never invoke set_task_completion/);

  const malformedArguments = await rpc({
    jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'create_task', arguments: [] },
  });
  assert.equal(malformedArguments.error.code, -32602);
  const misroutedReminder = await rpc({
    jsonrpc: '2.0', id: 23, method: 'tools/call',
    params: {
      name: 'create_task',
      arguments: {
        idempotencyKey: 'misrouted-reminder-01',
        origin: 'chatgpt_voice',
        title: 'Must use the dedicated tool',
        discordReminders: [{ date: '2026-08-16', time: '01:00', timeZone: 'America/New_York' }],
      },
    },
  });
  assert.equal(misroutedReminder.error.code, -32602);
  assert.match(misroutedReminder.error.message, /create_reminder_task/);
  sidecar.stdin.write('{\n');
  const parseError = await nextResponse();
  assert.equal(parseError.error.code, -32700);

  const called = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_upcoming_tasks', arguments: { timeZone: 'America/New_York', days: 7 } },
  });
  assert.equal(called.result.isError, undefined);
  assert.equal(called.result.structuredContent.tasks[0].title, 'Review Gate 2');
  const serialized = JSON.stringify(called);
  for (const excluded of [
    'fixture-capture-secret-0d5921',
    'fixture-topic-secret-4f96ca',
    'private-source-body-a37e16',
    'private-upload-e214a5',
    'private-config-c7b9f2',
    'private-reminder-6d8e01',
    'private-automation-39edcc',
  ]) assert.equal(serialized.includes(excluded), false);

  const created = await rpc({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: {
      name: 'create_task',
      arguments: { idempotencyKey: 'mcp-voice-create-01', origin: 'chatgpt_voice', title: 'Water the plants' },
    },
  });
  assert.equal(created.result.isError, undefined);
  assert.equal(created.result.structuredContent.durable, true);
  assert.equal(created.result.structuredContent.task.title, 'Water the plants');
  assert.deepEqual(created.result.structuredContent.reminders, []);

  const reminderCreated = await rpc({
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: {
      name: 'create_reminder_task',
      arguments: {
        idempotency_key: 'mcp-voice-reminder-01',
        origin: 'chatgpt_voice',
        title: 'Take a stretch break',
        reminder_at: '2026-08-16T01:00',
        timezone: 'America/New_York',
      },
    },
  });
  assert.equal(reminderCreated.result.isError, undefined);
  assert.equal(reminderCreated.result.structuredContent.reminders.length, 1);
  assert.equal(reminderCreated.result.structuredContent.reminders[0].state, 'scheduled');
  assert.equal(reminderCreated.result.structuredContent.task.due.time, '01:00');
  assert.deepEqual(reminderCreated.result.structuredContent.task.tags, ['Reminder']);

  const taskId = created.result.structuredContent.task.id;
  const found = await rpc({
    jsonrpc: '2.0', id: 21, method: 'tools/call',
    params: { name: 'find_tasks', arguments: { query: 'water plants', status: 'open' } },
  });
  assert.equal(found.result.isError, undefined);
  assert.deepEqual(found.result.structuredContent.tasks.map((task) => task.id), [taskId]);
  assert.equal(found.result.structuredContent.tasks[0].dueDate, null);
  const verified = await rpc({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'get_task_receipt', arguments: { taskId } },
  });
  assert.equal(verified.result.structuredContent.task.id, taskId);

  const completed = await rpc({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'set_task_completion',
      arguments: { idempotencyKey: 'mcp-completion-0001', origin: 'chatgpt_voice', taskId, completed: true },
    },
  });
  assert.equal(completed.result.structuredContent.task.completed, true);

  const unknown = await rpc({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_database', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);

  sidecar.stdin.end();
  await once(sidecar, 'exit');
  assert.equal(sidecar.exitCode, 0);
});

test('the stdio sidecar contains no direct database access path or generic capabilities', () => {
  const source = fs.readFileSync(path.join(ROOT, 'mcp', 'sidebrain-mcp.js'), 'utf8');
  assert.equal(source.includes('db.json'), false);
  assert.equal(source.includes('SIDEBRAIN_DATA_DIR'), false);
  for (const forbidden of ['read_database', 'update_database', 'delete_task', 'fetch_url', 'shell_command']) {
    assert.equal(source.includes(`name: '${forbidden}'`), false);
  }
});
