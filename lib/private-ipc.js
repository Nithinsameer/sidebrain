'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { projectFoundTasks, projectUpcomingTasks } = require('./task-projection');
const { TaskServiceError } = require('./task-service');

const MAX_REQUEST_BYTES = 64 * 1024;
const ALLOWED_ACTIONS = new Set([
  'get_upcoming_tasks',
  'find_tasks',
  'create_task',
  'create_reminder_task',
  'set_task_completion',
  'get_task_receipt',
]);

function defaultRuntimeDirectory() {
  const identity = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `sidebrain-${identity}`);
}

function ipcPaths(environment = process.env) {
  const runtimeDirectory = path.resolve(environment.SIDEBRAIN_MCP_RUNTIME_DIR || defaultRuntimeDirectory());
  return {
    runtimeDirectory,
    socketPath: path.resolve(environment.SIDEBRAIN_MCP_SOCKET || path.join(runtimeDirectory, 'readonly.sock')),
    tokenPath: path.resolve(environment.SIDEBRAIN_MCP_TOKEN_FILE || path.join(runtimeDirectory, 'readonly.token')),
  };
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MCP runtime path must be a directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('MCP runtime directory must be owned by the Sidebrain user');
  }
  fs.chmodSync(directory, 0o700);
}

function authorized(received, expected) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function writeResponse(socket, response) {
  socket.end(`${JSON.stringify(response)}\n`);
}

function socketIsActive(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (active) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function createPrivateIpcServer({ getDatabase, taskService, now = () => new Date(), environment = process.env }) {
  if (typeof getDatabase !== 'function') throw new TypeError('getDatabase is required');
  for (const method of ['createTask', 'createReminderTask', 'setTaskCompletion', 'getTaskReceipt']) {
    if (typeof taskService?.[method] !== 'function') throw new TypeError(`taskService.${method} is required`);
  }
  const paths = ipcPaths(environment);
  let token;
  let server;

  function removeOwnedToken() {
    if (!token) return;
    try {
      if (fs.readFileSync(paths.tokenPath, 'utf8').trim() === token) fs.unlinkSync(paths.tokenPath);
    } catch { /* already gone or replaced by a newer process */ }
  }

  async function dispatch(action, params) {
    if (action === 'get_upcoming_tasks') {
      if (Object.keys(params).some((key) => !['timeZone', 'days'].includes(key))) {
        throw new TaskServiceError('invalid_request', 'request contains an unsupported field');
      }
      return projectUpcomingTasks(getDatabase(), {
        timeZone: params.timeZone,
        days: params.days,
        now: now(),
      });
    }
    if (action === 'find_tasks') {
      try {
        return projectFoundTasks(getDatabase(), params);
      } catch (error) {
        throw new TaskServiceError('invalid_request', String(error.message || error));
      }
    }
    if (action === 'create_task') return taskService.createTask(params);
    if (action === 'create_reminder_task') return taskService.createReminderTask(params);
    if (action === 'set_task_completion') return taskService.setTaskCompletion(params);
    if (action === 'get_task_receipt') return taskService.getTaskReceipt(params);
    throw new Error('unsupported action');
  }

  function handleConnection(socket) {
    let buffer = '';
    let size = 0;
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', async (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_REQUEST_BYTES) return socket.destroy();
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.pause();

      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); }
      catch { return writeResponse(socket, { ok: false, error: 'invalid request' }); }

      if (!authorized(request?.authorization, token)) {
        return writeResponse(socket, { ok: false, error: 'unauthorized' });
      }
      if (!ALLOWED_ACTIONS.has(request?.action)) {
        return writeResponse(socket, { ok: false, error: 'unsupported action' });
      }
      if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
        return writeResponse(socket, { ok: false, error: 'invalid request', code: 'invalid_request' });
      }

      try {
        const result = await dispatch(request.action, request.params);
        return writeResponse(socket, { ok: true, result });
      } catch (error) {
        if (error instanceof TaskServiceError) {
          return writeResponse(socket, { ok: false, error: error.message, code: error.code });
        }
        return writeResponse(socket, { ok: false, error: 'Sidebrain request failed', code: 'internal_error' });
      }
    });
    socket.on('error', () => {});
  }

  return {
    ...paths,
    async start() {
      privateDirectory(paths.runtimeDirectory);
      if (path.dirname(paths.socketPath) !== paths.runtimeDirectory ||
          path.dirname(paths.tokenPath) !== paths.runtimeDirectory) {
        throw new Error('MCP socket and token must be inside the private runtime directory');
      }

      try {
        const stat = fs.lstatSync(paths.socketPath);
        if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('refusing to replace non-socket MCP path');
        if (await socketIsActive(paths.socketPath)) throw new Error('another Sidebrain MCP IPC server is already active');
        fs.unlinkSync(paths.socketPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        const stat = fs.lstatSync(paths.tokenPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('refusing to replace invalid MCP token path');
        fs.unlinkSync(paths.tokenPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(paths.tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.chmodSync(paths.tokenPath, 0o600);

      server = net.createServer(handleConnection);
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(paths.socketPath);
        });
      } catch (error) {
        removeOwnedToken();
        throw error;
      }
      fs.chmodSync(paths.socketPath, 0o600);
    },
    async close() {
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      try { fs.unlinkSync(paths.socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      removeOwnedToken();
    },
  };
}

module.exports = { ALLOWED_ACTIONS, createPrivateIpcServer, ipcPaths };
