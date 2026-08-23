#!/usr/bin/env node
// pack-assert.mjs — pack the package and assert what actually ships.
// Run from a package dir: node scripts/release/pack-assert.mjs [--kind cli|mcp|lib|plugin] [--budget-kb N] [--keep]
// Catches the failures a green build never does: a bin without a shebang, a secret swept into `files`,
// a workspace:* dependency that makes `npx` fail on a stranger's machine, an unreviewed size blowup.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTar } from './read-tar.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const kind = opt('--kind', pkg.bin ? 'cli' : 'lib');
const budgetKB = parseInt(opt('--budget-kb', '400'), 10);

const fail = [];
const note = [];
const out = mkdtempSync(join(tmpdir(), 'pack-assert-'));

let tgz;
try {
  const res = execFileSync('pnpm', ['pack', '--pack-destination', out], { stdio: ['pipe', 'pipe', 'inherit'] }).toString().trim();
  tgz = res.split('\n').filter(Boolean).pop().trim();
  if (!tgz.includes(out)) tgz = join(out, readdirSync(out).find(f => f.endsWith('.tgz')));
} catch (err) {
  console.error('pack-assert: pnpm pack failed —', err.message);
  process.exit(1);
}

const tarAll = readTar(tgz);
const links = tarAll.filter(e => e.kind === 'symlink' || e.kind === 'hardlink');
const tar = tarAll.filter(e => !e.dir);
const listing = tar.map(e => e.name.replace(/^package\//, '').replace(/\/$/, ''));
const entries = new Set(listing);
const byName = new Map(tar.map(e => [e.name.replace(/^package\//, ''), e]));
const unpacked = tar.reduce((n, e) => n + e.size, 0);

const has = p => entries.has(p);
const anyMatch = re => listing.filter(f => re.test(f));

// 1. Required entries. npm always includes package.json, README and LICENSE when present — assert
//    they are actually present, because a missing LICENSE is a publint error, not a warning.
const required = ['package.json'];
if (kind !== 'plugin') required.push(...Object.values(pkg.bin ?? {}).map(b => b.replace(/^\.\//, '')));
for (const r of required) if (!has(r)) fail.push(`missing required entry: ${r}`);
if (!listing.some(f => /^LICEN[CS]E/i.test(f))) fail.push('no LICENSE file in the tarball (publint errors on this)');
if (!listing.some(f => /^README/i.test(f))) fail.push('no README in the tarball');

// 2. Forbidden content.
const forbidden = [/^scripts\/release\//, /(^|\/)\.env($|\.)/, /(^|\/)test-output\.txt$/, /\.log$/, /(^|\/)node_modules\//, /(^|\/)\.asph-wip\//, /\.tsbuildinfo$/, /(^|\/)\.DS_Store$/, /(^|\/)\.npmrc$/];
for (const re of forbidden) for (const f of anyMatch(re)) fail.push(`forbidden file shipped: ${f}`);
if (kind !== 'plugin') for (const f of anyMatch(/^src\//)) { note.push(`ships source: ${f}`); break; }

// 3. Every bin must start with a shebang or the install is broken on POSIX.
for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
  const p = rel.replace(/^\.\//, '');
  if (!has(p)) continue;
  const body = byName.get(p)?.read().toString('utf8') ?? '';
  if (!body.startsWith('#!')) fail.push(`bin "${name}" (${p}) has no shebang — npx would not execute it`);
}

// 4. A published dependency on a workspace/link/file protocol is the @arcanea/mcp-server@0.7.0 defect:
//    it installs fine locally and 404s for every real user.
for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
  if (/^(workspace|link|file|portal):/.test(String(range))) fail.push(`dependency ${dep}@${range} uses a local protocol — npx install will fail for everyone else`);
}

// 5. Links. A symlink is a file for every purpose that matters here, and one pointing outside the
//    package is an escape the forbidden-name list cannot see.
for (const l of links) {
  const target = l.link ?? '';
  if (target.startsWith('/') || target.split('/').includes('..')) fail.push(`${l.kind} "${l.name}" points outside the package: ${target}`);
  else note.push(`${l.kind}: ${l.name} -> ${target}`);
}

// 6. Size budget.
const kb = Math.round(unpacked / 1024);
if (kb > budgetKB) fail.push(`unpacked ${kb} KB exceeds the ${budgetKB} KB budget (raise it in kit.json deliberately, or trim \`files\`)`);

if (!args.includes('--keep')) rmSync(out, { recursive: true, force: true });

console.log(`pack-assert: ${pkg.name}@${pkg.version} — ${listing.length} entries, ${kb} KB unpacked (budget ${budgetKB} KB)`);
for (const n of note) console.log(`  note: ${n}`);
if (fail.length) { console.error(`\npack-assert FAILED (${fail.length}):`); for (const f of fail) console.error(`  ✗ ${f}`); process.exit(1); }
console.log('  ✓ entries, shebangs, protocols, size all pass');
