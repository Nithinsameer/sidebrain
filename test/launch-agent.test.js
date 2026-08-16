'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('tunnel LaunchAgent starts at login, restarts after failure, and contains no secret material', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'extras', 'com.sidebrain.tunnel-client.plist'),
    'utf8',
  );
  assert.match(source, /<string>com\.sidebrain\.tunnel-client<\/string>/);
  assert.match(source, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(source, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(source, /<string>--profile<\/string>\s*<string>sidebrain<\/string>/);
  assert.doesNotMatch(source, /api.?key|authorization|bearer|token|sidebrain-readonly\.key/i);
});
