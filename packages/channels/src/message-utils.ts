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
