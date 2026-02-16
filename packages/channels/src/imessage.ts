/**
 * IMessageChannel -- macOS iMessage channel adapter.
 *
 * Implements the IChannel interface for Apple iMessage on macOS.
 * Uses ZERO npm dependencies -- only Node.js built-in `child_process.execFile`.
 *
 * How it works:
 *   - Receiving: Polls ~/Library/Messages/chat.db (SQLite) via the `sqlite3` CLI
 *     for new inbound messages. Tracks ROWID offset to avoid reprocessing.
 *   - Sending: Invokes `osascript -l JavaScript` (JXA) to drive Messages.app.
 *
 * macOS requirements:
 *   1. Full Disk Access -- System Settings > Privacy & Security > Full Disk Access
 *      must be granted to your terminal (or the Node.js binary) so that the process
 *      can read ~/Library/Messages/chat.db.
 *   2. Automation permission -- the first time `osascript` drives Messages.app,
 *      macOS will prompt to allow automation. Approve it, or pre-grant via
 *      System Settings > Privacy & Security > Automation.
 *   3. The `sqlite3` CLI must be available on PATH (ships with macOS by default).
 *
 * This adapter is macOS-only. Calling start() on any other platform throws.
 */

import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
  PresenceEvent,
  Attachment,
} from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IMessageConfig extends ChannelConfig {
  /** Polling interval in milliseconds (default: 2000). */
  pollInterval?: number;
  /** Phone number / email whitelist. Empty or omitted = allow all. */
  allowedHandles?: string[];
  /** Override chat.db path (useful for testing). */
  dbPath?: string;
}

/** Shape of a row returned by the sqlite3 -json query for messages. */
interface MessageRow {
  ROWID: number;
  text: string | null;
  date: number;
  handle: string;
  is_from_me: number;
  cache_has_attachments: number;
}

/** Shape of a row returned by the sqlite3 -json query for attachments. */
interface AttachmentRow {
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
}

/**
 * iMessage epoch: 2001-01-01T00:00:00Z in Unix milliseconds.
 * iMessage stores dates as nanoseconds since this epoch.
 */
const IMESSAGE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Convert an iMessage nanosecond timestamp to a JS Date. */
function imessageDateToJS(nanoseconds: number): Date {
  // chat.db stores dates as nanoseconds since 2001-01-01 00:00:00 UTC.
  // Convert to milliseconds and offset from the iMessage epoch.
  return new Date(IMESSAGE_EPOCH_MS + nanoseconds / 1_000_000);
}

