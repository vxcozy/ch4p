/**
 * WebSocketBridge — connects a WebSocket client to a canvas session.
 *
 * Responsibilities:
 *   1. Subscribe to CanvasState changes → serialize S2C messages to WebSocket
 *   2. Receive C2S messages from WebSocket → route to CanvasChannel or CanvasState
 *   3. Accept AgentEvent pushes → forward as S2C agent status / text events
 *   4. Handle ping/pong keepalive
 *
 * One bridge instance per connected WebSocket session.
 */

import type { WebSocket } from 'ws';
import type { CanvasState } from '@ch4p/canvas';
import type { CanvasChannel } from '@ch4p/canvas';
import type { S2CMessage, C2SMessage } from '@ch4p/canvas';
import { encodeMessage } from '@ch4p/canvas';

/**
 * Subset of AgentEvent types relevant to the canvas bridge.
 * Kept minimal to avoid a hard dependency on @ch4p/agent.
 */
export interface BridgeAgentEvent {
  type: string;
  delta?: string;
  partial?: string;
  answer?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: Error;
  reason?: string;
}

export class WebSocketBridge {
  private changeUnsubscribe: (() => void) | null = null;
  private alive = false;
  private messageHandler: ((data: Buffer | ArrayBuffer | Buffer[]) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly canvasState: CanvasState,
    private readonly canvasChannel: CanvasChannel,
    private readonly sessionId: string,
  ) {}

  /** Start the bridge — subscribe to state changes and handle incoming messages. */
  start(): void {
    this.alive = true;

    // Subscribe to canvas state changes → push to client
    this.changeUnsubscribe = this.canvasState.onChange((change) => {
      this.send({ type: 's2c:canvas:change', change });
    });

    // Send initial full snapshot so client can render current state
    this.send({
      type: 's2c:canvas:snapshot',
      snapshot: this.canvasState.getSnapshot(),
    });

    // Send initial idle status
    this.send({ type: 's2c:agent:status', status: 'idle' });

    // Handle incoming WebSocket messages — store refs so stop() can remove them.
    this.messageHandler = (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = Buffer.isBuffer(data)
          ? data.toString('utf-8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf-8')
            : Buffer.from(data).toString('utf-8');
        const msg = JSON.parse(raw) as C2SMessage;
        this.handleC2S(msg);
      } catch {
        this.send({
          type: 's2c:error',
          code: 'PARSE_ERROR',
          message: 'Invalid message format',
        });
      }
    };
    this.closeHandler = () => this.stop();
    this.errorHandler = () => this.stop();

    this.ws.on('message', this.messageHandler);
    this.ws.on('close', this.closeHandler);
    this.ws.on('error', this.errorHandler);
  }

  /** Called by the gateway when AgentEvents arrive from the agent loop. */
  handleAgentEvent(event: BridgeAgentEvent): void {
    if (!this.alive) return;

    switch (event.type) {
      case 'thinking':
        this.send({ type: 's2c:agent:status', status: 'thinking' });
        break;

      case 'text':
        this.send({ type: 's2c:agent:status', status: 'streaming' });
        this.send({
          type: 's2c:text:delta',
          delta: event.delta ?? '',
          partial: event.partial ?? '',
        });
        break;

      case 'tool_start':
        this.send({
          type: 's2c:agent:status',
          status: 'tool_executing',
          tool: event.tool,
        });
        this.send({
          type: 's2c:tool:start',
          tool: event.tool ?? '',
          data: event.args,
        });
        break;

      case 'tool_progress':
        this.send({
          type: 's2c:tool:progress',
          tool: event.tool ?? '',
          data: event.result,
        });
        break;

      case 'tool_end':
        this.send({
          type: 's2c:tool:end',
          tool: event.tool ?? '',
          data: event.result,
        });
        break;

      case 'complete':
        this.send({
          type: 's2c:text:complete',
          text: event.answer ?? '',
        });
        this.send({ type: 's2c:agent:status', status: 'complete' });
        break;

      case 'error':
        this.send({
          type: 's2c:agent:status',
          status: 'error',
          message: event.error?.message ?? 'Unknown error',
        });
        this.send({
          type: 's2c:error',
          code: 'AGENT_ERROR',
          message: event.error?.message ?? 'Unknown error',
        });
        break;

      case 'aborted':
        this.send({
          type: 's2c:agent:status',
          status: 'idle',
          message: `Aborted: ${event.reason ?? 'unknown'}`,
        });
        break;
    }
  }

  /** Stop the bridge — unsubscribe from state changes and remove WS listeners. */
  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    this.changeUnsubscribe?.();
    this.changeUnsubscribe = null;
    if (this.messageHandler) { this.ws.off('message', this.messageHandler); this.messageHandler = null; }
    if (this.closeHandler) { this.ws.off('close', this.closeHandler); this.closeHandler = null; }
    if (this.errorHandler) { this.ws.off('error', this.errorHandler); this.errorHandler = null; }
  }

  /** Whether the bridge is currently active. */
  isAlive(): boolean {
    return this.alive;
  }

  /** Get the session ID this bridge is connected to. */
  getSessionId(): string {
    return this.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleC2S(msg: C2SMessage): void {
    switch (msg.type) {
      case 'c2s:ping':
        this.send({ type: 's2c:pong', timestamp: new Date().toISOString() });
        break;

      case 'c2s:drag':
        // User-side drag updates server state directly (no agent involvement)
        this.canvasState.moveComponent(msg.componentId, msg.position);
        break;

      case 'c2s:abort':
        // Abort is handled at a higher level by the gateway command
        // Forward as a special message so the gateway can abort the agent loop
        this.canvasChannel.handleClientMessage(msg);
        break;

      default:
        // All other C2S messages go through the channel to the agent
        this.canvasChannel.handleClientMessage(msg);
        break;
    }
  }

  private send(msg: S2CMessage): void {
    if (this.alive && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(encodeMessage(msg));
    }
  }
}
