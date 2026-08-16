#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const { ipcPaths } = require('../lib/private-ipc');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
const TOOL_NAME = 'get_upcoming_tasks';
const TOOL = {
  name: TOOL_NAME,
  title: 'Get upcoming Sidebrain tasks',
  description: 'Return a bounded, read-only projection of open Sidebrain tasks due through the requested local-date window, including overdue tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      timeZone: {
        type: 'string',
        description: 'IANA timezone used to determine today, for example America/New_York.',
      },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 31,
        default: 7,
        description: 'Number of local calendar days in the window, including today.',
      },
    },
    required: ['timeZone'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      asOf: { type: 'string' },
      timeZone: { type: 'string' },
      window: {
        type: 'object',
        properties: { from: { type: 'string' }, through: { type: 'string' } },
        required: ['from', 'through'],
        additionalProperties: false,
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            dueDate: { type: 'string' },
            dueTime: { type: ['string', 'null'] },
            timing: { type: 'string', enum: ['overdue', 'today', 'upcoming'] },
          },
          required: ['id', 'title', 'dueDate', 'dueTime', 'timing'],
          additionalProperties: false,
        },
      },
      truncated: { type: 'boolean' },
    },
    required: ['asOf', 'timeZone', 'window', 'tasks', 'truncated'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function verifyPrivatePath(file, kind) {
  const stat = fs.lstatSync(file);
  const validType = kind === 'socket' ? stat.isSocket() : stat.isFile();
  if (!validType || stat.isSymbolicLink()) throw new Error(`invalid MCP ${kind} path`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`MCP ${kind} must be owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`MCP ${kind} permissions are not private`);
}

function callSidebrain(params) {
  const paths = ipcPaths();
  verifyPrivatePath(paths.socketPath, 'socket');
  verifyPrivatePath(paths.tokenPath, 'token');
  const authorization = fs.readFileSync(paths.tokenPath, 'utf8').trim();
  if (!authorization) return Promise.reject(new Error('empty MCP authorization token'));

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Sidebrain IPC timed out')));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ action: TOOL_NAME, authorization, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { return socket.destroy(new Error('invalid Sidebrain IPC response')); }
      socket.end();
      if (!response?.ok) return reject(new Error(response?.error || 'Sidebrain IPC request failed'));
      resolve(response.result);
    });
    socket.once('error', reject);
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) failure(message.id, -32600, 'Invalid Request');
    return;
  }
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    return result(message.id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'sidebrain-readonly', version: '0.1.0' },
      instructions: 'Read-only access to a bounded safe projection of upcoming Sidebrain tasks.',
    });
  }
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') return result(message.id, { tools: [TOOL] });
  if (message.method === 'tools/call') {
    if (message.params?.name !== TOOL_NAME) return failure(message.id, -32602, 'Unknown tool');
    const args = message.params?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return failure(message.id, -32602, 'Invalid tool arguments');
    try {
      const projection = await callSidebrain(args);
      return result(message.id, {
        content: [{ type: 'text', text: JSON.stringify(projection) }],
        structuredContent: projection,
      });
    } catch (error) {
      return result(message.id, {
        content: [{ type: 'text', text: `Sidebrain task lookup failed: ${String(error.message || error)}` }],
        isError: true,
      });
    }
  }
  failure(message.id, -32601, 'Method not found');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return failure(null, -32700, 'Parse error'); }
  handle(message).catch((error) => failure(message.id ?? null, -32603, String(error.message || error)));
});
