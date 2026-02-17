/**
 * IrcChannel — IRC (Internet Relay Chat) channel adapter.
 *
 * Implements the IChannel interface for IRC using raw TCP/TLS sockets
 * (node:net / node:tls). Zero external dependencies.
 *
 * Configuration (via ChannelConfig):
 *   server           — IRC server hostname (required)
 *   port             — Server port (default: 6697)
 *   ssl              — Use TLS (default: true)
 *   nick             — Bot nickname (default: "ch4p")
 *   channels         — IRC channels to join (e.g., ["#general", "#dev"])
 *   password         — Server password (optional)
 *   allowedUsers     — Nick whitelist (empty = allow all)
 *   reconnectDelay   — Delay in ms before reconnect (default: 5000)
 *
 * Supported features:
 *   - PRIVMSG send/receive (channel + DM)
 *   - Auto PONG on PING
 *   - Auto-reconnect on disconnect
 *   - Auto-join configured channels after registration
 *   - Long message splitting (512-byte IRC limit)
 *
 * Limitations:
 *   - No editMessage() (IRC doesn't support message editing)
 *   - No attachment support (IRC is text-only)
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IrcConfig extends ChannelConfig {
  server: string;
  port?: number;
  ssl?: boolean;
  nick?: string;
  channels?: string[];
  password?: string;
  allowedUsers?: string[];
  reconnectDelay?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 6697;
const DEFAULT_NICK = 'ch4p';
const DEFAULT_RECONNECT_DELAY = 5000;
const MAX_IRC_LINE = 512; // RFC 2812 max line length including CRLF.
const MAX_PRIVMSG_TEXT = 400; // Conservative limit for PRIVMSG text (leaving room for prefix/command/target).

// ---------------------------------------------------------------------------
// IrcChannel
// ---------------------------------------------------------------------------

export class IrcChannel implements IChannel {
  readonly id = 'irc';
  readonly name = 'IRC';

  private config: IrcConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private socket: Socket | null = null;
  private buffer = '';
  private registered = false;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as IrcConfig;

    if (!cfg.server || typeof cfg.server !== 'string') {
      throw new Error('IrcChannel requires server in config.');
    }

    this.config = cfg;
    this.stopping = false;

    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.rawSend('QUIT :Goodbye');
      } catch {
        // Best-effort.
      }
      this.socket.destroy();
      this.socket = null;
    }

    this.registered = false;
    this.buffer = '';
    this.messageHandler = null;
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config || !this.socket || !this.registered) {
      return { success: false, error: 'IrcChannel not connected.' };
    }

    const target = to.groupId ?? to.userId ?? to.channelId;
    if (!target) {
      return { success: false, error: 'No target specified.' };
    }

    try {
      // Split long messages to respect IRC line limits.
      const lines = splitMessage(message.text, MAX_PRIVMSG_TEXT);
      for (const line of lines) {
        this.rawSend(`PRIVMSG ${target} :${line}`);
      }

      return { success: true, messageId: `irc-${Date.now()}` };
    } catch (err) {
      return { success: false, error: `IRC send failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.registered && this.socket !== null && !this.socket.destroyed;
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.config) throw new Error('Not configured.');

    const cfg = this.config;
    const port = cfg.port ?? DEFAULT_PORT;
    const useSsl = cfg.ssl !== false;

    return new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        // Send registration commands.
        if (cfg.password) {
          this.rawSend(`PASS ${cfg.password}`);
        }
        const nick = cfg.nick ?? DEFAULT_NICK;
        this.rawSend(`NICK ${nick}`);
        this.rawSend(`USER ${nick} 0 * :ch4p bot`);
        resolve();
      };

      const onError = (err: Error) => {
        if (!this.registered) {
          reject(new Error(`IRC connection failed: ${err.message}`));
        }
      };

      if (useSsl) {
        this.socket = tlsConnect(
          { host: cfg.server, port, rejectUnauthorized: true },
          onConnect,
        );
      } else {
        this.socket = netConnect({ host: cfg.server, port }, onConnect);
      }

      this.socket.setEncoding('utf8');
      this.socket.on('data', (data: string) => this.handleData(data));
      this.socket.on('error', onError);
      this.socket.on('close', () => this.handleDisconnect());
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.config) return;

    const delay = this.config.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      this.registered = false;
      this.buffer = '';
      this.connect().catch(() => {
        // Retry again.
        this.scheduleReconnect();
      });
    }, delay);

    // Don't prevent process exit.
    this.reconnectTimer.unref();
  }

  private handleDisconnect(): void {
    this.registered = false;
    this.socket = null;
    if (!this.stopping) {
      this.scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // IRC protocol parsing
  // ---------------------------------------------------------------------------

  private handleData(data: string): void {
    this.buffer += data;

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 2);
      if (line.length > 0) {
        this.parseLine(line);
      }
    }
  }

  private parseLine(line: string): void {
    // IRC message format: [:prefix] command params... [:trailing]

    let prefix = '';
    let rest = line;

    if (rest.startsWith(':')) {
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) return;
      prefix = rest.slice(1, spaceIdx);
      rest = rest.slice(spaceIdx + 1);
    }

    const parts = rest.split(' ');
    const command = parts[0]!;

    // Handle PING immediately.
    if (command === 'PING') {
      const server = parts.slice(1).join(' ');
      this.rawSend(`PONG ${server}`);
      return;
    }

    // Handle numeric 001 (RPL_WELCOME) — registration complete.
    if (command === '001') {
      this.registered = true;
      // Join configured channels.
      const channels = this.config?.channels ?? [];
      for (const ch of channels) {
        this.rawSend(`JOIN ${ch}`);
      }
      return;
    }

    // Handle PRIVMSG — inbound messages.
    if (command === 'PRIVMSG' && parts.length >= 2) {
      const target = parts[1]!;
      // Extract trailing text after the " :" in the original rest.
      const msgStart = rest.indexOf(' :');
      if (msgStart === -1) return;
      const text = rest.slice(msgStart + 2);

      // Extract nick from prefix (nick!user@host).
      const nick = prefix.split('!')[0] ?? '';

      // Access control.
      if (this.config?.allowedUsers?.length) {
        if (!this.config.allowedUsers.includes(nick)) return;
      }

      if (!this.messageHandler) return;

      // Determine if this is a channel message or DM.
      const isChannel = target.startsWith('#') || target.startsWith('&');

      const inbound: InboundMessage = {
        id: `irc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channelId: isChannel ? target : nick,
        from: {
          channelId: isChannel ? target : nick,
          userId: nick,
          groupId: isChannel ? target : undefined,
        },
        text,
        timestamp: new Date(),
        raw: { prefix, command, target, text },
      };

      this.messageHandler(inbound);
    }
  }

  // ---------------------------------------------------------------------------
  // Raw socket I/O
  // ---------------------------------------------------------------------------

  private rawSend(line: string): void {
    if (!this.socket || this.socket.destroyed) return;
    // Truncate to max IRC line length (minus 2 for CRLF).
    const truncated = line.length > MAX_IRC_LINE - 2
      ? line.slice(0, MAX_IRC_LINE - 2)
      : line;
    this.socket.write(`${truncated}\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a message into chunks that fit within the IRC line limit. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}
