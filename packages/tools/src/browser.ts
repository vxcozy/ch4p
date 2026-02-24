/**
 * Browser control tool — headless browser automation via Playwright.
 *
 * Heavyweight tool providing page navigation, interaction, screenshot capture,
 * JavaScript evaluation, and scrolling. Uses playwright-core (no bundled
 * browsers) — the user installs a browser via `npx playwright install chromium`.
 *
 * Security:
 *   - SSRF guards on every navigation (reuses shared ssrf-guards module)
 *   - `evaluate` action blocked in readonly autonomy level
 *   - Page navigation timeout 30s; screenshot size cap 5MB
 *   - Persistent browser instance per tool lifetime (lazy-launched)
 *
 * AWM integration:
 *   - Implements getStateSnapshot() returning current URL, page title,
 *     and a visible-text excerpt so verifiers can diff pre/post state.
 */

import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
  StateSnapshot,
} from '@ch4p/core';
import { isBlockedHostname, resolveAndCheckPrivate } from './ssrf-guards.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BrowserAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'evaluate'
  | 'scroll'
  | 'wait'
  | 'close';

interface BrowserArgs {
  action: BrowserAction;
  /** URL for navigate action. */
  url?: string;
  /** CSS selector for click/type actions. */
  selector?: string;
  /** Text to type for type action. */
  text?: string;
  /** JavaScript expression for evaluate action. */
  expression?: string;
  /** Scroll direction: 'up' | 'down' | 'left' | 'right'. Default: 'down'. */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Scroll distance in pixels. Default: 500. */
  distance?: number;
  /** Wait time in milliseconds for wait action. Max 10000. */
  timeout?: number;
  /** Whether to take a full-page screenshot. Default: false. */
  fullPage?: boolean;
}

// Playwright types — we import dynamically to avoid hard failures when
// playwright-core is not installed.
type PlaywrightBrowser = import('playwright-core').Browser;
type PlaywrightPage = import('playwright-core').Page;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAV_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_EVAL_OUTPUT = 50_000;
const MAX_WAIT_MS = 10_000;
const MAX_TEXT_EXCERPT = 2000;

const VALID_ACTIONS = new Set<BrowserAction>([
  'navigate', 'click', 'type', 'screenshot',
  'evaluate', 'scroll', 'wait', 'close',
]);

const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// ---------------------------------------------------------------------------
// BrowserTool
// ---------------------------------------------------------------------------

