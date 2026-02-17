/**
 * Gateway package tests — SessionManager, MessageRouter, PairingManager, GatewayServer.
 *
 * The server tests spin up real HTTP servers on ephemeral ports (port 0)
 * and exercise the full request/response cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SessionConfig, InboundMessage } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { SessionManager } from './session-manager.js';
import { MessageRouter } from './router.js';
import { PairingManager } from './pairing.js';
import { GatewayServer } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    sessionId: generateId(16),
    engineId: 'native',
    model: 'test-model',
    provider: 'test',
    ...overrides,
  };
}

function makeInboundMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: generateId(),
    channelId: 'telegram',
    from: { userId: 'user-123', name: 'Alice' },
    text: 'Hello',
    timestamp: new Date(),
    ...overrides,
  };
}

async function fetchJson(
  base: string,
  path: string,
  opts?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers as Record<string, string> },
    ...opts,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ===========================================================================
// SessionManager
// ===========================================================================

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('should create a session', () => {
    const config = makeSessionConfig();
    const state = manager.createSession(config);

    expect(state.config.sessionId).toBe(config.sessionId);
    expect(state.status).toBe('active');
    expect(state.createdAt).toBeInstanceOf(Date);
    expect(state.lastActiveAt).toBeInstanceOf(Date);
  });

  it('should get a session by id', () => {
    const config = makeSessionConfig();
    manager.createSession(config);

    const found = manager.getSession(config.sessionId);
    expect(found).toBeDefined();
    expect(found!.config.sessionId).toBe(config.sessionId);
  });

  it('should return undefined for unknown session', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined();
  });

  it('should list all sessions', () => {
    manager.createSession(makeSessionConfig());
    manager.createSession(makeSessionConfig());
    manager.createSession(makeSessionConfig());

    expect(manager.listSessions()).toHaveLength(3);
  });

  it('should end a session and remove it from the map', () => {
    const config = makeSessionConfig();
    manager.createSession(config);

    manager.endSession(config.sessionId);

    expect(manager.getSession(config.sessionId)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('should handle ending a nonexistent session gracefully', () => {
    expect(() => manager.endSession('ghost')).not.toThrow();
  });

  it('should touch a session to update lastActiveAt', async () => {
    const config = makeSessionConfig();
    const state = manager.createSession(config);
    const originalTime = state.lastActiveAt.getTime();

    // Small delay to ensure time difference.
    await new Promise((r) => setTimeout(r, 5));

    manager.touchSession(config.sessionId);
    const updated = manager.getSession(config.sessionId);
    expect(updated!.lastActiveAt.getTime()).toBeGreaterThanOrEqual(originalTime);
    expect(updated!.status).toBe('active');
  });

  it('should handle touching a nonexistent session gracefully', () => {
    expect(() => manager.touchSession('ghost')).not.toThrow();
  });
});

// ===========================================================================
// MessageRouter
// ===========================================================================

describe('MessageRouter', () => {
  let sessionManager: SessionManager;
  let router: MessageRouter;

  beforeEach(() => {
    sessionManager = new SessionManager();
    router = new MessageRouter(sessionManager, {
      engineId: 'native',
      model: 'test-model',
      provider: 'test',
    });
  });

  it('should create a session for a new channel+user pair', () => {
    const msg = makeInboundMessage();
    const result = router.route(msg);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBeDefined();
    expect(result!.config.channelId).toBe('telegram');
    expect(result!.config.userId).toBe('user-123');
  });

  it('should reuse existing session for same channel+user', () => {
    const msg = makeInboundMessage();
    const first = router.route(msg)!;
    const second = router.route(msg)!;

    expect(first.sessionId).toBe(second.sessionId);
  });

  it('should create separate sessions for different users', () => {
    const msg1 = makeInboundMessage({ from: { userId: 'alice', name: 'Alice' } });
    const msg2 = makeInboundMessage({ from: { userId: 'bob', name: 'Bob' } });

    const r1 = router.route(msg1)!;
    const r2 = router.route(msg2)!;

    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  it('should create separate sessions for different channels', () => {
    const msg1 = makeInboundMessage({ channelId: 'telegram' });
    const msg2 = makeInboundMessage({ channelId: 'discord' });

    const r1 = router.route(msg1)!;
    const r2 = router.route(msg2)!;

    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  it('should return null for messages without channelId', () => {
    const msg = makeInboundMessage({ channelId: '' });
    expect(router.route(msg)).toBeNull();
  });

  it('should clean up stale routes when session was ended externally', () => {
    const msg = makeInboundMessage();
    const first = router.route(msg)!;

    // End the session externally.
    sessionManager.endSession(first.sessionId);

    // Next route should create a new session.
    const second = router.route(msg)!;
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('should use anonymous as default userId', () => {
    const msg = makeInboundMessage({ from: { userId: undefined as unknown as string, name: 'Unknown' } });
    const result = router.route(msg);

    expect(result).not.toBeNull();
    expect(result!.config.userId).toBeUndefined();
  });
});

// ===========================================================================
// PairingManager
// ===========================================================================

describe('PairingManager', () => {
  let pairing: PairingManager;

  beforeEach(() => {
    pairing = new PairingManager({ codeTtlMs: 5000 }); // 5s TTL for tests
  });

  describe('code generation', () => {
    it('should generate a 6-character code', () => {
      const pc = pairing.generateCode();
      expect(pc.code).toHaveLength(6);
      expect(pc.code).toMatch(/^[A-Z0-9]+$/);
    });

    it('should set expiration based on TTL', () => {
      const pc = pairing.generateCode();
      const diff = pc.expiresAt.getTime() - pc.createdAt.getTime();
      expect(diff).toBe(5000);
    });

    it('should accept an optional label', () => {
      const pc = pairing.generateCode('My Phone');
      expect(pc.label).toBe('My Phone');
    });

    it('should list active codes', () => {
      pairing.generateCode('A');
      pairing.generateCode('B');

      const codes = pairing.listCodes();
      expect(codes).toHaveLength(2);
    });

    it('should enforce max active codes limit', () => {
      const pm = new PairingManager({ maxActiveCodes: 2 });
      pm.generateCode();
      pm.generateCode();

      expect(() => pm.generateCode()).toThrow('Maximum active pairing codes');
    });

    it('should revoke a code', () => {
      const pc = pairing.generateCode();
      expect(pairing.revokeCode(pc.code)).toBe(true);
      expect(pairing.listCodes()).toHaveLength(0);
    });

    it('should return false when revoking nonexistent code', () => {
      expect(pairing.revokeCode('NONEXIST')).toBe(false);
    });
  });

  describe('code exchange', () => {
    it('should exchange a valid code for a token', () => {
      const pc = pairing.generateCode();
      const token = pairing.exchangeCode(pc.code);

      expect(token).not.toBeNull();
      expect(token!.length).toBe(64); // 32 bytes hex
    });

    it('should consume the code on exchange (one-time use)', () => {
      const pc = pairing.generateCode();
      pairing.exchangeCode(pc.code);

      // Second attempt should fail.
      expect(pairing.exchangeCode(pc.code)).toBeNull();
    });

    it('should return null for invalid code', () => {
      expect(pairing.exchangeCode('BADCODE')).toBeNull();
    });

    it('should return null for expired code', async () => {
      const pm = new PairingManager({ codeTtlMs: 1 }); // 1ms TTL
      const pc = pm.generateCode();
      await new Promise((r) => setTimeout(r, 10));
      expect(pm.exchangeCode(pc.code)).toBeNull();
    });

    it('should pass label to the paired client', () => {
      const pc = pairing.generateCode('Server Label');
      pairing.exchangeCode(pc.code, 'Client Label');

      const clients = pairing.listClients();
      expect(clients).toHaveLength(1);
      expect(clients[0]!.label).toBe('Client Label');
    });
  });

  describe('token validation', () => {
    it('should validate a token from code exchange', () => {
      const pc = pairing.generateCode();
      const token = pairing.exchangeCode(pc.code)!;

      expect(pairing.validateToken(token)).toBe(true);
    });

    it('should reject an invalid token', () => {
      expect(pairing.validateToken('invalidtoken')).toBe(false);
    });

    it('should update lastSeenAt on validation', async () => {
      const pc = pairing.generateCode();
      const token = pairing.exchangeCode(pc.code)!;

      await new Promise((r) => setTimeout(r, 5));
      pairing.validateToken(token);

      const clients = pairing.listClients();
      expect(clients[0]!.lastSeenAt.getTime()).toBeGreaterThan(clients[0]!.pairedAt.getTime());
    });
  });

  describe('client management', () => {
    it('should list paired clients with masked tokens', () => {
      const pc = pairing.generateCode();
      pairing.exchangeCode(pc.code);

      const clients = pairing.listClients();
      expect(clients).toHaveLength(1);
      expect(clients[0]!.tokenPreview).toMatch(/^[a-f0-9]{8}\.\.\.$/);
    });

    it('should revoke a client by token hash', () => {
      const pc = pairing.generateCode();
      const token = pairing.exchangeCode(pc.code)!;

      const clients = pairing.listClients();
      expect(pairing.revokeClient(clients[0]!.tokenHash)).toBe(true);
      expect(pairing.validateToken(token)).toBe(false);
    });

    it('should evict oldest client when max is reached', () => {
      const pm = new PairingManager({ maxPairedClients: 2, codeTtlMs: 60000 });

      // Pair 3 clients (exceeding limit of 2).
      const c1 = pm.generateCode();
      pm.exchangeCode(c1.code, 'First');

      const c2 = pm.generateCode();
      pm.exchangeCode(c2.code, 'Second');

      const c3 = pm.generateCode();
      pm.exchangeCode(c3.code, 'Third');

      const clients = pm.listClients();
      expect(clients).toHaveLength(2);
      // First client should have been evicted.
      expect(clients.some((c) => c.label === 'First')).toBe(false);
    });

    it('should report stats', () => {
      pairing.generateCode();
      const pc = pairing.generateCode();
      pairing.exchangeCode(pc.code);

      const stats = pairing.stats();
      expect(stats.activeCodes).toBe(1); // one was exchanged
      expect(stats.pairedClients).toBe(1);
    });
  });
});

// ===========================================================================
// GatewayServer (HTTP integration tests)
// ===========================================================================

describe('GatewayServer', () => {
  let sessionManager: SessionManager;
  let server: GatewayServer;
  let baseUrl: string;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    server = new GatewayServer({
      port: 0, // ephemeral port
      host: '127.0.0.1',
      sessionManager,
    });
    await server.start();
    const addr = server.getAddress()!;
    baseUrl = `http://${addr.host}:${addr.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const { status, body } = await fetchJson(baseUrl, '/health');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.sessions).toBe(0);
    });

    it('should include tunnel URL when set', async () => {
      server.setTunnelUrl('https://test.trycloudflare.com');
      const { body } = await fetchJson(baseUrl, '/health');
      expect(body.tunnel).toBe('https://test.trycloudflare.com');
    });

    it('should omit tunnel field when not set', async () => {
      const { body } = await fetchJson(baseUrl, '/health');
      expect(body.tunnel).toBeUndefined();
    });
  });

  describe('GET /sessions', () => {
    it('should return empty array when no sessions', async () => {
      const { status, body } = await fetchJson(baseUrl, '/sessions');
      expect(status).toBe(200);
      expect(body.sessions).toEqual([]);
    });

    it('should list created sessions', async () => {
      sessionManager.createSession(makeSessionConfig({ channelId: 'test' }));

      const { status, body } = await fetchJson(baseUrl, '/sessions');
      expect(status).toBe(200);
      expect((body.sessions as unknown[]).length).toBe(1);
    });
  });

  describe('POST /sessions', () => {
    it('should create a new session', async () => {
      const { status, body } = await fetchJson(baseUrl, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'web', userId: 'u1' }),
      });

      expect(status).toBe(201);
      expect(body.sessionId).toBeDefined();
      expect(body.channelId).toBe('web');
      expect(body.userId).toBe('u1');
      expect(body.status).toBe('active');
    });

    it('should create a session with defaults when no body', async () => {
      const { status, body } = await fetchJson(baseUrl, '/sessions', {
        method: 'POST',
        body: '{}',
      });

      expect(status).toBe(201);
      expect(body.sessionId).toBeDefined();
    });
  });

  describe('GET /sessions/:id', () => {
    it('should return a specific session', async () => {
      const config = makeSessionConfig({ channelId: 'web' });
      sessionManager.createSession(config);

      const { status, body } = await fetchJson(baseUrl, `/sessions/${config.sessionId}`);
      expect(status).toBe(200);
      expect(body.sessionId).toBe(config.sessionId);
    });

    it('should return 404 for unknown session', async () => {
      const { status } = await fetchJson(baseUrl, '/sessions/nonexistent');
      expect(status).toBe(404);
    });
  });

  describe('POST /sessions/:id/steer', () => {
    it('should steer an existing session', async () => {
      const config = makeSessionConfig();
      sessionManager.createSession(config);

      const { status, body } = await fetchJson(baseUrl, `/sessions/${config.sessionId}/steer`, {
        method: 'POST',
        body: JSON.stringify({ message: 'Focus on tests' }),
      });

      expect(status).toBe(200);
      expect(body.steered).toBe(true);
      expect(body.message).toBe('Focus on tests');
    });

    it('should return 404 for unknown session', async () => {
      const { status } = await fetchJson(baseUrl, '/sessions/ghost/steer', {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(status).toBe(404);
    });

    it('should return 400 when message is missing', async () => {
      const config = makeSessionConfig();
      sessionManager.createSession(config);

      const { status } = await fetchJson(baseUrl, `/sessions/${config.sessionId}/steer`, {
        method: 'POST',
        body: '{}',
      });
      expect(status).toBe(400);
    });
  });

  describe('DELETE /sessions/:id', () => {
    it('should end and remove a session', async () => {
      const config = makeSessionConfig();
      sessionManager.createSession(config);

      const { status, body } = await fetchJson(baseUrl, `/sessions/${config.sessionId}`, {
        method: 'DELETE',
      });

      expect(status).toBe(200);
      expect(body.ended).toBe(true);
      expect(sessionManager.getSession(config.sessionId)).toBeUndefined();
    });

    it('should return 404 for unknown session', async () => {
      const { status } = await fetchJson(baseUrl, '/sessions/ghost', {
        method: 'DELETE',
      });
      expect(status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('should respond to OPTIONS with 204', async () => {
      const res = await fetch(`${baseUrl}/sessions`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const { status } = await fetchJson(baseUrl, '/unknown');
      expect(status).toBe(404);
    });
  });
});

// ===========================================================================
// GatewayServer with pairing (auth integration tests)
// ===========================================================================

describe('GatewayServer with pairing', () => {
  let sessionManager: SessionManager;
  let pairingManager: PairingManager;
  let server: GatewayServer;
  let baseUrl: string;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    pairingManager = new PairingManager({ codeTtlMs: 60000 });
    server = new GatewayServer({
      port: 0,
      host: '127.0.0.1',
      sessionManager,
      pairingManager,
    });
    await server.start();
    const addr = server.getAddress()!;
    baseUrl = `http://${addr.host}:${addr.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should allow /health without auth', async () => {
    const { status, body } = await fetchJson(baseUrl, '/health');
    expect(status).toBe(200);
    expect(body.pairing).toBeDefined();
  });

  it('should block /sessions without auth', async () => {
    const { status, body } = await fetchJson(baseUrl, '/sessions');
    expect(status).toBe(401);
    expect(body.error).toContain('Unauthorized');
  });

  it('should allow POST /pair without auth', async () => {
    const code = pairingManager.generateCode();
    const { status, body } = await fetchJson(baseUrl, '/pair', {
      method: 'POST',
      body: JSON.stringify({ code: code.code }),
    });

    expect(status).toBe(200);
    expect(body.paired).toBe(true);
    expect(body.token).toBeDefined();
  });

  it('should reject POST /pair with invalid code', async () => {
    const { status, body } = await fetchJson(baseUrl, '/pair', {
      method: 'POST',
      body: JSON.stringify({ code: 'BADCOD' }),
    });

    expect(status).toBe(401);
    expect(body.error).toContain('Invalid or expired');
  });

  it('should reject POST /pair without code', async () => {
    const { status } = await fetchJson(baseUrl, '/pair', {
      method: 'POST',
      body: '{}',
    });
    expect(status).toBe(400);
  });

  it('should reject POST /pair when pairing is disabled', async () => {
    const serverNoPair = new GatewayServer({
      port: 0,
      host: '127.0.0.1',
      sessionManager: new SessionManager(),
    });
    await serverNoPair.start();
    const addr = serverNoPair.getAddress()!;
    const url = `http://${addr.host}:${addr.port}`;

    const { status } = await fetchJson(url, '/pair', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABC123' }),
    });

    expect(status).toBe(400);
    await serverNoPair.stop();
  });

  it('should allow authenticated requests after pairing', async () => {
    // 1. Generate code and exchange for token.
    const code = pairingManager.generateCode();
    const pairRes = await fetchJson(baseUrl, '/pair', {
      method: 'POST',
      body: JSON.stringify({ code: code.code }),
    });
    const token = pairRes.body.token as string;

    // 2. Use token to access protected route.
    const { status, body } = await fetchJson(baseUrl, '/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it('should reject requests with invalid token', async () => {
    const { status } = await fetchJson(baseUrl, '/sessions', {
      headers: { Authorization: 'Bearer invalidtoken' },
    });
    expect(status).toBe(401);
  });

  it('should reject requests with malformed auth header', async () => {
    const { status } = await fetchJson(baseUrl, '/sessions', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(status).toBe(401);
  });

  it('should complete full pairing → session → steer → delete flow', async () => {
    // 1. Pair.
    const code = pairingManager.generateCode();
    const pairRes = await fetchJson(baseUrl, '/pair', {
      method: 'POST',
      body: JSON.stringify({ code: code.code }),
    });
    const token = pairRes.body.token as string;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 2. Create session.
    const createRes = await fetchJson(baseUrl, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ channelId: 'web', userId: 'user1' }),
      headers: authHeaders,
    });
    expect(createRes.status).toBe(201);
    const sessionId = createRes.body.sessionId as string;

    // 3. List sessions.
    const listRes = await fetchJson(baseUrl, '/sessions', { headers: authHeaders });
    expect(listRes.status).toBe(200);
    expect((listRes.body.sessions as unknown[]).length).toBe(1);

    // 4. Steer session.
    const steerRes = await fetchJson(baseUrl, `/sessions/${sessionId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message: 'Please focus on tests' }),
      headers: authHeaders,
    });
    expect(steerRes.status).toBe(200);
    expect(steerRes.body.steered).toBe(true);

    // 5. Get session details.
    const getRes = await fetchJson(baseUrl, `/sessions/${sessionId}`, { headers: authHeaders });
    expect(getRes.status).toBe(200);
    expect(getRes.body.sessionId).toBe(sessionId);

    // 6. Delete session.
    const deleteRes = await fetchJson(baseUrl, `/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ended).toBe(true);

    // 7. Verify session is gone.
    const getAfter = await fetchJson(baseUrl, `/sessions/${sessionId}`, { headers: authHeaders });
    expect(getAfter.status).toBe(404);
  });
});

// ===========================================================================
// Server lifecycle
// ===========================================================================

describe('GatewayServer lifecycle', () => {
  it('should stop cleanly when not started', async () => {
    const server = new GatewayServer({
      port: 0,
      sessionManager: new SessionManager(),
    });
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('should return null address when not started', () => {
    const server = new GatewayServer({
      port: 0,
      sessionManager: new SessionManager(),
    });
    expect(server.getAddress()).toBeNull();
  });

  it('should return address when started', async () => {
    const server = new GatewayServer({
      port: 0,
      host: '127.0.0.1',
      sessionManager: new SessionManager(),
    });
    await server.start();
    const addr = server.getAddress();
    expect(addr).not.toBeNull();
    expect(addr!.port).toBeGreaterThan(0);
    await server.stop();
  });
});
