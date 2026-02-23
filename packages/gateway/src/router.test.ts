/**
 * Tests for MessageRouter — composite routing keys (group, thread, private).
 */

import { MessageRouter } from './router.js';
import { SessionManager } from './session-manager.js';
import type { InboundMessage } from '@ch4p/core';

function makeMsg(overrides: Partial<InboundMessage['from']> & { channelId?: string; text?: string } = {}): InboundMessage {
  const { channelId = 'telegram', text = 'hello', ...from } = overrides;
  return {
    id: 'msg-1',
    channelId,
    from: {
      channelId,
      userId: 'user-1',
      ...from,
    },
    text,
    timestamp: new Date(),
  };
}

function makeRouter() {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    engineId: 'echo',
    model: 'test-model',
    provider: 'test',
  });
  return { router, sessionManager };
}

describe('MessageRouter', () => {
  describe('private messages', () => {
    it('routes to the same session for the same user', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1' }));
      const r2 = router.route(makeMsg({ userId: 'user-1' }));
      expect(r1?.sessionId).toBe(r2?.sessionId);
    });

    it('routes to different sessions for different users', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1' }));
      const r2 = router.route(makeMsg({ userId: 'user-2' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });

    it('returns null when channelId is missing', () => {
      const { router } = makeRouter();
      const msg = makeMsg({ userId: 'user-1' });
      // @ts-expect-error — intentional: test missing channelId
      msg.channelId = undefined;
      expect(router.route(msg)).toBeNull();
    });
  });

  describe('group messages (no topic)', () => {
    it('gives each user their own session within a group', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      const r2 = router.route(makeMsg({ userId: 'user-2', groupId: 'group-42' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });

    it('same user same group returns same session', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      expect(r1?.sessionId).toBe(r2?.sessionId);
    });

    it('same user different groups get different sessions', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-99' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });

    it('group session is isolated from private session for same user', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });
  });

  describe('topic/thread messages', () => {
    it('all users in the same topic share one session', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42', threadId: 'thread-7' }));
      const r2 = router.route(makeMsg({ userId: 'user-2', groupId: 'group-42', threadId: 'thread-7' }));
      expect(r1?.sessionId).toBe(r2?.sessionId);
    });

    it('different topics in the same group get different sessions', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42', threadId: 'thread-7' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42', threadId: 'thread-8' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });

    it('same topic in different groups get different sessions', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42', threadId: 'thread-7' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-99', threadId: 'thread-7' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });

    it('topic session is isolated from group-level session', () => {
      const { router } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42' }));
      const r2 = router.route(makeMsg({ userId: 'user-1', groupId: 'group-42', threadId: 'thread-7' }));
      expect(r1?.sessionId).not.toBe(r2?.sessionId);
    });
  });

  describe('session reuse after eviction', () => {
    it('creates a new session when the previous one was ended', () => {
      const { router, sessionManager } = makeRouter();
      const r1 = router.route(makeMsg({ userId: 'user-1' }));
      expect(r1).not.toBeNull();
      sessionManager.endSession(r1!.sessionId);
      const r2 = router.route(makeMsg({ userId: 'user-1' }));
      expect(r2?.sessionId).not.toBe(r1?.sessionId);
    });
  });
});
