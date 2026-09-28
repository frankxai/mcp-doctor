import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkServer, lintTools } from '../dist/checker/check-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'fixture-server.mjs');
const cli = path.join(here, '..', 'dist', 'cli.js');
const good = [{ name: 'campaign_draft', description: 'Draft a seven-channel campaign package from sources.', inputSchema: { type: 'object', properties: {} } }];
const bad = [
  { name: 'Bad-Name', description: 'x', inputSchema: { type: 'string' } },
  { name: 'dup_tool', description: 'A long enough description for this tool.', inputSchema: { type: 'object' } },
  { name: 'dup_tool', description: 'A long enough description for this tool.', inputSchema: { type: 'object' } },
];
const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('lintTools passes a contract-clean tool', () => {
  assert.deepEqual(lintTools(good), []);
});

test('lintTools reports name, description, schema and duplicate violations', () => {
  const rules = lintTools(bad).map((issue) => issue.rule).sort();
  assert.deepEqual(rules, ['description', 'duplicate', 'name', 'schema']);
});

test('checkServer lists tools from a live stdio server', async () => {
  const report = await checkServer(process.execPath, [fixture, JSON.stringify(good)]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.server, { name: 'fixture', version: '0.0.1' });
  assert.deepEqual(report.tools, ['campaign_draft']);
});

test('checkServer reports a server that cannot start', async () => {
  const report = await checkServer(process.execPath, [path.join(here, 'missing.mjs')], 3000);
  assert.equal(report.ok, false);
  assert.equal(report.issues[0].rule, 'connect');
  assert.match(report.issues[0].message, /Cannot find module/, 'the server stderr explains why it died');
});

test('cli check exits 1 with JSON on violations and 0 when clean', () => {
  const fail = runCli(['check', '--json', '--', process.execPath, fixture, JSON.stringify(bad)]);
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).ok, false);
  const pass = runCli(['check', '--json', '--', process.execPath, fixture, JSON.stringify(good)]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).toolCount, 1);
});

test('mcp-doctor serve passes its own contract and reports the package version', async () => {
  const { version } = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const report = await checkServer(process.execPath, [cli, 'serve']);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.server, { name: 'mcp-doctor', version });
});

test('cli check without a target is a usage error', () => {
  const result = runCli(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: mcp-doctor check/);
});
