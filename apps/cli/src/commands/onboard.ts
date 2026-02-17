/**
 * Onboarding wizard -- interactive setup for new ch4p installations.
 *
 * Walks the user through:
 *   1. Welcome banner with Chappie mascot
 *   2. Engine detection & selection (claude-cli, codex-cli, ollama, or API keys)
 *   3. API key entry (only if API key path chosen)
 *   4. Model selection (only if API key path chosen)
 *   5. Autonomy level
 *   6. Additional features (~20 categories in 4 groups)
 *   7. Config file creation
 *   8. Security audit
 *   9. Ready message
 *
 * Uses Node.js readline -- zero external dependencies.
 */

import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import {
  getDefaultConfig,
  saveConfig,
  ensureConfigDir,
  configExists,
  getConfigPath,
} from '../config.js';
import { runAudit } from './audit.js';
import { playFullAnimation } from './splash.js';
import {
  TEAL,
  TEAL_DIM,
  RESET,
  BOLD,
  DIM,
  GREEN,
  YELLOW,
  RED,
  MAGENTA,
  WHITE,
  BOX,
  CHAPPIE_SMALL,
  box,
  sectionHeader,
  kvRow,
} from '../ui.js';

// ---------------------------------------------------------------------------
// Engine detection
// ---------------------------------------------------------------------------

export interface DetectedEngine {
  id: string;
  label: string;
  description: string;
}

