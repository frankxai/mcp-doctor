import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, findMissingEnvVars } from '../dist/scanner/config-reader.js';

test('findDuplicates: returns empty map when given empty array', () => {
  const duplicates = findDuplicates([]);
  assert.equal(duplicates.size, 0);
});

test('findDuplicates: returns empty map when there are no duplicates', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio' } },
    { name: 'server-b', scope: 'project-local', config: { type: 'stdio' } }
  ];
  const duplicates = findDuplicates(servers);
  assert.equal(duplicates.size, 0);
});

test('findDuplicates: identifies multiple duplicates correctly', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio' } },
    { name: 'server-a', scope: 'project-local', projectPath: '/path1', config: { type: 'stdio' } },
    { name: 'server-b', scope: 'mcp-json', projectPath: '/path2', config: { type: 'stdio' } },
    { name: 'server-b', scope: 'user', config: { type: 'stdio' } },
    { name: 'server-c', scope: 'user', config: { type: 'stdio' } }
  ];

  const duplicates = findDuplicates(servers);
  assert.equal(duplicates.size, 2);

  const dupA = duplicates.get('server-a');
  assert.ok(dupA);
  assert.equal(dupA.length, 2);
  assert.equal(dupA[0].scope, 'user');
  assert.equal(dupA[1].scope, 'project-local');

  const dupB = duplicates.get('server-b');
  assert.ok(dupB);
  assert.equal(dupB.length, 2);
  assert.equal(dupB[0].scope, 'mcp-json');
  assert.equal(dupB[1].scope, 'user');
});

test('findMissingEnvVars: returns empty array when given empty array', () => {
  const missing = findMissingEnvVars([]);
  assert.equal(missing.length, 0);
});

test('findMissingEnvVars: returns empty array when all env vars are valid', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio', env: { API_KEY: 'secret123', OTHER_VAR: 'val' } } },
    { name: 'server-b', scope: 'project-local', config: { type: 'stdio' } } // no env is valid
  ];
  const missing = findMissingEnvVars(servers);
  assert.equal(missing.length, 0);
});

test('findMissingEnvVars: detects empty string values', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio', env: { API_KEY: '' } } }
  ];
  const missing = findMissingEnvVars(servers);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, 'server-a');
});

test('findMissingEnvVars: detects undefined values as strings', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio', env: { API_KEY: 'undefined' } } }
  ];
  const missing = findMissingEnvVars(servers);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, 'server-a');
});

test('findMissingEnvVars: detects placeholder values starting with YOUR_', () => {
  const servers = [
    { name: 'server-a', scope: 'user', config: { type: 'stdio', env: { API_KEY: 'YOUR_API_KEY_HERE' } } },
    { name: 'server-b', scope: 'project-local', config: { type: 'stdio', env: { TOKEN: 'YOUR_TOKEN' } } }
  ];
  const missing = findMissingEnvVars(servers);
  assert.equal(missing.length, 2);
  assert.equal(missing[0].name, 'server-a');
  assert.equal(missing[1].name, 'server-b');
});
