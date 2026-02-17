/**
 * MacOSChannel — macOS native Notification Center + AppleScript channel.
 *
 * Implements the IChannel interface using only macOS built-in tools:
 *   - Output: `display notification` via osascript (Notification Center)
 *   - Input: `display dialog` via osascript (AppleScript dialog prompts)
 *
 * Two input modes:
 *   1. **dialog** (default): A persistent AppleScript dialog that reappears
 *      after each response, creating a conversational flow.
 *   2. **notification**: Agent responses appear as macOS notifications.
 *      User replies via a dialog that appears when they click the notification
 *      or via a timed prompt.
 *
 * macOS-only. Calling start() on any other platform throws.
 * Zero npm dependencies — uses only osascript via node:child_process.
 */

import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
  PresenceEvent,
} from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MacOSConfig extends ChannelConfig {
  /** Input mode: 'dialog' (polling AppleScript dialog) or 'notification' (click-to-reply). Default: 'dialog'. */
  mode?: 'dialog' | 'notification';
  /** Delay before showing the next input dialog (ms, default: 500). */
  dialogDelay?: number;
  /** Notification title (default: 'ch4p'). */
  title?: string;
  /** Notification sound name (default: 'Submarine'). */
  sound?: string;
}

// ---------------------------------------------------------------------------
// MacOSChannel
// ---------------------------------------------------------------------------

export class MacOSChannel implements IChannel {
  readonly id = 'macos';
  readonly name = 'macOS Native';

  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private mode: 'dialog' | 'notification' = 'dialog';
  private dialogDelay = 500;
  private title = 'ch4p';
  private sound = 'Submarine';
  private pendingDialog: ChildProcess | null = null;
  private dialogTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForResponse = false;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    // -- Platform gate ---------------------------------------------------
    if (process.platform !== 'darwin') {
      throw new Error(
        'MacOSChannel is macOS-only. ' +
        `Current platform "${process.platform}" is not supported.`,
      );
    }

    // -- Verify osascript is available -----------------------------------
    try {
      await execFile('which', ['osascript']);
    } catch {
      throw new Error(
        'osascript not found on PATH. This should always be available on macOS.',
      );
    }

    const cfg = config as MacOSConfig;
    this.mode = cfg.mode ?? 'dialog';
    this.dialogDelay = cfg.dialogDelay ?? 500;
    this.title = cfg.title ?? 'ch4p';
    this.sound = cfg.sound ?? 'Submarine';

    this.running = true;

    // Start the input loop.
    this.scheduleInputDialog();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = null;
    }

    // Kill any pending dialog process.
    if (this.pendingDialog) {
      try {
        this.pendingDialog.kill('SIGTERM');
      } catch {
        // Process may have already exited.
      }
      this.pendingDialog = null;
    }
  }

  async send(_to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.running) {
      return { success: false, error: 'Channel is not running.' };
    }

    try {
      const text = message.text || '(no text)';

      if (this.mode === 'notification') {
        await this.showNotification(text);
      } else {
        // In dialog mode, show a notification for the response too,
        // then the next input dialog will appear.
        await this.showNotification(text);
      }

      // After sending a response, schedule the next input dialog.
      this.waitingForResponse = false;
      this.scheduleInputDialog();

      return {
        success: true,
        messageId: generateId(),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // macOS Notification Center does not expose presence events.
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    if (process.platform !== 'darwin') return false;

    try {
      await execFile('osascript', ['-e', '1']);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Input dialog
  // -----------------------------------------------------------------------

  private scheduleInputDialog(): void {
    if (!this.running || !this.messageHandler || this.waitingForResponse) return;

    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer);
    }

    this.dialogTimer = setTimeout(() => {
      this.dialogTimer = null;
      void this.showInputDialog();
    }, this.dialogDelay);
  }

  private async showInputDialog(): Promise<void> {
    if (!this.running || !this.messageHandler) return;

    try {
      // AppleScript dialog that captures user input.
      const script = [
        `set dialogResult to display dialog "Message for ch4p:" ` +
        `default answer "" ` +
        `with title "${this.escapeAppleScript(this.title)}" ` +
        `buttons {"Cancel", "Send"} ` +
        `default button "Send"`,
        'return text returned of dialogResult',
      ].join('\n');

      const { stdout } = await execFile('osascript', ['-e', script]);
      const text = stdout.trim();

      if (text && this.messageHandler && this.running) {
        this.waitingForResponse = true;

        const inbound: InboundMessage = {
          id: generateId(),
          channelId: this.id,
          from: {
            channelId: this.id,
            userId: 'local-user',
          },
          text,
          timestamp: new Date(),
        };

        this.messageHandler(inbound);
      } else {
        // Empty input — show dialog again.
        this.scheduleInputDialog();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // User clicked Cancel — pause the dialog loop.
      // -128 is the AppleScript error code for "User canceled".
      if (errMsg.includes('-128') || errMsg.includes('User canceled')) {
        // Wait a bit before showing the dialog again.
        if (this.running) {
          this.dialogTimer = setTimeout(() => {
            this.dialogTimer = null;
            void this.showInputDialog();
          }, 5000); // 5s pause after cancel
        }
        return;
      }

      // Other error — retry after delay.
      if (this.running) {
        this.scheduleInputDialog();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Notification
  // -----------------------------------------------------------------------

  private async showNotification(text: string): Promise<void> {
    // Truncate very long messages for the notification (macOS has limits).
    const displayText = text.length > 500 ? text.slice(0, 497) + '...' : text;
    const escaped = this.escapeAppleScript(displayText);
    const escapedTitle = this.escapeAppleScript(this.title);

    const script =
      `display notification "${escaped}" ` +
      `with title "${escapedTitle}" ` +
      `sound name "${this.sound}"`;

    await execFile('osascript', ['-e', script]);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Escape a string for embedding in an AppleScript string literal. */
  private escapeAppleScript(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }
}
