/**
 * Tests for CLI commands: audit, status, doctor, tools, pairing.
 *
 * These tests exercise the logic in each command by mocking
 * filesystem and config dependencies where needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Ch4pConfig, AuditResult, AuditSeverity } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Mock homedir for config functions
// ---------------------------------------------------------------------------

const TEST_HOME = join(tmpdir(), `ch4p-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

import { getDefaultConfig, loadConfig } from '../config.js';
import { performAudit, runAudit } from './audit.js';
import { tools } from './tools.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTestConfig(config: Record<string, unknown>): void {
  const ch4pDir = join(TEST_HOME, '.ch4p');
  mkdirSync(ch4pDir, { recursive: true });
  writeFileSync(join(ch4pDir, 'config.json'), JSON.stringify(config));
}

function makeConfig(overrides: Record<string, unknown> = {}): Ch4pConfig {
  const defaults = getDefaultConfig();
  return { ...defaults, ...overrides } as unknown as Ch4pConfig;
}

// ---------------------------------------------------------------------------
// Audit tests
// ---------------------------------------------------------------------------

describe('performAudit', () => {
  it('returns 10 audit results', () => {
    const config = getDefaultConfig();
    const results = performAudit(config);

    expect(results).toHaveLength(10);
    expect(results[0]!.id).toBe(1);
    expect(results[9]!.id).toBe(10);
  });

  it('all checks pass for secure default config', () => {
    const config = getDefaultConfig();
    // Set real API keys so audit check #8 passes.
    (config.providers['anthropic'] as Record<string, unknown>).apiKey = 'sk-ant-real-key';

    const results = performAudit(config);
    const allPass = results.every((r) => r.severity === 'pass');

    expect(allPass).toBe(true);
  });

  it('detects public gateway binding (fail)', () => {
    const config = getDefaultConfig();
    config.gateway.allowPublicBind = true;

    const results = performAudit(config);
    const gatewayCheck = results.find((r) => r.name === 'Gateway binding');

    expect(gatewayCheck?.severity).toBe('fail');
    expect(gatewayCheck?.message).toContain('public binding');
  });

  it('detects disabled pairing (warn)', () => {
    const config = getDefaultConfig();
    config.gateway.requirePairing = false;

    const results = performAudit(config);
    const pairingCheck = results.find((r) => r.name === 'Pairing required');

    expect(pairingCheck?.severity).toBe('warn');
    expect(pairingCheck?.message).toContain('disabled');
  });

  it('detects disabled workspace scoping (warn)', () => {
    const config = getDefaultConfig();
    config.security.workspaceOnly = false;

    const results = performAudit(config);
    const wsCheck = results.find((r) => r.name === 'Workspace scoping');

    expect(wsCheck?.severity).toBe('warn');
    expect(wsCheck?.message).toContain('disabled');
  });

  it('reports blocked paths count when configured', () => {
    const config = getDefaultConfig();
    config.security.blockedPaths = ['/etc', '/root', '/var'];

    const results = performAudit(config);
    const pathsCheck = results.find((r) => r.name === 'Blocked paths');

    expect(pathsCheck?.severity).toBe('pass');
    expect(pathsCheck?.message).toContain('3 additional blocked');
  });

  it('reports default blocked paths when none configured', () => {
    const config = getDefaultConfig();
    // Default has empty blockedPaths.
    const results = performAudit(config);
    const pathsCheck = results.find((r) => r.name === 'Blocked paths');

    expect(pathsCheck?.severity).toBe('pass');
    expect(pathsCheck?.message).toContain('default system blocked paths');
  });

  it('detects full autonomy (warn)', () => {
    const config = getDefaultConfig();
    config.autonomy.level = 'full';

    const results = performAudit(config);
    const autonomyCheck = results.find((r) => r.name === 'Autonomy level');

    expect(autonomyCheck?.severity).toBe('warn');
    expect(autonomyCheck?.message).toContain('Full autonomy');
  });

  it('passes for supervised/readonly autonomy', () => {
    for (const level of ['supervised', 'readonly'] as const) {
      const config = getDefaultConfig();
      config.autonomy.level = level;

      const results = performAudit(config);
      const autonomyCheck = results.find((r) => r.name === 'Autonomy level');

      expect(autonomyCheck?.severity).toBe('pass');
    }
  });

  it('detects empty command allowlist (warn)', () => {
    const config = getDefaultConfig();
    config.autonomy.allowedCommands = [];

    const results = performAudit(config);
    const cmdCheck = results.find((r) => r.name === 'Command allowlist');

    expect(cmdCheck?.severity).toBe('warn');
    expect(cmdCheck?.message).toContain('No command allowlist');
  });

  it('passes for non-empty command allowlist', () => {
    const config = getDefaultConfig();
    // Default has commands in allowlist.
    const results = performAudit(config);
    const cmdCheck = results.find((r) => r.name === 'Command allowlist');

    expect(cmdCheck?.severity).toBe('pass');
    expect(cmdCheck?.message).toContain('command(s) in allowlist');
  });

  it('detects disabled secrets encryption (fail)', () => {
    const config = getDefaultConfig();
    config.secrets.encrypt = false;

    const results = performAudit(config);
    const secretsCheck = results.find((r) => r.name === 'Secrets encryption');

    expect(secretsCheck?.severity).toBe('fail');
    expect(secretsCheck?.message).toContain('disabled');
  });

  it('passes for enabled secrets encryption', () => {
    const config = getDefaultConfig();
    const results = performAudit(config);
    const secretsCheck = results.find((r) => r.name === 'Secrets encryption');

    expect(secretsCheck?.severity).toBe('pass');
    expect(secretsCheck?.message).toContain('AES-256-GCM');
  });

  it('warns when no API keys are configured', () => {
    const config = getDefaultConfig();
    // Default keys have ${VAR} references — treated as unresolved.
    const results = performAudit(config);
    const keysCheck = results.find((r) => r.name === 'API keys');

    expect(keysCheck?.severity).toBe('warn');
    expect(keysCheck?.message).toContain('No API keys');
  });

  it('passes when API keys are present', () => {
    const config = getDefaultConfig();
    (config.providers['anthropic'] as Record<string, unknown>).apiKey = 'sk-ant-key-123';

    const results = performAudit(config);
    const keysCheck = results.find((r) => r.name === 'API keys');

    expect(keysCheck?.severity).toBe('pass');
    expect(keysCheck?.message).toContain('Anthropic');
  });

  it('detects active tunnel (warn)', () => {
    const config = getDefaultConfig();
    config.tunnel.provider = 'cloudflare';

    const results = performAudit(config);
    const tunnelCheck = results.find((r) => r.name === 'Tunnel exposure');

    expect(tunnelCheck?.severity).toBe('warn');
    expect(tunnelCheck?.message).toContain('cloudflare');
  });

  it('passes when tunnel is disabled', () => {
    const config = getDefaultConfig();
    const results = performAudit(config);
    const tunnelCheck = results.find((r) => r.name === 'Tunnel exposure');

    expect(tunnelCheck?.severity).toBe('pass');
    expect(tunnelCheck?.message).toContain('local only');
  });

  it('warns when no observers are configured', () => {
    const config = getDefaultConfig();
    config.observability.observers = [];

    const results = performAudit(config);
    const obsCheck = results.find((r) => r.name === 'Observability');

    expect(obsCheck?.severity).toBe('warn');
    expect(obsCheck?.message).toContain('No observers');
  });

  it('passes when observers are active', () => {
    const config = getDefaultConfig();
    const results = performAudit(config);
    const obsCheck = results.find((r) => r.name === 'Observability');

    expect(obsCheck?.severity).toBe('pass');
    expect(obsCheck?.message).toContain('console');
  });

  it('sequential IDs from 1 to N', () => {
    const results = performAudit(getDefaultConfig());
    results.forEach((r, i) => {
      expect(r.id).toBe(i + 1);
    });
  });

  it('each result has required fields', () => {
    const results = performAudit(getDefaultConfig());
    for (const r of results) {
      expect(typeof r.id).toBe('number');
      expect(typeof r.name).toBe('string');
      expect(r.name.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail']).toContain(r.severity);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe('runAudit', () => {
  it('prints results to stdout', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const config = getDefaultConfig();
    runAudit(config);

    // Should print header, results, and summary.
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Security Audit');
    expect(output).toContain('checks');

    consoleSpy.mockRestore();
  });

  it('prints "Action required" when there are failures', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const config = getDefaultConfig();
    config.gateway.allowPublicBind = true;
    config.secrets.encrypt = false;

    runAudit(config);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Action required');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tools command tests
// ---------------------------------------------------------------------------

describe('tools command', () => {
  it('outputs tool listing to stdout', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tools();

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('ch4p Tools');

    consoleSpy.mockRestore();
  });

  it('lists known tool names', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tools();

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('file_read');
    expect(output).toContain('file_write');
    expect(output).toContain('bash');
    expect(output).toContain('grep');
    expect(output).toContain('memory_store');
    expect(output).toContain('memory_recall');
    expect(output).toContain('delegate');

    consoleSpy.mockRestore();
  });

  it('displays weight classifications', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tools();

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('lightweight');
    expect(output).toContain('heavyweight');

    consoleSpy.mockRestore();
  });

  it('shows tool count summary', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tools();

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('13 tools');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Doctor command tests (pure function checks)
// ---------------------------------------------------------------------------

describe('doctor checks (functional)', () => {
  // We test the individual check functions indirectly by verifying
  // the audit integration and config validation that doctor relies on.

  it('performAudit integrates with doctor — config with all passes', () => {
    const config = getDefaultConfig();
    (config.providers['anthropic'] as Record<string, unknown>).apiKey = 'sk-ant-real';

    const results = performAudit(config);
    const passed = results.filter((r) => r.severity === 'pass').length;
    const failed = results.filter((r) => r.severity === 'fail').length;

    expect(passed).toBe(10);
    expect(failed).toBe(0);
  });

  it('performAudit counts failures correctly', () => {
    const config = getDefaultConfig();
    config.gateway.allowPublicBind = true; // fail
    config.secrets.encrypt = false; // fail

    const results = performAudit(config);
    const failed = results.filter((r) => r.severity === 'fail').length;

    expect(failed).toBe(2);
  });

  it('performAudit counts warnings correctly', () => {
    const config = getDefaultConfig();
    config.gateway.requirePairing = false; // warn
    config.security.workspaceOnly = false; // warn
    config.autonomy.level = 'full'; // warn
    config.autonomy.allowedCommands = []; // warn
    config.tunnel.provider = 'tailscale'; // warn
    config.observability.observers = []; // warn
    // API keys warn is default

    const results = performAudit(config);
    const warned = results.filter((r) => r.severity === 'warn').length;

    expect(warned).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Pairing command tests (PairingManager integration)
// ---------------------------------------------------------------------------

describe('pairing (PairingManager integration)', () => {
  // We test the pairing manager directly since the pairing command
  // uses loadConfig which depends on the mock homedir setup.
  // We import PairingManager from gateway.

  it('generates and validates pairing codes', async () => {
    const { PairingManager } = await import('@ch4p/gateway');
    const pm = new PairingManager();

    const code = pm.generateCode('test-label');

    expect(code.code).toBeDefined();
    expect(code.code.length).toBeGreaterThan(0);
    expect(code.label).toBe('test-label');
    expect(code.expiresAt).toBeInstanceOf(Date);
    expect(code.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lists codes and clients', async () => {
    const { PairingManager } = await import('@ch4p/gateway');
    const pm = new PairingManager();

    pm.generateCode('a');
    pm.generateCode('b');

    const codes = pm.listCodes();
    expect(codes).toHaveLength(2);

    const clients = pm.listClients();
    expect(clients).toHaveLength(0);
  });

  it('revokes a code', async () => {
    const { PairingManager } = await import('@ch4p/gateway');
    const pm = new PairingManager();

    const code = pm.generateCode('revocable');
    expect(pm.listCodes()).toHaveLength(1);

    const revoked = pm.revokeCode(code.code);
    expect(revoked).toBe(true);
    expect(pm.listCodes()).toHaveLength(0);
  });

  it('reports stats', async () => {
    const { PairingManager } = await import('@ch4p/gateway');
    const pm = new PairingManager();

    pm.generateCode('s1');
    pm.generateCode('s2');

    const stats = pm.stats();
    expect(stats.activeCodes).toBe(2);
    expect(stats.pairedClients).toBe(0);
  });

  it('returns false when revoking nonexistent code', async () => {
    const { PairingManager } = await import('@ch4p/gateway');
    const pm = new PairingManager();

    const revoked = pm.revokeCode('nonexistent-code');
    expect(revoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status command tests (partial — output verification)
// ---------------------------------------------------------------------------

describe('status command integration', () => {
  it('loadConfig works for status display', () => {
    // The status command calls loadConfig(). We verify that with valid
    // config, the key fields used by status are accessible.
    writeTestConfig({
      agent: { model: 'test-model', provider: 'test-provider' },
    });

    const config = loadConfig();

    expect(config.agent.model).toBe('test-model');
    expect(config.agent.provider).toBe('test-provider');
    expect(config.engines.default).toBeDefined();
    expect(config.autonomy.level).toBeDefined();
    expect(config.memory.backend).toBeDefined();
    expect(config.gateway.port).toBeDefined();
    expect(config.channels).toBeDefined();
    expect(config.tunnel.provider).toBeDefined();
    expect(config.observability.observers).toBeDefined();
    expect(config.secrets.encrypt).toBeDefined();
  });
});
