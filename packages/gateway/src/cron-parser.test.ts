/**
 * Cron parser tests — validates 5-field expression parsing and matching.
 */

import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches } from './cron-parser.js';

describe('parseCron', () => {
  it('parses wildcard-only expression', () => {
    const s = parseCron('* * * * *');
    expect(s.minutes.size).toBe(60);
    expect(s.hours.size).toBe(24);
    expect(s.daysOfMonth.size).toBe(31);
    expect(s.months.size).toBe(12);
    expect(s.daysOfWeek.size).toBe(7);
  });

  it('parses exact values', () => {
    const s = parseCron('30 9 15 6 3');
    expect([...s.minutes]).toEqual([30]);
    expect([...s.hours]).toEqual([9]);
    expect([...s.daysOfMonth]).toEqual([15]);
    expect([...s.months]).toEqual([6]);
    expect([...s.daysOfWeek]).toEqual([3]);
  });

  it('parses ranges', () => {
    const s = parseCron('0-5 9-17 * * 1-5');
    expect([...s.minutes]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...s.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses lists', () => {
    const s = parseCron('0,15,30,45 * * * *');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
  });

  it('parses steps on wildcard', () => {
    const s = parseCron('*/15 * * * *');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
  });

  it('parses steps on range', () => {
    const s = parseCron('0 9-17/2 * * *');
    expect([...s.hours]).toEqual([9, 11, 13, 15, 17]);
  });

  it('parses combined list and range', () => {
    const s = parseCron('0 8,12,17 * * *');
    expect([...s.hours]).toEqual([8, 12, 17]);
  });

  it('throws on wrong number of fields', () => {
    expect(() => parseCron('* * *')).toThrow('expected 5 fields');
    expect(() => parseCron('* * * * * *')).toThrow('expected 5 fields');
  });

  it('throws on invalid values', () => {
    expect(() => parseCron('60 * * * *')).toThrow('out of bounds');
    expect(() => parseCron('* 25 * * *')).toThrow('out of bounds');
    expect(() => parseCron('* * 32 * *')).toThrow('out of bounds');
    expect(() => parseCron('* * * 13 *')).toThrow('out of bounds');
    expect(() => parseCron('* * * * 8')).toThrow('out of bounds');
  });

  it('throws on invalid range', () => {
    expect(() => parseCron('10-5 * * * *')).toThrow('out of bounds');
  });

  it('throws on invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow('Invalid step');
  });

  it('throws on non-numeric values', () => {
    expect(() => parseCron('abc * * * *')).toThrow();
  });
});

describe('cronMatches', () => {
  it('matches exact time', () => {
    const schedule = parseCron('30 9 15 6 *');
    // June 15, 2025 at 9:30 — check what day of week it is
    const date = new Date(2025, 5, 15, 9, 30, 0); // month is 0-indexed
    expect(cronMatches(schedule, date)).toBe(true);
  });

  it('does not match wrong minute', () => {
    const schedule = parseCron('30 9 * * *');
    const date = new Date(2025, 0, 1, 9, 31, 0);
    expect(cronMatches(schedule, date)).toBe(false);
  });

  it('does not match wrong hour', () => {
    const schedule = parseCron('30 9 * * *');
    const date = new Date(2025, 0, 1, 10, 30, 0);
    expect(cronMatches(schedule, date)).toBe(false);
  });

  it('matches every-15-minutes schedule', () => {
    const schedule = parseCron('*/15 * * * *');
    expect(cronMatches(schedule, new Date(2025, 0, 1, 0, 0))).toBe(true);
    expect(cronMatches(schedule, new Date(2025, 0, 1, 0, 15))).toBe(true);
    expect(cronMatches(schedule, new Date(2025, 0, 1, 0, 30))).toBe(true);
    expect(cronMatches(schedule, new Date(2025, 0, 1, 0, 45))).toBe(true);
    expect(cronMatches(schedule, new Date(2025, 0, 1, 0, 7))).toBe(false);
  });

  it('matches weekday-only schedule', () => {
    const schedule = parseCron('0 9 * * 1-5');
    // 2025-01-06 is a Monday
    const monday = new Date(2025, 0, 6, 9, 0);
    expect(cronMatches(schedule, monday)).toBe(true);
    // 2025-01-05 is a Sunday
    const sunday = new Date(2025, 0, 5, 9, 0);
    expect(cronMatches(schedule, sunday)).toBe(false);
  });
});
