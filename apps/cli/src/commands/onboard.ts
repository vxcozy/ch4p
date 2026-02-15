/**
 * Onboarding wizard -- interactive setup for new ch4p installations.
 *
 * Walks the user through:
 *   1. Welcome banner with ASCII art
 *   2. Anthropic API key
 *   3. OpenAI API key
 *   4. Preferred model
 *   5. Autonomy level
 *   6. Config file creation
 *   7. Security audit
 *   8. Ready message
 *
 * Uses Node.js readline -- zero external dependencies.
 */

import * as readline from 'node:readline';
import {
  getDefaultConfig,
  saveConfig,
  ensureConfigDir,
  configExists,
  getConfigPath,
} from '../config.js';
import { runAudit } from './audit.js';
import { playFullAnimation } from './splash.js';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';

// ---------------------------------------------------------------------------
// ASCII art banner
// ---------------------------------------------------------------------------

const BANNER = `
${CYAN}${BOLD}        _     _  _
   ____| |__ | || | _ __
  / __||  _ \\| || || '_ \\
 | (__ | | | |__   _| |_) |
  \\___||_| |_|  |_| | .__/
                     |_|${RESET}

  ${DIM}Personal AI Assistant${RESET}
  ${DIM}Security-first. BEAM-inspired. Zero-dependency memory.${RESET}
`;

// ---------------------------------------------------------------------------
// Prompt helper
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
  { id: 'readonly', label: 'Read-only   -- Agent can only read files and run safe commands' },
  { id: 'supervised', label: 'Supervised  -- Agent asks before writes and destructive actions (recommended)' },
  { id: 'full', label: 'Full        -- Agent operates autonomously (use with caution)' },
] as const;

// ---------------------------------------------------------------------------
// Main onboard command
// ---------------------------------------------------------------------------

export async function onboard(): Promise<void> {
  console.log(BANNER);

  if (configExists()) {
    console.log(`  ${YELLOW}A config file already exists at ${getConfigPath()}${RESET}`);
    console.log(`  ${YELLOW}Running the wizard will overwrite it.${RESET}\n`);
  }

  const rl = createPromptInterface();
  const config = getDefaultConfig();

  try {
    console.log(`  ${BOLD}Welcome to ch4p!${RESET}`);
    console.log(`  ${DIM}Let's get you set up. Press Enter to skip any step.${RESET}\n`);

    // --- Step 1: Anthropic API key ---
    console.log(`  ${MAGENTA}Step 1/5${RESET} ${WHITE}Anthropic API Key${RESET}`);
    console.log(`  ${DIM}Get yours at https://console.anthropic.com/keys${RESET}`);
    const anthropicKey = await askSecret(rl, `  ${CYAN}> API key: ${RESET}`);
    if (anthropicKey) {
      (config.providers['anthropic'] as Record<string, unknown>)['apiKey'] = anthropicKey;
      console.log(`  ${GREEN}Saved.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Skipped. Set ANTHROPIC_API_KEY env var later.${RESET}\n`);
    }

    // --- Step 2: OpenAI API key ---
    console.log(`  ${MAGENTA}Step 2/5${RESET} ${WHITE}OpenAI API Key (optional)${RESET}`);
    console.log(`  ${DIM}Get yours at https://platform.openai.com/api-keys${RESET}`);
    const openaiKey = await askSecret(rl, `  ${CYAN}> API key: ${RESET}`);
    if (openaiKey) {
      (config.providers['openai'] as Record<string, unknown>)['apiKey'] = openaiKey;
      console.log(`  ${GREEN}Saved.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Skipped.${RESET}\n`);
    }

    // --- Step 3: Preferred model ---
    console.log(`  ${MAGENTA}Step 3/5${RESET} ${WHITE}Preferred Model${RESET}`);
    for (let i = 0; i < MODELS.length; i++) {
      const m = MODELS[i]!;
      const marker = i === 0 ? ` ${GREEN}(default)${RESET}` : '';
      console.log(`  ${DIM}${i + 1}.${RESET} ${m.label}${marker}`);
    }
    const modelChoice = await ask(rl, `  ${CYAN}> Choice [1]: ${RESET}`);
    const modelIdx = modelChoice ? parseInt(modelChoice, 10) - 1 : 0;
    const selectedModel = MODELS[modelIdx] ?? MODELS[0]!;
    config.agent.model = selectedModel.id;
    config.agent.provider = selectedModel.provider;
    console.log(`  ${GREEN}Selected: ${selectedModel.label}${RESET}\n`);

    // --- Step 4: Autonomy level ---
    console.log(`  ${MAGENTA}Step 4/5${RESET} ${WHITE}Autonomy Level${RESET}`);
    for (let i = 0; i < AUTONOMY_LEVELS.length; i++) {
      const a = AUTONOMY_LEVELS[i]!;
      const marker = i === 1 ? ` ${GREEN}(default)${RESET}` : '';
      console.log(`  ${DIM}${i + 1}.${RESET} ${a.label}${marker}`);
    }
    const autonomyChoice = await ask(rl, `  ${CYAN}> Choice [2]: ${RESET}`);
    const autonomyIdx = autonomyChoice ? parseInt(autonomyChoice, 10) - 1 : 1;
    const selectedAutonomy = AUTONOMY_LEVELS[autonomyIdx] ?? AUTONOMY_LEVELS[1]!;
    config.autonomy.level = selectedAutonomy.id;
    console.log(`  ${GREEN}Selected: ${selectedAutonomy.id}${RESET}\n`);

    // --- Step 5: Save config ---
    console.log(`  ${MAGENTA}Step 5/5${RESET} ${WHITE}Saving configuration${RESET}`);
    ensureConfigDir();
    saveConfig(config);
    console.log(`  ${GREEN}Config written to ${getConfigPath()}${RESET}\n`);

    // --- Security audit ---
    console.log(`  ${BOLD}Running security audit...${RESET}\n`);
    runAudit(config);

    // --- Done — boot-up animation ---
    await playFullAnimation();
    console.log(`  ${DIM}Run ${CYAN}ch4p${DIM} to start an interactive session.${RESET}`);
    console.log(`  ${DIM}Run ${CYAN}ch4p --help${DIM} for all commands.${RESET}`);
    console.log('');
  } finally {
    rl.close();
  }
}