/** Check if a binary exists on PATH. */
export function detectBinary(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH for known CLI engines and return available options. */
export function detectEngines(): DetectedEngine[] {
  const engines: DetectedEngine[] = [];

  if (detectBinary('claude')) {
    engines.push({
      id: 'claude-cli',
      label: 'Claude Code CLI',
      description: 'Uses your Max/Pro plan — no API key needed',
    });
  }

  if (detectBinary('codex')) {
    engines.push({
      id: 'codex-cli',
      label: 'Codex CLI',
      description: 'Uses your OpenAI account via codex — no API key needed',
    });
  }

  if (detectBinary('ollama')) {
    engines.push({
      id: 'ollama',
      label: 'Ollama (local)',
      description: 'Run models locally — no API key, fully offline',
    });
  }

  return engines;
}

/** Try to list installed Ollama models by querying the local server. */
function listOllamaModels(): string[] {
  try {
    const raw = execSync('curl -sf http://localhost:11434/api/tags', {
      timeout: 3000,
      encoding: 'utf8',
    });
    const data = JSON.parse(raw);
    if (Array.isArray(data?.models)) {
      return (data.models as Array<{ name: string }>).map((m) => m.name);
    }
  } catch {
    // Server not reachable or invalid response.
  }
  return [];
}

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

export interface ChannelDef {
  id: string;
  label: string;
  fields: ChannelField[];
  notes?: string;
}

interface ChannelField {
  key: string;
  label: string;
  secret?: boolean;
  defaultValue?: string;
}

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true },
    ],
  },
  {
    id: 'discord',
    label: 'Discord',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    fields: [
      { key: 'botToken', label: 'Bot token (xoxb-...)', secret: true },
      { key: 'appToken', label: 'App token (xapp-...)', secret: true },
    ],
  },
  {
    id: 'matrix',
    label: 'Matrix',
    fields: [
      { key: 'homeserverUrl', label: 'Homeserver URL', defaultValue: 'https://matrix.org' },
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'userId', label: 'User ID (e.g. @bot:matrix.org)' },
    ],
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    fields: [
      { key: 'appId', label: 'App (client) ID' },
      { key: 'appPassword', label: 'App password', secret: true },
    ],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID' },
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'verifyToken', label: 'Webhook verify token' },
    ],
  },
  {
    id: 'signal',
    label: 'Signal',
    fields: [
      { key: 'signalCliPath', label: 'signal-cli path', defaultValue: 'signal-cli' },
      { key: 'phoneNumber', label: 'Phone number (e.g. +1234567890)' },
    ],
  },
  {
    id: 'imessage',
    label: 'iMessage',
    fields: [],
    notes: 'macOS only. Uses AppleScript — no additional config needed.',
  },
  {
    id: 'irc',
    label: 'IRC',
    fields: [
      { key: 'server', label: 'Server hostname' },
      { key: 'port', label: 'Port', defaultValue: '6697' },
      { key: 'nick', label: 'Nickname' },
      { key: 'channels', label: 'Channels (comma-separated, e.g. #general,#dev)' },
    ],
  },
  {
    id: 'zalo-oa',
    label: 'Zalo OA',
    fields: [
      { key: 'oaId', label: 'OA ID' },
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'oaSecretKey', label: 'OA secret key', secret: true },
    ],
  },
  {
    id: 'bluebubbles',
    label: 'BlueBubbles',
    fields: [
      { key: 'serverUrl', label: 'Server URL (e.g. http://localhost:1234)' },
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  {
    id: 'google-chat',
    label: 'Google Chat',
    fields: [
      { key: 'serviceAccountKeyPath', label: 'Service account JSON key path' },
      { key: 'spaceId', label: 'Space ID' },
    ],
  },
  {
    id: 'webchat',
    label: 'WebChat',
    fields: [
      { key: 'path', label: 'WebSocket path', defaultValue: '/webchat' },
    ],
  },
  {
    id: 'zalo-personal',
    label: 'Zalo Personal',
    fields: [
      { key: 'bridgeUrl', label: 'Bridge URL (e.g. http://localhost:3500)' },
    ],
    notes: 'Requires your own Zalo automation bridge (e.g. zca-js). May violate Zalo TOS.',
  },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a yes/no answer string.
 * Returns `defaultYes` when the answer is empty.
 */
export function parseYesNo(answer: string, defaultYes: boolean): boolean {
  const lower = answer.toLowerCase().trim();
  if (lower === '') return defaultYes;
  return lower === 'y' || lower === 'yes';
}

/**
 * Parse a comma-separated multi-select answer (e.g. "1,3,5").
 * Returns an array of 0-based indices. Ignores invalid entries.
 */
export function parseMultiSelect(answer: string, maxIndex: number): number[] {
  if (answer.trim() === '') return [];
  return answer
    .split(',')
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((n) => !isNaN(n) && n >= 0 && n < maxIndex);
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // For secret input, we print the question then mute the output.
    // Note: Node.js readline does not natively support hidden input,
    // so we use a workaround that replaces characters with nothing.
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let input = '';
    const onData = (ch: Buffer) => {
      const char = ch.toString('utf8');

      if (char === '\n' || char === '\r') {
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
        return;
      }

      if (char === '\u0003') {
        // Ctrl+C
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(130);
      }

      if (char === '\u007F' || char === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      input += char;
      process.stdout.write('*');
    };

    // Temporarily pause readline to handle raw input
    rl.pause();
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function askYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(rl, `  ${TEAL}> ${question} [${hint}]: ${RESET}`);
  return parseYesNo(answer, defaultYes);
}

async function askMultiSelect(
  rl: readline.Interface,
  items: { label: string }[],
): Promise<number[]> {
  // Display items in 2-column layout.
  const half = Math.ceil(items.length / 2);
  for (let i = 0; i < half; i++) {
    const left = `  ${DIM}${String(i + 1).padStart(2)}.${RESET} ${items[i]!.label}`;
    const leftPad = left.padEnd(42);
    const rightIdx = i + half;
    const right = rightIdx < items.length
      ? `${DIM}${String(rightIdx + 1).padStart(2)}.${RESET} ${items[rightIdx]!.label}`
      : '';
    console.log(`${leftPad}${right}`);
  }
  const answer = await ask(rl, `  ${TEAL}> Enter numbers (e.g. 1,3,5), or Enter to skip: ${RESET}`);
  return parseMultiSelect(answer, items.length);
}

// ---------------------------------------------------------------------------
// Model choices
// ---------------------------------------------------------------------------

const MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (recommended)', provider: 'anthropic' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'anthropic' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai' },
];

const AUTONOMY_LEVELS = [
  { id: 'readonly', label: 'Read-only   — Agent can only read files and run safe commands' },
  { id: 'supervised', label: 'Supervised  — Agent asks before writes and destructive actions (recommended)' },
  { id: 'full', label: 'Full        — Agent operates autonomously (use with caution)' },
] as const;

// ---------------------------------------------------------------------------
// Additional feature configurators
// ---------------------------------------------------------------------------

async function configureProviders(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  console.log('');
  console.log(sectionHeader('Additional Providers'));
  console.log('');

  // Google/Gemini
  if (await askYesNo(rl, 'Configure Google/Gemini API key?')) {
    console.log(`  ${DIM}Get yours at https://aistudio.google.com/apikey${RESET}`);
    const key = await askSecret(rl, `  ${TEAL}> API key: ${RESET}`);
    if (key) {
      config.providers['google'] = { apiKey: key };
      console.log(`  ${GREEN}Saved.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Skipped.${RESET}\n`);
    }
  }

  // OpenRouter
  if (await askYesNo(rl, 'Configure OpenRouter API key?')) {
    console.log(`  ${DIM}Get yours at https://openrouter.ai/keys${RESET}`);
    const key = await askSecret(rl, `  ${TEAL}> API key: ${RESET}`);
    if (key) {
      config.providers['openrouter'] = { apiKey: key };
      console.log(`  ${GREEN}Saved.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Skipped.${RESET}\n`);
    }
  }

  // AWS Bedrock
  if (await askYesNo(rl, 'Configure AWS Bedrock?')) {
    const accessKey = await askSecret(rl, `  ${TEAL}> AWS Access Key ID: ${RESET}`);
    const secretKey = await askSecret(rl, `  ${TEAL}> AWS Secret Access Key: ${RESET}`);
    const region = await ask(rl, `  ${TEAL}> AWS Region [us-east-1]: ${RESET}`) || 'us-east-1';
    if (accessKey && secretKey) {
      config.providers['bedrock'] = { accessKeyId: accessKey, secretAccessKey: secretKey, region };
      console.log(`  ${GREEN}Saved.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Skipped.${RESET}\n`);
    }
  }
}

async function configureChannels(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  console.log('');
  console.log(sectionHeader('Channels'));
  console.log(`  ${DIM}Enable messaging channels for ch4p to receive and send messages.${RESET}`);
  console.log('');

  const selected = await askMultiSelect(rl, CHANNEL_DEFS.map((c) => ({ label: c.label })));
  if (selected.length === 0) {
    console.log(`  ${DIM}No channels selected.${RESET}\n`);
    return;
  }

  for (const idx of selected) {
    const def = CHANNEL_DEFS[idx]!;
    console.log(`\n  ${BOLD}${def.label}${RESET}`);

    if (def.notes) {
      console.log(`  ${YELLOW}Note: ${def.notes}${RESET}`);
    }

    if (def.fields.length === 0) {
      // No fields needed (e.g. iMessage).
      config.channels[def.id] = { enabled: true };
      console.log(`  ${GREEN}Enabled.${RESET}`);
      continue;
    }

    const channelConfig: Record<string, unknown> = { enabled: true };
    for (const field of def.fields) {
      const defaultHint = field.defaultValue ? ` [${field.defaultValue}]` : '';
      let value: string;
      if (field.secret) {
        value = await askSecret(rl, `  ${TEAL}> ${field.label}${defaultHint}: ${RESET}`);
      } else {
        value = await ask(rl, `  ${TEAL}> ${field.label}${defaultHint}: ${RESET}`);
      }
      channelConfig[field.key] = value || field.defaultValue || '';
    }
    config.channels[def.id] = channelConfig;
    console.log(`  ${GREEN}${def.label} configured.${RESET}`);
  }
  console.log('');
}

async function configureSearch(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure web search (Brave Search API)?'))) return;

  console.log(`  ${DIM}Get a key at https://api.search.brave.com${RESET}`);
  const key = await askSecret(rl, `  ${TEAL}> Brave API key: ${RESET}`);
  if (key) {
    (config as Record<string, unknown>).search = {
      enabled: true,
      provider: 'brave',
      apiKey: key,
      maxResults: 5,
    };
    console.log(`  ${GREEN}Web search enabled.${RESET}\n`);
  } else {
    console.log(`  ${DIM}Skipped.${RESET}\n`);
  }
}

async function configureBrowser(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Enable browser tool (Playwright)?'))) return;

  // Browser tool is enabled via autonomy — just note it.
  console.log(`  ${GREEN}Browser tool will be available.${RESET}`);
  console.log(`  ${DIM}Install Playwright: npx playwright install chromium${RESET}\n`);
}

async function configureVoice(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure voice pipeline (STT/TTS)?'))) return;

  console.log('');
  console.log(`  ${BOLD}Speech-to-Text provider:${RESET}`);
  console.log(`  ${DIM}1.${RESET} Whisper (default)`);
  console.log(`  ${DIM}2.${RESET} Deepgram`);
  const sttChoice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
  const sttProvider = sttChoice === '2' ? 'deepgram' : 'whisper';

  let sttApiKey: string | undefined;
  if (sttProvider === 'deepgram') {
    sttApiKey = await askSecret(rl, `  ${TEAL}> Deepgram API key: ${RESET}`) || undefined;
  }

  console.log('');
  console.log(`  ${BOLD}Text-to-Speech provider:${RESET}`);
  console.log(`  ${DIM}1.${RESET} ElevenLabs`);
  console.log(`  ${DIM}2.${RESET} None (skip TTS)`);
  const ttsChoice = await ask(rl, `  ${TEAL}> Choice [2]: ${RESET}`);
  const ttsProvider = ttsChoice === '1' ? 'elevenlabs' : 'none';

  let ttsApiKey: string | undefined;
  let ttsVoiceId: string | undefined;
  if (ttsProvider === 'elevenlabs') {
    ttsApiKey = await askSecret(rl, `  ${TEAL}> ElevenLabs API key: ${RESET}`) || undefined;
    ttsVoiceId = await ask(rl, `  ${TEAL}> Voice ID (Enter for default): ${RESET}`) || undefined;
  }

  (config as Record<string, unknown>).voice = {
    enabled: true,
    stt: { provider: sttProvider, apiKey: sttApiKey },
    tts: { provider: ttsProvider, apiKey: ttsApiKey, voiceId: ttsVoiceId },
  };
  console.log(`  ${GREEN}Voice pipeline configured.${RESET}\n`);
}

async function configureMcp(
  rl: readline.Interface,
  _config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure MCP servers?'))) return;

  console.log(`  ${DIM}MCP servers are configured in ~/.ch4p/config.json under "mcp.servers".${RESET}`);
  console.log(`  ${DIM}See docs/how-to/use-mcp.md for details.${RESET}\n`);
}

async function configureCron(
  rl: readline.Interface,
  _config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Enable cron scheduler & webhooks?'))) return;

  console.log(`  ${GREEN}Cron scheduler and webhooks are available via the gateway.${RESET}`);
  console.log(`  ${DIM}Configure jobs in ~/.ch4p/config.json under "cron.jobs".${RESET}`);
  console.log(`  ${DIM}See docs/how-to/use-cron-webhooks.md for details.${RESET}\n`);
}

async function configureMemory(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure memory backend?'))) return;

  console.log('');
  console.log(`  ${BOLD}Memory backend:${RESET}`);
  console.log(`  ${DIM}1.${RESET} SQLite (default — vector + keyword search)`);
  console.log(`  ${DIM}2.${RESET} Markdown (flat files)`);
  console.log(`  ${DIM}3.${RESET} None (disable memory)`);
  const choice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
  if (choice === '2') {
    config.memory.backend = 'markdown';
  } else if (choice === '3') {
    config.memory.backend = 'noop';
  } else {
    config.memory.backend = 'sqlite';
  }
  console.log(`  ${GREEN}Memory backend: ${config.memory.backend}${RESET}\n`);
}

async function configureVerification(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure verification settings?'))) return;

  const enabled = await askYesNo(rl, 'Enable task verification?', true);
  let semantic = true;
  if (enabled) {
    semantic = await askYesNo(rl, 'Enable semantic (LLM) verification?', true);
  }
  (config as Record<string, unknown>).verification = { enabled, semantic };
  console.log(`  ${GREEN}Verification: ${enabled ? 'on' : 'off'}${semantic ? ' (semantic)' : ''}${RESET}\n`);
}

async function configureGateway(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure gateway settings?'))) return;

  const portStr = await ask(rl, `  ${TEAL}> Gateway port [${config.gateway.port}]: ${RESET}`);
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      config.gateway.port = port;
    }
  }

  const requirePairing = await askYesNo(rl, 'Require pairing tokens?', true);
  config.gateway.requirePairing = requirePairing;

  console.log(`  ${GREEN}Gateway: port ${config.gateway.port}, pairing ${requirePairing ? 'on' : 'off'}${RESET}\n`);
}

