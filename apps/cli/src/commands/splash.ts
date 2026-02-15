/**
 * Splash animation — startup personality for the ch4p CLI.
 *
 * Two modes:
 *   1. playFullAnimation() — post-onboard celebration (~3s scan-line reveal)
 *   2. playBriefSplash()   — brief agent startup splash (~1s)
 *
 * Zero external dependencies. Raw ANSI escape codes + setTimeout.
 * Skippable: any keypress cancels the animation immediately.
 */

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const WHITE = '\x1b[37m';

// ---------------------------------------------------------------------------
// ANSI cursor control
// ---------------------------------------------------------------------------

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const MOVE_UP = (n: number) => `\x1b[${n}A`;

// ---------------------------------------------------------------------------
// Compile-time version constant
// ---------------------------------------------------------------------------

declare const CH4P_VERSION: string | undefined;

function getVersion(): string {
  try {
    if (typeof CH4P_VERSION === 'string') return CH4P_VERSION;
  } catch {
    // Not defined.
  }
  return '0.1.0';
}

// ---------------------------------------------------------------------------
// Chappie ASCII art — cropped head/face region
// ---------------------------------------------------------------------------

// Sourced from user-provided ascii-chappie.txt, cropped to head/face
// and trimmed of outer @ padding for a compact ~52-col display.

