/**
 * Shared CLI styling module — single source of truth for ch4p terminal UI.
 *
 * Provides:
 *   - Color constants (true-color teal brand + standard ANSI)
 *   - Box-drawing characters and rendering functions
 *   - Status indicators (check, cross, warn, bullet)
 *   - Section headers, key-value rows, separators
 *   - Small Chappie mascot (Unicode block characters)
 *   - Spinner animation characters
 *
 * Zero external dependencies. Pure string rendering with console.log().
 */

// ---------------------------------------------------------------------------
// Colors — true-color teal as primary brand, standard ANSI as accents
// ---------------------------------------------------------------------------

/** Primary brand color: ch4p teal. True-color (24-bit). */
export const TEAL = '\x1b[38;2;0;186;188m';

/** Dimmed teal for borders and secondary elements. */
export const TEAL_DIM = '\x1b[38;2;0;130;132m';

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const RED = '\x1b[31m';
export const MAGENTA = '\x1b[35m';
export const WHITE = '\x1b[37m';
export const BLUE = '\x1b[34m';

/** Legacy alias — use TEAL for brand contexts. */
export const CYAN = '\x1b[36m';

// ---------------------------------------------------------------------------
// Box drawing characters
// ---------------------------------------------------------------------------

export const BOX = {
  topLeft: '\u256d',     // ╭
  topRight: '\u256e',    // ╮
  bottomLeft: '\u2570',  // ╰
  bottomRight: '\u256f', // ╯
  horizontal: '\u2500',  // ─
  vertical: '\u2502',    // │
} as const;

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

export const CHECK = `${GREEN}\u2713${RESET}`;   // ✓
export const CROSS = `${RED}\u2717${RESET}`;      // ✗
export const WARN = `${YELLOW}\u26a0${RESET}`;    // ⚠
export const BULLET = `${TEAL}\u25cf${RESET}`;    // ●

// ---------------------------------------------------------------------------
// Spinner characters (cycle at ~200ms for thinking/loading)
// ---------------------------------------------------------------------------

export const SPINNER_CHARS = ['\u00b7', '\u2722', '\u2733', '\u2736', '\u273b', '\u273d'];
//                             ·        ✢        ✳        ✶        ✻        ✽

// ---------------------------------------------------------------------------
// Chappie small mascot — Unicode block characters
//
// Based on the actual Chappie robot figurine: two tall antenna/ears,
// angular boxy helmet, dark visor with chevron eyes.
// Rendered in TEAL color.
// ---------------------------------------------------------------------------

export const CHAPPIE_SMALL = [
  ' \u2590\u258c   \u2590\u258c ',    //  ▐▌   ▐▌  — two tall ears
  ' \u2590\u2599\u2584\u2584\u2584\u259f\u258c ',    //  ▐▙▄▄▄▟▌  — ears connect to helmet top
  '\u2590\u2588\u2580\u2580\u2580\u2580\u2580\u2588\u258c',   // ▐█▀▀▀▀▀█▌ — helmet upper
  '\u2590\u2588 \u2580\u2598\u259d\u2580 \u2588\u258c',   // ▐█ ▀▘▝▀ █▌ — visor with eyes
  ' \u259d\u2580\u2580\u2580\u2580\u2580\u2598 ',    //  ▝▀▀▀▀▀▘  — chin/jaw
];

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/** Get terminal width with 80-column fallback. */
export function termWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Measure visible character length (strips ANSI escape sequences). */
export function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Center-pad a string within the given width.
 * Accounts for ANSI escape sequences when calculating visible width.
 */
export function centerPad(line: string, width?: number): string {
  const w = width ?? termWidth();
  const visible = visibleLength(line);
  const pad = Math.max(0, Math.floor((w - visible) / 2));
  return ' '.repeat(pad) + line;
}

// ---------------------------------------------------------------------------
// Box rendering
// ---------------------------------------------------------------------------

/**
 * Render a bordered box with an optional title.
 *
 * Returns a multi-line string. Border color is TEAL_DIM.
 * Content lines are left-aligned with 2-space interior padding.
 *
 * Example output:
 * ```
 * ╭─── Title ─────────────────────────────────────────────────╮
 * │                                                            │
 * │  Content line 1                                            │
 * │  Content line 2                                            │
 * │                                                            │
 * ╰───────────────────────────────────────────────────────────╯
 * ```
 */
