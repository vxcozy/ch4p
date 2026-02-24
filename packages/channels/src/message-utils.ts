/**
 * Shared message utilities for channel adapters.
 *
 * Each channel platform has its own character-per-message limit. These helpers
 * allow channel send() and editMessage() implementations to respect those limits
 * without duplicating logic.
 */

/**
 * Split a text string into chunks that each fit within `maxLen` characters.
 *
 * Splitting strategy:
 * - If the text fits, returns a single-element array.
 * - Prefers splitting at the last space within the window (word-aware split),
 *   but only if that space falls in the latter half of the window. This avoids
 *   producing tiny leading chunks when a space appears very early.
 * - Falls back to a hard character split when no suitable space is found.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (!text) return [''];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Prefer the last space in the latter 50% of the window so chunks are
    // reasonably balanced and we don't split mid-word unnecessarily.
    const lastSpace = remaining.lastIndexOf(' ', maxLen);
    const splitAt = lastSpace > maxLen * 0.5 ? lastSpace : maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Truncate a text string to `maxLen` characters, appending '…' if it was cut.
 *
 * Used for live `editMessage()` calls where splitting is not possible mid-stream.
 * The final `send()` will deliver the full content in chunks.
 */
export function truncateMessage(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Evict the oldest entries from a timestamp map when it exceeds `maxEntries`.
 *
 * Channel adapters store `lastEditTimestamps` to rate-limit `editMessage()`.
 * Without eviction this map grows forever in long-running gateway processes.
 * Call this after every `.set()` — the eviction is cheap (O(n) only when
 * the threshold is exceeded, which is rare with a 500-entry default).
 */
export function evictOldTimestamps(map: Map<string, number>, maxEntries: number): void {
  if (map.size <= maxEntries) return;

  // Sort by timestamp ascending, delete the oldest quarter.
  const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const toDelete = Math.max(1, Math.floor(sorted.length / 4));
  for (let i = 0; i < toDelete; i++) {
    map.delete(sorted[i]![0]);
  }
}
