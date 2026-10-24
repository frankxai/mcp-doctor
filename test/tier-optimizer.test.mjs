import test from 'node:test';
import assert from 'node:assert';
import { analyzeTiers, generateOnDemandCommands } from '../dist/analyzer/tier-optimizer.js';

test('analyzeTiers: identifies broken servers', () => {
  const servers = [
    { name: 'broken-server', scope: 'user', config: { type: 'stdio', command: 'broken' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'broken', message: 'Failed to start' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'remove');
  assert.equal(recs[0].currentTier, 'always-on');
});

test('analyzeTiers: identifies broken servers when missing-command', () => {
  const servers = [
    { name: 'broken-server', scope: 'project', config: { type: 'stdio', command: 'broken' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'missing-command', message: 'Command not found' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'remove');
  assert.equal(recs[0].currentTier, 'unknown');
});

test('analyzeTiers: identifies core servers', () => {
  const servers = [
    { name: 'memory', scope: 'project', config: { type: 'stdio', command: 'memory' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'healthy' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'always-on');
});

test('analyzeTiers: identifies occasional servers', () => {
  const servers = [
    { name: 'browser-use', scope: 'user', config: { type: 'stdio', command: 'browser-use' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'healthy' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'on-demand');
});

test('analyzeTiers: identifies specialty servers', () => {
  const servers = [
    { name: 'lyric-genius', scope: 'user', config: { type: 'stdio', command: 'lyric-genius' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'healthy' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'on-demand');
});

test('analyzeTiers: identifies unknown servers as on-demand by default', () => {
  const servers = [
    { name: 'unknown-server-123', scope: 'project', config: { type: 'stdio', command: 'unknown' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'healthy' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'on-demand');
});

test('analyzeTiers: missing env recommends removal', () => {
  const servers = [
    { name: 'some-server', scope: 'user', config: { type: 'stdio', command: 'some' } }
  ];
  const healthResults = [
    { server: servers[0], status: 'missing-env', message: 'API_KEY' }
  ];
  const recs = analyzeTiers(servers, healthResults);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recommendedTier, 'remove');
});

test('generateOnDemandCommands: maps servers to add commands and masks secrets', () => {
  const servers = [
    {
      name: 'resend',
      scope: 'user',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@resend/mcp'],
        env: { RESEND_API_KEY: 're_1234567890abcdef', SOME_VAR: 'YOUR_API_KEY_HERE' }
      }
    },
    {
      name: 'simple',
      scope: 'project',
      config: {
        type: 'stdio',
        command: 'simple-cmd'
      }
    },
    {
      name: 'short-secret',
      scope: 'user',
      config: {
        type: 'stdio',
        command: 'short',
        env: { SHORT: '123' }
      }
    },
    {
      name: 'ignore-sse',
      scope: 'user',
      config: {
        type: 'sse',
        url: 'http://localhost'
      }
    }
  ];
  const commands = generateOnDemandCommands(servers);

  // stdio with env and args, skipping values starting with YOUR_
  assert.equal(
    commands.get('resend'),
    'claude mcp add resend -e RESEND_API_KEY=re_1... -- npx -y @resend/mcp'
  );

  // simple stdio without args/env
  assert.equal(
    commands.get('simple'),
    'claude mcp add simple -- simple-cmd '
  );

  // short secret is fully masked
  assert.equal(
    commands.get('short-secret'),
    'claude mcp add short-secret -e SHORT=*** -- short '
  );

  // ignores non-stdio
  assert.equal(commands.has('ignore-sse'), false);
});
