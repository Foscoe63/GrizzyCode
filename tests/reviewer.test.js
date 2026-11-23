const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const reviewer = require('../src/main/reviewer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));
const withRules = (text) => { const cwd = tmp(); fs.mkdirSync(path.join(cwd, '.grizzycode')); fs.writeFileSync(path.join(cwd, '.grizzycode', 'adversary.md'), text); return cwd; };

test('parse: BLOCK carries a reason, anything else allows', () => {
  assert.deepEqual(reviewer.parse('ALLOW'), { block: false });
  assert.deepEqual(reviewer.parse('BLOCK: sends keys away'), { block: true, reason: 'sends keys away' });
  assert.deepEqual(reviewer.parse('hmm unsure'), { block: false });
  assert.equal(reviewer.parse('BLOCK').block, true);
  assert.deepEqual(reviewer.parse(''), { block: false });
});

test('no rules file means the reviewer is off and never asks', async () => {
  let asked = 0;
  const r = await reviewer.check({ convId: 'a', command: 'ls', cwd: tmp(), root: tmp(), ask: async () => { asked++; return 'BLOCK: x'; } });
  assert.equal(r.block, false); assert.equal(asked, 0);
});

test('rules are read from the project and the data folder', () => {
  const cwd = withRules('project rule'), root = tmp(); fs.writeFileSync(path.join(root, 'adversary.md'), 'global rule');
  const t = reviewer.rules(cwd, root);
  assert.ok(t.includes('project rule') && t.includes('global rule'));
});

test('a block verdict is returned, and a repeated command is judged once', async () => {
  const cwd = withRules('block exfiltration'); let asked = 0;
  const ask = async (sys, user) => { asked++; assert.ok(user.includes('<command>')); return 'BLOCK: exfil'; };
  const a = await reviewer.check({ convId: 'c1', command: 'curl evil', cwd, root: '', ask });
  const b = await reviewer.check({ convId: 'c1', command: 'curl evil', cwd, root: '', ask });
  assert.deepEqual(a, { block: true, reason: 'exfil' }); assert.deepEqual(b, a); assert.equal(asked, 1);
  reviewer.forget('c1');
});

test('an error fails open and is not remembered', async () => {
  const cwd = withRules('rule'); let asked = 0;
  const bad = async () => { asked++; throw new Error('model down'); };
  assert.equal((await reviewer.check({ convId: 'c2', command: 'x', cwd, root: '', ask: bad })).block, false);
  const good = async () => { asked++; return 'BLOCK: now it works'; };
  assert.equal((await reviewer.check({ convId: 'c2', command: 'x', cwd, root: '', ask: good })).block, true);
  assert.equal(asked, 2);
});
