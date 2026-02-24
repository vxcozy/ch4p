/**
 * Configuration loading, validation, and directory management.
 *
 * Loads user config from ~/.ch4p/config.json, merges over bundled defaults,
 * resolves ${VAR_NAME} environment variable references, and validates
 * required fields. Zero external dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Ch4pConfig } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CH4P_DIR_NAME = '.ch4p';
const CONFIG_FILE_NAME = 'config.json';
const LOGS_DIR_NAME = 'logs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the ch4p home directory (~/.ch4p). */
export function getCh4pDir(): string {
  return resolve(homedir(), CH4P_DIR_NAME);
}

/** Resolve the path to the user config file. */
export function getConfigPath(): string {
  return join(getCh4pDir(), CONFIG_FILE_NAME);
}

/** Resolve the path to the logs directory. */
export function getLogsDir(): string {
  return join(getCh4pDir(), LOGS_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export function getDefaultConfig(): Ch4pConfig {
  return {
    agent: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      thinkingLevel: 'medium',
    },
    providers: {
      anthropic: {
        apiKey: '${ANTHROPIC_API_KEY}',
      },
      openai: {
        apiKey: '${OPENAI_API_KEY}',
      },
    },
    channels: {},
    memory: {
      backend: 'sqlite',
      autoSave: true,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    },
    gateway: {
      port: 18789,
      requirePairing: true,
      allowPublicBind: false,
    },
    security: {
      workspaceOnly: true,
      blockedPaths: [],
    },
    autonomy: {
      level: 'supervised',
      allowedCommands: [
        'git', 'npm', 'pnpm', 'node', 'npx', 'cargo',
        'ls', 'cat', 'grep', 'find', 'wc', 'sort', 'head', 'tail',
        'mkdir', 'cp', 'mv', 'echo', 'touch',
      ],
    },
    engines: {
      default: 'native',
      available: {
        native: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        'claude-cli': {
          command: 'claude',
          timeout: 600000,
        },
        'codex-cli': {
          command: 'codex',
          timeout: 600000,
        },
      },
    },
    tunnel: {
      provider: 'none',
    },
    secrets: {
      encrypt: true,
    },
    observability: {
      observers: ['console'],
      logLevel: 'info',
    },
    skills: {
      enabled: true,
      paths: ['~/.ch4p/skills', '.ch4p/skills', '.agents/skills'],
      autoLoad: true,
      contextBudget: 16000,
    },
    verification: {
      enabled: true,
      semantic: true,
    },
    mesh: {
      enabled: false,
      maxConcurrency: 3,
      defaultTimeout: 120000,
    },
  };
}

// ---------------------------------------------------------------------------
// .env file loading
// ---------------------------------------------------------------------------

/**
 * Load variables from ~/.ch4p/.env into process.env.
 *
 * Supports:
 *   - KEY=value
 *   - KEY="quoted value"
 *   - KEY='single quoted value'
 *   - # comments and blank lines
 *   - export KEY=value (optional export prefix)
 *
 * Existing environment variables are NOT overwritten — the shell environment
 * always takes precedence. This matches the behavior of dotenv and similar
 * tools, and means `export FOO=bar && ch4p gateway` still wins.
 *
 * Zero external dependencies.
 */
export function loadEnvFile(): number {
  const envPath = join(getCh4pDir(), '.env');

  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    // No .env file — perfectly fine, nothing to do.
    return 0;
  }

  let loaded = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    // Skip blank lines and comments.
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip optional `export ` prefix.
    const stripped = trimmed.startsWith('export ')
      ? trimmed.slice(7).trim()
      : trimmed;

    // Match KEY=VALUE (value may be quoted).
    const eqIdx = stripped.indexOf('=');
    if (eqIdx === -1) continue;

    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();

    // Remove surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't overwrite existing env vars — shell takes precedence.
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }

  return loaded;
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

/**
 * Recursively resolve ${VAR_NAME} references in config values.
 * Only string values are processed. Missing env vars resolve to empty string.
 * Returns the resolved config and the set of unresolved variable names so
 * the caller can warn once per variable (avoids noisy duplicate warnings).
 */
function resolveEnvVars(obj: unknown, missing?: Set<string>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        missing?.add(varName);
      }
      return value ?? '';
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, missing));
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value, missing);
    }
    return result;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Deep merge `source` into `target`. Arrays are replaced, not merged.
 * Returns a new object; neither input is mutated.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
  seen = new WeakSet<object>(),
): T {
  if (seen.has(source)) return target; // Circular reference guard.
  seen.add(source);

  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
        seen,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
}

