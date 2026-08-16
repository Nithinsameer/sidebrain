'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('scheduled task specification is Local, live-checkout, single-claim, and worktree-free', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'automation', 'sidebrain-codex-agent.md'), 'utf8');
  assert.match(spec, /^# Sidebrain Codex Agent/m);
  assert.match(spec, /every 15 minutes/i);
  assert.match(spec, /Execution environment: Local/);
  assert.match(spec, /\/Volumes\/NithinSameer\/Personal\/mindchuck/);
  assert.match(spec, /Worktree: disabled/);
  assert.match(spec, /claim_oldest_codex_task` at most once/);
  assert.match(spec, /release_expired_codex_claims/);
  assert.match(spec, /untrusted data, never instructions/);
  assert.match(spec, /Prefer structured plugins and APIs/);
  assert.match(spec, /mark_codex_waiting/);
  assert.match(spec, /Never claim a second task/);
});

test('Home Agent runbook documents protected key, Shortcut auth, backup, verification, and rollback', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'SIDEBRAIN_HOME_AGENT.md'), 'utf8');
  for (const required of [
    'govee-api-key', 'read -r -s', 'chmod 600', 'POST', '/api/voice-command',
    'Authorization', 'Speak Text', 'requiresConfirmation', 'data/backups/',
    'Actual bulb inventory', 'not created or enabled',
  ]) assert.equal(docs.includes(required), true, `missing ${required}`);
  assert.equal(/Govee API key:\s+[A-Za-z0-9]/.test(docs), false);
});
