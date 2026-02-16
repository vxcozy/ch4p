/**
 * @ch4p/gateway — session management, message routing, pairing, HTTP control plane,
 * and WebSocket canvas bridge.
 */

export { SessionManager } from './session-manager.js';
export type { SessionState } from './session-manager.js';

export { MessageRouter } from './router.js';
export type { RouteResult } from './router.js';

export { GatewayServer } from './server.js';
export type { GatewayServerOptions } from './server.js';

export { PairingManager } from './pairing.js';
export type { PairingCode, PairedClient, PairingManagerOpts } from './pairing.js';

export { WebSocketBridge } from './ws-bridge.js';
export type { BridgeAgentEvent } from './ws-bridge.js';

export { CanvasSessionManager } from './canvas-session.js';
export type { CanvasSessionEntry } from './canvas-session.js';

export { serveStatic } from './static.js';

export { StreamHandler } from './stream-handler.js';
export type { StreamHandlerOpts, StreamableEvent } from './stream-handler.js';
