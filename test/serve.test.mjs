import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
      leaky: { type: 'stdio', command: 'node', args: [path.join(here, 'fixtures', 'leaky-server.mjs'), '--token=sentinel-arg-secret'] },
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
    assert.deepEqual(audit.servers.map((s) => s.name).sort(), ['alpha', 'beta', 'leaky']);
    assert.equal(audit.summary.servers, 3);
    assert.equal(audit.summary.unchecked, 3);
    assert.equal(audit.summary.healthScore, null);
    assert.deepEqual(audit.misplaced.map((m) => m.serverNames), [['lost']]);
    const text = JSON.stringify(audit);
    assert.ok(!text.includes('sk-live-should-never-leak'), 'env values stay out');
    assert.ok(!text.includes('secret-in-url'), 'url query strings stay out');
  } finally {
    await client.close();
  }
});

test('full audit starts servers, yet a token a failing server echoes from its args never reaches the agent', async () => {
  const client = await connect();
  try {
    const { structuredContent: audit } = await call(client, 'mcp_doctor_audit', { quick: false });
    const leaky = audit.servers.find((s) => s.name === 'leaky');
    assert.equal(leaky.status, 'broken', 'the fixture really ran and failed');
    const text = JSON.stringify(audit);
    assert.ok(!text.includes('sentinel-arg-secret'), 'args secrets stay out of status and tier reasons');
    assert.ok(!text.includes('sk-live-should-never-leak'));
  } finally {
    await client.close();
  }
});

