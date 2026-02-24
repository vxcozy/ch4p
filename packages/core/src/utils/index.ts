/**
 * Pure utility functions shared across ch4p packages.
 */

/** Generate a random ID (nanoid-style, no deps) */
export function generateId(length = 21): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[bytes[i]! & 63];
  }
  return id;
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that resolves early if an AbortSignal fires.
 *
 * Useful in retry loops where backoff delays should not prevent timely
 * abort handling. Cleans up the timer and abort listener on resolution.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const delay = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = delay * 0.1 * Math.random();
  return delay + jitter;
}

/** Truncate a string to a max length, adding ellipsis */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/** Deep freeze an object (for immutable configs) */
export function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return Object.freeze(obj);
}
