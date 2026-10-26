import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { invalidArguments, probeServer, UNKNOWN_TOOL } from '../dist/checker/probe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'behavior-server.mjs');
const cli = path.join(here, '..', 'dist', 'cli.js');
const logFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'mcp-probe-')), 'calls.log');
const calls = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
const failing = (report) => report.findings.filter((f) => !f.ok).map((f) => `${f.rule}:${f.tool ?? ''}`).sort();

test('invalidArguments derives input only from the tool\'s own schema, and only for read-only tools', () => {
  const ro = { readOnlyHint: true };
  assert.deepEqual(invalidArguments({ name: 'a', annotations: ro, inputSchema: { type: 'object', required: ['q'] } }), { args: {} });
  assert.deepEqual(Object.keys(invalidArguments({ name: 'b', annotations: ro, inputSchema: { type: 'object', additionalProperties: false } }).args), ['mcp_doctor_probe_extra']);
  assert.match(invalidArguments({ name: 'c', annotations: ro, inputSchema: { type: 'object' } }).skip, /any object/);
  assert.match(invalidArguments({ name: 'd', annotations: { readOnlyHint: true, destructiveHint: true } }).skip, /destructive/);
  assert.match(invalidArguments({ name: 'e', inputSchema: { type: 'object', required: ['id'] } }).skip, /never called/);
});

test('a server that honours its schemas passes, and write or unannotated tools are never called', async () => {
  const log = logFile();
  const report = await probeServer(process.execPath, [fixture, 'strict', log]);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.probed, ['note_lookup', 'note_list']);
  assert.deepEqual(report.skipped.map((s) => s.tool), ['note_search_open', 'note_delete', 'note_touch']);
  assert.deepEqual(calls(log), [UNKNOWN_TOOL, 'note_lookup', 'note_list']);
});

test('a server that accepts invalid input fails every probe it should have refused', async () => {
  const report = await probeServer(process.execPath, [fixture, 'lax', logFile()]);
  assert.equal(report.ok, false);
  assert.deepEqual(failing(report), ['bad-args:note_list', 'bad-args:note_lookup', 'unknown-tool:']);
  assert.ok(report.findings.find((f) => f.rule === 'survives').ok);
});

test('a server that hangs is reported per call and the probe still finishes', async () => {
  const started = Date.now();
  const report = await probeServer(process.execPath, [fixture, 'hang', logFile()], { callTimeoutMs: 300 });
  assert.equal(report.ok, false);
  assert.match(report.findings[0].message, /No answer/);
  assert.ok(Date.now() - started < 20000, 'per-call timeouts bound the run');
});

test('a server that dies on its first call stops the probe and fails survives', async () => {
  const log = logFile();
  const report = await probeServer(process.execPath, [fixture, 'crash', log]);
  assert.equal(report.ok, false);
  assert.match(report.findings[0].message, /connection dropped/);
  assert.equal(report.findings.find((f) => f.rule === 'survives').ok, false);
  assert.deepEqual(calls(log), [UNKNOWN_TOOL], 'nothing is called after the server dies');
});

test('a server that cannot start is reported as connect', async () => {
  const report = await probeServer(process.execPath, [path.join(here, 'missing.mjs')], { timeoutMs: 3000 });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].rule, 'connect');
});

test('cli probe exits 0 on a well-behaved server and 1 with JSON on a lax one', () => {
  const pass = spawnSync(process.execPath, [cli, 'probe', '--json', '--', process.execPath, fixture, 'strict'], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).ok, true);
  const fail = spawnSync(process.execPath, [cli, 'probe', '--json', '--', process.execPath, fixture, 'lax'], { encoding: 'utf8' });
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).ok, false);
});
