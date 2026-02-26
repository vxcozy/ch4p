/**
 * WebSocketBridge + CanvasSessionManager tests.
 *
 * Uses a mock WebSocket to test the bridge lifecycle, C2S routing,
 * S2C emission, canvas state sync, agent event translation, and
 * session manager CRUD.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CanvasState, CanvasChannel, encodeMessage } from '@ch4p/canvas';
import type { S2CMessage, C2SMessage } from '@ch4p/canvas';
import { WebSocketBridge } from './ws-bridge.js';
import type { BridgeAgentEvent } from './ws-bridge.js';
import { CanvasSessionManager } from './canvas-session.js';
import type { CardComponent, ComponentPosition } from '@ch4p/canvas';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }

  /** Helper: parse all sent messages. */
  getSentMessages(): S2CMessage[] {
    return this.sent.map((s) => JSON.parse(s) as S2CMessage);
  }

  /** Helper: simulate receiving a C2S message. */
  simulateMessage(msg: C2SMessage): void {
    const data = Buffer.from(JSON.stringify(msg));
    this.emit('message', data);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCard(id = 'card-1'): CardComponent {
  return { id, type: 'card', title: 'Test', body: 'Hello' };
}

function makePosition(x = 100, y = 200): ComponentPosition {
  return { x, y, width: 300, height: 200 };
}

// ============================================================================
// WebSocketBridge
// ============================================================================

describe('WebSocketBridge', () => {
  let ws: MockWebSocket;
  let state: CanvasState;
  let channel: CanvasChannel;
  let bridge: WebSocketBridge;

  beforeEach(async () => {
    ws = new MockWebSocket();
    state = new CanvasState();
    channel = new CanvasChannel();
    await channel.start({ sessionId: 'test-session' });
    bridge = new WebSocketBridge(ws as unknown as import('ws').WebSocket, state, channel, 'test-session');
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('starts alive', () => {
      bridge.start();
      expect(bridge.isAlive()).toBe(true);
    });

    it('reports session id', () => {
      expect(bridge.getSessionId()).toBe('test-session');
    });

    it('sends initial snapshot on start', () => {
      bridge.start();
      const messages = ws.getSentMessages();
      const snapshot = messages.find((m) => m.type === 's2c:canvas:snapshot');
      expect(snapshot).toBeDefined();
    });

    it('sends initial idle status on start', () => {
      bridge.start();
      const messages = ws.getSentMessages();
      const status = messages.find(
        (m) => m.type === 's2c:agent:status' && (m as { status: string }).status === 'idle',
      );
      expect(status).toBeDefined();
    });

    it('stop unsubscribes from state changes', () => {
      bridge.start();
      ws.sent = []; // Clear startup messages

      bridge.stop();
      expect(bridge.isAlive()).toBe(false);

      // State change should NOT produce WS message
      state.addComponent(makeCard('c1'), makePosition());
      expect(ws.sent).toHaveLength(0);
    });

    it('stop is idempotent', () => {
      bridge.start();
      bridge.stop();
      bridge.stop(); // Should not throw
      expect(bridge.isAlive()).toBe(false);
    });

    it('stops on WebSocket close', () => {
      bridge.start();
      ws.emit('close');
      expect(bridge.isAlive()).toBe(false);
    });

    it('stops on WebSocket error', () => {
      bridge.start();
      ws.emit('error', new Error('connection lost'));
      expect(bridge.isAlive()).toBe(false);
    });

    it('removes message/close/error listeners from WebSocket on stop', () => {
      bridge.start();
      expect(ws.listenerCount('message')).toBeGreaterThan(0);
      expect(ws.listenerCount('close')).toBeGreaterThan(0);
      expect(ws.listenerCount('error')).toBeGreaterThan(0);

      bridge.stop();

      expect(ws.listenerCount('message')).toBe(0);
      expect(ws.listenerCount('close')).toBe(0);
      expect(ws.listenerCount('error')).toBe(0);
    });

    it('does not receive messages after stop', () => {
      bridge.start();
      ws.sent = [];

      bridge.stop();
      // Simulate a message arriving after stop — should be silently ignored
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'c2s:ping', timestamp: '2025-01-01' })));
      expect(ws.sent).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Canvas state sync → WS
  // -------------------------------------------------------------------------

  describe('canvas state → WS sync', () => {
    it('forwards add_node changes to client', () => {
      bridge.start();
      ws.sent = [];

      state.addComponent(makeCard('c1'), makePosition());
      const messages = ws.getSentMessages();
      const change = messages.find((m) => m.type === 's2c:canvas:change');
      expect(change).toBeDefined();
      expect((change as { change: { type: string } }).change.type).toBe('add_node');
    });

    it('forwards update_node changes to client', () => {
      state.addComponent(makeCard('c1'), makePosition());
      bridge.start();
      ws.sent = [];

      state.updateComponent('c1', { title: 'Updated' } as Partial<CardComponent>);
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:canvas:change' &&
        (m as { change: { type: string } }).change.type === 'update_node',
      )).toBe(true);
    });

    it('forwards remove_node changes to client', () => {
      state.addComponent(makeCard('c1'), makePosition());
      bridge.start();
      ws.sent = [];

      state.removeComponent('c1');
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:canvas:change' &&
        (m as { change: { type: string } }).change.type === 'remove_node',
      )).toBe(true);
    });

    it('forwards clear changes to client', () => {
      state.addComponent(makeCard('c1'), makePosition());
      bridge.start();
      ws.sent = [];

      state.clear();
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:canvas:change' &&
        (m as { change: { type: string } }).change.type === 'clear',
      )).toBe(true);
    });

    it('initial snapshot includes existing state', () => {
      state.addComponent(makeCard('c1'), makePosition());
      state.addComponent(makeCard('c2'), makePosition(400, 200));

      bridge.start();
      const messages = ws.getSentMessages();
      const snapshot = messages.find((m) => m.type === 's2c:canvas:snapshot') as {
        type: string;
        snapshot: { nodes: unknown[]; connections: unknown[] };
      };
      expect(snapshot.snapshot.nodes).toHaveLength(2);
    });

    it('does not send when WS is closed', () => {
      bridge.start();
      ws.sent = [];
      ws.readyState = 3; // CLOSED

      state.addComponent(makeCard('c1'), makePosition());
      expect(ws.sent).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // C2S message routing
  // -------------------------------------------------------------------------

  describe('C2S message routing', () => {
    it('routes c2s:ping to pong response', () => {
      bridge.start();
      ws.sent = [];

      ws.simulateMessage({ type: 'c2s:ping', timestamp: '2025-01-01T00:00:00Z' });
      const messages = ws.getSentMessages();
      expect(messages.some((m) => m.type === 's2c:pong')).toBe(true);
    });

    it('routes c2s:drag to canvas state (not channel)', () => {
      state.addComponent(makeCard('c1'), makePosition(0, 0));
      bridge.start();

      ws.simulateMessage({
        type: 'c2s:drag',
        componentId: 'c1',
        position: { x: 500, y: 600 },
      });

      expect(state.getNode('c1')!.position.x).toBe(500);
      expect(state.getNode('c1')!.position.y).toBe(600);
    });

    it('routes c2s:message through channel', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));
      bridge.start();

      ws.simulateMessage({ type: 'c2s:message', text: 'Hello agent' });
      expect(received).toHaveLength(1);
      expect((received[0] as { text: string }).text).toBe('Hello agent');
    });

    it('routes c2s:click through channel', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));
      bridge.start();

      ws.simulateMessage({
        type: 'c2s:click',
        componentId: 'btn-1',
        actionId: 'submit',
      });
      expect(received).toHaveLength(1);
      expect((received[0] as { text: string }).text).toContain('[USER_CLICK]');
    });

    it('routes c2s:form_submit through channel', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));
      bridge.start();

      ws.simulateMessage({
        type: 'c2s:form_submit',
        componentId: 'form-1',
        values: { name: 'Alice' },
      });
      expect(received).toHaveLength(1);
      expect((received[0] as { text: string }).text).toContain('[FORM_SUBMIT]');
    });

    it('routes c2s:abort through channel', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));
      bridge.start();

      ws.simulateMessage({ type: 'c2s:abort', reason: 'User cancelled' });
      expect(received).toHaveLength(1);
      expect((received[0] as { text: string }).text).toContain('[ABORT]');
    });

    it('handles invalid JSON gracefully', () => {
      bridge.start();
      ws.sent = [];

      const badData = Buffer.from('not json');
      ws.emit('message', badData);

      const messages = ws.getSentMessages();
      expect(messages.some((m) => m.type === 's2c:error')).toBe(true);
      const err = messages.find((m) => m.type === 's2c:error') as { code: string; message: string };
      expect(err.code).toBe('PARSE_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // Agent event → S2C
  // -------------------------------------------------------------------------

  describe('handleAgentEvent', () => {
    it('translates thinking event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'thinking' });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' && (m as { status: string }).status === 'thinking',
      )).toBe(true);
    });

    it('translates text event to streaming status + delta', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'text', delta: 'Hello', partial: 'Hello' });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' && (m as { status: string }).status === 'streaming',
      )).toBe(true);
      expect(messages.some((m) =>
        m.type === 's2c:text:delta' && (m as { delta: string }).delta === 'Hello',
      )).toBe(true);
    });

    it('translates tool_start event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'tool_start', tool: 'canvas_render', args: { action: 'add' } });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' &&
        (m as { status: string }).status === 'tool_executing' &&
        (m as { tool: string }).tool === 'canvas_render',
      )).toBe(true);
      expect(messages.some((m) =>
        m.type === 's2c:tool:start' && (m as { tool: string }).tool === 'canvas_render',
      )).toBe(true);
    });

    it('translates tool_progress event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'tool_progress', tool: 'bash', result: { progress: 50 } });
      const messages = ws.getSentMessages();
      expect(messages.some((m) => m.type === 's2c:tool:progress')).toBe(true);
    });

    it('translates tool_end event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'tool_end', tool: 'canvas_render', result: { success: true } });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:tool:end' && (m as { tool: string }).tool === 'canvas_render',
      )).toBe(true);
    });

    it('translates complete event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'complete', answer: 'Done!' });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:text:complete' && (m as { text: string }).text === 'Done!',
      )).toBe(true);
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' && (m as { status: string }).status === 'complete',
      )).toBe(true);
    });

    it('translates error event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'error', error: new Error('Something broke') });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' && (m as { status: string }).status === 'error',
      )).toBe(true);
      expect(messages.some((m) =>
        m.type === 's2c:error' && (m as { message: string }).message === 'Something broke',
      )).toBe(true);
    });

    it('translates aborted event', () => {
      bridge.start();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'aborted', reason: 'User cancelled' });
      const messages = ws.getSentMessages();
      expect(messages.some((m) =>
        m.type === 's2c:agent:status' &&
        (m as { status: string }).status === 'idle' &&
        (m as { message: string }).message?.includes('User cancelled'),
      )).toBe(true);
    });

    it('ignores events when bridge is stopped', () => {
      bridge.start();
      bridge.stop();
      ws.sent = [];

      bridge.handleAgentEvent({ type: 'thinking' });
      expect(ws.sent).toHaveLength(0);
    });
  });
});

