/**
 * Doctor command -- health checks for the ch4p installation.
 *
 * Validates:
 *   1. Node.js version >= 22
 *   2. Config file exists and is valid
 *   3. Memory database accessible
 *   4. API keys configured
 *   5. Security audit summary
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig, getConfigPath, getCh4pDir, configExists } from '../config.js';
import { performAudit } from './audit.js';
import { TEAL, RESET, BOLD, DIM, GREEN, YELLOW, RED, separator } from '../ui.js';

// ---------------------------------------------------------------------------
// Check result type
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

function statusIcon(s: 'ok' | 'warn' | 'fail'): string {
  switch (s) {
    case 'ok': return `${GREEN}OK${RESET}`;
    case 'warn': return `${YELLOW}WARN${RESET}`;
    case 'fail': return `${RED}FAIL${RESET}`;
  }
}

function statusPrefix(s: 'ok' | 'warn' | 'fail'): string {
  switch (s) {
    case 'ok': return `${GREEN}+${RESET}`;
    case 'warn': return `${YELLOW}~${RESET}`;
    case 'fail': return `${RED}x${RESET}`;
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNodeVersion(): CheckResult {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0]!, 10);

  if (major >= 22) {
    return {
      name: 'Node.js version',
      status: 'ok',
      message: `Node.js ${version} (>= 22 required)`,
    };
  }

  return {
    name: 'Node.js version',
    status: 'fail',
    message: `Node.js ${version} detected. Version >= 22 is required.`,
  };
}

function checkConfigFile(): CheckResult {
  const path = getConfigPath();

  if (!configExists()) {
    return {
      name: 'Config file',
      status: 'fail',
      message: `Not found at ${path}. Run 'ch4p onboard' to create.`,
    };
  }

  // Try loading to validate JSON structure.
  try {
    loadConfig();
    return {
      name: 'Config file',
      status: 'ok',
      message: `Valid config at ${path}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'Config file',
      status: 'fail',
      message: `Invalid config: ${message}`,
    };
  }
}

function checkDataDir(): CheckResult {
  const dir = getCh4pDir();
  if (existsSync(dir)) {
    return {
      name: 'Data directory',
      status: 'ok',
      message: `Exists at ${dir}`,
    };
  }

  return {
    name: 'Data directory',
    status: 'warn',
    message: `Not found at ${dir}. Will be created on first use.`,
  };
}

function checkMemoryDatabase(): CheckResult {
  // The memory database uses SQLite, which requires the data directory.
  const dir = getCh4pDir();
  if (!existsSync(dir)) {
    return {
      name: 'Memory database',
      status: 'warn',
      message: 'Data directory does not exist yet. Memory will be initialized on first use.',
    };
  }

  // For now, we just check the directory exists. The actual SQLite DB
  // will be created by @ch4p/memory when it's first accessed.
  return {
    name: 'Memory database',
    status: 'ok',
    message: 'Data directory accessible. SQLite will initialize on first use.',
  };
}

function checkApiKeys(): CheckResult {
  if (!configExists()) {
    return {
      name: 'API keys',
      status: 'warn',
      message: 'No config file. Cannot check API keys.',
    };
  }

  try {
    const config = loadConfig();

    // Subprocess engines handle their own auth — no API key needed.
    const engineDefault = config.engines?.default ?? 'native';
    if (engineDefault === 'claude-cli' || engineDefault === 'codex-cli') {
      return {
        name: 'API keys',
        status: 'ok',
        message: `Using ${engineDefault} engine. Auth handled by CLI tool.`,
      };
    }

    // Ollama runs locally — no API key needed.
    if (config.agent?.provider === 'ollama') {
      return {
        name: 'API keys',
        status: 'ok',
        message: 'Using Ollama provider. No API key required (local inference).',
      };
    }

    // Check the configured provider's key specifically.
    const providerName = config.agent?.provider ?? 'anthropic';
    const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;
    const apiKey = providerConfig?.['apiKey'];
    const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];

    const hasKey =
      (typeof apiKey === 'string' && apiKey.length > 0 && !apiKey.includes('${')) ||
      (typeof envKey === 'string' && envKey.length > 0);

    if (hasKey) {
      return {
        name: 'API keys',
        status: 'ok',
        message: `${providerName} key configured.`,
      };
    }

    return {
      name: 'API keys',
      status: 'fail',
      message: `No API key for configured provider "${providerName}". ` +
        `Set ${providerName.toUpperCase()}_API_KEY or run 'ch4p onboard'.`,
    };
  } catch {
    return {
      name: 'API keys',
      status: 'warn',
      message: 'Could not load config to check keys.',
    };
  }
}

function checkSubprocessEngine(engineId: string): CheckResult {
  const command = engineId === 'claude-cli' ? 'claude'
    : engineId === 'codex-cli' ? 'codex'
    : engineId;

  try {
    execSync(`${command} --version`, { timeout: 5000, stdio: 'pipe' });
    return {
      name: `${engineId} binary`,
      status: 'ok',
      message: `${command} found on PATH. Auth verified on first use.`,
    };
  } catch {
    const hint = engineId === 'claude-cli'
      ? 'Install Claude Code from https://claude.ai/download, then run /login.'
      : engineId === 'codex-cli'
        ? 'Install Codex CLI: npm install -g @openai/codex'
        : `Ensure ${command} is installed and on your PATH.`;
    return {
      name: `${engineId} binary`,
      status: 'fail',
      message: `${command} not found or not responding. ${hint}`,
    };
  }
}

function checkSecurityAudit(): CheckResult {
  if (!configExists()) {
    return {
      name: 'Security audit',
      status: 'warn',
      message: 'No config file. Cannot run audit.',
    };
  }

  try {
    const config = loadConfig();
    const results = performAudit(config);
    const passed = results.filter((r) => r.severity === 'pass').length;
    const warned = results.filter((r) => r.severity === 'warn').length;
    const failed = results.filter((r) => r.severity === 'fail').length;

    if (failed > 0) {
      return {
        name: 'Security audit',
        status: 'fail',
        message: `${passed} passed, ${warned} warnings, ${failed} failed. Run 'ch4p audit' for details.`,
      };
    }

    if (warned > 0) {
      return {
        name: 'Security audit',
        status: 'warn',
        message: `${passed} passed, ${warned} warnings. Run 'ch4p audit' for details.`,
      };
    }

    return {
      name: 'Security audit',
      status: 'ok',
      message: `All ${results.length} checks passed.`,
    };
  } catch {
    return {
      name: 'Security audit',
      status: 'warn',
      message: 'Could not load config to run audit.',
    };
  }
}

// ---------------------------------------------------------------------------
// Main doctor command
// ---------------------------------------------------------------------------

export async function doctor(): Promise<void> {
  console.log(`\n  ${TEAL}${BOLD}ch4p Doctor${RESET}`);
  console.log(separator());
  console.log('');

  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkConfigFile(),
    checkDataDir(),
    checkMemoryDatabase(),
    checkApiKeys(),
    checkSecurityAudit(),
  ];

  // When a subprocess engine is configured, verify the binary is reachable.
  if (configExists()) {
    try {
      const config = loadConfig();
      const engineDefault = config.engines?.default ?? 'native';
      if (engineDefault === 'claude-cli' || engineDefault === 'codex-cli') {
        checks.splice(checks.length - 1, 0, checkSubprocessEngine(engineDefault));
      }
    } catch {
      // Config already validated above; skip.
    }
  }

  for (const check of checks) {
    const padName = check.name.padEnd(20, ' ');
    console.log(`  ${statusPrefix(check.status)} ${padName} ${check.message}`);
  }

  const okCount = checks.filter((c) => c.status === 'ok').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;

  console.log(`\n${separator()}`);
  console.log(
    `  ${statusIcon('ok')} ${okCount}  ` +
    `${statusIcon('warn')} ${warnCount}  ` +
    `${statusIcon('fail')} ${failCount}  ` +
    `${DIM}(${checks.length} checks)${RESET}`,
  );

  if (failCount > 0) {
    console.log(`\n  ${RED}${BOLD}Issues found.${RESET} Fix the failures above to ensure ch4p works correctly.`);
    process.exitCode = 1;
  } else if (warnCount > 0) {
    console.log(`\n  ${YELLOW}Warnings found.${RESET} ch4p will work, but consider addressing them.`);
  } else {
    console.log(`\n  ${GREEN}${BOLD}All checks passed.${RESET} ch4p is healthy.`);
  }

  console.log('');
}
