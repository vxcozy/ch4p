/**
 * MinimalMatrixClient — lightweight Matrix client-server API wrapper.
 *
 * Replaces `matrix-bot-sdk` to eliminate its transitive dependency on the
 * deprecated `request` package (and its vulnerable sub-deps: form-data, qs,
 * tough-cookie).
 *
 * Uses only native `fetch()` — zero third-party dependencies.
 *
 * Implements the subset of the Matrix client-server API that ch4p needs:
 *   - /account/whoami      — resolve bot user ID
 *   - /sync                — long-poll event loop
 *   - /rooms/:id/send      — send room events
 *   - /join/:id            — join rooms on invite
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Timeline event from the sync response. */
export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  room_id: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

/** Minimal shape of the /sync response we actually consume. */
interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEvent[] };
      ephemeral?: { events?: MatrixEvent[] };
    }>;
    invite?: Record<string, {
      invite_state?: { events?: MatrixEvent[] };
    }>;
  };
}

// ---------------------------------------------------------------------------
// MinimalMatrixClient
// ---------------------------------------------------------------------------

export class MinimalMatrixClient extends EventEmitter {
  private nextBatch: string | null = null;
  private abortController: AbortController | null = null;
  private running = false;
  private txnCounter = 0;

  constructor(
    private readonly homeserverUrl: string,
    private readonly accessToken: string,
  ) {
    super();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Resolve the authenticated user's Matrix user ID. */
  async getUserId(): Promise<string> {
    const res = await this.api('GET', '/_matrix/client/v3/account/whoami');
    return res.user_id as string;
  }

  /** Start the long-poll sync loop. Resolves after the first sync completes. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    // Perform the initial sync (non-blocking timeout so we catch up quickly).
    await this.sync(0);

    // Start the long-poll loop in the background.
    void this.syncLoop().catch((err) => {
      this.emit('error', err);
    });
  }

  /** Stop the sync loop. */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.removeAllListeners();
  }

  /** Send a room event. Returns the event ID. */
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<string> {
    const txnId = `ch4p_${Date.now()}_${this.txnCounter++}`;
    const encoded = encodeURIComponent(roomId);
    const res = await this.api(
      'PUT',
      `/_matrix/client/v3/rooms/${encoded}/send/m.room.message/${txnId}`,
      content,
    );
    return res.event_id as string;
  }

  /** Edit a previously sent message using the m.replace relation. */
  async editMessage(roomId: string, eventId: string, content: Record<string, unknown>): Promise<string> {
    const newContent = {
      ...content,
      'm.new_content': { ...content },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: eventId,
      },
    };
    const txnId = `ch4p_edit_${Date.now()}_${this.txnCounter++}`;
    const encoded = encodeURIComponent(roomId);
    const res = await this.api(
      'PUT',
      `/_matrix/client/v3/rooms/${encoded}/send/m.room.message/${txnId}`,
      newContent,
    );
    return res.event_id as string;
  }

  /** Join a room by ID or alias. */
  async joinRoom(roomId: string): Promise<void> {
    const encoded = encodeURIComponent(roomId);
    await this.api('POST', `/_matrix/client/v3/join/${encoded}`);
  }

  // -----------------------------------------------------------------------
  // Sync loop
  // -----------------------------------------------------------------------

  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.sync(30_000);
      } catch (err) {
        if (!this.running) return; // Expected abort.
        // Backoff on transient errors and retry.
        this.emit('error', err);
        await this.sleep(5_000);
      }
    }
  }

  private async sync(timeoutMs: number): Promise<void> {
    const params = new URLSearchParams({ timeout: String(timeoutMs) });
    if (this.nextBatch) {
      params.set('since', this.nextBatch);
    }
    // We only care about room timeline & ephemeral events.
    params.set('filter', JSON.stringify({
      presence: { types: [] },       // Ignore global presence.
      account_data: { types: [] },   // Ignore account data.
      room: {
        state: { lazy_load_members: true },
        timeline: { limit: 50 },
      },
    }));

    const data = await this.api(
      'GET',
      `/_matrix/client/v3/sync?${params.toString()}`,
    ) as SyncResponse;

    this.nextBatch = data.next_batch;

    // Process invited rooms — auto-join.
    if (data.rooms?.invite) {
      for (const roomId of Object.keys(data.rooms.invite)) {
        this.emit('room.invite', roomId);
      }
    }

    // Process joined rooms — timeline events + ephemeral (typing).
    if (data.rooms?.join) {
      for (const [roomId, room] of Object.entries(data.rooms.join)) {
        for (const event of room.timeline?.events ?? []) {
          event.room_id = roomId;
          if (event.type === 'm.room.message') {
            this.emit('room.message', roomId, event);
          }
          this.emit('room.event', roomId, event);
        }
        for (const event of room.ephemeral?.events ?? []) {
          event.room_id = roomId;
          this.emit('room.event', roomId, event);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // HTTP helpers
  // -----------------------------------------------------------------------

  private async api(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.homeserverUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };

    const init: RequestInit = {
      method,
      headers,
      signal: this.abortController?.signal,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Matrix API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
