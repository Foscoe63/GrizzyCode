// Pure-function unit tests: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { applyEdits } = require('../src/main/tools');

test('applyEdits replaces a unique match', () => {
  assert.strictEqual(applyEdits('a b c', [{ old_string: 'b', new_string: 'X' }]), 'a X c');
});
test('applyEdits rejects ambiguous match without replace_all', () => {
  assert.throws(() => applyEdits('a a', [{ old_string: 'a', new_string: 'b' }]), /matches 2 times/);
});
test('applyEdits replace_all replaces every match', () => {
  assert.strictEqual(applyEdits('a a', [{ old_string: 'a', new_string: 'b', replace_all: true }]), 'b b');
});
test('applyEdits applies a list in order and fails atomically', () => {
  assert.strictEqual(applyEdits('one two', [{ old_string: 'one', new_string: '1' }, { old_string: 'two', new_string: '2' }]), '1 2');
  assert.throws(() => applyEdits('one', [{ old_string: 'one', new_string: '1' }, { old_string: 'zzz', new_string: '2' }]), /not found \(edit 2\)/);
});
test('applyEdits treats $ patterns in new_string literally', () => {
  assert.strictEqual(applyEdits('x', [{ old_string: 'x', new_string: '$&$1' }]), '$&$1');
});
