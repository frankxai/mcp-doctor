import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCollectionTool, scoreTools, servicePrefix } from '../dist/checker/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'fixture-server.mjs');
const cli = path.join(here, '..', 'dist', 'cli.js');

const best = [
  {
    name: 'fixture_search_articles',
    title: 'Search articles',
    description: 'Search published articles by keyword. Use before fixture_get_article; returns at most `limit` short summaries, no bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Keywords' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max results' },
      },
      required: ['query'],
    },
    outputSchema: { type: 'object', properties: { items: { type: 'array' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'fixture_save_note',
    title: 'Save a note',
    description: 'Save a note to the local vault, replacing any note with the same id. Use only when the user asks to keep something.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,64}$', description: 'Note id' }, body: { type: 'string', maxLength: 10000, description: 'Markdown body' } },
      required: ['id', 'body'],
    },
    outputSchema: { type: 'object', properties: { saved: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'fixture_status',
    title: 'Server status',
    description: 'Report the server version and vault location. Cheap, takes no input; call it first when a tool fails unexpectedly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { version: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
];

const bare = [
  { name: 'searchStuff', description: 'Search.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'save', description: 'Saves things to the store.', inputSchema: { type: 'object', properties: {} } },
];

const byId = (report) => Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion]));

test('a server following every mechanical practice scores full marks', () => {
  const report = scoreTools(best, 'fixture');
  assert.equal(report.points, report.max);
  assert.equal(report.percent, 100);
  assert.deepEqual(report.criteria.filter((criterion) => criterion.points < 2).map((criterion) => criterion.id), []);
});

test('a bare server fails each criterion it misses, with the offending tools named', () => {
  const report = scoreTools(bare, 'fixture');
  const c = byId(report);
  assert.equal(c.annotations.points, 0);
  assert.equal(c.titles.points, 0);
  assert.equal(c.namespace.points, 0);
  assert.equal(c.descriptions.points, 0);
  assert.equal(c.inputs.points, 0);
  assert.equal(c.structured_output.points, 0);
  assert.equal(c.paging.points, 0);
  assert.deepEqual(c.paging.failing, ['searchStuff']);
  assert.ok(report.percent < 20);
});

test('namespace: server prefix earns 2, a shared other prefix 1', () => {
  assert.equal(byId(scoreTools(best, 'fixture')).namespace.points, 2);
  const shared = best.map((tool) => ({ ...tool, name: tool.name.replace('fixture_', 'notes_') }));
  assert.equal(byId(scoreTools(shared, 'fixture')).namespace.points, 1);
  assert.equal(byId(scoreTools(best, '@scope/fixture-mcp')).namespace.points, 2, 'scope and suffix are ignored');
});

test('paging is not applicable when no tool lists or searches', () => {
  const paging = byId(scoreTools([best[1], best[2]], 'fixture')).paging;
  assert.equal(paging.points, 2);
  assert.equal(paging.applicable, 0);
});

test('partial compliance earns 1 point', () => {
  const half = [best[0], { ...best[1], title: undefined }];
  assert.equal(byId(scoreTools(half, 'fixture')).titles.points, 1);
});

test('cli score: JSON report and --min gate', () => {
  const run = (tools, extra) => spawnSync(process.execPath, [cli, 'score', '--json', ...extra, '--', process.execPath, fixture, JSON.stringify(tools)], { encoding: 'utf8' });
  const good = run(best, ['--min', '90']);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).percent, 100);
  const poor = run(bare, ['--min', '50']);
  assert.equal(poor.status, 1);
  assert.ok(JSON.parse(poor.stdout).percent < 50);
});

test('a server with no tools scores 0 and fails the cli gate', () => {
  assert.equal(scoreTools([], 'fixture').percent, 0);
  const run = spawnSync(process.execPath, [cli, 'score', '--json', '--', process.execPath, fixture, '[]'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
});

test('servicePrefix keeps the whole service name', () => {
  assert.equal(servicePrefix('mcp-doctor'), 'mcp_doctor');
  assert.equal(servicePrefix('@scope/fixture-mcp'), 'fixture');
  assert.equal(servicePrefix('@modelcontextprotocol/server-filesystem'), 'filesystem');
  assert.equal(servicePrefix('arcanea-mcp-server'), 'arcanea');
  const tools = best.map((tool) => ({ ...tool, name: tool.name.replace('fixture_', 'mcp_unrelated_') }));
  assert.notEqual(byId(scoreTools(tools, 'mcp-doctor')).namespace.points, 2, 'a shared first word is not the prefix');
});

test('inputs: presence of a pattern, format or array is not a bound', () => {
  const pts = (schema) =>
    byId(scoreTools([{ ...best[2], inputSchema: { type: 'object', properties: { x: { description: 'x', ...schema } } } }], 'fixture')).inputs.points;
  assert.equal(pts({ type: 'string', pattern: '.*' }), 0);
  assert.equal(pts({ type: 'string', pattern: '^[a-z]+$' }), 0);
  assert.equal(pts({ type: 'string', format: 'uri' }), 0);
  assert.equal(pts({ type: 'array', items: { type: 'string', maxLength: 9 } }), 0);
  assert.equal(pts({ type: 'object', properties: { y: { type: 'string' } } }), 0);
  assert.equal(pts({ type: 'string', pattern: '^[a-z]{2,8}$' }), 2);
  assert.equal(pts({ type: 'string', format: 'uuid' }), 2);
  assert.equal(pts({ type: 'array', maxItems: 5, items: { type: 'string', maxLength: 9 } }), 2);
  assert.equal(pts({ type: 'boolean' }), 2);
});

test('paging: whole-word collection verbs, and the limit itself must be bounded', () => {
  assert.equal(isCollectionTool('listening_status'), false);
  assert.equal(isCollectionTool('listSessions'), true);
  assert.equal(isCollectionTool('get_all_records'), true);
  const lister = (limit) => [{ ...best[0], name: 'fixture_list_notes', inputSchema: { type: 'object', properties: { limit } } }];
  assert.equal(byId(scoreTools(lister({ type: 'integer', description: 'n' }), 'fixture')).paging.points, 0);
  assert.equal(byId(scoreTools(lister({ type: 'integer', maximum: 50, description: 'n' }), 'fixture')).paging.points, 2);
});

test('cli score: --min outside 0-100 is a usage error, not a disabled gate', () => {
  for (const min of ['-Infinity', '101', 'abc']) {
    const run = spawnSync(process.execPath, [cli, 'score', '--min', min, '--', process.execPath, fixture, JSON.stringify(best)], { encoding: 'utf8' });
    assert.equal(run.status, 1, min);
    assert.match(run.stderr, /Usage/, min);
  }
});
