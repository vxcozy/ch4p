/**
 * GatewayServer — lightweight HTTP control plane.
 *
 * Exposes a REST API for health checks, pairing, session management,
 * and session steering. Uses the Node.js built-in `http` module with
 * zero external dependencies.
 *
 * Routes:
 *   GET    /health                - liveness probe (no auth required)
 *   POST   /pair                  - exchange pairing code for token
 *   GET    /sessions              - list active sessions
 *   POST   /sessions              - create a new session
 *   GET    /sessions/:id          - get a single session
 *   POST   /sessions/:id/steer    - steer (inject message into) a session
 *   DELETE /sessions/:id          - end a session
 *
 * When pairing is enabled, all routes except /health and /pair require
 * a valid bearer token in the Authorization header.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionConfig } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import type { SessionManager } from './session-manager.js';
import type { PairingManager } from './pairing.js';

export interface GatewayServerOptions {
  port: number;
  host?: string;
  sessionManager: SessionManager;
  /** When provided, bearer token auth is enforced on protected routes. */
  pairingManager?: PairingManager;
  /** Default session config merged into newly created sessions. */
  defaultSessionConfig?: Omit<SessionConfig, 'sessionId' | 'channelId' | 'userId'>;
}

export class GatewayServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly sessionManager: SessionManager;
  private readonly pairingManager: PairingManager | null;
  private readonly defaultSessionConfig: Omit<SessionConfig, 'sessionId' | 'channelId' | 'userId'>;

  constructor(options: GatewayServerOptions) {
    this.port = options.port;
    this.host = options.host ?? '127.0.0.1';
    this.sessionManager = options.sessionManager;
    this.pairingManager = options.pairingManager ?? null;
    this.defaultSessionConfig = options.defaultSessionConfig ?? {
      engineId: 'native',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
    };
  }

  /** Start listening on the configured port. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal server error' });
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  /** Gracefully close the server. */
  async stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Get the bound address (useful in tests with port 0). */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (typeof addr === 'string' || addr === null) return null;
    return { host: addr.address, port: addr.port };
  }

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // CORS headers for browser clients.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ----- Public routes (no auth) -----

    // GET /health
    if (method === 'GET' && url === '/health') {
      const stats = this.pairingManager?.stats();
      this.sendJson(res, 200, {
        status: 'ok',
        timestamp: new Date().toISOString(),
        sessions: this.sessionManager.listSessions().length,
        ...(stats ? { pairing: stats } : {}),
      });
      return;
    }

    // POST /pair
    if (method === 'POST' && url === '/pair') {
      if (!this.pairingManager) {
        this.sendJson(res, 400, { error: 'Pairing is not enabled on this gateway.' });
        return;
      }

      const body = await this.readBody(req);
      let payload: { code?: string; label?: string } = {};
      try {
        payload = JSON.parse(body) as { code?: string; label?: string };
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body.' });
        return;
      }

      if (!payload.code) {
        this.sendJson(res, 400, { error: 'Missing "code" in request body.' });
        return;
      }

      const token = this.pairingManager.exchangeCode(payload.code, payload.label);
      if (!token) {
        this.sendJson(res, 401, { error: 'Invalid or expired pairing code.' });
        return;
      }

      this.sendJson(res, 200, { token, paired: true });
      return;
    }

    // ----- Protected routes (require auth if pairing is enabled) -----

    if (this.pairingManager && !this.checkAuth(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized. Provide a valid bearer token.' });
      return;
    }

    // GET /sessions
    if (method === 'GET' && url === '/sessions') {
      const sessions = this.sessionManager.listSessions().map((s) => ({
        sessionId: s.config.sessionId,
        channelId: s.config.channelId,
        userId: s.config.userId,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
      }));
      this.sendJson(res, 200, { sessions });
      return;
    }

    // POST /sessions — create a new session
    if (method === 'POST' && url === '/sessions') {
      const body = await this.readBody(req);
      let payload: { channelId?: string; userId?: string; systemPrompt?: string } = {};
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body.' });
        return;
      }

      const sessionId = generateId(16);
      const config: SessionConfig = {
        ...this.defaultSessionConfig,
        sessionId,
        channelId: payload.channelId,
        userId: payload.userId,
        systemPrompt: payload.systemPrompt ?? this.defaultSessionConfig.systemPrompt,
      };

      const session = this.sessionManager.createSession(config);
      this.sendJson(res, 201, {
        sessionId: session.config.sessionId,
        channelId: session.config.channelId,
        userId: session.config.userId,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
      });
      return;
    }

    // Match /sessions/:id routes
    const sessionMatch = url.match(/^\/sessions\/([^/]+)(\/steer)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const isSteer = sessionMatch[2] === '/steer';

      // GET /sessions/:id
      if (method === 'GET' && !isSteer) {
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        this.sendJson(res, 200, {
          sessionId: session.config.sessionId,
          channelId: session.config.channelId,
          userId: session.config.userId,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          lastActiveAt: session.lastActiveAt.toISOString(),
        });
        return;
      }

      // POST /sessions/:id/steer
      if (method === 'POST' && isSteer) {
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        const body = await this.readBody(req);
        let payload: { message?: string };
        try {
          payload = JSON.parse(body) as { message?: string };
        } catch {
          this.sendJson(res, 400, { error: 'Invalid JSON body.' });
          return;
        }

        if (!payload.message) {
          this.sendJson(res, 400, { error: 'Missing "message" in request body' });
          return;
        }

        this.sessionManager.touchSession(sessionId);
        this.sendJson(res, 200, {
          sessionId,
          steered: true,
          message: payload.message,
        });
        return;
      }

      // DELETE /sessions/:id
      if (method === 'DELETE' && !isSteer) {
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        this.sessionManager.endSession(sessionId);
        this.sendJson(res, 200, { sessionId, ended: true });
        return;
      }
    }

    // Fallback: 404
    this.sendJson(res, 404, { error: 'Not found' });
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.pairingManager) return true;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

    const token = authHeader.slice(7);
    return this.pairingManager.validateToken(token);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