export class BrowserTool implements ITool {
  readonly name = 'browser';
  readonly description =
    'Control a headless browser. Navigate to URLs, click elements, type text, ' +
    'take screenshots, evaluate JavaScript, and scroll pages. The browser ' +
    'persists across calls within a session.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'The browser action to perform: navigate, click, type, screenshot, ' +
          'evaluate, scroll, wait, or close.',
        enum: ['navigate', 'click', 'type', 'screenshot', 'evaluate', 'scroll', 'wait', 'close'],
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (required for navigate action).',
      },
      selector: {
        type: 'string',
        description: 'CSS selector of the target element (required for click and type actions).',
      },
      text: {
        type: 'string',
        description: 'Text to type into the selected element (required for type action).',
      },
      expression: {
        type: 'string',
        description: 'JavaScript expression to evaluate in the page context (required for evaluate action).',
      },
      direction: {
        type: 'string',
        description: 'Scroll direction: up, down, left, or right. Default: down.',
        enum: ['up', 'down', 'left', 'right'],
      },
      distance: {
        type: 'number',
        description: 'Scroll distance in pixels. Default: 500.',
        minimum: 1,
        maximum: 10000,
      },
      timeout: {
        type: 'number',
        description: 'Wait time in milliseconds (for wait action). Max 10000.',
        minimum: 100,
        maximum: 10000,
      },
      fullPage: {
        type: 'boolean',
        description: 'Whether to capture a full-page screenshot. Default: false.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  };

  // Persistent browser state.
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;
  private launching = false;

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const a = args as Record<string, unknown>;
    const errors: string[] = [];

    // action: required
    if (typeof a.action !== 'string' || !VALID_ACTIONS.has(a.action as BrowserAction)) {
      errors.push(`action must be one of: ${[...VALID_ACTIONS].join(', ')}.`);
      return { valid: false, errors };
    }

    const action = a.action as BrowserAction;

    // Per-action validation.
    switch (action) {
      case 'navigate':
        if (typeof a.url !== 'string' || a.url.trim().length === 0) {
          errors.push('url is required for navigate action.');
        } else {
          try {
            const parsed = new URL(a.url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              errors.push('url must use http or https protocol.');
            }
            if (isBlockedHostname(parsed.hostname)) {
              errors.push('url targets a blocked or private network address.');
            }
          } catch {
            errors.push('url must be a valid URL.');
          }
        }
        break;

      case 'click':
        if (typeof a.selector !== 'string' || a.selector.trim().length === 0) {
          errors.push('selector is required for click action.');
        }
        break;

      case 'type':
        if (typeof a.selector !== 'string' || a.selector.trim().length === 0) {
          errors.push('selector is required for type action.');
        }
        if (typeof a.text !== 'string') {
          errors.push('text is required for type action.');
        }
        break;

      case 'evaluate':
        if (typeof a.expression !== 'string' || a.expression.trim().length === 0) {
          errors.push('expression is required for evaluate action.');
        }
        break;

      case 'scroll':
        if (a.direction !== undefined && (typeof a.direction !== 'string' || !VALID_DIRECTIONS.has(a.direction))) {
          errors.push('direction must be one of: up, down, left, right.');
        }
        if (a.distance !== undefined) {
          if (typeof a.distance !== 'number' || a.distance < 1 || a.distance > 10000) {
            errors.push('distance must be a number between 1 and 10000.');
          }
        }
        break;

      case 'wait':
        if (a.timeout !== undefined) {
          if (typeof a.timeout !== 'number' || a.timeout < 100 || a.timeout > MAX_WAIT_MS) {
            errors.push(`timeout must be between 100 and ${MAX_WAIT_MS}ms.`);
          }
        }
        break;

      case 'screenshot':
        // Optional: fullPage boolean.
        if (a.fullPage !== undefined && typeof a.fullPage !== 'boolean') {
          errors.push('fullPage must be a boolean.');
        }
        break;

      case 'close':
        // No additional args.
        break;
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validation = this.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `Invalid arguments: ${validation.errors!.join(' ')}`,
      };
    }

    const a = args as BrowserArgs;

    if (context.abortSignal.aborted) {
      return { success: false, output: '', error: 'Request aborted before execution.' };
    }

    // Block evaluate in readonly mode.
    if (a.action === 'evaluate' && context.securityPolicy) {
      // The security policy may have autonomyLevel — cast safely.
      const policy = context.securityPolicy as unknown as Record<string, unknown>;
      const autonomy = policy.autonomyLevel;
      if (autonomy === 'readonly') {
        return {
          success: false,
          output: '',
          error: 'evaluate action is blocked in readonly autonomy mode.',
        };
      }
    }

    // Close action does not require a page.
    if (a.action === 'close') {
      return this.doClose();
    }

    // Ensure the browser is running.
    const ensureResult = await this.ensureBrowser(context);
    if (ensureResult) return ensureResult;

    try {
      switch (a.action) {
        case 'navigate':
          return await this.doNavigate(a, context);
        case 'click':
          return await this.doClick(a);
        case 'type':
          return await this.doType(a);
        case 'screenshot':
          return await this.doScreenshot(a);
        case 'evaluate':
          return await this.doEvaluate(a);
        case 'scroll':
          return await this.doScroll(a);
        case 'wait':
          return await this.doWait(a);
        default:
          return { success: false, output: '', error: `Unknown action: ${a.action}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Browser error: ${message}` };
    }
  }

  // ---------------------------------------------------------------------------
  // AWM state snapshot
  // ---------------------------------------------------------------------------

  async getStateSnapshot(_args: unknown, _context: ToolContext): Promise<StateSnapshot> {
    const state: Record<string, unknown> = {};

    if (this.page && !this.page.isClosed()) {
      try {
        state.url = this.page.url();
        state.title = await this.page.title();
        // Grab visible text excerpt (use string expression to avoid TS dom errors).
        const excerpt = await this.page.evaluate(
          '(() => { const b = document.body; return b ? (b.innerText || "").slice(0, 2000) : ""; })()',
        ).catch(() => '') as string;
        state.visibleText = (excerpt ?? '').slice(0, MAX_TEXT_EXCERPT);
      } catch {
        state.url = 'unknown';
        state.title = 'unknown';
      }
    } else {
      state.url = null;
      state.title = null;
      state.browserRunning = false;
    }

    return {
      timestamp: new Date().toISOString(),
      state,
      description: state.url
        ? `Browser at ${state.url} — "${state.title}"`
        : 'Browser not running',
    };
  }

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  abort(_reason: string): void {
    this.closeBrowser().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Browser lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Ensure the browser is launched. Lazy-starts on first call.
   * Returns a ToolResult error if playwright-core is not available.
   */
  private async ensureBrowser(context: ToolContext): Promise<ToolResult | null> {
    if (this.page && !this.page.isClosed()) return null;
    if (this.browser && this.browser.isConnected()) {
      // Browser alive but page closed — open a new page.
      this.page = await this.browser.newPage();
      return null;
    }

    // Prevent re-entrant launches.
    if (this.launching) {
      return { success: false, output: '', error: 'Browser is already launching.' };
    }

    this.launching = true;
    try {
      // Dynamic import — fails gracefully if not installed.
      const pw = await import('playwright-core').catch(() => null);
      if (!pw) {
        return {
          success: false,
          output: '',
          error:
            'playwright-core is not installed. Run: npm install -D playwright-core && npx playwright install chromium',
        };
      }

      // Try chromium first, then firefox, then webkit.
      let executablePath: string | undefined;
      for (const browserType of [pw.chromium, pw.firefox, pw.webkit]) {
        try {
          executablePath = browserType.executablePath();
          if (executablePath) {
            this.browser = await browserType.launch({
              headless: true,
              args: ['--disable-dev-shm-usage', '--no-sandbox'],
            });
            break;
          }
        } catch {
          // Try next browser type.
          continue;
        }
      }

      if (!this.browser) {
        return {
          success: false,
          output: '',
          error:
            'No browser found. Install one with: npx playwright install chromium',
        };
      }

      this.page = await this.browser.newPage();

      // Wire abort signal to close.
      context.abortSignal.addEventListener('abort', () => {
        this.closeBrowser().catch(() => {});
      }, { once: true });

      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        error: `Failed to launch browser: ${message}`,
      };
    } finally {
      this.launching = false;
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      try { await this.page.close(); } catch { /* best-effort */ }
    }
    this.page = null;

    if (this.browser) {
      try { await this.browser.close(); } catch { /* best-effort */ }
    }
    this.browser = null;
  }

  // ---------------------------------------------------------------------------
  // Action implementations
  // ---------------------------------------------------------------------------

  private async doNavigate(a: BrowserArgs, context: ToolContext): Promise<ToolResult> {
    let url = a.url!;

    // Upgrade http to https.
    url = url.replace(/^http:\/\//, 'https://');

    // Async SSRF check: resolve DNS.
    try {
      const parsed = new URL(url);
      const dnsCheck = await resolveAndCheckPrivate(parsed.hostname);
      if (dnsCheck.blocked) {
        return {
          success: false,
          output: '',
          error: `SSRF blocked: ${dnsCheck.reason}`,
          metadata: { url, ssrfBlocked: true },
        };
      }
    } catch {
      return {
        success: false,
        output: '',
        error: 'Failed to parse URL for SSRF check.',
        metadata: { url },
      };
    }

    context.onProgress(`Navigating to ${url}...`);

    await this.page!.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    const title = await this.page!.title();
    const currentUrl = this.page!.url();

    return {
      success: true,
      output: `Navigated to ${currentUrl}\nTitle: ${title}`,
      metadata: { url: currentUrl, title },
    };
  }

  private async doClick(a: BrowserArgs): Promise<ToolResult> {
    const selector = a.selector!;

    await this.page!.click(selector, { timeout: 5000 });

    // Wait briefly for any resulting navigation or DOM update.
    await this.page!.waitForTimeout(500);

    const url = this.page!.url();
    const title = await this.page!.title();

    return {
      success: true,
      output: `Clicked "${selector}"\nCurrent URL: ${url}\nTitle: ${title}`,
      metadata: { selector, url, title },
    };
  }

  private async doType(a: BrowserArgs): Promise<ToolResult> {
    const selector = a.selector!;
    const text = a.text!;

    // Clear existing content and type new text.
    await this.page!.fill(selector, text, { timeout: 5000 });

    return {
      success: true,
      output: `Typed ${text.length} characters into "${selector}"`,
      metadata: { selector, length: text.length },
    };
  }

  private async doScreenshot(a: BrowserArgs): Promise<ToolResult> {
    const fullPage = a.fullPage ?? false;

    const buffer = await this.page!.screenshot({
      type: 'png',
      fullPage,
    });

    if (buffer.byteLength > MAX_SCREENSHOT_SIZE) {
      return {
        success: false,
        output: '',
        error: `Screenshot too large: ${buffer.byteLength} bytes (limit: ${MAX_SCREENSHOT_SIZE}).`,
        metadata: { size: buffer.byteLength },
      };
    }

    const base64 = buffer.toString('base64');
    const url = this.page!.url();
    const title = await this.page!.title();

    return {
      success: true,
      output: `Screenshot captured (${buffer.byteLength} bytes, ${fullPage ? 'full page' : 'viewport'})\nURL: ${url}\nTitle: ${title}`,
      metadata: {
        url,
        title,
        size: buffer.byteLength,
        fullPage,
        base64,
        mimeType: 'image/png',
      },
    };
  }

  private async doEvaluate(a: BrowserArgs): Promise<ToolResult> {
    const expression = a.expression!;

    const result = await this.page!.evaluate(expression);

    let output: string;
    if (result === undefined) {
      output = 'undefined';
    } else if (result === null) {
      output = 'null';
    } else if (typeof result === 'string') {
      output = result;
    } else {
      try {
        output = JSON.stringify(result, null, 2);
      } catch {
        output = String(result);
      }
    }

    if (output.length > MAX_EVAL_OUTPUT) {
      output = output.slice(0, MAX_EVAL_OUTPUT) + '\n\n... [output truncated] ...';
    }

    return {
      success: true,
      output,
      metadata: { expression, outputLength: output.length },
    };
  }

  private async doScroll(a: BrowserArgs): Promise<ToolResult> {
    const direction = a.direction ?? 'down';
    const distance = a.distance ?? 500;

    let deltaX = 0;
    let deltaY = 0;

    switch (direction) {
      case 'down':  deltaY = distance;  break;
      case 'up':    deltaY = -distance; break;
      case 'right': deltaX = distance;  break;
      case 'left':  deltaX = -distance; break;
    }

    // Use string expressions to avoid TS dom type errors (runs in browser context).
    await this.page!.evaluate(
      `window.scrollBy(${deltaX}, ${deltaY})`,
    );

    // Wait for potential lazy-load content.
    await this.page!.waitForTimeout(300);

    const scrollPos = await this.page!.evaluate(
      '({ x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, viewportHeight: window.innerHeight })',
    ) as { x: number; y: number; height: number; viewportHeight: number };

    return {
      success: true,
      output: `Scrolled ${direction} ${distance}px\nScroll position: ${scrollPos.y}px / ${scrollPos.height}px (viewport: ${scrollPos.viewportHeight}px)`,
      metadata: { direction, distance, ...scrollPos },
    };
  }

  private async doWait(a: BrowserArgs): Promise<ToolResult> {
    const timeout = a.timeout ?? 1000;
    const clamped = Math.min(timeout, MAX_WAIT_MS);

    await this.page!.waitForTimeout(clamped);

    return {
      success: true,
      output: `Waited ${clamped}ms`,
      metadata: { waited: clamped },
    };
  }

  private async doClose(): Promise<ToolResult> {
    const wasRunning = this.browser !== null;
    await this.closeBrowser();

    return {
      success: true,
      output: wasRunning ? 'Browser closed.' : 'Browser was not running.',
      metadata: { wasRunning },
    };
  }
}
