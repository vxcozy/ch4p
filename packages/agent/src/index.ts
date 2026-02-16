/**
 * @ch4p/agent — agent runtime package.
 *
 * Core agent loop with session management, context handling,
 * live steering, worker pool, and AWM-inspired verification.
 */

export { SteeringQueue } from './steering.js';
export type { SteeringMessage, SteeringMessageType } from './steering.js';

export { ContextManager, NAMED_STRATEGIES } from './context.js';
export type { ContextManagerOpts, CompactionStrategy, NamedStrategy } from './context.js';

export { ToolWorkerPool } from './worker-pool.js';
export type {
  WorkerPoolOpts,
  WorkerTask,
  WorkerTaskContext,
  PoolStats,
} from './worker-pool.js';

export { Session } from './session.js';
export type { SessionState, SessionMetadata, SessionOpts } from './session.js';

export { AgentLoop } from './agent-loop.js';
export type { AgentEvent, AgentLoopOpts } from './agent-loop.js';

export { FormatVerifier } from './format-verifier.js';
export type { FormatVerifierOpts, FormatRule } from './format-verifier.js';

export { LLMVerifier } from './llm-verifier.js';
export type { LLMVerifierOpts } from './llm-verifier.js';

export { createAutoRecallHook, createAutoSummarizeHook } from './auto-memory.js';
export type { AutoRecallOpts, AutoSummarizeOpts } from './auto-memory.js';
