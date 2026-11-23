const test = require('node:test');
const assert = require('node:assert');
const { isValidName, redact } = require('../src/main/secrets');

test('names must be shell variables', () => {
  for (const ok of ['GITHUB_TOKEN', 'API_KEY_2']) assert.ok(isValidName(ok), ok);
  for (const bad of ['github_token', '1TOKEN', 'A', 'TOKEN; rm -rf /', '']) assert.ok(!isValidName(bad), bad);
});

test('redaction replaces values, longest first', () => {
  const list = [['SHORT', 'abcdef'], ['LONG', 'abcdef-ghijkl']];
  assert.equal(redact('key=abcdef-ghijkl and abcdef', list), 'key=[secret LONG] and [secret SHORT]');
});

test('short values are left alone', () => {
  assert.equal(redact('pin 1234 ok', [['PIN', '1234']]), 'pin 1234 ok');
});
