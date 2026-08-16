'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const API_ORIGIN = 'https://openapi.api.govee.com';
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.config', 'sidebrain', 'govee-api-key');

class GoveeError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'GoveeError';
    this.code = code;
    this.status = status;
  }
}

function readProtectedApiKey(file = process.env.SIDEBRAIN_GOVEE_KEY_FILE || DEFAULT_KEY_FILE) {
  const directory = path.dirname(file);
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) ||
        (directoryStat.mode & 0o077) !== 0) {
      throw new Error('insecure');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GoveeError('govee_not_configured', 'Govee is not configured');
    throw new GoveeError('govee_key_insecure', 'Govee credential directory permissions must be 0700');
  }
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new GoveeError('govee_not_configured', 'Govee is not configured');
    throw new GoveeError('govee_key_unavailable', 'Govee credential file is unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new GoveeError('govee_key_insecure', 'Govee credential path must be a regular file');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new GoveeError('govee_key_insecure', 'Govee credential file must be owned by the Sidebrain user');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new GoveeError('govee_key_insecure', 'Govee credential file permissions must be 0600');
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key || key.length > 512 || /[\r\n\u0000]/.test(key)) {
    throw new GoveeError('govee_key_invalid', 'Govee credential file is invalid');
  }
  return key;
}

function createGoveeClient({
  fetchImpl = globalThis.fetch,
  apiKeyProvider = readProtectedApiKey,
  requestId = () => crypto.randomUUID(),
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof apiKeyProvider !== 'function') throw new TypeError('apiKeyProvider is required');

  async function request(route, { method = 'POST', payload } = {}) {
    const key = apiKeyProvider();
    const id = requestId();
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': key,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method !== 'GET') options.body = JSON.stringify({ requestId: id, payload });

    let response;
    try { response = await fetchImpl(`${API_ORIGIN}${route}`, options); }
    catch (error) {
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError'
        ? 'govee_timeout'
        : 'govee_unavailable';
      throw new GoveeError(code, 'Govee request failed');
    }

    let body;
    try { body = await response.json(); }
    catch { throw new GoveeError('govee_invalid_response', 'Govee returned an invalid response', response.status); }
    const apiCode = Number(body?.code);
    if (!response.ok || (Number.isFinite(apiCode) && apiCode !== 200)) {
      const status = response.ok ? (apiCode || null) : response.status;
      const code = status === 401 ? 'govee_unauthorized' : status === 429 ? 'govee_rate_limited' : 'govee_rejected';
      throw new GoveeError(code, 'Govee rejected the request', status);
    }
    return body;
  }

  return {
    async listDevices() {
      const body = await request('/router/api/v1/user/devices', { method: 'GET' });
      return Array.isArray(body?.data) ? body.data : [];
    },
    async getState(device) {
      const body = await request('/router/api/v1/device/state', {
        payload: { sku: device.sku, device: device.device },
      });
      return Array.isArray(body?.payload?.capabilities) ? body.payload.capabilities : [];
    },
    async listDynamicScenes(device) {
      const body = await request('/router/api/v1/device/scenes', {
        payload: { sku: device.sku, device: device.device },
      });
      return Array.isArray(body?.payload?.capabilities) ? body.payload.capabilities : [];
    },
    async listDiyScenes(device) {
      const body = await request('/router/api/v1/device/diy-scenes', {
        payload: { sku: device.sku, device: device.device },
      });
      return Array.isArray(body?.payload?.capabilities) ? body.payload.capabilities : [];
    },
    async control(device, capability) {
      await request('/router/api/v1/device/control', {
        payload: { sku: device.sku, device: device.device, capability },
      });
      return true;
    },
  };
}

module.exports = {
  API_ORIGIN,
  DEFAULT_KEY_FILE,
  GoveeError,
  createGoveeClient,
  readProtectedApiKey,
};
