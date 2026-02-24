/**
 * Scheduler — cron-based job runner for the ch4p gateway.
 *
 * Runs a 60-second tick loop (matching HealthMonitor pattern) that checks
 * all registered cron jobs against the current time. When a job's schedule
 * matches, it fires the `onTrigger` callback with the job details.
 *
 * The timer is `.unref()`ed so it doesn't keep the process alive.
 *
 * Usage:
 *   const scheduler = new Scheduler({ onTrigger: (job) => handleCronMessage(job) });
 *   scheduler.addJob({ name: 'daily-summary', schedule: '0 9 * * *', message: 'Give me a daily summary' });
 *   scheduler.start();
 */

import { parseCron, cronMatches, type CronSchedule } from './cron-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronJob {
  /** Unique name for this job. */
  name: string;
  /** Cron expression (5 fields: minute hour dom month dow). */
  schedule: string;
  /** The message to send when the cron fires. */
  message: string;
  /** Whether this job is enabled. Default: true. */
  enabled?: boolean;
  /** Optional userId to attribute the cron message to. */
  userId?: string;
}

export interface SchedulerOptions {
  /** Called when a cron job triggers. */
  onTrigger: (job: CronJob) => void;
  /** Tick interval in milliseconds. Default: 60000 (1 minute). */
  tickMs?: number;
}

interface InternalJob extends CronJob {
  parsed: CronSchedule;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly onTrigger: (job: CronJob) => void;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMinute = -1;

  constructor(opts: SchedulerOptions) {
    this.onTrigger = opts.onTrigger;
    this.tickMs = opts.tickMs ?? 60_000;
  }

  /**
   * Add or replace a cron job. Validates the schedule eagerly.
   * Throws if the cron expression is invalid.
   */
  addJob(job: CronJob): void {
    const parsed = parseCron(job.schedule);
    this.jobs.set(job.name, { ...job, enabled: job.enabled ?? true, parsed });
  }

  /**
   * Remove a job by name. Returns true if removed.
   */
  removeJob(name: string): boolean {
    return this.jobs.delete(name);
  }

  /**
   * List all registered jobs.
   */
  listJobs(): CronJob[] {
    return [...this.jobs.values()].map(({ parsed: _p, ...rest }) => rest);
  }

  /**
   * Get the number of registered jobs.
   */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Start the tick loop. Idempotent — calling start() while running is a no-op.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref(); // Don't keep the process alive.

    // Run an immediate tick so we don't wait up to 60s for the first check.
    this.tick();
  }

  /**
   * Stop the tick loop. Safe to call when not running.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether the scheduler is currently running.
   */
  get running(): boolean {
    return this.timer !== null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private tick(): void {
    const now = new Date();
    // Use epoch-based minute to avoid DST duplicate/skip issues.
    const currentMinute = Math.floor(Date.now() / 60_000);

    // Deduplicate: only fire once per calendar minute.
    if (currentMinute === this.lastTickMinute) return;
    this.lastTickMinute = currentMinute;

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;

      if (cronMatches(job.parsed, now)) {
        try {
          this.onTrigger(job);
        } catch {
          // Don't let a single job failure crash the scheduler.
        }
      }
    }
  }
}
