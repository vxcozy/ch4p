/**
 * Onboarding wizard -- interactive setup for new ch4p installations.
 *
 * Walks the user through:
 *   1. Welcome banner with ASCII art
 *   2. Engine detection & selection (claude-cli, codex-cli, ollama, or API keys)
 *   3. API key entry (only if API key path chosen)
 *   4. Model selection (only if API key path chosen)
 *   5. Autonomy level
 *   6. Config file creation
 *   7. Security audit
 *   8. Ready message
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

    // -----------------------------------------------------------------------
    // Detect available CLI engines
    // -----------------------------------------------------------------------
    const detectedEngines = detectEngines();
    let useApiKeys = true; // Default: API key setup
    let step = 0;

    // Compute total steps based on whether we show engine selection.
    // If CLI engines detected: step 1 = engine, then branch.
    //   CLI path: engine + autonomy + save = 3 steps
    //   API path: engine + anthropic + openai + model + autonomy + save = 6 steps
    // If no CLI engines: original 5-step flow (no engine step).
    let totalSteps = 5; // Default: no engine selection shown

    if (detectedEngines.length > 0) {
      // --- Engine selection step ---
      step++;
      // We can't know totalSteps until after the choice, so show "Step 1" without total.
      console.log(`  ${MAGENTA}Step ${step}${RESET} ${WHITE}Engine Setup${RESET}`);
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

      const engineChoice = await ask(rl, `  ${CYAN}> Choice [1]: ${RESET}`);
      const choiceNum = engineChoice ? parseInt(engineChoice, 10) : 1;
      const chosenEngineIdx = choiceNum - 1;

      if (chosenEngineIdx >= 0 && chosenEngineIdx < detectedEngines.length) {
        // User picked a detected CLI engine.
        const chosen = detectedEngines[chosenEngineIdx]!;
        useApiKeys = false;
        totalSteps = 3; // engine + autonomy + save

        if (chosen.id === 'claude-cli' || chosen.id === 'codex-cli') {
          // Subprocess engine — set as default, keep agent model/provider for metadata.
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
            const modelChoice = await ask(rl, `  ${CYAN}> Choice [1]: ${RESET}`);
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
        totalSteps = 6; // engine + anthropic + openai + model + autonomy + save
        console.log(`  ${DIM}Proceeding with API key setup.${RESET}\n`);
      }
    }

    // -----------------------------------------------------------------------
    // API key path (skipped for CLI engine users)
    // -----------------------------------------------------------------------
    if (useApiKeys) {
      // --- Anthropic API key ---
      step++;
      console.log(`  ${MAGENTA}Step ${step}/${totalSteps}${RESET} ${WHITE}Anthropic API Key${RESET}`);
      console.log(`  ${DIM}Get yours at https://console.anthropic.com/keys${RESET}`);
      const anthropicKey = await askSecret(rl, `  ${CYAN}> API key: ${RESET}`);
      if (anthropicKey) {
        (config.providers['anthropic'] as Record<string, unknown>)['apiKey'] = anthropicKey;
        console.log(`  ${GREEN}Saved.${RESET}\n`);
      } else {
        console.log(`  ${DIM}Skipped. Set ANTHROPIC_API_KEY env var later.${RESET}\n`);
      }

      // --- OpenAI API key ---
      step++;
      console.log(`  ${MAGENTA}Step ${step}/${totalSteps}${RESET} ${WHITE}OpenAI API Key (optional)${RESET}`);
      console.log(`  ${DIM}Get yours at https://platform.openai.com/api-keys${RESET}`);
      const openaiKey = await askSecret(rl, `  ${CYAN}> API key: ${RESET}`);
      if (openaiKey) {
        (config.providers['openai'] as Record<string, unknown>)['apiKey'] = openaiKey;
        console.log(`  ${GREEN}Saved.${RESET}\n`);
      } else {
        console.log(`  ${DIM}Skipped.${RESET}\n`);
      }

      // --- Preferred model ---
      step++;
      console.log(`  ${MAGENTA}Step ${step}/${totalSteps}${RESET} ${WHITE}Preferred Model${RESET}`);
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
    }

    // -----------------------------------------------------------------------
    // Autonomy level (always shown)
    // -----------------------------------------------------------------------
    step++;
    console.log(`  ${MAGENTA}Step ${step}/${totalSteps}${RESET} ${WHITE}Autonomy Level${RESET}`);
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

    // -----------------------------------------------------------------------
    // Save config
    // -----------------------------------------------------------------------
    step++;
    console.log(`  ${MAGENTA}Step ${step}/${totalSteps}${RESET} ${WHITE}Saving configuration${RESET}`);
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