/** Classify a MIME type string into an Attachment type. */
function classifyMimeType(mime: string | null): Attachment['type'] {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// ---------------------------------------------------------------------------
// IMessageChannel
// ---------------------------------------------------------------------------

export class IMessageChannel implements IChannel {
  readonly id = 'imessage';
  readonly name = 'iMessage';

  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInterval = 2000;
  private lastRowId = 0;
  private dbPath = '';
  private allowedHandles: Set<string> = new Set();

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    // -- Platform gate -----------------------------------------------------
    if (process.platform !== 'darwin') {
      throw new Error(
        'IMessageChannel is macOS-only. ' +
        `Current platform "${process.platform}" is not supported.`,
      );
    }

    const cfg = config as IMessageConfig;

    // -- Verify sqlite3 is available ---------------------------------------
    try {
      await execFile('which', ['sqlite3']);
    } catch {
      throw new Error(
        'sqlite3 CLI not found on PATH. It ships with macOS by default -- ' +
        'ensure your system is not missing it or that PATH is configured correctly.',
      );
    }

    // -- Configuration -----------------------------------------------------
    this.pollInterval = cfg.pollInterval ?? 2000;
    this.allowedHandles = new Set(cfg.allowedHandles ?? []);
    this.dbPath = cfg.dbPath ?? `${process.env.HOME}/Library/Messages/chat.db`;

    // -- Determine initial ROWID offset ------------------------------------
    // Query the current max ROWID so we only process messages that arrive
    // after the adapter starts.
    try {
      const { stdout } = await execFile('sqlite3', [
        '-json',
        this.dbPath,
        'SELECT MAX(ROWID) as max_id FROM message;',
      ]);
      const rows = JSON.parse(stdout || '[]') as Array<{ max_id: number | null }>;
      this.lastRowId = rows[0]?.max_id ?? 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('unable to open database') ||
        message.includes('permission denied') ||
        message.includes('not authorized')
      ) {
        throw new Error(
          'Cannot read iMessage database. Grant Full Disk Access to your terminal:\n' +
          'System Settings > Privacy & Security > Full Disk Access\n' +
          `Database path: ${this.dbPath}`,
        );
      }
      throw new Error(`Failed to query iMessage database: ${message}`);
    }

    // -- Start polling loop ------------------------------------------------
    this.running = true;
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    const handle = to.userId;
    const group = to.groupId;

    if (!handle && !group) {
      return { success: false, error: 'Recipient must have userId (handle) or groupId (chat name)' };
    }

    try {
      // Escape the text for embedding in a JXA string literal.
      const escapedText = message.text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');

      let jxa: string;

      if (group) {
        // Group chat: look up by chat name.
        const escapedGroup = group.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        jxa = [
          'const app = Application("Messages");',
          `const chat = app.chats.whose({name: "${escapedGroup}"})[0];`,
          `app.send("${escapedText}", {to: chat});`,
        ].join('\n');
      } else {
        // Direct message: look up buddy by handle.
        const escapedHandle = handle!.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        jxa = [
          'const app = Application("Messages");',
          `const buddy = app.buddies.whose({handle: "${escapedHandle}"})[0];`,
          `app.send("${escapedText}", {to: buddy});`,
        ].join('\n');
      }

      await execFile('osascript', ['-l', 'JavaScript', '-e', jxa]);

      return {
        success: true,
        messageId: generateId(),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errMsg.includes('not authorized') || errMsg.includes('assistive access')) {
        return {
          success: false,
          error:
            'Automation permission denied. Allow your terminal to control Messages.app:\n' +
            'System Settings > Privacy & Security > Automation',
        };
      }

      return {
        success: false,
        error: errMsg,
      };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // iMessage does not expose presence/typing events via chat.db.
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    try {
      await execFile('sqlite3', [this.dbPath, 'SELECT 1;']);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;

      try {
        await this.pollMessages();
      } catch {
        // Polling errors are non-fatal; retry on next tick.
      }

      if (this.running) {
        this.pollTimer = setTimeout(poll, this.pollInterval);
      }
    };

    this.pollTimer = setTimeout(poll, 0);
  }

  private async pollMessages(): Promise<void> {
    if (!this.messageHandler) return;

    const query = [
      'SELECT m.ROWID, m.text, m.date, h.id as handle, m.is_from_me,',
      '       m.cache_has_attachments',
      'FROM message m',
      'JOIN handle h ON m.handle_id = h.ROWID',
      `WHERE m.ROWID > ${this.lastRowId} AND m.is_from_me = 0`,
      'ORDER BY m.ROWID ASC;',
    ].join(' ');

    const { stdout } = await execFile('sqlite3', ['-json', this.dbPath, query]);

    // sqlite3 -json returns an empty string when there are no results.
    if (!stdout || stdout.trim() === '' || stdout.trim() === '[]') return;

    let rows: MessageRow[];
    try {
      rows = JSON.parse(stdout) as MessageRow[];
    } catch {
      // Malformed JSON -- skip this cycle.
      return;
    }

    for (const row of rows) {
      // Update offset regardless of filtering so we don't re-examine skipped rows.
      if (row.ROWID > this.lastRowId) {
        this.lastRowId = row.ROWID;
      }

      // Apply handle whitelist.
      if (this.allowedHandles.size > 0 && !this.allowedHandles.has(row.handle)) {
        continue;
      }

      const inbound = await this.processRow(row);
      if (inbound) {
        this.messageHandler(inbound);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private async processRow(row: MessageRow): Promise<InboundMessage | null> {
    const text = row.text ?? '';
    if (!text && !row.cache_has_attachments) return null;

    // Resolve attachments if flagged.
    let attachments: Attachment[] | undefined;
    if (row.cache_has_attachments) {
      attachments = await this.fetchAttachments(row.ROWID);
      if (attachments.length === 0) attachments = undefined;
    }

    // Skip rows with neither text nor attachments.
    if (!text && !attachments) return null;

    return {
      id: String(row.ROWID),
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: row.handle,
      },
      text,
      attachments,
      timestamp: imessageDateToJS(row.date),
      raw: row,
    };
  }

  // -----------------------------------------------------------------------
  // Attachment handling
  // -----------------------------------------------------------------------

  private async fetchAttachments(messageRowId: number): Promise<Attachment[]> {
    const query = [
      'SELECT a.filename, a.mime_type, a.uti',
      'FROM attachment a',
      'JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id',
      `WHERE maj.message_id = ${messageRowId};`,
    ].join(' ');

    try {
      const { stdout } = await execFile('sqlite3', ['-json', this.dbPath, query]);

      if (!stdout || stdout.trim() === '' || stdout.trim() === '[]') return [];

      const rows = JSON.parse(stdout) as AttachmentRow[];

      return rows.map((att): Attachment => {
        // Resolve the ~/Library tilde path that chat.db stores.
        let filepath = att.filename ?? undefined;
        if (filepath?.startsWith('~/')) {
          filepath = `${process.env.HOME}${filepath.slice(1)}`;
        }

        return {
          type: classifyMimeType(att.mime_type),
          url: filepath ? `file://${filepath}` : undefined,
          filename: filepath?.split('/').pop(),
          mimeType: att.mime_type ?? undefined,
        };
      });
    } catch {
      // Attachment query failure is non-fatal.
      return [];
    }
  }
}
