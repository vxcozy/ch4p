/**
 * Security audit command -- runs and displays the ch4p security audit.
 *
 * Checks the security posture of the current configuration and prints
 * a numbered checklist with pass/warn/fail status for each item.
 * Modeled after ZeroClaw's audit command.
 */

import type { Ch4pConfig, AuditResult, AuditSeverity } from '@ch4p/core';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

// ---------------------------------------------------------------------------
// Severity formatting
// ---------------------------------------------------------------------------

function severityIcon(severity: AuditSeverity): string {
  switch (severity) {
    case 'pass': return `${GREEN}PASS${RESET}`;
    case 'warn': return `${YELLOW}WARN${RESET}`;
    case 'fail': return `${RED}FAIL${RESET}`;
  }
}

function severityPrefix(severity: AuditSeverity): string {
  switch (severity) {
    case 'pass': return `${GREEN}+${RESET}`;
    case 'warn': return `${YELLOW}~${RESET}`;
    case 'fail': return `${RED}x${RESET}`;
  }
}

// ---------------------------------------------------------------------------
// Audit checks
// ---------------------------------------------------------------------------

/**
 * Run all security audit checks against the given config.
 * Returns an array of AuditResult items.
 */
export function performAudit(config: Ch4pConfig): AuditResult[] {
  const results: AuditResult[] = [];
  let id = 0;

  // 1. Gateway binding
  id++;
  const port = config.gateway?.port ?? 18789;
  const allowPublic = config.gateway?.allowPublicBind ?? false;
  results.push({
    id,
    name: 'Gateway binding',
    severity: allowPublic ? 'fail' : 'pass',
    message: allowPublic
      ? `Gateway allows public binding (0.0.0.0:${port}). Restrict to loopback.`
      : `Gateway bound to loopback (127.0.0.1:${port})`,
  });

  // 2. Pairing requirement
  id++;
  const requirePairing = config.gateway?.requirePairing ?? true;
  results.push({
    id,
    name: 'Pairing required',
    severity: requirePairing ? 'pass' : 'warn',
    message: requirePairing
      ? 'Gateway requires pairing for all connections'
      : 'Pairing is disabled. Any local process can connect.',
  });

  // 3. Workspace scoping
  id++;
  const workspaceOnly = config.security?.workspaceOnly ?? true;
  results.push({
    id,
    name: 'Workspace scoping',
    severity: workspaceOnly ? 'pass' : 'warn',
    message: workspaceOnly
      ? 'Filesystem access restricted to workspace'
      : 'Workspace scoping disabled. Agent can access files outside workspace.',
  });

  // 4. Blocked paths configured
  id++;
  const blockedPaths = config.security?.blockedPaths ?? [];
  results.push({
    id,
    name: 'Blocked paths',
    severity: 'pass',
    message: blockedPaths.length > 0
      ? `${blockedPaths.length} additional blocked path(s) configured`
      : 'Using default system blocked paths (14 dirs + 4 dotfiles)',
  });

  // 5. Autonomy level
  id++;
  const autonomy = config.autonomy?.level ?? 'supervised';
  results.push({
    id,
    name: 'Autonomy level',
    severity: autonomy === 'full' ? 'warn' : 'pass',
    message: autonomy === 'full'
      ? 'Full autonomy enabled. Agent will not ask for confirmation.'
      : `Autonomy level: ${autonomy}`,
  });

  // 6. Command allowlist
  id++;
  const allowedCommands = config.autonomy?.allowedCommands ?? [];
  results.push({
    id,
    name: 'Command allowlist',
    severity: allowedCommands.length > 0 ? 'pass' : 'warn',
    message: allowedCommands.length > 0
      ? `${allowedCommands.length} command(s) in allowlist`
      : 'No command allowlist configured. All commands may be executed.',
  });

  // 7. Secrets encryption
  id++;
  const encryptSecrets = config.secrets?.encrypt ?? true;
  results.push({
    id,
    name: 'Secrets encryption',
    severity: encryptSecrets ? 'pass' : 'fail',
    message: encryptSecrets
      ? 'Secrets are encrypted at rest (AES-256-GCM)'
      : 'Secrets encryption is disabled. Credentials stored in plaintext.',
  });

  // 8. API key status
  id++;
  const engineDefault = config.engines?.default ?? 'native';
  const usesSubprocessEngine = engineDefault === 'claude-cli' || engineDefault === 'codex-cli';
  const usesOllama = config.agent?.provider === 'ollama';

  if (usesSubprocessEngine) {
    results.push({
      id,
      name: 'API keys',
      severity: 'pass',
      message: `Using ${engineDefault} engine. Auth handled by CLI tool.`,
    });
  } else if (usesOllama) {
    results.push({
      id,
      name: 'API keys',
      severity: 'pass',
      message: 'Using Ollama provider. No API key required (local inference).',
    });
  } else {
    const anthropicKey = (config.providers?.['anthropic'] as Record<string, unknown> | undefined)?.['apiKey'];
    const openaiKey = (config.providers?.['openai'] as Record<string, unknown> | undefined)?.['apiKey'];
    const hasAnthropicKey = typeof anthropicKey === 'string' && anthropicKey.length > 0 && !anthropicKey.includes('${');
    const hasOpenaiKey = typeof openaiKey === 'string' && openaiKey.length > 0 && !openaiKey.includes('${');
    const hasAnyKey = hasAnthropicKey || hasOpenaiKey;
    results.push({
      id,
      name: 'API keys',
      severity: hasAnyKey ? 'pass' : 'warn',
      message: hasAnyKey
        ? `API key(s) configured: ${[hasAnthropicKey && 'Anthropic', hasOpenaiKey && 'OpenAI'].filter(Boolean).join(', ')}`
        : 'No API keys configured. Set keys via onboard or environment variables.',
    });
  }

  // 9. Tunnel exposure
  id++;
  const tunnelProvider = config.tunnel?.provider ?? 'none';
  results.push({
    id,
    name: 'Tunnel exposure',
    severity: tunnelProvider === 'none' ? 'pass' : 'warn',
    message: tunnelProvider === 'none'
      ? 'No tunnel configured. Gateway is local only.'
      : `Tunnel active via ${tunnelProvider}. Gateway is exposed to the internet.`,
  });

  // 10. Observability
  id++;
  const observers = config.observability?.observers ?? [];
  results.push({
    id,
    name: 'Observability',
    severity: observers.length > 0 ? 'pass' : 'warn',
    message: observers.length > 0
      ? `Observer(s) active: ${observers.join(', ')}`
      : 'No observers configured. Security events may go unlogged.',
  });

  return results;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Run the audit against a config and print formatted results to stdout.
 */
export function runAudit(config: Ch4pConfig): void {
  const results = performAudit(config);

  console.log(`  ${CYAN}${BOLD}ch4p Security Audit${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}`);

  for (const r of results) {
    const padId = String(r.id).padStart(2, ' ');
    console.log(`  ${severityPrefix(r.severity)} ${DIM}${padId}.${RESET} ${r.message}`);
  }

  const passed = results.filter((r) => r.severity === 'pass').length;
  const warned = results.filter((r) => r.severity === 'warn').length;
  const failed = results.filter((r) => r.severity === 'fail').length;

  console.log(`  ${DIM}${'='.repeat(50)}${RESET}`);
  console.log(
    `  ${severityIcon('pass')} ${passed}  ` +
    `${severityIcon('warn')} ${warned}  ` +
    `${severityIcon('fail')} ${failed}  ` +
    `${DIM}(${results.length} checks)${RESET}`,
  );

  if (failed > 0) {
    console.log(`\n  ${RED}${BOLD}Action required:${RESET} ${failed} check(s) failed. Review your config.`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Run the audit command from the CLI.
 * Loads config and prints results.
 */
export async function audit(): Promise<void> {
  try {
    const config = loadConfig();
    console.log('');
    runAudit(config);
    console.log('');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed to load config:${RESET} ${message}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p onboard${DIM} to create a config file.${RESET}\n`);
    process.exitCode = 1;
  }
}
