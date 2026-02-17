/**
 * Status command -- display current system status.
 *
 * Shows: version, config path, memory backend, active channels,
 * engine, autonomy level, and other key configuration values.
 */

import { existsSync } from 'node:fs';
import type { Ch4pConfig } from '@ch4p/core';
import { loadConfig, getConfigPath, getCh4pDir } from '../config.js';
import { TEAL, RESET, BOLD, DIM, GREEN, YELLOW, RED, box, kvRow, separator } from '../ui.js';

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

export async function status(): Promise<void> {
  console.log(`\n  ${TEAL}${BOLD}ch4p Status${RESET}`);
  console.log(separator());
  console.log('');

  // Version
  console.log(`  ${BOLD}Version${RESET}          0.1.0`);

  // Config
  const configPath = getConfigPath();
  const configExists = existsSync(configPath);
  console.log(
    `  ${BOLD}Config${RESET}           ${configExists ? `${GREEN}${configPath}${RESET}` : `${YELLOW}Not found${RESET} (run ch4p onboard)`}`,
  );

  // Data directory
  const ch4pDir = getCh4pDir();
  console.log(
    `  ${BOLD}Data dir${RESET}         ${existsSync(ch4pDir) ? ch4pDir : `${YELLOW}Not created${RESET}`}`,
  );

  if (!configExists) {
    console.log(`\n  ${YELLOW}No configuration found.${RESET}`);
    console.log(`  ${DIM}Run ${TEAL}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    return;
  }

  try {
    const config = loadConfig();

    // Provider & model
    console.log(`  ${BOLD}Provider${RESET}         ${config.agent.provider}`);
    console.log(`  ${BOLD}Model${RESET}            ${config.agent.model}`);

    // Engine
    console.log(`  ${BOLD}Engine${RESET}           ${config.engines.default}`);

    // Autonomy
    const autonomyColors: Record<string, string> = {
      readonly: GREEN,
      supervised: YELLOW,
      full: RED,
    };
    const autonomyColor = autonomyColors[config.autonomy.level] ?? DIM;
    console.log(`  ${BOLD}Autonomy${RESET}         ${autonomyColor}${config.autonomy.level}${RESET}`);

    // Memory
    console.log(`  ${BOLD}Memory${RESET}           ${config.memory.backend} (auto-save: ${config.memory.autoSave ? 'on' : 'off'})`);

    // Gateway
    console.log(
      `  ${BOLD}Gateway${RESET}          port ${config.gateway.port} ` +
      `(pairing: ${config.gateway.requirePairing ? `${GREEN}required${RESET}` : `${YELLOW}disabled${RESET}`})`,
    );

    // Channels
    const channelNames = Object.keys(config.channels);
    console.log(
      `  ${BOLD}Channels${RESET}         ${channelNames.length > 0 ? channelNames.join(', ') : `${DIM}none configured${RESET}`}`,
    );

    // Tunnel
    console.log(
      `  ${BOLD}Tunnel${RESET}           ${config.tunnel.provider === 'none' ? `${DIM}disabled${RESET}` : config.tunnel.provider}`,
    );

    // Observability
    const observers = config.observability.observers;
    console.log(
      `  ${BOLD}Observers${RESET}        ${observers.length > 0 ? observers.join(', ') : `${DIM}none${RESET}`}`,
    );

    // Secrets
    console.log(
      `  ${BOLD}Secrets${RESET}          ${config.secrets.encrypt ? `${GREEN}encrypted${RESET}` : `${YELLOW}plaintext${RESET}`}`,
    );

    // API key status
    const hasAnthropicKey = checkApiKey(config, 'anthropic');
    const hasOpenaiKey = checkApiKey(config, 'openai');
    const keyStatus: string[] = [];
    if (hasAnthropicKey) keyStatus.push(`${GREEN}Anthropic${RESET}`);
    if (hasOpenaiKey) keyStatus.push(`${GREEN}OpenAI${RESET}`);
    console.log(
      `  ${BOLD}API Keys${RESET}         ${keyStatus.length > 0 ? keyStatus.join(', ') : `${YELLOW}none configured${RESET}`}`,
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Error loading config:${RESET} ${message}`);
    process.exitCode = 1;
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkApiKey(config: Ch4pConfig, provider: string): boolean {
  const providerConfig = config.providers[provider] as Record<string, unknown> | undefined;
  const key = providerConfig?.['apiKey'];
  return typeof key === 'string' && key.length > 0 && !key.includes('${');
}
