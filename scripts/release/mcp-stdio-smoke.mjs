#!/usr/bin/env node
// mcp-stdio-smoke.mjs — prove an MCP server actually speaks the protocol over stdio.
// Run: node scripts/release/mcp-stdio-smoke.mjs [--expect a,b,c] [--min N] [--timeout MS] -- <command> [args...]
// A build that compiles and a server that answers `tools/list` are different claims. This asserts the second.
//
// Expectations are flags, not environment variables: `EXPECT_TOOLS=… node …` in a package script is
// POSIX-only, so an env-based smoke passes in Linux CI and fails on the Windows machine that cuts the
// release. Env vars are still honoured as a fallback.

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep >= 0 ? argv.slice(0, sep) : argv.filter(a => a.startsWith('--'));
const rest = sep >= 0 ? argv.slice(sep + 1) : argv.filter(a => !a.startsWith('--'));
const flag = (name, fallback) => { const i = flags.indexOf(`--${name}`); return i >= 0 ? flags[i + 1] : fallback; };

const [cmd, ...cmdArgs] = rest;
if (!cmd) { console.error('usage: mcp-stdio-smoke.mjs [--expect a,b,c] [--min N] -- <command> [args...]'); process.exit(2); }

const TIMEOUT = parseInt(flag('timeout', process.env.SMOKE_TIMEOUT_MS ?? '15000'), 10);
const MIN_TOOLS = parseInt(flag('min', process.env.MIN_TOOLS ?? '1'), 10);
const EXPECT = String(flag('expect', process.env.EXPECT_TOOLS ?? '')).split(',').map(s => s.trim()).filter(Boolean);
const PROTOCOL = '2025-06-18';

const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
const stderr = [];
child.stderr.on('data', d => stderr.push(d.toString()));

const pending = new Map();
let buf = '';
child.stdout.on('data', chunk => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }   // servers legitimately log non-JSON to stdout during boot
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

const send = (id, method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (${TIMEOUT}ms)`)), TIMEOUT);
  pending.set(id, msg => { clearTimeout(timer); msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
});

const die = (why) => {
  console.error(`mcp-stdio-smoke FAILED: ${why}`);
  if (stderr.length) console.error('--- server stderr ---\n' + stderr.join('').slice(0, 4000));
  child.kill('SIGKILL');
  process.exit(1);
};

child.on('error', err => die(`could not spawn ${cmd}: ${err.message}`));
child.on('exit', code => { if (code !== null && code !== 0 && pending.size) die(`server exited with code ${code} before answering`); });

try {
  const init = await send(1, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'starlight-release-smoke', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await send(2, 'tools/list', {});
  const tools = (list.tools ?? []).map(t => t.name);

  if (tools.length < MIN_TOOLS) die(`server exposed ${tools.length} tools, expected at least ${MIN_TOOLS}`);
  const missing = EXPECT.filter(t => !tools.includes(t));
  if (missing.length) die(`missing expected tools: ${missing.join(', ')} (got: ${tools.join(', ')})`);

  console.log(`mcp-stdio-smoke: ${init.serverInfo?.name ?? cmd} v${init.serverInfo?.version ?? '?'} · protocol ${init.protocolVersion} · ${tools.length} tools`);
  console.log(`  ${tools.join(', ')}`);
  console.log(`  ✓ initialize + tools/list${EXPECT.length ? ` + all ${EXPECT.length} expected tools` : ''}`);
  child.kill('SIGTERM');
  process.exit(0);
} catch (err) {
  die(err.message);
}