test('a remote-only setup is not rated 0: nothing was verified, so the score is null', async () => {
  const remoteHome = mkdtempSync(path.join(tmpdir(), 'mcp-doctor-remote-'));
  writeFileSync(path.join(remoteHome, '.claude.json'), JSON.stringify({ mcpServers: { r: { type: 'streamable-http', url: 'https://example.com/mcp' } } }));
  const client = new Client({ name: 'serve-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve'],
      env: { ...env, HOME: remoteHome, USERPROFILE: remoteHome },
      cwd: remoteHome,
      stderr: 'pipe',
    }),
  );
  try {
    const { structuredContent: audit } = await call(client, 'mcp_doctor_audit', {});
    assert.equal(audit.summary.unchecked, 1);
    assert.equal(audit.summary.healthScore, null);
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

// ------------------------------------------------------------------ PRD-005
// heal as a callable MCP surface: same ladder the CLI runs, explicit target
// always. Same fixture vocabulary as test/heal-s1.test.mjs (missing-binary
// death is deterministic), exercised end-to-end through the server.
const strip = (text) => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

// The single verb table, imported exactly once and shared by every test that
// checks a surface against it (PRD-005 §5): the lazy import keeps the file
// loading before a build exists, and there is no duplicated list in tests.
let doctorVerbsTable;
async function doctorVerbs() {
  doctorVerbsTable ??= (
    await import(pathToFileURL(path.join(here, '..', 'dist', 'heal', 'modes.js')))
  ).DOCTOR_VERBS;
  return doctorVerbsTable;
}

const DEAD_COMMAND = 'mcp-doctor-serve-heal-fixture-missing-binary';
const LAST_FAILURE = '2026-11-01T00:00:00.000Z';
const REASON = `MCP check failed (missing-command) on 3 consecutive audit runs; last failure ${LAST_FAILURE}`;
const HEAL_SECRET = 'sk-heal-should-never-leak';

const deadConfig = { type: 'stdio', command: DEAD_COMMAND, env: { TOKEN: HEAL_SECRET } };
const healthyConfig = { type: 'stdio', command: process.execPath, args: [path.join(here, 'fixtures', 'health-probe.mjs'), 'success'] };
const deadText = JSON.stringify(deadConfig);
const healthyText = JSON.stringify(healthyConfig);
const healPreText = `{"mcpServers":{"healthy":${healthyText},"dead":${deadText}}}`;
const quarantineEntry = `{"name":"dead","config":${deadText},"reason":${JSON.stringify(REASON)}}`;
const healPostText = `{"quarantined":[${quarantineEntry}],"mcpServers":{"healthy":${healthyText}}}`;

/**
 * Seed the durable H1 failure history exactly as three separate `audit` runs
 * would (PRD-001 §3 H1, review surface A). Same file, same identity key, same
 * config hash the production read path computes — the test exercises the real
 * reader, never a parallel one.
 */
function seedHealHistory(configPath, rawValue, name = 'dead') {
  const file = path.join(home, '.mcp-doctor', 'failure-history.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, records: {} };
  store.records[`${configPath}\u0000user\u0000\u0000${name}`] = {
    server: name,
    scope: 'user',
    configPath,
    configHash: createHash('sha256').update(rawValue, 'utf8').digest('hex'),
    consecutiveFailures: 3,
    firstFailureAt: '2026-10-31T00:00:00.000Z',
    lastFailureAt: LAST_FAILURE,
    lastStatus: 'missing-command',
    run: 'seed',
  };
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
}

/** A heal fixture config inside its own temp dir; the receipt tree lands beside it. */
function healFixture({ seed = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-doctor-serve-heal-'));
  const configPath = path.join(dir, 'claude.json');
  writeFileSync(configPath, healPreText, 'utf8');
  if (seed) seedHealHistory(configPath, deadText);
  return { dir, configPath };
}

function receipts(dir) {
  const healDir = path.join(dir, '.mcp-doctor', 'heal');
  return existsSync(healDir) ? readdirSync(healDir).filter((n) => n.endsWith('.json')) : [];
}

test('PRD-005 §4.1: heal_plan mirrors heal --plan --config in structured output and writes nothing', { timeout: 45000 }, async () => {
  const { dir, configPath } = healFixture();
  const before = readFileSync(configPath, 'utf8');
  const client = await connect();
  try {
    const { structuredContent: plan } = await call(client, 'mcp_doctor_heal_plan', { configPath });
    assert.equal(plan.configPath, configPath);
    assert.deepEqual(plan.items.map((i) => [i.rung, i.server, i.scope]), [['H1', 'dead', 'user']], JSON.stringify(plan));
    assert.ok(plan.items[0].reason.length > 0, 'the reason travels');
    assert.ok(!JSON.stringify(plan).includes(HEAL_SECRET), 'raw config values stay out of the plan');
    assert.ok(!JSON.stringify(plan).includes(deadText), 'the raw byte config stays out of the plan');

    // Same repair list as the CLI shows for the same explicit target.
    const run = spawnSync(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'heal', '--plan', '--config', configPath], {
      env, cwd: dir, encoding: 'utf8', timeout: 45000,
    });
    const cliNames = [...strip(run.stdout).matchAll(/H1 QUARANTINE-DEAD (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(plan.items.map((i) => i.server), cliNames);
    assert.ok(strip(run.stdout).includes(plan.items[0].reason), 'the CLI plan cites the same redacted reason');

    // And it wrote nothing anywhere.
    assert.equal(readFileSync(configPath, 'utf8'), before, 'fixture byte-identical after planning');
    assert.ok(!existsSync(path.join(dir, '.mcp-doctor')), 'no receipt tree created');
  } finally {
    await client.close();
  }
});

test('PRD-005 §4.2: heal_apply without configPath fails validation and writes nothing', { timeout: 45000 }, async () => {
  const { dir, configPath } = healFixture();
  const before = readFileSync(configPath, 'utf8');
  const client = await connect();
  try {
    const bad = await client.callTool({ name: 'mcp_doctor_heal_apply', arguments: {} });
    assert.equal(bad.isError, true, 'a mutating call without an explicit target must fail');
    assert.match(String(bad.content?.[0]?.text), /configPath/, `the error names the missing input: ${bad.content?.[0]?.text}`);
    assert.equal(readFileSync(configPath, 'utf8'), before, 'the refused call writes nothing');
    assert.ok(!existsSync(path.join(dir, '.mcp-doctor')), 'no receipt tree created');
  } finally {
    await client.close();
  }
});

test('PRD-005 §4.3: heal_apply with configPath applies, returns the plan it executed, and reaches the expected post-image', { timeout: 45000 }, async () => {
  const { dir, configPath } = healFixture();
  const client = await connect();
  try {
    const { structuredContent: applied } = await call(client, 'mcp_doctor_heal_apply', { configPath });
    assert.equal(applied.applied, 1, JSON.stringify(applied));
    assert.deepEqual(applied.receiptIds.length, 1, 'exactly one receipt');
    assert.equal(applied.configPath, configPath);
    assert.deepEqual(applied.plan.items.map((i) => [i.rung, i.server]), [['H1', 'dead']], 'the plan it executed travels in the response');
    assert.ok(!JSON.stringify(applied).includes(HEAL_SECRET), 'raw config values stay out of the apply response');

    // The fixture reached the expected post-image byte-for-byte.
    assert.equal(readFileSync(configPath, 'utf8'), healPostText, 'survivor bytes intact; dead entry verbatim in quarantined[]');

    // The receipt sits beside the named target and records that target only.
    assert.deepEqual(receipts(dir), [`${applied.receiptIds[0]}.json`]);
    const receipt = JSON.parse(readFileSync(path.join(dir, '.mcp-doctor', 'heal', `${applied.receiptIds[0]}.json`), 'utf8'));
    assert.equal(receipt.configPath, configPath);
    assert.equal(receipt.preImageSha256, applied.preImageSha256);
    assert.equal(receipt.postImageSha256, applied.postImageSha256);

    // §4.3/§5.3: the receipt carries hashes and a redacted diff, never a
    // plaintext pre-image or a path to one, and no artifact under .mcp-doctor
    // carries the fixture's credential.
    assert.equal(receipt.diff.removedEntries.length, 1, 'the redacted diff travels in the receipt');
    assert.ok(receipt.reconstruction, 'the receipt carries reconstruction metadata instead of bytes');
    assert.ok(!('preImagePath' in receipt), 'no plaintext pre-image path in the receipt');
    assert.ok(!('preImage' in receipt), 'no plaintext pre-image bytes in the receipt');
    assert.ok(!JSON.stringify(receipt).includes(HEAL_SECRET), 'the receipt never carries the credential');
    assert.equal(existsSync(path.join(dir, '.mcp-doctor', 'pre-images')), false, 'no pre-image store exists at all');
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else assert.ok(!readFileSync(full, 'utf8').includes(HEAL_SECRET), `${full} leaked the credential`);
      }
    };
    walk(path.join(dir, '.mcp-doctor'));

    // §5.3: rollback still restores the byte-exact pre-image, proved by hash.
    const { structuredContent: rolled } = await call(client, 'mcp_doctor_heal_rollback', { id: applied.receiptIds[0], configPath });
    assert.equal(rolled.status, 'restored', JSON.stringify(rolled));
    assert.equal(readFileSync(configPath, 'utf8'), healPreText, 'byte-exact pre-image restored');
    assert.equal(
      createHash('sha256').update(readFileSync(configPath)).digest('hex'),
      applied.preImageSha256,
      'sha256 equality with the receipt pre-image hash',
    );
  } finally {
    await client.close();
  }
});

test('PRD-005 §4.4: heal_rollback refuses a receipt whose recorded path is not configPath, and writes nothing', { timeout: 45000 }, async () => {
  const { dir: dirA, configPath: configPathA } = healFixture();
  const client = await connect();
  try {
    const { structuredContent: applied } = await call(client, 'mcp_doctor_heal_apply', { configPath: configPathA });
    const id = applied.receiptIds[0];

    // Plant the receipt beside a different config (the planted-receipt attack from heal-s1).
    const dirB = mkdtempSync(path.join(tmpdir(), 'mcp-doctor-serve-heal-b-'));
    const configPathB = path.join(dirB, 'claude.json');
    writeFileSync(configPathB, healPostText, 'utf8');
    mkdirSync(path.join(dirB, '.mcp-doctor', 'heal'), { recursive: true });
    writeFileSync(path.join(dirB, '.mcp-doctor', 'heal', `${id}.json`), readFileSync(path.join(dirA, '.mcp-doctor', 'heal', `${id}.json`), 'utf8'));

    const refused = await client.callTool({ name: 'mcp_doctor_heal_rollback', arguments: { id, configPath: configPathB } });
    assert.equal(refused.isError, true, 'a mismatched target is refused, not silently ignored');
    assert.equal(refused.structuredContent.status, 'refused');
    assert.match(String(refused.structuredContent.refusal), /is not the config/, JSON.stringify(refused.structuredContent));
    assert.equal(readFileSync(configPathB, 'utf8'), healPostText, 'the refused rollback wrote nothing');
    assert.equal(readFileSync(configPathA, 'utf8'), healPostText, 'the receipt owner is untouched too');
  } finally {
    await client.close();
  }
});

test('PRD-005 §4.5: modes lists every verb with its write class from the one shared table', { timeout: 45000 }, async () => {
  const client = await connect();
  try {
    const { structuredContent: modes } = await call(client, 'mcp_doctor_modes');
    const expected = [
      'mcp_doctor_audit',
      'mcp_doctor_agents',
      'mcp_doctor_misplaced_configs',
      'mcp_doctor_preset_packs',
      'mcp_doctor_modes',
      'mcp_doctor_heal_plan',
      'mcp_doctor_heal_apply',
      'mcp_doctor_heal_rollback',
    ];
    assert.deepEqual(modes.verbs.map((v) => v.verb).sort(), expected.slice().sort());

    const writeClass = Object.fromEntries(modes.verbs.map((v) => [v.verb, v]));
    // §3: read-only and named-config-write, exactly as declared.
    for (const verb of ['mcp_doctor_modes', 'mcp_doctor_heal_plan', 'mcp_doctor_audit', 'mcp_doctor_agents']) {
      assert.equal(writeClass[verb].writeClass, 'read-only', verb);
    }
    for (const verb of ['mcp_doctor_heal_apply', 'mcp_doctor_heal_rollback']) {
      assert.equal(writeClass[verb].writeClass, 'named-config-write', verb);
      assert.match(writeClass[verb].writes, /named config/, `${verb}: writes name the scope`);
      assert.match(writeClass[verb].target, /configPath \(required/, `${verb}: the explicit-target rule is in the table`);
    }

    // The table is the single source: the response equals the exported table,
    // and the four PRD-declared annotations follow it (§3's no-drift rule).
    const DOCTOR_VERBS = await doctorVerbs();
    assert.deepEqual(modes.verbs, DOCTOR_VERBS);
    const tools = await client.listTools();
    const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
    for (const row of DOCTOR_VERBS.filter((r) => r.verb.startsWith('mcp_doctor_heal') || r.verb === 'mcp_doctor_modes')) {
      const annotation = byName[row.verb].annotations;
      if (row.writeClass === 'read-only') {
        assert.equal(annotation.readOnlyHint, true, `${row.verb}: readOnlyHint follows the table`);
      } else {
        assert.equal(annotation.readOnlyHint, false, `${row.verb}: readOnlyHint follows the table`);
        assert.equal(annotation.destructiveHint, true, `${row.verb}: destructiveHint follows the table`);
        assert.equal(annotation.idempotentHint, true, `${row.verb}: idempotentHint follows the table`);
      }
    }

    // The table agrees with CLI behavior: ambient apply refuses, explicit plan
    // writes nothing (empirical no-drift check for the CLI side of the table).
    const applyRefused = spawnSync(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'heal', '--apply'], {
      env, cwd: home, encoding: 'utf8', timeout: 45000,
    });
    assert.equal(applyRefused.status, 3, `ambient apply without --yes must refuse: ${applyRefused.stdout}\n${applyRefused.stderr}`);
    assert.ok(
      (applyRefused.stdout + applyRefused.stderr).includes(path.join(home, '.claude.json')),
      `the refusal names the ambient target the table says a healer must not touch: ${applyRefused.stdout}\n${applyRefused.stderr}`,
    );

    const { dir, configPath } = healFixture();
    const before = readFileSync(configPath, 'utf8');
    const planned = spawnSync(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'heal', '--plan', '--config', configPath], {
      env, cwd: dir, encoding: 'utf8', timeout: 45000,
    });
    assert.equal(planned.status, 1, 'the CLI proposes the repair (write class read-only still reports it)');
    assert.ok(strip(planned.stdout).includes('H1 QUARANTINE-DEAD dead'));
    assert.equal(readFileSync(configPath, 'utf8'), before, 'plan write class matches CLI behavior: nothing written');

    // And the same verb proposes nothing when the history does not vouch for
    // the entry: one observation is not death (surface A).
    const quiet = healFixture({ seed: false });
    const quietBefore = readFileSync(quiet.configPath, 'utf8');
    const quietPlan = spawnSync(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'heal', '--plan', '--config', quiet.configPath], {
      env, cwd: quiet.dir, encoding: 'utf8', timeout: 45000,
    });
    assert.equal(quietPlan.status, 0, `a fresh registration must not be proposed: ${quietPlan.stdout}\n${quietPlan.stderr}`);
    assert.ok(!strip(quietPlan.stdout).includes('H1 QUARANTINE-DEAD'), 'no repair without three recorded failures');
    assert.equal(readFileSync(quiet.configPath, 'utf8'), quietBefore, 'the quiet plan writes nothing either');
  } finally {
    await client.close();
  }
});

test('PRD-005 §5: the CLI help and the modes response both derive from the one verb table', { timeout: 45000 }, async () => {
  const table = await doctorVerbs();

  // The CLI renders every row of the table — verb and its CLI mapping — in
  // its help, so editing src/heal/modes.ts has to change the help's verb
  // section on the next build.
  const help = spawnSync(process.execPath, [cli, 'help'], { env, cwd: home, encoding: 'utf8' });
  const helpText = strip(help.stdout + help.stderr);
  for (const row of table) {
    assert.ok(helpText.includes(row.verb), `CLI help names the verb ${row.verb}`);
    assert.ok(helpText.includes(row.mapsTo), `CLI help names ${row.verb}'s CLI mapping`);
  }

  // And conversely the MCP surface serves exactly that same table, verbatim,
  // with no snapshot copy in between: assert against the import, not a literal.
  const client = await connect();
  try {
    const { structuredContent: modes } = await call(client, 'mcp_doctor_modes');
    assert.deepEqual(modes.verbs, table);
  } finally {
    await client.close();
  }
});
