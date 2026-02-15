/**
 * @ch4p/gateway — session management, message routing, pairing, and HTTP control plane.
 */

export { SessionManager } from './session-manager.js';
export type { SessionState } from './session-manager.js';

export { MessageRouter } from './router.js';
export type { RouteResult } from './router.js';

export { GatewayServer } from './server.js';
export type { GatewayServerOptions } from './server.js';

export { PairingManager } from './pairing.js';
export type { PairingCode, PairedClient, PairingManagerOpts } from './pairing.js';
