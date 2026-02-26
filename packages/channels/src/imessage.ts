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
 * Features:
 *   - Tapback reactions (love, like, dislike, laugh, emphasis, question)
 *   - Thread context via thread_originator_guid
 *   - Group chat detection via chat_identifier
 *   - Destination caller ID and display name metadata
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
import { homedir } from 'node:os';
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
  /** Tapback/reaction type (2000-2005 = add, 3000-3005 = remove). Null for normal messages. */
  associated_message_type: number | null;
  /** GUID of the message this tapback applies to. */
  associated_message_guid: string | null;
  /** GUID of the thread originator (for threaded replies). */
  thread_originator_guid: string | null;
  /** Destination caller ID (recipient identifier in group chats). */
  destination_caller_id: string | null;
  /** Chat identifier (e.g., "chat123456789" for group chats, phone/email for DMs). */
  chat_identifier: string | null;
  /** Display name of the chat (group name). */
  display_name: string | null;
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
// Tapback reaction types
// ---------------------------------------------------------------------------

/**
 * Maps outbound reaction type names to their 0-based position in the
 * Messages tapback picker (the radial menu that appears after long-press
 * or right-click on a bubble).
 *
 * Picker order (left → right): love, like, dislike, laugh, emphasis, question.
 */
const TAPBACK_SEND_MAP: Record<string, number> = {
  love: 0, heart: 0,
  like: 1, thumbsup: 1,
  dislike: 2, thumbsdown: 2,
  laugh: 3, haha: 3,
  emphasis: 4, exclamation: 4,
  question: 5,
};

/**
 * iMessage tapback types.
 * 2000–2005: adding a reaction. 3000–3005: removing a reaction.
 */
const TAPBACK_TYPES: Record<number, { name: string; isRemove: boolean }> = {
  2000: { name: 'love', isRemove: false },
  2001: { name: 'like', isRemove: false },
  2002: { name: 'dislike', isRemove: false },
  2003: { name: 'laugh', isRemove: false },
  2004: { name: 'emphasis', isRemove: false },
  2005: { name: 'question', isRemove: false },
  3000: { name: 'love', isRemove: true },
  3001: { name: 'like', isRemove: true },
  3002: { name: 'dislike', isRemove: true },
  3003: { name: 'laugh', isRemove: true },
  3004: { name: 'emphasis', isRemove: true },
  3005: { name: 'question', isRemove: true },
};

/** Check whether an associated_message_type value represents a tapback reaction. */
function isReaction(associatedMessageType: number | null): boolean {
  if (associatedMessageType === null || associatedMessageType === 0) return false;
  return associatedMessageType in TAPBACK_TYPES;
}

// ---------------------------------------------------------------------------
// JXA accessibility path constants
// ---------------------------------------------------------------------------

/** Sidebar scroll area — contains the conversation list. */
export const JXA_SIDEBAR_PATH = 'proc.windows[0].splitterGroups[0].scrollAreas[0]';
/** Primary message transcript area on macOS 13–14 (scrollAreas index 1). */
export const JXA_MSG_AREA_PATH = 'proc.windows[0].splitterGroups[0].scrollAreas[1]';
/**
 * Fallback message transcript area path.
 * On macOS versions where the splitter layout differs, the transcript may be
 * at scrollAreas[0] rather than scrollAreas[1].
 */
