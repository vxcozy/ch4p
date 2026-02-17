/**
 * Scheduler tests — lifecycle, job management, and trigger callbacks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops without errors', () => {
    const onTrigger = vi.fn();
    const scheduler = new Scheduler({ onTrigger });

    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it('start is idempotent', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });
    scheduler.start();
    scheduler.start(); // Should not throw or create duplicate timers.
    scheduler.stop();
  });

  it('stop is safe when not running', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });
    scheduler.stop(); // Should not throw.
  });

  it('adds and removes jobs', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });

    scheduler.addJob({ name: 'test', schedule: '*/5 * * * *', message: 'hello' });
    expect(scheduler.size).toBe(1);

    scheduler.addJob({ name: 'test2', schedule: '0 9 * * *', message: 'morning' });
    expect(scheduler.size).toBe(2);

    expect(scheduler.removeJob('test')).toBe(true);
    expect(scheduler.size).toBe(1);

    expect(scheduler.removeJob('nonexistent')).toBe(false);
  });

  it('replaces existing job with same name', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });

    scheduler.addJob({ name: 'test', schedule: '*/5 * * * *', message: 'first' });
    scheduler.addJob({ name: 'test', schedule: '*/10 * * * *', message: 'second' });
    expect(scheduler.size).toBe(1);

    const jobs = scheduler.listJobs();
    expect(jobs[0]?.message).toBe('second');
  });

  it('throws on invalid cron expression', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });
    expect(() => scheduler.addJob({ name: 'bad', schedule: 'invalid', message: 'x' })).toThrow();
  });

  it('listJobs returns clean objects without internal state', () => {
    const scheduler = new Scheduler({ onTrigger: vi.fn() });
    scheduler.addJob({ name: 'test', schedule: '0 9 * * *', message: 'hello' });

    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe('test');
    expect(jobs[0]!.schedule).toBe('0 9 * * *');
    expect(jobs[0]!.message).toBe('hello');
    // Internal `parsed` field should not be exposed.
    expect((jobs[0] as Record<string, unknown>).parsed).toBeUndefined();
  });

  it('triggers matching jobs at the right time', () => {
    const onTrigger = vi.fn();
    // Set current time to 9:00 AM on a Monday (Jan 6, 2025).
    vi.setSystemTime(new Date(2025, 0, 6, 9, 0, 0));

    const scheduler = new Scheduler({ onTrigger, tickMs: 100 });
    scheduler.addJob({ name: 'morning', schedule: '0 9 * * *', message: 'good morning' });
    scheduler.start();

    // The immediate tick should fire the job since we're at 9:00.
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'morning', message: 'good morning' }),
    );

    scheduler.stop();
  });

  it('does not trigger disabled jobs', () => {
    const onTrigger = vi.fn();
    vi.setSystemTime(new Date(2025, 0, 6, 9, 0, 0));

    const scheduler = new Scheduler({ onTrigger, tickMs: 100 });
    scheduler.addJob({
      name: 'disabled',
      schedule: '0 9 * * *',
      message: 'should not fire',
      enabled: false,
    });
    scheduler.start();

    expect(onTrigger).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('does not fire the same minute twice', () => {
    const onTrigger = vi.fn();
    vi.setSystemTime(new Date(2025, 0, 6, 9, 0, 0));

    const scheduler = new Scheduler({ onTrigger, tickMs: 100 });
    scheduler.addJob({ name: 'test', schedule: '0 9 * * *', message: 'hello' });
    scheduler.start();

    // First tick fires.
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Advance 100ms (still same minute) — should not fire again.
    vi.advanceTimersByTime(100);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('fires again in the next matching minute', () => {
    const onTrigger = vi.fn();
    vi.setSystemTime(new Date(2025, 0, 6, 9, 0, 0));

    const scheduler = new Scheduler({ onTrigger, tickMs: 100 });
    scheduler.addJob({ name: 'every-min', schedule: '* * * * *', message: 'tick' });
    scheduler.start();

    // Fires at 9:00.
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Advance to 9:01.
    vi.setSystemTime(new Date(2025, 0, 6, 9, 1, 0));
    vi.advanceTimersByTime(100);
    expect(onTrigger).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('handles trigger callback errors gracefully', () => {
    const onTrigger = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    vi.setSystemTime(new Date(2025, 0, 6, 9, 0, 0));

    const scheduler = new Scheduler({ onTrigger, tickMs: 100 });
    scheduler.addJob({ name: 'boom', schedule: '0 9 * * *', message: 'explode' });

    // Should not throw — error is caught internally.
    expect(() => scheduler.start()).not.toThrow();
    expect(onTrigger).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
