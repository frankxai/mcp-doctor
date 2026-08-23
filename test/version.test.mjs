// Run: node --test "test/*.test.mjs"   (after `pnpm build`)
//
// This package had its version written out by hand in three places and all three had drifted: the
// CLI banner and the MCP handshake said 0.4.0, the health-checker introduced itself to other servers
// as 0.3.0, while package.json said 0.4.1. Nothing failed, because nothing compared them.
//
// These assertions are behavioural on purpose. The test they replaced grepped a 140-character window
// of a build artifact for a version literal, which passes vacuously the moment the constant is
// hoisted, the object gains a field, or the symbol moves file — i.e. exactly when it regresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { formatHeader } from '../dist/reporter/format.js';
import { PACKAGE_VERSION } from '../dist/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('the exported version is the manifest version', () => {
  assert.equal(PACKAGE_VERSION, pkg.version);
});

test('the CLI banner prints the version the package actually is', () => {
  const banner = strip(formatHeader());
  assert.ok(banner.includes(`MCP Doctor v${pkg.version}`), `banner does not carry v${pkg.version}:\n${banner}`);
});

test('the banner box stays aligned whatever the version string is', () => {
  // A longer version (0.9.0 -> 0.10.0) must not push the right border out.
  const widths = new Set(strip(formatHeader()).split('\n').filter(l => l.trim()).map(l => [...l].length));
  assert.equal(widths.size, 1, `banner rows have differing widths: ${[...widths].join(', ')}`);
});

test('the MCP handshake advertises the manifest version', () => {
  const out = execFileSync(process.execPath, ['scripts/release/mcp-stdio-smoke.mjs', '--', 'node', 'dist/cli.js', 'serve'], { encoding: 'utf8' });
  assert.ok(out.includes(`mcp-doctor v${pkg.version}`), `smoke reported: ${out.split('\n')[0]}`);
});

test('no version literal is hand-written anywhere in the built output', () => {
  // Belt to the behavioural braces above: catches a drift site that has no observable surface yet.
  const pattern = /version:\s*["'](\d+\.\d+\.\d+)["']|v\d+\.\d+\.\d+/g;
  for (const f of ['dist/reporter/format.js', 'dist/mcp-server.js', 'dist/scanner/health-checker.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const hits = [...src.matchAll(pattern)].map(m => m[0]);
    assert.deepEqual(hits, [], `${f} hardcodes a version: ${hits.join(', ')} — import PACKAGE_VERSION instead`);
  }
});
