import { describe, it, expect } from 'vitest';
import { splitMessage, truncateMessage } from './message-utils.js';

describe('splitMessage', () => {
  it('returns single element for empty string', () => {
    expect(splitMessage('', 100)).toEqual(['']);
  });

  it('returns single element when text fits exactly', () => {
    const text = 'a'.repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  it('returns single element when text is under limit', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('hard-splits when one char over limit', () => {
    const text = 'a'.repeat(101);
    const chunks = splitMessage(text, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks.join('')).toBe(text);
  });

  it('splits at word boundary when space is in latter half', () => {
    // Space at position 80 of a 101-char string — falls in latter 50% of window (100)
    const part1 = 'a'.repeat(80);
    const part2 = 'b'.repeat(20);
    const text = part1 + ' ' + part2; // length = 101
    const chunks = splitMessage(text, 100);
    expect(chunks[0]).toBe(part1);
    expect(chunks[1]).toBe(part2);
  });

  it('does NOT split at space when it falls in first half of window', () => {
    // Space at position 10 of a 101-char string — falls in first 50%, use hard split
    const text = 'a'.repeat(10) + ' ' + 'b'.repeat(90); // length = 101
    const chunks = splitMessage(text, 100);
    // Hard split at 100: '(10 a's + space + 89 b's)' | '(1 b)'
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(1);
  });

  it('produces 3 chunks for a very long string', () => {
    const text = 'x'.repeat(250);
    const chunks = splitMessage(text, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
    expect(chunks.join('')).toBe(text);
  });

  it('handles a long word with no spaces (hard-split)', () => {
    const word = 'superlongword'.repeat(20); // 260 chars, no spaces
    const chunks = splitMessage(word, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join('')).toBe(word);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('returns full text when maxLen is 0 (guard against infinite loop)', () => {
    const text = 'hello world';
    expect(splitMessage(text, 0)).toEqual([text]);
  });

  it('returns full text when maxLen is negative', () => {
    const text = 'some text';
    expect(splitMessage(text, -5)).toEqual([text]);
  });

  it('realistic: Telegram 4096-char limit on a 5000-char message', () => {
    const text = ('hello world ').repeat(417); // ~5004 chars
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // Reassemble (chunks may have trimmed spaces at boundaries)
    const joined = chunks.join(' ');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe(text.trim().replace(/\s+/g, ' '));
  });
});

describe('truncateMessage', () => {
  it('returns unchanged when text fits exactly', () => {
    const text = 'a'.repeat(100);
    expect(truncateMessage(text, 100)).toBe(text);
  });

  it('returns unchanged when text is under limit', () => {
    expect(truncateMessage('hello', 100)).toBe('hello');
  });

  it('truncates with ellipsis when one char over', () => {
    const text = 'a'.repeat(101);
    const result = truncateMessage(text, 100);
    expect(result).toHaveLength(100);
    expect(result.endsWith('…')).toBe(true);
  });

  it('truncates a much longer string', () => {
    const text = 'x'.repeat(10_000);
    const result = truncateMessage(text, 4096);
    expect(result).toHaveLength(4096);
    expect(result.endsWith('…')).toBe(true);
  });

  it('uses exactly maxLen - 1 chars of content plus ellipsis', () => {
    const text = 'abcde'; // 5 chars
    const result = truncateMessage(text, 4); // limit 4 → 3 chars + '…'
    expect(result).toBe('abc…');
  });

  it('does not slice through a surrogate pair (emoji)', () => {
    // '😀' is U+1F600, encoded as two UTF-16 code units (a surrogate pair).
    const text = 'ab😀cd'; // 6 code units: a, b, \uD83D, \uDE00, c, d
    // maxLen = 4 → slice at index 3 would cut inside the surrogate pair.
    const result = truncateMessage(text, 4);
    // Should back up to index 2 and append '…', producing 'ab…'.
    expect(result).toBe('ab…');
    // Verify no broken surrogates.
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      // No lone high surrogate (0xD800-0xDBFF) without following low surrogate.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it('returns unchanged when maxLen is 0 (guard)', () => {
    expect(truncateMessage('hello', 0)).toBe('hello');
  });
});
