'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readVoiceCredential } = require('../lib/protected-credential');

test('voice credential requires a private directory and owned regular 0600 file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebrain-voice-'));
  const file = path.join(directory, 'voice-token');
  const credential = 'dedicated-voice-test-token-72c8';
  fs.writeFileSync(file, `${credential}\n`, { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(readVoiceCredential(file), credential);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readVoiceCredential(file), (error) => error.code === 'voice_not_configured_insecure' && !error.message.includes(credential));
});

test('voice credential does not fall back to a database or capture credential', () => {
  assert.throws(() => readVoiceCredential(path.join(os.tmpdir(), 'missing-sidebrain-voice', 'token')), (error) => error.code === 'voice_not_configured');
});
