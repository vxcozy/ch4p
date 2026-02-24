/**
 * SignalChannel -- Signal Messenger channel adapter via signal-cli TCP JSON-RPC.
 *
 * Implements the IChannel interface for Signal using a TCP socket connection
 * to a running signal-cli daemon in JSON-RPC mode.
 *
 * Configuration (via ChannelConfig):
 *   host              -- TCP host for signal-cli daemon (default: "localhost")
 *   port              -- TCP port for signal-cli daemon (default: 7583)
 *   account           -- Registered phone number, e.g. "+1234567890" (required)
 *   allowedNumbers    -- Array of phone numbers to accept messages from (empty = allow all)
 *   reconnectInterval -- Reconnect delay in ms (default: 5000)
 *
 * Uses Node.js built-in `net.Socket` -- zero external dependencies.
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
import { Socket } from 'node:net';
import { evictOldTimestamps } from './message-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalConfig extends ChannelConfig {
  host?: string;
  port?: number;
  account: string;
  allowedNumbers?: string[];
  reconnectInterval?: number;
}

/** JSON-RPC 2.0 request shape. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** JSON-RPC 2.0 response shape (success or error). */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification shape (no id field). */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

/** Pending request tracker for correlating JSON-RPC responses. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** signal-cli envelope shape inside receive notifications. */
interface SignalEnvelope {
  sourceNumber?: string;
  sourceName?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    attachments?: Array<{
      contentType?: string;
      filename?: string;
      id?: string;
      size?: number;
    }>;
    groupInfo?: {
      groupId?: string;
    };
    quote?: {
      id?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// SignalChannel
// ---------------------------------------------------------------------------

export class SignalChannel implements IChannel {
  readonly id = 'signal';
  readonly name = 'Signal';

  private account = '';
  private host = 'localhost';
  private port = 7583;
  private reconnectInterval = 5000;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private socket: Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private allowedNumbers: Set<string> = new Set();
  private buffer = '';
  private nextRequestId = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private lastEditTimestamps = new Map<string, number>();
  private static readonly EDIT_TS_MAX_ENTRIES = 500;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as SignalConfig;
    if (!cfg.account) {
      throw new Error('Signal channel requires an "account" (phone number) in config');
    }

    this.account = cfg.account;
    this.host = cfg.host ?? 'localhost';
    this.port = cfg.port ?? 7583;
    this.reconnectInterval = cfg.reconnectInterval ?? 5000;
    this.allowedNumbers = new Set(cfg.allowedNumbers ?? []);

    // Connect to signal-cli daemon and verify.
    await this.connect();
    this.running = true;

    // Verify connection by requesting the account's contacts list.
    try {
      await this.rpcCall('listContacts', { account: this.account });
    } catch {
      // Non-fatal: some signal-cli versions may not support listContacts.
      // The TCP connection itself is sufficient proof of connectivity.
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests.
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Channel stopped'));
      this.pendingRequests.delete(id);
    }

    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Ignore close errors.
      }
      this.socket = null;
    }

    this.buffer = '';
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    const recipient = to.userId ?? to.groupId;
    if (!recipient) {
      return { success: false, error: 'Recipient must have userId (phone number) or groupId' };
    }

