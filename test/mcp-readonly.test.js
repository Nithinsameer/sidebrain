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

test('authorized IPC is allowlisted to the read-only task action', async () => {
  const authorization = fs.readFileSync(tokenPath, 'utf8').trim();
  const unsupported = await ipcRequest({ action: 'read_database', authorization, params: {} });
  assert.deepEqual(unsupported, { ok: false, error: 'unsupported action' });

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

test('local stdio MCP inspection lists and calls exactly one read-only tool', async () => {
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
  sidecar.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['get_upcoming_tasks']);
  assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);

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

  sidecar.stdin.end();
  await once(sidecar, 'exit');
  assert.equal(sidecar.exitCode, 0);
});

test('the stdio sidecar contains no direct database access path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'mcp', 'sidebrain-mcp.js'), 'utf8');
  assert.equal(source.includes('db.json'), false);
  assert.equal(source.includes('SIDEBRAIN_DATA_DIR'), false);
});