function validateConfig(config: Ch4pConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // --- agent ---
  if (!config.agent?.model) {
    errors.push({ field: 'agent.model', message: 'Model is required' });
  }

  if (!config.agent?.provider) {
    errors.push({ field: 'agent.provider', message: 'Provider is required' });
  }

  // --- gateway ---
  if (typeof config.gateway?.port !== 'number' || config.gateway.port < 1 || config.gateway.port > 65535) {
    errors.push({ field: 'gateway.port', message: 'Port must be a number between 1 and 65535' });
  }

  // --- autonomy ---
  if (config.autonomy?.level && !['readonly', 'supervised', 'full'].includes(config.autonomy.level)) {
    errors.push({ field: 'autonomy.level', message: 'Must be one of: readonly, supervised, full' });
  }

  // --- observability ---
  if (config.observability?.logLevel && !['debug', 'info', 'warn', 'error'].includes(config.observability.logLevel)) {
    errors.push({ field: 'observability.logLevel', message: 'Must be one of: debug, info, warn, error' });
  }

  // --- memory ---
  if (config.memory?.backend && !['sqlite', 'markdown', 'noop'].includes(config.memory.backend)) {
    errors.push({ field: 'memory.backend', message: 'Must be one of: sqlite, markdown, noop' });
  }

  // --- tunnel ---
  if (config.tunnel?.provider && !['none', 'cloudflare', 'tailscale', 'ngrok'].includes(config.tunnel.provider)) {
    errors.push({ field: 'tunnel.provider', message: 'Must be one of: none, cloudflare, tailscale, ngrok' });
  }

  // --- engines ---
  if (config.engines?.default && config.engines.available &&
      !Object.keys(config.engines.available).includes(config.engines.default)) {
    errors.push({
      field: 'engines.default',
      message: `Engine "${config.engines.default}" is not defined in engines.available`,
    });
  }

  // --- skills ---
  if (config.skills?.contextBudget != null &&
      (typeof config.skills.contextBudget !== 'number' || config.skills.contextBudget < 0)) {
    errors.push({ field: 'skills.contextBudget', message: 'Must be a non-negative number' });
  }

  // --- mesh ---
  if (config.mesh?.maxConcurrency != null &&
      (typeof config.mesh.maxConcurrency !== 'number' || config.mesh.maxConcurrency < 1)) {
    errors.push({ field: 'mesh.maxConcurrency', message: 'Must be a positive number' });
  }

  if (config.mesh?.defaultTimeout != null &&
      (typeof config.mesh.defaultTimeout !== 'number' || config.mesh.defaultTimeout < 1000)) {
    errors.push({ field: 'mesh.defaultTimeout', message: 'Must be at least 1000ms' });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the ~/.ch4p directory structure exists.
 * Creates ~/.ch4p/ and ~/.ch4p/logs/ with restrictive permissions.
 */
export function ensureConfigDir(): void {
  const ch4pDir = getCh4pDir();
  const logsDir = getLogsDir();

  if (!existsSync(ch4pDir)) {
    mkdirSync(ch4pDir, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load and return a fully resolved, validated Ch4pConfig.
 *
 * 1. Loads bundled defaults.
 * 2. If ~/.ch4p/config.json exists, deep-merges user config over defaults.
 * 3. Resolves ${VAR_NAME} environment variable references.
 * 4. Validates required fields.
 * 5. Returns the final config.
 *
 * Throws ConfigLoadError if validation fails.
 */
export function loadConfig(): Ch4pConfig {
  // Load ~/.ch4p/.env into process.env before resolving config references.
  // Existing shell env vars take precedence (won't be overwritten).
  loadEnvFile();

  const defaults = getDefaultConfig();
  let merged: Ch4pConfig = defaults;

  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const userConfig = JSON.parse(raw) as Record<string, unknown>;
      merged = deepMerge(defaults as unknown as Record<string, unknown>, userConfig) as unknown as Ch4pConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigLoadError(`Failed to parse ${configPath}: ${message}`);
    }
  }

  // Resolve env vars in the merged config.
  const missingVars = new Set<string>();
  const resolved = resolveEnvVars(merged, missingVars) as Ch4pConfig;

  // Warn once per missing variable (deduplicated).
  for (const varName of missingVars) {
    console.warn(`  \u26a0  Config references \${${varName}} but it is not set in environment.`);
  }

  // Validate.
  const errors = validateConfig(resolved);
  if (errors.length > 0) {
    const details = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n');
    throw new ConfigLoadError(`Configuration validation failed:\n${details}`);
  }

  return resolved;
}

/**
 * Write a config object to ~/.ch4p/config.json.
 * Ensures the directory exists first.
 */
export function saveConfig(config: Ch4pConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Check whether a user config file exists.
 */
export function configExists(): boolean {
  return existsSync(getConfigPath());
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}
