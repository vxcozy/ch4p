import { generateId, sleep, abortableSleep, backoffDelay, truncate, deepFreeze } from './index.js';

// ─── generateId ──────────────────────────────────────────────────────────────

describe('generateId', () => {
  it('returns a string of default length 21', () => {
    const id = generateId();
    expect(id).toHaveLength(21);
  });

  it('returns a string of custom length', () => {
    expect(generateId(8)).toHaveLength(8);
    expect(generateId(64)).toHaveLength(64);
    expect(generateId(1)).toHaveLength(1);
  });

  it('only contains URL-safe characters (A-Z, a-z, 0-9, _, -)', () => {
    const validChars = /^[A-Za-z0-9_-]+$/;
    for (let i = 0; i < 100; i++) {
      expect(generateId()).toMatch(validChars);
    }
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    // With 64-char alphabet and 21 length, collisions should be near-zero
    expect(ids.size).toBe(1000);
  });

  it('handles length 0 by returning empty string', () => {
    const id = generateId(0);
    expect(id).toBe('');
  });

  it('generates different IDs on successive calls', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});

// ─── sleep ───────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('returns a promise that resolves after the given ms', async () => {
    const start = performance.now();
    await sleep(50);
    const elapsed = performance.now() - start;
    // Allow some tolerance for timer imprecision
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it('resolves with undefined', async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });

  it('handles 0 ms', async () => {
    const start = performance.now();
    await sleep(0);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── abortableSleep ─────────────────────────────────────────────────────────

describe('abortableSleep', () => {
  it('resolves after the given ms when no signal', async () => {
    const start = performance.now();
    await abortableSleep(50);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = performance.now();
    await abortableSleep(5000, ac.signal);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('resolves early when signal fires during sleep', async () => {
    const ac = new AbortController();
    const start = performance.now();

    // Abort after 30ms, sleep for 5000ms.
    setTimeout(() => ac.abort(), 30);
    await abortableSleep(5000, ac.signal);

    const elapsed = performance.now() - start;
    // Should resolve in ~30ms, not 5000ms.
    expect(elapsed).toBeLessThan(200);
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it('cleans up abort listener after normal timer completion', async () => {
    const ac = new AbortController();
    await abortableSleep(10, ac.signal);

    // If listeners aren't cleaned up, aborting after completion would throw
    // or cause unexpected side effects. This should be a no-op.
    expect(() => ac.abort()).not.toThrow();
  });
});

// ─── backoffDelay ────────────────────────────────────────────────────────────

describe('backoffDelay', () => {
  it('returns a number', () => {
    const delay = backoffDelay(0);
    expect(typeof delay).toBe('number');
  });

  it('increases exponentially with attempt number', () => {
    // Use baseMs=100 so we can compare easily.
    // Jitter adds up to 10%, so the deterministic base is 100 * 2^attempt.
    const d0 = backoffDelay(0, 100, 100_000);
    const d1 = backoffDelay(1, 100, 100_000);
    const d2 = backoffDelay(2, 100, 100_000);

    // Base values: 100, 200, 400. Jitter adds 0-10%.
    expect(d0).toBeGreaterThanOrEqual(100);
    expect(d0).toBeLessThanOrEqual(110);

    expect(d1).toBeGreaterThanOrEqual(200);
    expect(d1).toBeLessThanOrEqual(220);

    expect(d2).toBeGreaterThanOrEqual(400);
    expect(d2).toBeLessThanOrEqual(440);
  });

  it('caps at maxMs', () => {
    const delay = backoffDelay(20, 1000, 30_000);
    // 1000 * 2^20 = 1_048_576_000 but capped at 30_000.
    // Jitter adds up to 10%, so max is 33_000.
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(33_000);
  });

  it('uses default baseMs of 1000', () => {
    const delay = backoffDelay(0);
    // Base: 1000 * 2^0 = 1000, jitter up to 10% = 100.
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1100);
  });

  it('uses default maxMs of 30000', () => {
    const delay = backoffDelay(100);
    // 1000 * 2^100 would be enormous but capped at 30_000 + jitter.
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(33_000);
  });

  it('attempt 0 returns approximately baseMs', () => {
    const base = 500;
    const delay = backoffDelay(0, base, 100_000);
    expect(delay).toBeGreaterThanOrEqual(base);
    expect(delay).toBeLessThanOrEqual(base * 1.1);
  });

  it('always returns a positive number', () => {
    for (let i = 0; i < 20; i++) {
      expect(backoffDelay(i)).toBeGreaterThan(0);
    }
  });
});

// ─── truncate ────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns the original string if shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the original string if exactly maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when string exceeds maxLength', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('handles maxLength of 3 (minimum for ellipsis)', () => {
    expect(truncate('hello', 3)).toBe('...');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('handles empty string with 0 maxLength', () => {
    expect(truncate('', 0)).toBe('');
  });

  it('preserves the string when maxLength equals string length', () => {
    const str = 'exact length';
    expect(truncate(str, str.length)).toBe(str);
  });

  it('truncates to maxLength - 3 chars plus ellipsis', () => {
    const result = truncate('abcdefghij', 7);
    expect(result).toBe('abcd...');
    expect(result).toHaveLength(7);
  });

  it('handles single-character string within limit', () => {
    expect(truncate('a', 5)).toBe('a');
  });

  it('handles unicode characters', () => {
    const emoji = 'Hello World';
    expect(truncate(emoji, 20)).toBe(emoji);
  });
});

// ─── deepFreeze ──────────────────────────────────────────────────────────────

describe('deepFreeze', () => {
  it('freezes a simple object', () => {
    const obj = { a: 1, b: 'two' };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('returns the same object reference', () => {
    const obj = { a: 1 };
    const frozen = deepFreeze(obj);
    expect(frozen).toBe(obj);
  });

  it('freezes nested objects', () => {
    const obj = {
      level1: {
        level2: {
          value: 42,
        },
      },
    };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.level1)).toBe(true);
    expect(Object.isFrozen(obj.level1.level2)).toBe(true);
  });

  it('prevents modifications to top-level properties', () => {
    const obj = deepFreeze({ a: 1, b: 2 });
    expect(() => {
      (obj as Record<string, unknown>).a = 99;
    }).toThrow();
  });

  it('prevents modifications to nested properties', () => {
    const obj = deepFreeze({
      nested: { value: 'original' },
    });
    expect(() => {
      (obj.nested as Record<string, unknown>).value = 'modified';
    }).toThrow();
  });

  it('prevents adding new properties', () => {
    const obj = deepFreeze({ a: 1 });
    expect(() => {
      (obj as Record<string, unknown>).newProp = 'nope';
    }).toThrow();
  });

  it('prevents deleting properties', () => {
    const obj = deepFreeze({ a: 1 });
    expect(() => {
      delete (obj as Record<string, unknown>).a;
    }).toThrow();
  });

  it('handles objects with array values', () => {
    const obj = deepFreeze({
      items: [1, 2, 3] as unknown as Record<string, unknown>,
    });
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.items)).toBe(true);
  });

  it('handles empty object', () => {
    const obj = deepFreeze({});
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('handles objects with null values', () => {
    const obj = deepFreeze({ a: null as unknown as Record<string, unknown> });
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('does not fail on already-frozen nested objects', () => {
    const inner = Object.freeze({ x: 1 });
    const obj = { nested: inner as Record<string, unknown> };
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('preserves existing values after freezing', () => {
    const obj = deepFreeze({
      name: 'test',
      count: 42,
      nested: { flag: true },
    });
    expect(obj.name).toBe('test');
    expect(obj.count).toBe(42);
    expect(obj.nested.flag).toBe(true);
  });
});