export const JXA_MSG_AREA_ALT = 'proc.windows[0].splitterGroups[0].scrollAreas[0]';

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
  /** macOS version string (e.g. "15.1") for diagnostic error messages. Null if detection failed. */
  private macOSVersion: string | null = null;

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
    this.pollInterval = Math.max(100, cfg.pollInterval ?? 2000);
    this.allowedHandles = new Set(cfg.allowedHandles ?? []);
    this.dbPath = cfg.dbPath ?? `${homedir()}/Library/Messages/chat.db`;

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

    // -- Detect macOS version for diagnostic error messages (best-effort) ----
    this.running = true;
    try {
      const { stdout: versionOut } = await execFile('sw_vers', ['-productVersion']);
      this.macOSVersion = versionOut.trim() || null;
    } catch {
      this.macOSVersion = null;
    }

    // -- Start polling loop ------------------------------------------------
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

  /**
   * Send a tapback reaction to a specific message via JXA UI scripting.
   *
   * Uses System Events accessibility API to:
   *   1. Look up the message text + chat identifier from chat.db by GUID.
   *   2. Focus the conversation in Messages.app.
   *   3. Right-click the target message bubble.
   *   4. Select the tapback from the context menu.
   *
   * Requires macOS 13+ and Accessibility permission for your terminal in
   * System Settings > Privacy & Security > Accessibility.
   *
   * Valid reactionTypes: love, heart, like, thumbsup, dislike, thumbsdown,
   *   laugh, haha, emphasis, exclamation, question.
   */
  async sendReaction(
    _to: Recipient,
    messageGuid: string,
    reactionType: string,
  ): Promise<SendResult> {
    const reactionIndex = TAPBACK_SEND_MAP[reactionType.toLowerCase()];
    if (reactionIndex === undefined) {
      const valid = Object.keys(TAPBACK_SEND_MAP).join(', ');
      return {
        success: false,
        error: `Unknown reaction type "${reactionType}". Valid types: ${valid}.`,
      };
    }

    const info = await this.getMessageInfo(messageGuid);
    if (!info) {
      return {
        success: false,
        error: `Message with GUID "${messageGuid}" not found in chat.db.`,
      };
    }

    const jxa = buildTapbackScript(info.chatIdentifier, info.text, reactionIndex);
    try {
      const { stdout: jxaOut } = await execFile('osascript', ['-l', 'JavaScript', '-e', jxa]);
      const out = jxaOut.trim();
      // The JXA script returns error strings to stdout on non-fatal failures.
      if (out.startsWith('react_menu_error:') || out === 'message_not_found') {
        return {
          success: false,
          error: `${out} (macOS ${this.macOSVersion ?? 'unknown'})`,
        };
      }
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('not authorized') || errMsg.includes('assistive access')) {
        return {
          success: false,
          error:
            'Accessibility permission denied. Allow your terminal in ' +
            'System Settings > Privacy & Security > Accessibility.',
        };
      }
      return { success: false, error: `${errMsg} (macOS ${this.macOSVersion ?? 'unknown'})` };
    }
  }

  /**
   * Look up the plain text and chat_identifier for a message by GUID from chat.db.
   * Returns null if the message is not found or the query fails.
   */
  private async getMessageInfo(
    guid: string,
  ): Promise<{ text: string; chatIdentifier: string } | null> {
    // Validate GUID format before interpolating into SQL.
    // Apple GUIDs are UUIDs (with optional prefix like "p:0/"), hex digits, hyphens, colons, slashes.
    if (!/^[A-Za-z0-9\-:/]+$/.test(guid)) {
      return null;
    }
    const safeGuid = guid.replace(/'/g, "''");
    const sql = `
      SELECT m.text, c.chat_identifier
      FROM message m
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE m.guid = '${safeGuid}'
      LIMIT 1
    `;
    try {
      const { stdout } = await execFile('sqlite3', ['-json', this.dbPath, sql]);
      const rows = JSON.parse(stdout || '[]') as Array<{
        text: string | null;
        chat_identifier: string | null;
      }>;
      const row = rows[0];
      if (!row) return null;
      return {
        text: row.text ?? '',
        chatIdentifier: row.chat_identifier ?? '',
      };
    } catch {
      return null;
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // iMessage does not expose presence/typing events via chat.db.
    // The chat.db database has no typing indicator data — this is a
    // platform limitation, not a missing feature.
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

    // Expanded query: joins chat table for group ID and display name,
    // includes reaction/thread/destination fields.
    const query = [
      'SELECT m.ROWID, m.text, m.date, h.id as handle, m.is_from_me,',
      '       m.cache_has_attachments,',
      '       m.associated_message_type, m.associated_message_guid,',
      '       m.thread_originator_guid, m.destination_caller_id,',
      '       c.chat_identifier, c.display_name',
      'FROM message m',
      'JOIN handle h ON m.handle_id = h.ROWID',
      'LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id',
      'LEFT JOIN chat c ON cmj.chat_id = c.ROWID',
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
    // --- Tapback reaction handling ---
    if (isReaction(row.associated_message_type)) {
      const tapback = TAPBACK_TYPES[row.associated_message_type!];
      if (!tapback) return null; // Unknown reaction type.

      // Extract the target message GUID. iMessage stores it as "p:0/GUID" or "bp:GUID".
      let targetGuid = row.associated_message_guid ?? '';
      // Strip the "p:N/" or "bp:" prefix to get the raw GUID.
      const guidMatch = targetGuid.match(/^(?:p:\d+\/|bp:)(.+)$/);
      if (guidMatch) {
        targetGuid = guidMatch[1]!;
      }

      return {
        id: String(row.ROWID),
        channelId: this.id,
        from: {
          channelId: this.id,
          userId: row.handle,
          groupId: row.chat_identifier ?? undefined,
        },
        text: tapback.isRemove
          ? `[Removed ${tapback.name} reaction]`
          : `[${tapback.name} reaction]`,
        replyTo: targetGuid || undefined,
        timestamp: imessageDateToJS(row.date),
        raw: {
          ...row,
          reaction: true,
          reactionType: tapback.name,
          reactionRemoved: tapback.isRemove,
        },
      };
    }

    // --- Normal message handling ---
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

    // Determine group context from chat table.
    const isGroup = row.chat_identifier
      ? row.chat_identifier.startsWith('chat')
      : false;

    return {
      id: String(row.ROWID),
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: row.handle,
        groupId: isGroup ? (row.chat_identifier ?? undefined) : undefined,
      },
      text,
      attachments,
      // Thread context: if this message is a reply in a thread.
      replyTo: row.thread_originator_guid ?? undefined,
      timestamp: imessageDateToJS(row.date),
      raw: {
        ...row,
        destination_caller_id: row.destination_caller_id,
        display_name: row.display_name,
      },
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

// ---------------------------------------------------------------------------
// JXA tapback script builder (module-level, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Build a JXA (JavaScript for Automation) script that sends a tapback
 * reaction to the most recent matching message bubble in Messages.app.
 *
 * The script:
 *   1. Activates Messages.app.
 *   2. Selects the conversation identified by `chatIdentifier` in the sidebar.
 *   3. Locates the message bubble whose text starts with `messageText` (first 40 chars).
 *   4. Right-clicks the bubble and selects "React…" from the context menu.
 *   5. Clicks the tapback at position `reactionIndex` (0-based) in the submenu.
 *
 * @param chatIdentifier   The chat_identifier value from chat.db (e.g. "+15555550100").
 * @param messageText      The plain text of the target message.
 * @param reactionIndex    0-based index in the tapback picker (love=0, like=1, ...).
 */
export function buildTapbackScript(
  chatIdentifier: string,
  messageText: string,
  reactionIndex: number,
): string {
  /** Escape a string for embedding inside a JXA double-quoted string. */
  const esc = (s: string): string =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\x00/g, '');  // strip null bytes — they truncate JXA strings

  return `(function() {
  const app = Application("Messages");
  app.activate();
  delay(0.5);
  const se = Application("System Events");
  const proc = se.processes.byName("Messages");

  // Select the conversation in the sidebar.
  try {
    const sidebar = ${JXA_SIDEBAR_PATH};
    const rows = sidebar.tables[0].rows();
    for (const row of rows) {
      try {
        const label = row.staticTexts[0].value();
        if (label && label.includes("${esc(chatIdentifier)}")) {
          row.select();
          break;
        }
      } catch (_) {}
    }
  } catch (_) {}
  delay(0.3);

  // Find the message bubble — primary path (macOS 13–14).
  let msgEl = null;
  const targetText = "${esc(messageText.slice(0, 40))}";
  try {
    const msgArea = ${JXA_MSG_AREA_PATH};
    const groups = msgArea.groups();
    for (const g of groups) {
      try {
        const txt = g.staticTexts[0].value();
        if (txt && txt.includes(targetText)) {
          msgEl = g;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Fallback path: try alternate scroll area if primary search found nothing.
  if (!msgEl) {
    try {
      const msgAreaAlt = ${JXA_MSG_AREA_ALT};
      const altGroups = msgAreaAlt.groups();
      for (const g of altGroups) {
        try {
          const txt = g.staticTexts[0].value();
          if (txt && txt.includes(targetText)) {
            msgEl = g;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  if (!msgEl) return "message_not_found";

  // Right-click the bubble to open the context menu.
  const pos = msgEl.position();
  const size = msgEl.size();
  se.rightClick({ at: [pos[0] + size[0] / 2, pos[1] + size[1] / 2] });
  delay(0.3);

  // Click "React\u2026" item.
  try {
    const menu = proc.windows[0].menus[0];
    const reactItem = menu.menuItems.byName("React\u2026");
    reactItem.actions.byName("AXPress").perform();
    delay(0.2);
    reactItem.menus[0].menuItems[${reactionIndex}].actions.byName("AXPress").perform();
  } catch (err) {
    return "react_menu_error: " + err.toString();
  }

  return "ok";
})()`;
}
