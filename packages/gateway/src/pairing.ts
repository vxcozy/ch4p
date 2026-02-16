/**
 * PairingManager — one-time pairing code authentication for the gateway.
 *
 * Security mechanism ensuring only authorized clients can connect.
 * Based on the one-time pairing code pattern:
 *
 *   1. Server generates a short-lived pairing code (6 chars, alphanumeric).
 *   2. User shares the code with a client (QR, copy-paste, etc.).
 *   3. Client sends the code in an HTTP header or query param.
 *   4. Server validates and exchanges it for a long-lived session token.
 *   5. The code is consumed (one-time use). The token persists.
 *
 * Tokens are opaque hex strings, stored in-memory. A future version
 * could persist to disk for gateway restarts.
 */

import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairingCode {
  code: string;
  createdAt: Date;
  expiresAt: Date;
  label?: string;
}

export interface PairedClient {
  token: string;
  /** SHA-256 hash of the token for comparison without storing raw token. */
  tokenHash: string;
  pairedAt: Date;
  lastSeenAt: Date;
  /** When this token expires. Expired tokens are rejected and evicted. */
  expiresAt: Date;
  label?: string;
}

export interface PairingManagerOpts {
  /** Code lifetime in milliseconds. Default: 5 minutes. */
  codeTtlMs?: number;
  /** Token lifetime in milliseconds. Default: 30 days. */
  tokenTtlMs?: number;
  /** Maximum number of active pairing codes. Default: 5. */
  maxActiveCodes?: number;
  /** Maximum number of paired clients. Default: 20. */
  maxPairedClients?: number;
}

// ---------------------------------------------------------------------------
// PairingManager
// ---------------------------------------------------------------------------

export class PairingManager {
  private readonly codes = new Map<string, PairingCode>();
  private readonly clients = new Map<string, PairedClient>();
  private readonly codeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxActiveCodes: number;
  private readonly maxPairedClients: number;

  constructor(opts: PairingManagerOpts = {}) {
    this.codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.tokenTtlMs = opts.tokenTtlMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.maxActiveCodes = opts.maxActiveCodes ?? 5;
    this.maxPairedClients = opts.maxPairedClients ?? 20;
  }

  // -----------------------------------------------------------------------
  // Code generation
  // -----------------------------------------------------------------------

  /**
   * Generate a new pairing code.
   * Returns the code object. The code string is what gets shared.
   */
  generateCode(label?: string): PairingCode {
    // Expire old codes first.
    this.pruneExpiredCodes();

    if (this.codes.size >= this.maxActiveCodes) {
      throw new Error(
        `Maximum active pairing codes (${this.maxActiveCodes}) reached. ` +
        'Revoke existing codes or wait for them to expire.',
      );
    }

    const code = this.createRandomCode();
    const now = new Date();

    const pairingCode: PairingCode = {
      code,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.codeTtlMs),
      label,
    };

    this.codes.set(code, pairingCode);
    return pairingCode;
  }

  /**
   * List all active (non-expired) pairing codes.
   */
  listCodes(): PairingCode[] {
    this.pruneExpiredCodes();
    return [...this.codes.values()];
  }

  /**
   * Revoke a specific pairing code.
   */
  revokeCode(code: string): boolean {
    return this.codes.delete(code);
  }

  // -----------------------------------------------------------------------
  // Code exchange → token
  // -----------------------------------------------------------------------

  /**
   * Exchange a pairing code for a session token.
   *
   * Returns the token string on success, or null if the code is invalid
   * or expired. The code is consumed (deleted) after successful exchange.
   */
  exchangeCode(code: string, label?: string): string | null {
    this.pruneExpiredCodes();

    const pairingCode = this.codes.get(code);
    if (!pairingCode) return null;

    // Check expiration.
    if (new Date() > pairingCode.expiresAt) {
      this.codes.delete(code);
      return null;
    }

    // Consume the code.
    this.codes.delete(code);

    // Enforce max paired clients.
    if (this.clients.size >= this.maxPairedClients) {
      // Evict the oldest (least recently seen) client.
      this.evictOldestClient();
    }

    // Generate a session token.
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const now = new Date();

    this.clients.set(tokenHash, {
      token,
      tokenHash,
      pairedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.tokenTtlMs),
      label: label ?? pairingCode.label,
    });

    return token;
  }

  // -----------------------------------------------------------------------
  // Token validation
  // -----------------------------------------------------------------------

  /**
   * Validate a bearer token.
   * Returns true if the token belongs to a paired client and has not expired.
   * Updates `lastSeenAt` on successful validation.
   * Expired tokens are evicted on discovery.
   */
  validateToken(token: string): boolean {
    const tokenHash = this.hashToken(token);
    const client = this.clients.get(tokenHash);
    if (!client) return false;

    // Check token expiration.
    if (new Date() > client.expiresAt) {
      this.clients.delete(tokenHash);
      return false;
    }

    client.lastSeenAt = new Date();
    return true;
  }

  /**
   * List all paired clients (tokens are masked).
   */
  listClients(): Array<Omit<PairedClient, 'token'> & { tokenPreview: string }> {
    this.pruneExpiredTokens();
    return [...this.clients.values()].map((c) => ({
      tokenHash: c.tokenHash,
      tokenPreview: c.token.slice(0, 8) + '...',
      pairedAt: c.pairedAt,
      lastSeenAt: c.lastSeenAt,
      expiresAt: c.expiresAt,
      label: c.label,
    }));
  }

  /**
   * Revoke a paired client by token hash.
   */
  revokeClient(tokenHash: string): boolean {
    return this.clients.delete(tokenHash);
  }

  /**
   * Get the number of active codes and paired clients.
   */
  stats(): { activeCodes: number; pairedClients: number } {
    this.pruneExpiredCodes();
    this.pruneExpiredTokens();
    return {
      activeCodes: this.codes.size,
      pairedClients: this.clients.size,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private createRandomCode(): string {
    // 6-character uppercase alphanumeric code (avoids confusing chars).
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    const bytes = randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i]! % chars.length];
    }
    return code;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private pruneExpiredCodes(): void {
    const now = new Date();
    for (const [code, pc] of this.codes) {
      if (now > pc.expiresAt) {
        this.codes.delete(code);
      }
    }
  }

  private pruneExpiredTokens(): void {
    const now = new Date();
    for (const [hash, client] of this.clients) {
      if (now > client.expiresAt) {
        this.clients.delete(hash);
      }
    }
  }

  private evictOldestClient(): void {
    let oldest: { hash: string; time: number } | null = null;
    for (const [hash, client] of this.clients) {
      const time = client.lastSeenAt.getTime();
      if (!oldest || time < oldest.time) {
        oldest = { hash, time };
      }
    }
    if (oldest) {
      this.clients.delete(oldest.hash);
    }
  }
}
