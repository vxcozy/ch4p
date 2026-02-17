/**
 * GatewayServer — lightweight HTTP control plane with WebSocket support.
 *
 * Exposes a REST API for health checks, pairing, session management,
 * and session steering. Optionally upgrades connections to WebSocket
 * for real-time canvas communication.
 *
 * Routes:
 *   GET    /health                - liveness probe (no auth required)
 *   GET    /.well-known/agent.json - ERC-8004 service discovery (no auth)
 *   POST   /pair                  - exchange pairing code for token
 *   GET    /sessions              - list active sessions
 *   POST   /sessions              - create a new session
 *   GET    /sessions/:id          - get a single session
 *   POST   /sessions/:id/steer    - steer (inject message into) a session
 *   DELETE /sessions/:id          - end a session
 *   POST   /webhooks/:name        - receive a webhook trigger (auth required)
 *   WS     /ws/:sessionId         - WebSocket upgrade for canvas sessions
 *   GET    /*                     - static file serving (when staticDir configured)
 *
 * When pairing is enabled, all routes except /health and /pair require
 * a valid bearer token in the Authorization header.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { SessionConfig } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import type { SessionManager } from './session-manager.js';
import type { PairingManager } from './pairing.js';
import type { CanvasSessionManager } from './canvas-session.js';
import { WebSocketBridge } from './ws-bridge.js';
import { serveStatic } from './static.js';

export interface GatewayServerOptions {
  port: number;
  host?: string;
  sessionManager: SessionManager;
  /** When provided, bearer token auth is enforced on protected routes. */
  pairingManager?: PairingManager;
  /** Default session config merged into newly created sessions. */
  defaultSessionConfig?: Omit<SessionConfig, 'sessionId' | 'channelId' | 'userId'>;
  /** When provided, enables WebSocket canvas sessions. */
  canvasSessionManager?: CanvasSessionManager;
  /** Directory to serve static files from (built web UI). */
  staticDir?: string;
  /** Called when a new WebSocket bridge is established. */
  onCanvasConnection?: (sessionId: string, bridge: WebSocketBridge) => void;
  /** Agent registration file served at GET /.well-known/agent.json (ERC-8004 service discovery). */
  agentRegistration?: Record<string, unknown>;
  /** Called when a webhook message is received at POST /webhooks/:name. */
  onWebhook?: (name: string, payload: { message: string; userId?: string }) => void;
}

export class GatewayServer {
  private server: Server | null = null;
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly sessionManager: SessionManager;
  private readonly pairingManager: PairingManager | null;
  private readonly defaultSessionConfig: Omit<SessionConfig, 'sessionId' | 'channelId' | 'userId'>;
  private readonly canvasSessionManager: CanvasSessionManager | null;
  private readonly staticDir: string | null;
  private readonly onCanvasConnection: ((sessionId: string, bridge: WebSocketBridge) => void) | null;
  private readonly agentRegistration: Record<string, unknown> | null;
  private readonly onWebhook: GatewayServerOptions['onWebhook'] | null;

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
    this.canvasSessionManager = options.canvasSessionManager ?? null;
    this.staticDir = options.staticDir ?? null;
    this.onCanvasConnection = options.onCanvasConnection ?? null;
    this.agentRegistration = options.agentRegistration ?? null;
    this.onWebhook = options.onWebhook ?? null;
  }

  /** Start listening on the configured port. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal server error' });
        });
      });

      // Set up WebSocket server for canvas connections (noServer mode)
      if (this.canvasSessionManager) {
        this.wss = new WebSocketServer({ noServer: true });

        this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          this.handleUpgrade(req, socket, head);
        });
      }

      this.server.on('error', reject);

      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  /** Gracefully close the server. */
  async stop(): Promise<void> {
    // Close all WebSocket connections
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

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
  // WebSocket upgrade handling
  // ---------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss || !this.canvasSessionManager) {
      socket.destroy();
      return;
    }

    const url = req.url ?? '';
    const wsMatch = url.match(/^\/ws\/([^?]+)/);
    if (!wsMatch) {
      socket.destroy();
      return;
    }

    const sessionId = wsMatch[1]!;

    // Auth check: if pairing is enabled, validate token from query param
    if (this.pairingManager) {
      const urlObj = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
      const token = urlObj.searchParams.get('token');
      if (!token || !this.pairingManager.validateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // Ensure the canvas session exists (create if needed)
    if (!this.canvasSessionManager.hasSession(sessionId)) {
      this.canvasSessionManager.createCanvasSession(sessionId);
    }

    const entry = this.canvasSessionManager.getSession(sessionId);
    if (!entry) {
      socket.destroy();
      return;
    }

    // Upgrade the HTTP connection to WebSocket
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = new WebSocketBridge(ws, entry.canvasState, entry.canvasChannel, sessionId);

      // Wire the channel's sendToClient function
      entry.canvasChannel.setSendFunction((msg) => {
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(JSON.stringify(msg));
        }
      });

      this.canvasSessionManager!.setBridge(sessionId, bridge);
      bridge.start();

      // Notify the gateway command so it can wire agent events
      this.onCanvasConnection?.(sessionId, bridge);

      this.wss!.emit('connection', ws, req);
    });
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
        canvas: this.canvasSessionManager?.listSessionIds().length ?? 0,
        ...(stats ? { pairing: stats } : {}),
      });
      return;
    }

    // GET /.well-known/agent.json — ERC-8004 service discovery (no auth)
    if (method === 'GET' && url === '/.well-known/agent.json') {
      if (!this.agentRegistration) {
        this.sendJson(res, 404, { error: 'No agent registration configured.' });
        return;
      }
      this.sendJson(res, 200, this.agentRegistration);
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
        // Also clean up canvas session if it exists
        this.canvasSessionManager?.endCanvasSession(sessionId);
        this.sendJson(res, 200, { sessionId, ended: true });
        return;
      }
    }

    // POST /webhooks/:name — receive a webhook trigger
    const webhookMatch = url.match(/^\/webhooks\/([a-zA-Z0-9_-]+)$/);
    if (method === 'POST' && webhookMatch) {
      const webhookName = webhookMatch[1]!;

      if (!this.onWebhook) {
        this.sendJson(res, 404, { error: 'Webhooks are not enabled on this gateway.' });
        return;
      }

      const body = await this.readBody(req);
      let payload: { message?: string; userId?: string } = {};
      try {
        payload = JSON.parse(body) as { message?: string; userId?: string };
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body.' });
        return;
      }

      if (!payload.message) {
        this.sendJson(res, 400, { error: 'Missing "message" in request body.' });
        return;
      }

      try {
        this.onWebhook(webhookName, { message: payload.message, userId: payload.userId });
        this.sendJson(res, 200, { webhook: webhookName, accepted: true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: `Webhook handler failed: ${errMsg}` });
      }
      return;
    }

    // ----- Static file serving (when configured) -----
    if (this.staticDir && serveStatic(req, res, this.staticDir)) {
      return;
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
