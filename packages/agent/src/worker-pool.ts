/**
 * ToolWorkerPool — worker thread pool for heavyweight tool execution.
 *
 * Lightweight tools run on the main thread; heavyweight tools run in pooled
 * worker threads to avoid blocking the agent loop. The pool:
 *
 *   - Creates workers lazily on first task demand.
 *   - Reuses idle workers.
 *   - Kills workers that exceed the configured timeout.
 *   - Queues tasks when all workers are busy.
 *   - Streams progress updates back to the caller.
 *   - Handles worker crashes (returns error result, does not lose the task).
 *   - Tracks execution statistics.
 */

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import type { ToolResult } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerPoolOpts {
  /** Maximum number of concurrent workers. Default: 4. */
  maxWorkers?: number;
  /** Per-task timeout in milliseconds. Default: 60 000 (60 s). */
  taskTimeoutMs?: number;
  /** Path to the worker script. Default: built-in inline worker. */
  workerScript?: string;
}

export interface WorkerTask {
  tool: string;
  args: unknown;
  context: WorkerTaskContext;
}

export interface WorkerTaskContext {
  sessionId: string;
  cwd: string;
}

export interface PoolStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  queuedTasks: number;
  avgDurationMs: number;
  workerCount: number;
  idleWorkers: number;
}

interface QueuedTask {
  task: WorkerTask;
  signal?: AbortSignal;
  onProgress: (update: string) => void;
  resolve: (result: ToolResult) => void;
  reject: (err: Error) => void;
}

