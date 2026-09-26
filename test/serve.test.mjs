import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

// The server reads the real user's agent configs; a scratch home keeps every run hermetic.
const home = mkdtempSync(path.join(tmpdir(), 'mcp-doctor-serve-'));
writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify({
    mcpServers: {
      alpha: { type: 'stdio', command: 'node', args: ['alpha.js'], env: { API_TOKEN: 'sk-live-should-never-leak' } },
      beta: { type: 'streamable-http', url: 'https://example.com/mcp?key=secret-in-url' },
    },
  }),
);
mkdirSync(path.join(home, '.claude'));
writeFileSync(
  path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ mcpServers: { lost: { command: 'node' } } }),
);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') };

async function connect() {
  const client = new Client({ name: 'serve-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve'], env, cwd: home, stderr: 'pipe' }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${name}: text block mirrors structuredContent`);
  return result;
}

test('serve scores 100% on its own quality bar', () => {
  const run = spawnSync(process.execPath, [cli, 'score', '--json', '--', process.execPath, cli, 'serve'], { env, cwd: home, encoding: 'utf8' });
  const report = JSON.parse(run.stdout);
  const failing = report.criteria.filter((c) => c.points < 2).map((c) => `${c.id}: ${c.failing.join(', ')}`);
  assert.deepEqual(failing, []);
  assert.equal(report.percent, 100);
  assert.equal(run.status, 0);
});

test('audit returns structured health for every configured server, without secrets', async () => {
  const client = await connect();
  try {
    const { structuredContent: audit } = await call(client, 'mcp_doctor_audit', { quick: true });
    assert.equal(audit.mode, 'quick');
    assert.deepEqual(audit.servers.map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.equal(audit.summary.servers, 2);
    assert.ok(audit.summary.healthScore >= 0 && audit.summary.healthScore <= 100);
    assert.deepEqual(audit.misplaced.map((m) => m.serverNames), [['lost']]);
    const text = JSON.stringify(audit);
    assert.ok(!text.includes('sk-live-should-never-leak'), 'env values stay out');
    assert.ok(!text.includes('secret-in-url'), 'url query strings stay out');
  } finally {
    await client.close();
  }
});

test('misplaced configs name the file, the servers, and the fix', async () => {
  const client = await connect();
  try {
    const { structuredContent: out } = await call(client, 'mcp_doctor_misplaced_configs');
    assert.equal(out.misplaced.length, 1);
    assert.equal(out.misplaced[0].filePath, path.join(home, '.claude', 'settings.json'));
    assert.deepEqual(out.misplaced[0].serverNames, ['lost']);
    assert.ok(out.fix.some((step) => step.includes('claude mcp add')));
  } finally {
    await client.close();
  }
});

test('preset packs: overview, one pack in detail, unknown pack rejected before running', async () => {
  const client = await connect();
  try {
    const { structuredContent: all } = await call(client, 'mcp_doctor_preset_packs');
    assert.ok(all.packs.length > 0);
    assert.ok(all.packs.every((p) => p.alwaysOn + p.onDemand > 0));
    assert.equal(all.pack, undefined);

    const { structuredContent: one } = await call(client, 'mcp_doctor_preset_packs', { pack: all.packs[0].key });
    assert.equal(one.pack.key, all.packs[0].key);
    assert.ok(one.pack.servers.length > 0);

    const bad = await client.callTool({ name: 'mcp_doctor_preset_packs', arguments: { pack: 'nope' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /pack/);
  } finally {
    await client.close();
  }
});

test('agents lists the scratch home as Claude Code with its server count', async () => {
  const client = await connect();
  try {
    const { structuredContent: out } = await call(client, 'mcp_doctor_agents');
    const claude = out.agents.find((a) => a.agent === 'claude-code');
    assert.ok(claude, JSON.stringify(out.agents));
    assert.ok(claude.serverCount >= 2);
    assert.ok(!JSON.stringify(out).includes('secret-in-url'));
  } finally {
    await client.close();
  }
});
