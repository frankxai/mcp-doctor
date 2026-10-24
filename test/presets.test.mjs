import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreset, listPresets, generateInstallCommands } from '../dist/analyzer/presets.js';

test('getPreset: returns preset for existing name', () => {
  const preset = getPreset('web-developer');
  assert.ok(preset);
  assert.equal(preset.name, 'Web Developer');
});

test('getPreset: returns undefined for non-existent name', () => {
  const preset = getPreset('non-existent-preset');
  assert.equal(preset, undefined);
});

test('listPresets: returns array of preset packs', () => {
  const presets = listPresets();
  assert.ok(Array.isArray(presets));
  assert.ok(presets.length > 0);
  assert.ok(presets.some(p => p.name === 'Web Developer'));
});

test('generateInstallCommands: generates correct installation commands', () => {
  // @ts-ignore - duck typing for test
  const preset = {
    name: 'test-preset',
    description: 'Test Preset',
    servers: [
      {
        name: 'test-server',
        command: 'npx',
        args: ['-y', 'test-pkg'],
        tier: 'always-on',
        why: 'Because',
      },
      {
        name: 'env-server',
        command: 'uvx',
        args: ['env-pkg'],
        env: { API_KEY: 'secret' },
        tier: 'on-demand',
        why: 'Testing env',
      },
      {
        name: 'custom-install-server',
        command: 'docker',
        args: ['run', 'foo'],
        installCommand: 'claude mcp add custom -- docker run foo',
        tier: 'always-on',
        why: 'Testing custom install command',
      }
    ]
  };

  const commands = generateInstallCommands(preset);
  assert.equal(commands.length, 3);
  assert.equal(commands[0], 'claude mcp add test-server -- npx -y test-pkg');
  assert.equal(commands[1], 'claude mcp add env-server -e API_KEY=secret -- uvx env-pkg');
  assert.equal(commands[2], 'claude mcp add custom -- docker run foo');
});
