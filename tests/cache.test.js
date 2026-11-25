const test = require('node:test');
const assert = require('node:assert');
const llm = require('../src/main/llm');

const msgs = [{ role: 'user', content: 'hi' }];

test('only the stable part of the system prompt is a cache breakpoint', () => {
  const c = llm.withCache('stable' + llm.CACHE_BOUNDARY + 'memory', msgs);
  assert.deepStrictEqual(c.system.map((b) => b.text), ['stable', 'memory']);
  assert.ok(c.system[0].cache_control);
  assert.ok(!c.system[1].cache_control);
});

test('a system prompt with no boundary is one cached block, as before', () => {
  const c = llm.withCache('just one', msgs);
  assert.strictEqual(c.system.length, 1);
  assert.ok(c.system[0].cache_control);
  assert.strictEqual(llm.withCache('', msgs).system, null);
});

test('changing the volatile part leaves the cached block identical', () => {
  const a = llm.withCache('stable' + llm.CACHE_BOUNDARY + 'memory one', msgs).system[0];
  const b = llm.withCache('stable' + llm.CACHE_BOUNDARY + 'memory two', msgs).system[0];
  assert.deepStrictEqual(a, b);
});

test('providers that do not cache get the two parts joined without the marker', () => {
  const out = llm.toOpenAI('stable' + llm.CACHE_BOUNDARY + 'memory', msgs);
  assert.strictEqual(out[0].content, 'stable\n\nmemory');
  assert.ok(!out[0].content.includes('cache-boundary'));
});