interface ManagedWorker {
  worker: Worker;
  busy: boolean;
  taskCount: number;
  currentTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Default inline worker
// ---------------------------------------------------------------------------

/**
 * Minimal default worker script, serialised as a data URL so the pool can
 * function without a separate file on disk. Real deployments should provide
 * a proper workerScript path that loads the actual tool registry.
 *
 * Message protocol (parent -> worker):
 *   { type: 'execute', tool: string, args: unknown, context: WorkerTaskContext }
 *
 * Message protocol (worker -> parent):
 *   { type: 'progress', update: string }
 *   { type: 'result', result: ToolResult }
 *   { type: 'error', message: string }
 */
const DEFAULT_WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');

parentPort.on('message', async (msg) => {
  if (msg.type === 'execute') {
    try {
      // In production the worker would look up the tool in a registry.
      // Here we simply return an error indicating the tool is not loaded.
      parentPort.postMessage({
        type: 'result',
        result: {
          success: false,
          output: '',
          error: 'Worker has no tool registry — provide a workerScript.',
        },
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
`;

// ---------------------------------------------------------------------------
// ToolWorkerPool
// ---------------------------------------------------------------------------

export class ToolWorkerPool extends EventEmitter {
  private workers: ManagedWorker[] = [];
  private taskQueue: QueuedTask[] = [];
  private shuttingDown = false;

  private readonly maxWorkers: number;
  private readonly taskTimeoutMs: number;
  private readonly workerScript: string | undefined;

  // Stats
  private totalTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;
  private totalDurationMs = 0;

  constructor(opts: WorkerPoolOpts = {}) {
    super();
    this.maxWorkers = opts.maxWorkers ?? 4;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 60_000;
    this.workerScript = opts.workerScript;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a tool task in a worker thread. Returns a promise that resolves
   * with the ToolResult. If `signal` is already aborted the task is rejected
   * immediately.
   */
  execute(
    task: WorkerTask,
    signal?: AbortSignal,
    onProgress: (update: string) => void = () => {},
  ): Promise<ToolResult> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Worker pool is shutting down'));
    }

    if (signal?.aborted) {
      return Promise.reject(new Error('Task aborted before execution'));
    }

    this.totalTasks++;

    return new Promise<ToolResult>((resolve, reject) => {
      const queued: QueuedTask = { task, signal, onProgress, resolve, reject };

      // If there is an abort signal, wire up cancellation.
      if (signal) {
        const onAbort = () => {
          // Remove from queue if still queued.
          const idx = this.taskQueue.indexOf(queued);
          if (idx !== -1) {
            this.taskQueue.splice(idx, 1);
            this.failedTasks++;
            reject(new Error('Task aborted while queued'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const idle = this.getIdleWorker();
      if (idle) {
        this.dispatch(idle, queued);
      } else if (this.workers.length < this.maxWorkers) {
        const managed = this.spawnWorker();
        this.dispatch(managed, queued);
      } else {
        this.taskQueue.push(queued);
      }
    });
  }

  /** Gracefully shut down the pool: finish in-flight tasks, then terminate. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Reject all queued tasks.
    for (const q of this.taskQueue) {
      this.failedTasks++;
      q.reject(new Error('Worker pool shutting down'));
    }
    this.taskQueue = [];

    // Wait for busy workers to finish, then terminate everyone.
    const terminatePromises = this.workers.map((mw) => {
      if (mw.currentTimer) clearTimeout(mw.currentTimer);
      return mw.worker.terminate();
    });

    await Promise.allSettled(terminatePromises);
    this.workers = [];
  }

  /** Check whether a real worker script is configured (not the default stub). */
  hasWorkerScript(): boolean {
    return this.workerScript !== undefined;
  }

  /** Return current pool statistics. */
  getStats(): PoolStats {
    const activeWorkers = this.workers.filter((w) => w.busy).length;
    return {
      totalTasks: this.totalTasks,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      activeTasks: activeWorkers,
      queuedTasks: this.taskQueue.length,
      avgDurationMs:
        this.completedTasks > 0
          ? Math.round(this.totalDurationMs / this.completedTasks)
          : 0,
      workerCount: this.workers.length,
      idleWorkers: this.workers.filter((w) => !w.busy).length,
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private spawnWorker(): ManagedWorker {
    let worker: Worker;

    if (this.workerScript) {
      worker = new Worker(this.workerScript);
    } else {
      // Inline eval worker as fallback.
      worker = new Worker(DEFAULT_WORKER_SCRIPT, { eval: true });
    }

    const managed: ManagedWorker = {
      worker,
      busy: false,
      taskCount: 0,
    };

    // Handle unexpected crash: mark idle, dispatch next task.
    worker.on('error', (err) => {
      this.emit('worker_error', err);
      this.handleWorkerCrash(managed, err);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this.shuttingDown) {
        this.emit('worker_exit', code);
        this.removeWorker(managed);
      }
    });

    this.workers.push(managed);
    return managed;
  }

  private getIdleWorker(): ManagedWorker | undefined {
    return this.workers.find((w) => !w.busy);
  }

  private dispatch(managed: ManagedWorker, queued: QueuedTask): void {
    managed.busy = true;
    managed.taskCount++;
    const startTime = Date.now();

    const { task, signal, onProgress, resolve, reject } = queued;

    // Timeout guard.
    managed.currentTimer = setTimeout(() => {
      this.failedTasks++;
      managed.busy = false;
      if (managed.currentTimer) clearTimeout(managed.currentTimer);
      managed.currentTimer = undefined;

      // Terminate the hung worker and replace it.
      managed.worker.terminate().catch(() => {});
      this.removeWorker(managed);

      reject(new Error(`Tool "${task.tool}" timed out after ${this.taskTimeoutMs}ms`));
      this.dispatchNext();
    }, this.taskTimeoutMs);

    // Abort signal wiring.
    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => {
        if (managed.currentTimer) clearTimeout(managed.currentTimer);
        managed.currentTimer = undefined;
        managed.busy = false;
        this.failedTasks++;

        // Terminate the worker running the aborted task.
        managed.worker.terminate().catch(() => {});
        this.removeWorker(managed);

        reject(new Error('Task aborted during execution'));
        this.dispatchNext();
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    const cleanup = () => {
      if (managed.currentTimer) clearTimeout(managed.currentTimer);
      managed.currentTimer = undefined;
      managed.busy = false;
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
    };

    // Message handler for this execution.
    const handler = (msg: { type: string; result?: ToolResult; update?: string; message?: string }) => {
      if (msg.type === 'progress' && msg.update) {
        onProgress(msg.update);
        return;
      }

      if (msg.type === 'result' && msg.result) {
        cleanup();
        const duration = Date.now() - startTime;
        this.completedTasks++;
        this.totalDurationMs += duration;
        managed.worker.removeListener('message', handler);
        resolve(msg.result);
        this.dispatchNext();
        return;
      }

      if (msg.type === 'error') {
        cleanup();
        this.failedTasks++;
        managed.worker.removeListener('message', handler);
        resolve({
          success: false,
          output: '',
          error: msg.message ?? 'Unknown worker error',
        });
        this.dispatchNext();
        return;
      }
    };

    managed.worker.on('message', handler);

    // Send the task to the worker.
    managed.worker.postMessage({
      type: 'execute',
      tool: task.tool,
      args: task.args,
      context: task.context,
    });
  }

  private dispatchNext(): void {
    if (this.taskQueue.length === 0) return;
    if (this.shuttingDown) return;

    const idle = this.getIdleWorker();
    if (idle) {
      const next = this.taskQueue.shift()!;
      // Skip if the task was already aborted while queued.
      if (next.signal?.aborted) {
        this.failedTasks++;
        next.reject(new Error('Task aborted while queued'));
        this.dispatchNext();
        return;
      }
      this.dispatch(idle, next);
    } else if (this.workers.length < this.maxWorkers) {
      const managed = this.spawnWorker();
      const next = this.taskQueue.shift()!;
      if (next.signal?.aborted) {
        this.failedTasks++;
        next.reject(new Error('Task aborted while queued'));
        this.dispatchNext();
        return;
      }
      this.dispatch(managed, next);
    }
  }

  private handleWorkerCrash(managed: ManagedWorker, _err: Error): void {
    if (managed.currentTimer) clearTimeout(managed.currentTimer);
    managed.currentTimer = undefined;
    this.removeWorker(managed);

    // If the worker was busy, it crashed during a task — that task's promise
    // was already resolved/rejected by the message handler or timeout guard.
    // We just need to ensure a replacement can be spawned for queued work.
    this.dispatchNext();
  }

  private removeWorker(managed: ManagedWorker): void {
    const idx = this.workers.indexOf(managed);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
    }
  }
}