async function configureSecurity(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure security settings?'))) return;

  const workspaceOnly = await askYesNo(rl, 'Restrict file access to workspace?', true);
  config.security.workspaceOnly = workspaceOnly;

  const blockedStr = await ask(rl, `  ${TEAL}> Blocked paths (comma-separated, Enter to skip): ${RESET}`);
  if (blockedStr) {
    config.security.blockedPaths = blockedStr.split(',').map((s) => s.trim()).filter(Boolean);
  }

  console.log(`  ${GREEN}Security: workspace-only ${workspaceOnly ? 'on' : 'off'}, ${config.security.blockedPaths.length} blocked paths${RESET}\n`);
}

async function configureAllowedCommands(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure allowed commands?'))) return;

  console.log(`  ${DIM}Current: ${config.autonomy.allowedCommands.join(', ')}${RESET}`);
  const addStr = await ask(rl, `  ${TEAL}> Additional commands (comma-separated, Enter to skip): ${RESET}`);
  if (addStr) {
    const additional = addStr.split(',').map((s) => s.trim()).filter(Boolean);
    config.autonomy.allowedCommands.push(...additional);
    console.log(`  ${GREEN}Added: ${additional.join(', ')}${RESET}\n`);
  } else {
    console.log(`  ${DIM}Keeping defaults.${RESET}\n`);
  }
}

