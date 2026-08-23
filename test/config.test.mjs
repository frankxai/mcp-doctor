// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates } from '../dist/scanner/config-reader.js';

const entry = (name, scope) => ({ name, scope, config: { command: 'npx', args: [name] }, source: `${scope}.json` });

test('findDuplicates returns only names that appear more than once', () => {
  const dupes = findDuplicates([entry('github', 'user'), entry('github', 'project'), entry('linear', 'user')]);
  assert.deepEqual([...dupes.keys()], ['github']);
  assert.equal(dupes.get('github').length, 2);
});

test('a server registered once in every scope is still one server per scope, not a duplicate', () => {
  const dupes = findDuplicates([entry('github', 'user'), entry('linear', 'project')]);
  assert.equal(dupes.size, 0);
});

test('an empty config yields no duplicates rather than throwing', () => {
  assert.equal(findDuplicates([]).size, 0);
});

test('duplicates keep every occurrence so the report can name both scopes', () => {
  const dupes = findDuplicates([entry('slack', 'user'), entry('slack', 'project'), entry('slack', 'local')]);
  assert.deepEqual(dupes.get('slack').map(e => e.scope), ['user', 'project', 'local']);
});