const CHAPPIE_ART = [
  '@@@@@@@@*=#@@@@@@@@@@@@@@@@%%@@@@@@@@@@@@@@@',
  '@@@@@@@@*==#@@@@@@@@@@@@@@@@*==@@@@@@@@@@@@@',
  '@@@@@@@@#+==@@@@@@@%@@@@@@@@@@*==*@@@@@@@@@@',
  '@@@@@@@@@++-*@@@@@%%@@@@@@@@@@@*-=+@@@@@@@@@',
  '@@@@@@@@@%+=-@@@@@%#%@@@@@@@@@@@*-++%@@@@@@@',
  '@@@@@@%%@@@@@@@#+=*@#+====++==-=#%@@#+*+%@@@',
  '@@@@#***+=++@@@@%#+=***+**++===-++=+*+=+@@@@',
  '@@@@###++*%%%@@@#*+++*****++=====+==----=#@@@',
  '@@@@%@@@%@@@@@@#+**##%@@@@@@@%%#+++==-=#+@@@',
  '@@@@@@@@%@@@@@@@*#%@@@@%%%%%%%%%%%%#++=%%@@@',
  '@@@@%@@#*%@@@@@%##%##************#*#**=@@@@@',
  '@@%####**#@@@@@%%#%#*+*+*###*+*=**#***+@@@@@',
  '@@%####*##@@@@@@#%###%%%%%%#######%####@@@@@',
  '@@@****+++%@@@@@@%#@@%@@@@@%%%@%@@###%%@@@@@',
  '@@#***+==+*@@@@@@@%%%%%@@@@@@%%%#+=#%@@@@@@@',
  '@@########%@@@%%@@@%#*##########=#%%@@@@@@@@',
  '@@#%%%@%%##%@%#@@@@@@@%#######%%@%@@@@@@@@@@',
  '@@%%%%%%%%%@@@%%##%@@@@@@%%%@@@%##%@@@@@@@@@',
  '@@@@@@@@@@@@##*+**%%@@@@@@@%@@%%%%#*#@@@@@@@',
  '@@%@%%%@@%#*%@%##%@@@@@@@@@@@@@%@@#*##====+#',
  '@@%@@@@@@%%#%%%#*+*##@@@@@%**++**+===**-====',
  '@@%@@%@@%%@@@@%##*+++**#%@%%####**+===-=++++',
  '@@%%%@@@@@@@@@%%##**+*****++===--==---=-+%%%',
  '@@@@@@@@@@@@@%%%#%%#=====-+*-****--*=-=*+@%*',
  '@@@@@@@@@@%%@%%#####+=**==+==++===+*-=*%*@@@',
  '@@@@@@@@@@@@@@%%%%%%%%%%%%#*********==***@%@',
  '@@@@@@@@@@@@@@%**#@@@@@@@@@@@@@@@%#%%%%%%@@%',
  '@@@@@@@@@@@@@@@@@%%%@@@@%%%%@%@@@@@@@%%@@@%#',
  '@@@@@@@@@@@@@@@@@%*#%@%%%#+=#+=#%@@@@@@%%#*+',
];

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function centerPad(line: string, termWidth: number): string {
  const visible = stripAnsi(line);
  const pad = Math.max(0, Math.floor((termWidth - visible) / 2));
  return ' '.repeat(pad) + line;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

function delay(ms: number, skip: Promise<void>): Promise<boolean> {
  return Promise.race([
    new Promise<false>((r) => setTimeout(() => r(false), ms)),
    skip.then(() => true),
  ]);
}

function createSkipController(): { skipped: Promise<void>; cleanup: () => void } {
  let resolve: () => void;
  const skipped = new Promise<void>((r) => {
    resolve = r;
  });

  let wasRaw: boolean | undefined;
  const stdin = process.stdin;

  if (stdin.isTTY) {
    wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
  }

  const onData = () => resolve!();
  stdin.once('data', onData);

  const cleanup = () => {
    stdin.removeListener('data', onData);
    if (stdin.isTTY) {
      stdin.setRawMode(wasRaw ?? false);
    }
    try {
      stdin.pause();
    } catch {
      // Already paused or closed.
    }
  };

  return { skipped, cleanup };
}

function withCursorHidden(fn: () => Promise<void>): Promise<void> {
  process.stdout.write(HIDE_CURSOR);
  const restore = () => process.stdout.write(SHOW_CURSOR);
  const onExit = () => {
    restore();
  };
  process.on('exit', onExit);
  return fn().finally(() => {
    process.removeListener('exit', onExit);
    restore();
  });
}

// ---------------------------------------------------------------------------
// Typewriter
// ---------------------------------------------------------------------------

async function typewrite(
  text: string,
  skip: Promise<void>,
  charDelay = 20,
  punctuationDelay = 40,
): Promise<boolean> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    process.stdout.write(char);

    // ANSI escape sequences — don't delay on them
    if (char === '\x1b') {
      // Find the end of the escape sequence and write it all at once
      const rest = text.slice(i + 1);
      const match = rest.match(/^\[[0-9;]*m/);
      if (match) {
        process.stdout.write(match[0]);
        i += match[0].length;
        continue;
      }
    }

    let ms = charDelay;
    if ('.!,;:'.includes(char)) ms = punctuationDelay;
    if (char === '\n') ms = 100;

    const wasSkipped = await delay(ms, skip);
    if (wasSkipped) {
      // Print remaining text immediately
      process.stdout.write(text.slice(i + 1));
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderArtStatic(color: string): void {
  const width = getTerminalWidth();
  for (const line of CHAPPIE_ART) {
    const colored = `${color}${line}${RESET}`;
    console.log(centerPad(colored, width));
  }
}

// ---------------------------------------------------------------------------
// Full animation — post-onboard scan-line reveal
// ---------------------------------------------------------------------------

export async function playFullAnimation(): Promise<void> {
  if (!isTTY()) {
    // Non-interactive: static display.
    console.log('');
    renderArtStatic(CYAN);
    console.log('');
    console.log(`  ${CYAN}${BOLD}ch4p${RESET} ${DIM}v${getVersion()}${RESET}`);
    console.log(`  ${DIM}Hello! I'm ch4p, your personal AI assistant.${RESET}`);
    console.log(`  ${DIM}Security-first. BEAM-inspired. Zero-dependency memory.${RESET}`);
    console.log('');
    return;
  }

  await withCursorHidden(async () => {
    const { skipped, cleanup } = createSkipController();

    try {
      const width = getTerminalWidth();
      const lineCount = CHAPPIE_ART.length;

      console.log('');

      // Scan-line reveal: draw each line top-to-bottom.
      // Current line is bright (WHITE+BOLD), previous line dims to CYAN.
      for (let i = 0; i < lineCount; i++) {
        const line = CHAPPIE_ART[i]!;

        // Dim previous line by overwriting it.
        if (i > 0) {
          process.stdout.write(MOVE_UP(1));
          process.stdout.write(CLEAR_LINE);
          const dimmed = `${CYAN}${CHAPPIE_ART[i - 1]}${RESET}`;
          process.stdout.write(centerPad(dimmed, width) + '\n');
        }

        // Draw current line bright.
        const bright = `${WHITE}${BOLD}${line}${RESET}`;
        process.stdout.write(centerPad(bright, width) + '\n');

        const wasSkipped = await delay(70, skipped);
        if (wasSkipped) {
          // Jump to final state: clear everything and render static.
          process.stdout.write(MOVE_UP(i + 2));
          for (let j = 0; j <= i; j++) {
            process.stdout.write(CLEAR_LINE + '\n');
          }
          process.stdout.write(MOVE_UP(i + 2));
          console.log('');
          renderArtStatic(CYAN);
          break;
        }
      }

      // Dim the last line.
      if (lineCount > 0) {
        process.stdout.write(MOVE_UP(1));
        process.stdout.write(CLEAR_LINE);
        const lastDimmed = `${CYAN}${CHAPPIE_ART[lineCount - 1]}${RESET}`;
        process.stdout.write(centerPad(lastDimmed, width) + '\n');
      }

      // Pause after reveal.
      if (await delay(400, skipped)) {
        cleanup();
        return;
      }

      // Typewriter welcome.
      console.log('');
      const welcome =
        `  ${CYAN}${BOLD}ch4p${RESET} ${DIM}v${getVersion()}${RESET}\n` +
        `  ${DIM}Hello! I'm ch4p, your personal AI assistant.${RESET}\n` +
        `  ${DIM}Security-first. BEAM-inspired. Zero-dependency memory.${RESET}\n`;

      await typewrite(welcome, skipped);

      // Let the user read it.
      await delay(300, skipped);
      console.log('');
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Brief splash — every agent startup
// ---------------------------------------------------------------------------

export async function playBriefSplash(): Promise<void> {
  if (!isTTY()) return; // Silent in non-interactive mode.

  await withCursorHidden(async () => {
    const { skipped, cleanup } = createSkipController();

    try {
      console.log('');

      // Show art instantly in dim.
      renderArtStatic(DIM);

      if (await delay(200, skipped)) {
        cleanup();
        return;
      }

      // Quick typewriter version line.
      console.log('');
      const versionLine = `  ${CYAN}${BOLD}ch4p${RESET} ${DIM}v${getVersion()}${RESET} ${GREEN}ready.${RESET}\n`;
      await typewrite(versionLine, skipped, 15);

      await delay(100, skipped);
    } finally {
      cleanup();
    }
  });
}