// ============================================================================
// CanvasSessionManager
// ============================================================================

describe('CanvasSessionManager', () => {
  let manager: CanvasSessionManager;

  beforeEach(() => {
    manager = new CanvasSessionManager();
  });

  describe('createCanvasSession', () => {
    it('creates a session with state and channel', () => {
      const entry = manager.createCanvasSession('s1');
      expect(entry.canvasState).toBeInstanceOf(CanvasState);
      expect(entry.canvasChannel).toBeInstanceOf(CanvasChannel);
      expect(entry.bridge).toBeNull();
    });

    it('session is accessible by id', () => {
      manager.createCanvasSession('s1');
      expect(manager.hasSession('s1')).toBe(true);
      expect(manager.getSession('s1')).toBeDefined();
    });

    it('respects maxComponents parameter', () => {
      const entry = manager.createCanvasSession('s1', 5);
      const state = entry.canvasState;
      for (let i = 0; i < 5; i++) {
        state.addComponent(makeCard(`c${i}`), makePosition());
      }
      expect(() => state.addComponent(makeCard('overflow'), makePosition())).toThrow('limit reached');
    });
  });

  describe('getCanvasState / getCanvasChannel', () => {
    it('returns state for existing session', () => {
      manager.createCanvasSession('s1');
      expect(manager.getCanvasState('s1')).toBeInstanceOf(CanvasState);
    });

    it('returns channel for existing session', () => {
      manager.createCanvasSession('s1');
      expect(manager.getCanvasChannel('s1')).toBeInstanceOf(CanvasChannel);
    });

    it('returns undefined for missing session', () => {
      expect(manager.getCanvasState('nope')).toBeUndefined();
      expect(manager.getCanvasChannel('nope')).toBeUndefined();
    });
  });

  describe('setBridge', () => {
    it('associates a bridge with a session', () => {
      manager.createCanvasSession('s1');
      const fakeBridge = { stop: vi.fn() } as unknown as import('./ws-bridge.js').WebSocketBridge;
      manager.setBridge('s1', fakeBridge);

      expect(manager.getSession('s1')!.bridge).toBe(fakeBridge);
    });

    it('does nothing for missing session', () => {
      const fakeBridge = { stop: vi.fn() } as unknown as import('./ws-bridge.js').WebSocketBridge;
      // Should not throw
      manager.setBridge('nope', fakeBridge);
    });
  });

  describe('listSessionIds', () => {
    it('lists all session ids', () => {
      manager.createCanvasSession('s1');
      manager.createCanvasSession('s2');
      manager.createCanvasSession('s3');

      const ids = manager.listSessionIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids).toContain('s3');
    });

    it('returns empty array when no sessions', () => {
      expect(manager.listSessionIds()).toHaveLength(0);
    });
  });

  describe('endCanvasSession', () => {
    it('removes session and stops bridge', () => {
      manager.createCanvasSession('s1');
      const fakeBridge = { stop: vi.fn() } as unknown as import('./ws-bridge.js').WebSocketBridge;
      manager.setBridge('s1', fakeBridge);

      manager.endCanvasSession('s1');
      expect(manager.hasSession('s1')).toBe(false);
      expect(fakeBridge.stop).toHaveBeenCalled();
    });

    it('handles session without bridge', () => {
      manager.createCanvasSession('s1');
      manager.endCanvasSession('s1');
      expect(manager.hasSession('s1')).toBe(false);
    });

    it('does nothing for missing session', () => {
      // Should not throw
      manager.endCanvasSession('nope');
    });
  });

  describe('endAll', () => {
    it('ends all sessions', () => {
      manager.createCanvasSession('s1');
      manager.createCanvasSession('s2');
      manager.createCanvasSession('s3');

      const bridges = ['s1', 's2', 's3'].map(() => {
        const b = { stop: vi.fn() } as unknown as import('./ws-bridge.js').WebSocketBridge;
        return b;
      });
      manager.setBridge('s1', bridges[0]!);
      manager.setBridge('s2', bridges[1]!);
      manager.setBridge('s3', bridges[2]!);

      manager.endAll();
      expect(manager.listSessionIds()).toHaveLength(0);
      for (const b of bridges) {
        expect(b.stop).toHaveBeenCalled();
      }
    });
  });
});