async function configureTunnel(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure tunnel provider?'))) return;

  console.log('');
  console.log(`  ${BOLD}Tunnel provider:${RESET}`);
  console.log(`  ${DIM}1.${RESET} None (default)`);
  console.log(`  ${DIM}2.${RESET} Cloudflare Tunnel`);
  console.log(`  ${DIM}3.${RESET} Tailscale`);
  console.log(`  ${DIM}4.${RESET} ngrok`);
  const choice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
  const providers = ['none', 'cloudflare', 'tailscale', 'ngrok'];
  const idx = choice ? parseInt(choice, 10) - 1 : 0;
  config.tunnel.provider = providers[idx] ?? 'none';
  console.log(`  ${GREEN}Tunnel: ${config.tunnel.provider}${RESET}\n`);
}

async function configureCanvas(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure canvas workspace?'))) return;

  const portStr = await ask(rl, `  ${TEAL}> Canvas port [4800]: ${RESET}`);
  const port = portStr ? parseInt(portStr, 10) : 4800;

  (config as Record<string, unknown>).canvas = {
    enabled: true,
    port: (!isNaN(port) && port > 0 && port <= 65535) ? port : 4800,
  };
  console.log(`  ${GREEN}Canvas enabled on port ${(config as Record<string, unknown> & { canvas: { port: number } }).canvas.port}.${RESET}\n`);
}

