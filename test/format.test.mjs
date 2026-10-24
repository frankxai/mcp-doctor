import test from 'node:test';
import assert from 'node:assert';
import {
  formatHeader,
  formatHealthReport,
  formatDuplicates,
  formatTierRecommendations,
  formatSummary,
  formatFixCommands,
  formatMisplacedConfigs
} from '../dist/reporter/format.js';

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

test('formatHeader: contains MCP Doctor title', () => {
  const header = stripAnsi(formatHeader());
  assert.ok(header.includes('MCP Doctor'));
  assert.ok(header.includes('Diagnose & optimize your MCP setup'));
});

test('formatHealthReport: groups by status and formats correctly', () => {
  const results = [
    { server: { name: 'server-a', scope: 'user' }, status: 'healthy', responseTimeMs: 120 },
    { server: { name: 'server-b', scope: 'project' }, status: 'broken', message: 'Failed to start' },
    { server: { name: 'server-c', scope: 'user' }, status: 'timeout' },
    { server: { name: 'server-d', scope: 'user' }, status: 'missing-command', message: 'Command not found' },
    { server: { name: 'server-e', scope: 'project' }, status: 'missing-env', message: 'Missing MY_VAR' },
    { server: { name: 'server-f', scope: 'user' }, status: 'unchecked' },
  ];

  const report = stripAnsi(formatHealthReport(results));

  assert.ok(report.includes('HEALTH REPORT'));
  assert.ok(report.includes('✓ server-a [user] 120ms'));
  assert.ok(report.includes('✗ server-b [project] Failed to start'));
  assert.ok(report.includes('⏱ server-c [user]'));
  assert.ok(report.includes('? server-d [user] Command not found'));
  assert.ok(report.includes('⚠ server-e [project] Missing MY_VAR'));
  assert.ok(report.includes('○ server-f [user]'));

  assert.ok(report.includes('1 healthy'));
  assert.ok(report.includes('2 broken'));
  assert.ok(report.includes('1 timed out'));
  assert.ok(report.includes('1 missing config'));
  assert.ok(report.includes('1 skipped'));
});

test('formatDuplicates: formats duplicates correctly', () => {
  const duplicates = new Map();
  duplicates.set('my-server', [
    { name: 'my-server', scope: 'user' },
    { name: 'my-server', scope: 'project', projectPath: '/home/user/project' }
  ]);

  const result = stripAnsi(formatDuplicates(duplicates));

  assert.ok(result.includes('DUPLICATES FOUND'));
  assert.ok(result.includes('my-server registered 2x:'));
  assert.ok(result.includes('→ user'));
  assert.ok(result.includes('→ project (project)'));
});

test('formatDuplicates: returns empty string if no duplicates', () => {
  const duplicates = new Map();
  const result = formatDuplicates(duplicates);
  assert.equal(result, '');
});

test('formatTierRecommendations: groups and formats recommendations', () => {
  const recommendations = [
    { server: { name: 'always-on-server' }, recommendedTier: 'always-on', reason: 'Because it is critical' },
    { server: { name: 'on-demand-server' }, recommendedTier: 'on-demand', reason: 'Because it is heavy' },
    { server: { name: 'remove-server' }, recommendedTier: 'remove', reason: 'Because it is broken' }
  ];

  const result = stripAnsi(formatTierRecommendations(recommendations));

  assert.ok(result.includes('TIER RECOMMENDATIONS'));
  assert.ok(result.includes('Always-On (load every session)'));
  assert.ok(result.includes('● always-on-server — Because it is critical'));

  assert.ok(result.includes('On-Demand (add when needed)'));
  assert.ok(result.includes('◐ on-demand-server — Because it is heavy'));

  assert.ok(result.includes('Remove (broken or misconfigured)'));
  assert.ok(result.includes('✗ remove-server — Because it is broken'));
});

test('formatSummary: formats scores and counts correctly', () => {
  // Score 100
  let result = stripAnsi(formatSummary(10, 10, 0, 0));
  assert.ok(result.includes('MCP Health Score: 100/100'));
  assert.ok(result.includes('10 total servers | 10 healthy | 0 duplicates | 0 should remove'));

  // Score below 100
  result = stripAnsi(formatSummary(10, 5, 2, 3));
  assert.ok(result.includes('MCP Health Score: 50/100'));
  assert.ok(result.includes('10 total servers | 5 healthy | 2 duplicates | 3 should remove'));

  // Score 0
  result = stripAnsi(formatSummary(10, 0, 0, 10));
  assert.ok(result.includes('MCP Health Score: 0/100'));

  // verifiedCount given
  result = stripAnsi(formatSummary(10, 5, 0, 0, 8));
  assert.ok(result.includes('MCP Health Score: 63/100'));

  // Unverified (verified = 0)
  result = stripAnsi(formatSummary(5, 0, 0, 0, 0));
  assert.ok(result.includes('MCP Health Score: unverified (no runtime probes)'));
});

test('formatFixCommands: includes commands for removing and adding servers', () => {
  const toRemove = [
    { server: { name: 'broken-server' }, recommendedTier: 'remove', reason: '' }
  ];
  const toMoveOnDemand = new Map();
  toMoveOnDemand.set('heavy-server', 'claude mcp add heavy-server -- npx heavy');

  const result = stripAnsi(formatFixCommands(toRemove, toMoveOnDemand));

  assert.ok(result.includes('SUGGESTED FIX COMMANDS'));
  assert.ok(result.includes('claude mcp remove broken-server'));
  assert.ok(result.includes('claude mcp add heavy-server -- npx heavy'));
});

test('formatMisplacedConfigs: formats misplaced configs nicely', () => {
  const misplaced = [
    { filePath: '/some/path/settings.json', serverNames: ['lost-server1', 'lost-server2'] }
  ];

  const result = stripAnsi(formatMisplacedConfigs(misplaced));

  assert.ok(result.includes('MISPLACED MCP CONFIGS (CRITICAL)'));
  assert.ok(result.includes('✗ /some/path/settings.json'));
  assert.ok(result.includes('- lost-server1'));
  assert.ok(result.includes('- lost-server2'));
  assert.ok(result.includes('How to fix:'));
});

test('formatMisplacedConfigs: returns empty string if none misplaced', () => {
  assert.equal(formatMisplacedConfigs([]), '');
});
