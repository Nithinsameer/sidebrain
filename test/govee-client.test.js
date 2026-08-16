'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GoveeError, createGoveeClient, readProtectedApiKey } = require('../lib/govee-client');

test('protected Govee key reader requires an owned regular 0600 file and never returns it in errors', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebrain-govee-key-'));
  const file = path.join(directory, 'key');
  const secret = 'govee-fixture-secret-91c4';
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    assert.equal(readProtectedApiKey(file), secret);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readProtectedApiKey(file), (error) => {
      assert.equal(error.code, 'govee_key_insecure');
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Govee client uses only official endpoints and keeps the API key out of results and errors', async () => {
  const secret = 'govee-fixture-secret-c503';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ code: 200, data: [{ sku: 'H6001' }] }) };
  };
  const client = createGoveeClient({ fetchImpl, apiKeyProvider: () => secret, requestId: () => 'request-1' });
  assert.deepEqual(await client.listDevices(), [{ sku: 'H6001' }]);
  assert.equal(calls[0].url, 'https://openapi.api.govee.com/router/api/v1/user/devices');
  assert.equal(calls[0].options.headers['Govee-API-Key'], secret);
  assert.equal(JSON.stringify(await client.listDevices()).includes(secret), false);

  const rejected = createGoveeClient({
    apiKeyProvider: () => secret,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ code: 401, message: secret }) }),
  });
  await assert.rejects(rejected.listDevices(), (error) => {
    assert.ok(error instanceof GoveeError);
    assert.equal(error.code, 'govee_unauthorized');
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test('Govee client reports an API error code returned inside an HTTP 200 response', async () => {
  const client = createGoveeClient({
    apiKeyProvider: () => 'fixture-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 400, message: 'device does not support this endpoint' }),
    }),
  });

  await assert.rejects(client.listDevices(), (error) => {
    assert.equal(error.code, 'govee_rejected');
    assert.equal(error.status, 400);
    assert.equal(error.message.includes('device does not support'), false);
    return true;
  });
});