async function configureObservability(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure observability?'))) return;

  console.log('');
  console.log(`  ${BOLD}Log level:${RESET}`);
  console.log(`  ${DIM}1.${RESET} debug`);
  console.log(`  ${DIM}2.${RESET} info (default)`);
  console.log(`  ${DIM}3.${RESET} warn`);
  console.log(`  ${DIM}4.${RESET} error`);
  const choice = await ask(rl, `  ${TEAL}> Choice [2]: ${RESET}`);
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  const idx = choice ? parseInt(choice, 10) - 1 : 1;
  config.observability.logLevel = levels[idx] ?? 'info';

  const fileObserver = await askYesNo(rl, 'Enable file observer (JSONL logs)?');
  config.observability.observers = fileObserver ? ['console', 'file'] : ['console'];

  console.log(`  ${GREEN}Observability: ${config.observability.logLevel}, observers: ${config.observability.observers.join(', ')}${RESET}\n`);
}

async function configureSkills(
  rl: readline.Interface,
  config: ReturnType<typeof getDefaultConfig>,
): Promise<void> {
  if (!(await askYesNo(rl, 'Configure skills?'))) return;

  console.log(`  ${DIM}Default skill paths: ${config.skills.paths.join(', ')}${RESET}`);
  const additionalPaths = await ask(rl, `  ${TEAL}> Additional skill paths (comma-separated, Enter to skip): ${RESET}`);
  if (additionalPaths) {
    const paths = additionalPaths.split(',').map((s) => s.trim()).filter(Boolean);
    config.skills.paths.push(...paths);
    console.log(`  ${GREEN}Added: ${paths.join(', ')}${RESET}\n`);
  } else {
    console.log(`  ${DIM}Keeping defaults.${RESET}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main onboard command
// ---------------------------------------------------------------------------

export async function onboard(): Promise<void> {
  // Welcome banner with Chappie mascot.
  const mascotLines: string[] = [];
  const info = [
    '',
    `${TEAL}${BOLD}ch4p${RESET}  ${DIM}Personal AI Assistant${RESET}`,
    '',
    `${DIM}Security-first. BEAM-inspired. Zero-dependency memory.${RESET}`,
    '',
  ];
  for (let i = 0; i < Math.max(CHAPPIE_SMALL.length, info.length); i++) {
    const art = i < CHAPPIE_SMALL.length ? `${TEAL}${CHAPPIE_SMALL[i]}${RESET}` : '            ';
    const text = i < info.length ? info[i]! : '';
    mascotLines.push(`${art}    ${text}`);
  }
  console.log('');
  console.log(box('', mascotLines));
  console.log('');

  if (configExists()) {
    console.log(`  ${YELLOW}A config file already exists at ${getConfigPath()}${RESET}`);
    console.log(`  ${YELLOW}Running the wizard will overwrite it.${RESET}\n`);
  }

  const rl = createPromptInterface();
  const config = getDefaultConfig();

  try {
    console.log(`  ${DIM}Let's get you set up. Press Enter to skip any step.${RESET}\n`);

    // -----------------------------------------------------------------------
    // Detect available CLI engines
    // -----------------------------------------------------------------------
    const detectedEngines = detectEngines();
    let useApiKeys = true; // Default: API key setup
    let step = 0;

    // Compute total steps based on whether we show engine selection.
    let totalSteps = 6; // Default: no engine selection shown (anthropic + openai + model + autonomy + features + save)

    if (detectedEngines.length > 0) {
      // --- Engine selection step ---
      step++;
      console.log(`  ${TEAL}${BOLD}Step ${step}${RESET} ${WHITE}Engine Setup${RESET}`);
      console.log('');

      for (const eng of detectedEngines) {
        console.log(`  ${GREEN}✓${RESET} ${eng.label} detected`);
      }
      console.log('');

      for (let i = 0; i < detectedEngines.length; i++) {
        const eng = detectedEngines[i]!;
        const marker = i === 0 ? ` ${GREEN}(recommended)${RESET}` : '';
        console.log(`  ${DIM}${i + 1}.${RESET} ${eng.label} — ${eng.description}${marker}`);
      }
      const apiIdx = detectedEngines.length + 1;
      console.log(`  ${DIM}${apiIdx}.${RESET} API key setup (Anthropic/OpenAI keys)`);

      const engineChoice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
      const choiceNum = engineChoice ? parseInt(engineChoice, 10) : 1;
      const chosenEngineIdx = choiceNum - 1;

      if (chosenEngineIdx >= 0 && chosenEngineIdx < detectedEngines.length) {
        // User picked a detected CLI engine.
        const chosen = detectedEngines[chosenEngineIdx]!;
        useApiKeys = false;
        totalSteps = 4; // engine + autonomy + features + save

        if (chosen.id === 'claude-cli' || chosen.id === 'codex-cli') {
          // Subprocess engine — set as default.
          config.engines.default = chosen.id;
          console.log(`  ${GREEN}Engine set to ${chosen.label}.${RESET}`);
          console.log(`  ${DIM}Auth handled by your subscription. No API keys needed.${RESET}\n`);
        } else if (chosen.id === 'ollama') {
          // Ollama — native engine with ollama provider.
          config.engines.default = 'native';
          config.agent.provider = 'ollama';

          // Try to list installed models and let user pick.
          const models = listOllamaModels();
          if (models.length > 0) {
            console.log(`  ${GREEN}Ollama server is running.${RESET} Installed models:\n`);
            for (let i = 0; i < models.length; i++) {
              const marker = i === 0 ? ` ${GREEN}(default)${RESET}` : '';
              console.log(`  ${DIM}${i + 1}.${RESET} ${models[i]}${marker}`);
            }
            const modelChoice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
            const modelIdx = modelChoice ? parseInt(modelChoice, 10) - 1 : 0;
            config.agent.model = models[modelIdx] ?? models[0] ?? 'llama3.3';
          } else {
            config.agent.model = 'llama3.3';
            console.log(`  ${YELLOW}Ollama server not reachable. Using default model: llama3.3${RESET}`);
            console.log(`  ${DIM}Start Ollama with 'ollama serve' before running ch4p.${RESET}`);
          }
          console.log(`  ${GREEN}Engine set to Ollama (${config.agent.model}).${RESET}\n`);
        }
      } else {
        // User picked API key setup.
        useApiKeys = true;
        totalSteps = 7; // engine + anthropic + openai + model + autonomy + features + save
        console.log(`  ${DIM}Proceeding with API key setup.${RESET}\n`);
      }
    }

    // -----------------------------------------------------------------------
    // API key path (skipped for CLI engine users)
    // -----------------------------------------------------------------------
    if (useApiKeys) {
      // --- Anthropic API key ---
      step++;
      console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}Anthropic API Key${RESET}`);
      console.log(`  ${DIM}Get yours at https://console.anthropic.com/keys${RESET}`);
      const anthropicKey = await askSecret(rl, `  ${TEAL}> API key: ${RESET}`);
      if (anthropicKey) {
        (config.providers['anthropic'] as Record<string, unknown>)['apiKey'] = anthropicKey;
        console.log(`  ${GREEN}Saved.${RESET}\n`);
      } else {
        console.log(`  ${DIM}Skipped. Set ANTHROPIC_API_KEY env var later.${RESET}\n`);
      }

      // --- OpenAI API key ---
      step++;
      console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}OpenAI API Key (optional)${RESET}`);
      console.log(`  ${DIM}Get yours at https://platform.openai.com/api-keys${RESET}`);
      const openaiKey = await askSecret(rl, `  ${TEAL}> API key: ${RESET}`);
      if (openaiKey) {
        (config.providers['openai'] as Record<string, unknown>)['apiKey'] = openaiKey;
        console.log(`  ${GREEN}Saved.${RESET}\n`);
      } else {
        console.log(`  ${DIM}Skipped.${RESET}\n`);
      }

      // --- Preferred model ---
      step++;
      console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}Preferred Model${RESET}`);
      for (let i = 0; i < MODELS.length; i++) {
        const m = MODELS[i]!;
        const marker = i === 0 ? ` ${GREEN}(default)${RESET}` : '';
        console.log(`  ${DIM}${i + 1}.${RESET} ${m.label}${marker}`);
      }
      const modelChoice = await ask(rl, `  ${TEAL}> Choice [1]: ${RESET}`);
      const modelIdx = modelChoice ? parseInt(modelChoice, 10) - 1 : 0;
      const selectedModel = MODELS[modelIdx] ?? MODELS[0]!;
      config.agent.model = selectedModel.id;
      config.agent.provider = selectedModel.provider;
      console.log(`  ${GREEN}Selected: ${selectedModel.label}${RESET}\n`);
    }

    // -----------------------------------------------------------------------
    // Autonomy level (always shown)
    // -----------------------------------------------------------------------
    step++;
    console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}Autonomy Level${RESET}`);
    for (let i = 0; i < AUTONOMY_LEVELS.length; i++) {
      const a = AUTONOMY_LEVELS[i]!;
      const marker = i === 1 ? ` ${GREEN}(default)${RESET}` : '';
      console.log(`  ${DIM}${i + 1}.${RESET} ${a.label}${marker}`);
    }
    const autonomyChoice = await ask(rl, `  ${TEAL}> Choice [2]: ${RESET}`);
    const autonomyIdx = autonomyChoice ? parseInt(autonomyChoice, 10) - 1 : 1;
    const selectedAutonomy = AUTONOMY_LEVELS[autonomyIdx] ?? AUTONOMY_LEVELS[1]!;
    config.autonomy.level = selectedAutonomy.id;
    console.log(`  ${GREEN}Selected: ${selectedAutonomy.id}${RESET}\n`);

    // -----------------------------------------------------------------------
    // Additional features (gated behind a single yes/no)
    // -----------------------------------------------------------------------
    step++;
    console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}Additional Features${RESET}`);
    console.log(`  ${DIM}Configure providers, channels, services, and system settings.${RESET}`);
    console.log(`  ${DIM}Each category can be skipped individually.${RESET}\n`);

    const configureFeatures = await askYesNo(rl, 'Configure additional features?');

    if (configureFeatures) {
      // --- Group 1: Providers ---
      await configureProviders(rl, config);

      // --- Group 2: Channels ---
      await configureChannels(rl, config);

      // --- Group 3: Services ---
      console.log('');
      console.log(sectionHeader('Services'));
      console.log('');

      await configureSearch(rl, config);
      await configureBrowser(rl, config);
      await configureVoice(rl, config);
      await configureMcp(rl, config);
      await configureCron(rl, config);

      // --- Group 4: System ---
      console.log('');
      console.log(sectionHeader('System'));
      console.log('');

      await configureMemory(rl, config);
      await configureVerification(rl, config);
      await configureGateway(rl, config);
      await configureSecurity(rl, config);
      await configureAllowedCommands(rl, config);
      await configureTunnel(rl, config);
      await configureCanvas(rl, config);
      await configureObservability(rl, config);
      await configureSkills(rl, config);
    }

    // -----------------------------------------------------------------------
    // Save config
    // -----------------------------------------------------------------------
    step++;
    console.log(`  ${TEAL}${BOLD}Step ${step}/${totalSteps}${RESET} ${WHITE}Saving configuration${RESET}`);
    ensureConfigDir();
    saveConfig(config);
    console.log(`  ${GREEN}Config written to ${getConfigPath()}${RESET}\n`);

    // --- Security audit ---
    console.log(`  ${BOLD}Running security audit...${RESET}\n`);
    runAudit(config);

    // --- Done — boot-up animation ---
    await playFullAnimation();
    console.log(`  ${DIM}Run ${TEAL}ch4p${DIM} to start an interactive session.${RESET}`);
    console.log(`  ${DIM}Run ${TEAL}ch4p --help${DIM} for all commands.${RESET}`);
    console.log('');
  } finally {
    rl.close();
  }
}
