// Run: node --test test/   (after `pnpm build` — these exercise the built output, which is what ships)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactSecrets } from '../dist/scanner/health-checker.js';

// redactSecrets is the load-bearing safety function here: mcp-doctor spawns other people's MCP
// servers and prints their stderr, so anything it misses gets printed.
//
// Every fixture below is assembled at runtime from a prefix plus filler. No literal secret shape is
// ever written into this file — a repo's own test suite is a place real keys get committed.
const fake = (prefix, len, fill = 'a') => prefix + fill.repeat(len);

test('redacts a configured env value out of captured output', () => {
  const token = fake('ghp_', 36);
  const out = redactSecrets(`failed to auth with ${token} sorry`, { GITHUB_TOKEN: token });
  assert.ok(!out.includes(token), 'raw secret survived');
  assert.match(out, /\[REDACTED:GITHUB_TOKEN\]/);
});

test('redacts every occurrence, not just the first', () => {
  const value = fake('value', 14);
  const out = redactSecrets(`${value} then ${value}`, { API_KEY: value });
  assert.equal(out.includes(value), false);
  assert.equal(out.match(/\[REDACTED:API_KEY\]/g).length, 2);
});

test('catches a registry token by pattern even when it is not in the server env', () => {
  const token = fake('npm_', 36, 'b');
  const out = redactSecrets(`${token} leaked into a log`, {});
  assert.match(out, /\[REDACTED:NPM_TOKEN\]/);
  assert.ok(!out.includes(token));
});

test('catches provider key shapes with no env at all', () => {
  const cases = [
    [fake('sk-ant-api', 24), /\[REDACTED:ANTHROPIC_KEY\]/],
    [fake('sk-', 26, 'c'), /\[REDACTED:OPENAI_KEY\]/],
    [fake('AIzaSy', 33, 'd'), /\[REDACTED:GEMINI_KEY\]/],
    [`${fake('eyJ', 50, 'e')}.payload.signature`, /\[REDACTED:JWT\]/],
    [fake('xai-', 24, 'f'), /\[REDACTED:XAI_KEY\]/],
  ];
  for (const [secret, expected] of cases) {
    assert.match(redactSecrets(`log: ${secret}`, {}), expected, `missed ${secret.slice(0, 8)}…`);
  }
});

test('leaves ordinary text alone', () => {
  const text = 'Exited with code 1: ENOENT: no such file or directory';
  assert.equal(redactSecrets(text, { PATH: '/usr/bin' }), text);
});

// Documented limitation, asserted so that changing the threshold is a deliberate act: values of six
// characters or fewer are not redacted by env matching. They are too short to replace without
// mangling ordinary output, and the pattern net still covers real key shapes.
test('short env values are deliberately not redacted by value matching', () => {
  const out = redactSecrets('the mode is debug', { MODE: 'debug' });
  assert.equal(out, 'the mode is debug');
});

test('the MCP handshake advertises the version the package actually is', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const built = readFileSync(new URL('../dist/mcp-server.js', import.meta.url), 'utf8');
  const afterServerInfo = built.slice(built.indexOf('serverInfo'), built.indexOf('serverInfo') + 140);
  assert.ok(!/version:\s*["']\d+\.\d+\.\d+["']/.test(afterServerInfo),
    'serverInfo carries a hardcoded version — it drifts from package.json on the next release');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
});
