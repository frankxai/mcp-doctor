#!/usr/bin/env node
// verify-package.mjs — the publish gate. Run from a package dir: node scripts/release/verify-package.mjs
//   flags: --kind cli|mcp|lib|plugin  --budget-kb N  --skip-audit  --skip-changeset
// Fails on the first red. Every check answers a way a package can be green in CI and broken for a user.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const kind = opt('--kind', pkg.mcpName ? 'mcp' : pkg.bin ? 'cli' : 'lib');
const budget = opt('--budget-kb', '400');

const step = (label, fn) => {
  process.stdout.write(`\n── ${label}\n`);
  try { fn(); } catch (err) {
    console.error(`\nverify FAILED at: ${label}`);
    if (err.stdout) console.error(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    else if (!err.stdout) console.error(err.message);
    process.exit(1);
  }
};
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...o });

step('publint — package.json against the built output', () => {
  run('pnpm', ['dlx', 'publint@0.3.24', '--strict']);
});

if (kind === 'lib') step('attw — do TypeScript consumers actually get types', () => {
  run('pnpm', ['dlx', '@arethetypeswrong/cli@0.18.5', '--pack', '.', '--profile', 'node16']);
});

step('pack-assert — what actually ships', () => {
  run('node', ['scripts/release/pack-assert.mjs', '--kind', kind, '--budget-kb', budget]);
});

if (kind === 'mcp') step('mcp stdio smoke — does it speak the protocol', () => {
  // Prefer the package's own `smoke:mcp` script: a server whose entrypoint is a CLI needs its
  // subcommand (`… serve`) and its expected tool list, and only the package knows those.
  if (pkg.scripts?.['smoke:mcp']) { run('pnpm', ['run', 'smoke:mcp']); return; }
  const bin = Object.values(pkg.bin ?? {})[0];
  if (!bin) throw new Error('kind=mcp but package.json declares no bin and no smoke:mcp script');
  run('node', ['scripts/release/mcp-stdio-smoke.mjs', 'node', bin.replace(/^\.\//, '')]);
});

if (!args.includes('--skip-audit')) step('audit — production dependencies only', () => {
  run('pnpm', ['audit', '--prod', '--audit-level=high']);
});

step('install scripts — nothing runs code on a stranger\'s machine unannounced', () => {
  const allow = new Set(['better-sqlite3']);
  const deps = Object.keys(pkg.dependencies ?? {});
  const offenders = [];
  for (const d of deps) {
    if (allow.has(d)) continue;
    let meta;
    try { meta = JSON.parse(execFileSync('npm', ['view', d, 'scripts', '--json'], { stdio: ['pipe', 'pipe', 'ignore'] }).toString() || '{}'); } catch { continue; }
    const s = Array.isArray(meta) ? meta.at(-1) ?? {} : meta;
    for (const hook of ['preinstall', 'install', 'postinstall']) if (s?.[hook]) offenders.push(`${d}.${hook}`);
  }
  if (offenders.length) throw new Error(`dependencies with install hooks (allow-list them in kit.json if intended): ${offenders.join(', ')}`);
  console.log(`  ✓ ${deps.length} production dependencies, no unexpected install hooks`);
});

if (!args.includes('--skip-changeset') && existsSync('.changeset')) step('changeset — a source change without a version bump is a silent release gap', () => {
  try { run('pnpm', ['exec', 'changeset', 'status', '--since=origin/main']); }
  catch { throw new Error('no changeset for the changes on this branch — run `pnpm changeset` (or `pnpm changeset --empty` if this genuinely ships nothing)'); }
});

console.log(`\n✓ verify-package: ${pkg.name}@${pkg.version} (kind=${kind}) is publishable`);