    try {
      const params: Record<string, unknown> = {
        account: this.account,
        message: message.text,
      };

      // Signal distinguishes between direct recipients and group targets.
      if (to.groupId) {
        params.groupId = to.groupId;
      } else {
        params.recipient = [to.userId];
      }

      if (message.replyTo) {
        params.quoteTimestamp = Number(message.replyTo);
      }

      const result = await this.rpcCall('send', params);
      const resultObj = result as { timestamp?: number } | undefined;

      return {
        success: true,
        messageId: resultObj?.timestamp ? String(resultObj.timestamp) : generateId(),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }


  /** Edit a previously sent message via signal-cli editMessage RPC. */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const recipient = to.userId ?? to.groupId;
    if (!recipient) {
      return { success: false, error: 'Recipient must have userId or groupId' };
    }
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    const SIGNAL_EDIT_RATE_LIMIT_MS = 1_000;
    if (lastEdit && now - lastEdit < SIGNAL_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId };
    }
    try {
      const params: Record<string, unknown> = {
        account: this.account,
        targetTimestamp: Number(messageId),
        message: message.text,
      };
      if (to.groupId) {
        params.groupId = to.groupId;
      } else {
        params.recipient = [to.userId];
      }
      await this.rpcCall('editMessage', params);
      this.lastEditTimestamps.set(messageId, now);
      evictOldTimestamps(this.lastEditTimestamps, SignalChannel.EDIT_TS_MAX_ENTRIES);
      return { success: true, messageId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // Signal does not expose real-time typing indicators via JSON-RPC.
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    if (!this.socket || this.socket.destroyed) return false;
    try {
      await this.rpcCall('listContacts', { account: this.account });
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // TCP connection management
  // -----------------------------------------------------------------------

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buffer = '';
      this.socket = new Socket();

      let connected = false;

      this.socket.on('connect', () => {
        connected = true;
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });

      this.socket.on('error', (err: Error) => {
        if (!connected) {
          reject(new Error(`Failed to connect to signal-cli at ${this.host}:${this.port}: ${err.message}`));
        }
        // Errors while running trigger reconnect via the close handler.
      });

      this.socket.on('close', () => {
        this.socket = null;

        // Reject all pending requests on disconnect.
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Socket closed'));
          this.pendingRequests.delete(id);
        }

        if (this.running) {
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.port, this.host);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.running) return;

      try {
        await this.connect();
      } catch {
        // Retry on failure.
        if (this.running) {
          this.scheduleReconnect();
        }
      }
    }, this.reconnectInterval);
  }

  // -----------------------------------------------------------------------
  // Line-delimited JSON-RPC handling
  // -----------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ('id' in parsed && typeof parsed.id === 'number') {
          // This is a JSON-RPC response to one of our requests.
          this.handleResponse(parsed as unknown as JsonRpcResponse);
        } else if ('method' in parsed) {
          // This is a JSON-RPC notification from signal-cli.
          this.handleNotification(parsed as unknown as JsonRpcNotification);
        }
      } catch {
        // Ignore malformed JSON lines.
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(
        `JSON-RPC error ${response.error.code}: ${response.error.message}`,
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'receive') {
      this.processReceiveNotification(notification.params);
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private processReceiveNotification(params: Record<string, unknown>): void {
    if (!this.messageHandler) return;

    const envelope = params.envelope as SignalEnvelope | undefined;
    if (!envelope) return;

    const sourceNumber = envelope.sourceNumber;
    if (!sourceNumber) return;

    // Enforce allowed numbers if configured.
    if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(sourceNumber)) {
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const text = dataMessage.message ?? '';
    if (!text && (!dataMessage.attachments || dataMessage.attachments.length === 0)) {
      return;
    }

    // Process attachments.
    const attachments: Attachment[] = [];
    if (dataMessage.attachments) {
      for (const att of dataMessage.attachments) {
        attachments.push({
          type: this.classifyAttachment(att.contentType ?? ''),
          url: att.id,
          filename: att.filename,
          mimeType: att.contentType,
        });
      }
    }

    const timestamp = dataMessage.timestamp ?? envelope.timestamp ?? Date.now();

    const inbound: InboundMessage = {
      id: String(timestamp),
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: sourceNumber,
        groupId: dataMessage.groupInfo?.groupId,
      },
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: dataMessage.quote?.id ? String(dataMessage.quote.id) : undefined,
      timestamp: new Date(timestamp),
      raw: params,
    };

    this.messageHandler(inbound);
  }

  // -----------------------------------------------------------------------
  // JSON-RPC helpers
  // -----------------------------------------------------------------------

  private rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to signal-cli daemon'));
        return;
      }

      const id = this.nextRequestId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify(request) + '\n';
      this.socket.write(payload, 'utf-8', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to signal-cli socket: ${err.message}`));
        }
      });
    });
  }

  private classifyAttachment(contentType: string): Attachment['type'] {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.startsWith('video/')) return 'video';
    return 'file';
  }
}