export function box(title: string, lines: string[], width?: number): string {
  const w = Math.min(width ?? termWidth(), termWidth()) - 2; // 2 char margin
  const innerW = w - 2; // subtract left + right border chars

  const out: string[] = [];

  // Top border with title
  if (title) {
    const titleStr = ` ${title} `;
    const titleVisible = visibleLength(titleStr);
    const dashesAfter = Math.max(0, w - 4 - titleVisible); // 4 = ╭── prefix + ╮ suffix
    out.push(
      `  ${TEAL_DIM}${BOX.topLeft}${BOX.horizontal.repeat(2)}${RESET}` +
      `${TEAL}${BOLD}${titleStr}${RESET}` +
      `${TEAL_DIM}${BOX.horizontal.repeat(dashesAfter)}${BOX.topRight}${RESET}`,
    );
  } else {
    out.push(`  ${TEAL_DIM}${BOX.topLeft}${BOX.horizontal.repeat(w - 2)}${BOX.topRight}${RESET}`);
  }

  // Empty line inside box
  out.push(`  ${TEAL_DIM}${BOX.vertical}${RESET}${' '.repeat(innerW)}${TEAL_DIM}${BOX.vertical}${RESET}`);

  // Content lines
  for (const line of lines) {
    const lineVisible = visibleLength(line);
    const padRight = Math.max(0, innerW - 2 - lineVisible); // 2 = left padding inside box
    out.push(
      `  ${TEAL_DIM}${BOX.vertical}${RESET}  ${line}${' '.repeat(padRight)}${TEAL_DIM}${BOX.vertical}${RESET}`,
    );
  }

  // Empty line inside box
  out.push(`  ${TEAL_DIM}${BOX.vertical}${RESET}${' '.repeat(innerW)}${TEAL_DIM}${BOX.vertical}${RESET}`);

  // Bottom border
  out.push(`  ${TEAL_DIM}${BOX.bottomLeft}${BOX.horizontal.repeat(w - 2)}${BOX.bottomRight}${RESET}`);

  return out.join('\n');
}

/**
 * Render a section header with dashes.
 *
 * Example: ── Providers ────────────────────────────
 */
export function sectionHeader(title: string, width?: number): string {
  const w = Math.min(width ?? termWidth(), termWidth()) - 6; // margin
  const prefix = `${BOX.horizontal.repeat(2)} `;
  const titleStr = `${title} `;
  const dashesAfter = Math.max(0, w - 3 - title.length - 1);
  return `  ${TEAL_DIM}${prefix}${RESET}${TEAL}${BOLD}${titleStr}${RESET}${TEAL_DIM}${BOX.horizontal.repeat(dashesAfter)}${RESET}`;
}

/**
 * Render a key-value row with aligned label.
 *
 * Example: "  Model        claude-sonnet-4 (anthropic)"
 */
export function kvRow(label: string, value: string, labelWidth = 14): string {
  const paddedLabel = label.padEnd(labelWidth, ' ');
  return `${BOLD}${paddedLabel}${RESET} ${value}`;
}

/**
 * Render a horizontal separator line.
 */
export function separator(width?: number): string {
  const w = Math.min(width ?? termWidth(), termWidth()) - 4;
  return `  ${TEAL_DIM}${BOX.horizontal.repeat(w)}${RESET}`;
}

/**
 * Render a status prefix icon for pass/warn/fail results.
 */
export function statusPrefix(status: 'pass' | 'warn' | 'fail' | 'ok'): string {
  switch (status) {
    case 'pass':
    case 'ok':
      return `${GREEN}+${RESET}`;
    case 'warn':
      return `${YELLOW}~${RESET}`;
    case 'fail':
      return `${RED}x${RESET}`;
  }
}

/**
 * Render a status badge (PASS, WARN, FAIL, OK).
 */
export function statusBadge(status: 'pass' | 'warn' | 'fail' | 'ok'): string {
  switch (status) {
    case 'pass':
      return `${GREEN}PASS${RESET}`;
    case 'ok':
      return `${GREEN}OK${RESET}`;
    case 'warn':
      return `${YELLOW}WARN${RESET}`;
    case 'fail':
      return `${RED}FAIL${RESET}`;
  }
}
