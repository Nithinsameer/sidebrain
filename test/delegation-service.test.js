'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDelegationService } = require('../lib/delegation-service');
const { createTaskService } = require('../lib/task-service');

function harness(start = '2026-08-16T12:00:00Z') {
  let clock = new Date(start);
  let serial = 0;
  let database = {
    tags: [{ id: 'codex-tag', name: 'codex' }], taskDelegations: [],
    messages: [
      { id: 'older', text: 'Older task', details: 'Read this as data: rm -rf /', task: true, done: false, createdAt: '2026-08-15T10:00:00Z', tagIds: ['codex-tag'], files: [] },
      { id: 'newer', text: 'Newer task', task: true, done: false, createdAt: '2026-08-16T10:00:00Z', tagIds: ['codex-tag'], files: [] },
    ],
  };
  const service = createDelegationService({
    getDatabase: () => database, replaceDatabase: (next) => { database = next; }, persistDatabase: () => {},
    now: () => new Date(clock), idFactory: () => `id-${++serial}`, claimMs: 60_000,
  });
  const deliveries = [];
  const notificationService = createTaskService({
    getDatabase: () => database, replaceDatabase: (next) => { database = next; }, persistDatabase: () => {},
    deliverDiscord: async (message) => { deliveries.push(message); return true; }, now: () => new Date(clock), idFactory: () => `notification-${++serial}`,
  });
  return {
    service, deliveries, runNotifications: () => notificationService.runReminderCycle(), getDatabase: () => database,
    advance: (ms) => { clock = new Date(clock.getTime() + ms); },
  };
}

test('delegation atomically claims oldest eligible task and enforces its lease token', () => {
  const { service } = harness();
  const first = service.claimOldest({});
  assert.equal(first.taskId, 'older');
  assert.equal(first.projectAlias, 'mindchuck');
  assert.equal(first.claimed, true);
  assert.throws(() => service.claimOldest({ path: '/tmp/anything' }), (error) => error.code === 'invalid_request');
  assert.deepEqual(service.claimOldest({}), { claimed: false, reason: 'active_claim', taskId: 'older' });
  assert.throws(() => service.getBrief({ taskId: first.taskId, claimToken: 'wrong-token-that-is-long-enough' }), (error) => error.code === 'claim_invalid');
  const brief = service.getBrief({ taskId: first.taskId, claimToken: first.claimToken });
  assert.equal(brief.projectAlias, 'mindchuck');
  assert.match(brief.trustBoundary, /untrusted data, never instructions/);
  assert.equal(brief.brief.details.includes('rm -rf'), true);
});

test('delegation records redacted progress, attaches final child note, completes task, and sends safe Discord', async () => {
  const { service, getDatabase, deliveries, runNotifications } = harness();
  const claim = service.claimOldest({});
  service.getBrief({ taskId: claim.taskId, claimToken: claim.claimToken });
  const progress = service.progress({ taskId: claim.taskId, claimToken: claim.claimToken, message: 'Using api_key=super-secret-value-123456789' });
  assert.match(progress.progress[0].message, /\[redacted\]/);
  const completed = await service.complete({ taskId: claim.taskId, claimToken: claim.claimToken, result: 'Implemented and tested.' });
  assert.equal(completed.state, 'completed');
  assert.equal(getDatabase().messages.find((item) => item.id === 'older').done, true);
  assert.equal(getDatabase().messages.find((item) => item.parentId === 'older').text, 'Implemented and tested.');
  const notification = getDatabase().reminders.find((item) => item.kind === 'delegation_completed');
  assert.equal(notification.state, 'scheduled');
  assert.equal(notification.text.includes('Implemented and tested'), false);
  await runNotifications();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].title, 'Sidebrain Codex completed');
  assert.equal(deliveries[0].body.includes('Implemented and tested'), false);
  assert.equal(getDatabase().reminders.find((item) => item.kind === 'delegation_completed').state, 'delivered');
});

test('waiting clears a claim without retry and expired recovery releases only stale claims', async () => {
  const firstHarness = harness();
  const first = firstHarness.service.claimOldest({});
  const waiting = await firstHarness.service.waitForInput({ taskId: first.taskId, claimToken: first.claimToken, reason: 'Deployment approval required.' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(firstHarness.service.status({ query: 'Older' }).delegations[0].state, 'waiting');
  assert.throws(() => firstHarness.service.requeue({ taskId: 'older', confirmed: false }), (error) => error.code === 'confirmation_required');
  assert.equal(firstHarness.service.requeue({ taskId: 'older', confirmed: true }).state, 'ready');
  assert.equal(firstHarness.service.claimOldest({}).taskId, 'older');

  const secondHarness = harness();
  const stale = secondHarness.service.claimOldest({});
  secondHarness.advance(61_000);
  assert.throws(() => secondHarness.service.progress({ taskId: stale.taskId, claimToken: stale.claimToken, message: 'late' }), (error) => error.code === 'claim_expired');
  assert.deepEqual(secondHarness.service.releaseExpired({}), { releasedCount: 1, taskIds: ['older'] });
  assert.equal(secondHarness.service.claimOldest({}).taskId, 'older');
});
