/**
 * @ch4p/plugin-x402 — x402 HTTP micropayment plugin
 *
 * Provides two components:
 *
 * **Server-side** (`createX402Middleware`):
 *   Register on GatewayServer via the `preHandler` option to protect gateway
 *   endpoints with HTTP 402 Payment Required. Responds with structured x402
 *   payment requirements and verifies X-PAYMENT headers on retry.
 *
 * **Client-side** (`X402PayTool`):
 *   Register in the agent's ToolRegistry to let the agent pay for x402-gated
 *   resources. Builds the X-PAYMENT header value from a 402 response body.
 *   Plug in an `x402Signer` via toolContextExtensions for live signing.
 *
 * Config key in ~/.ch4p/config.json: `"x402"`
 */

export { createX402Middleware } from './middleware.js';
export type { X402PreHandler } from './middleware.js';
export { pathMatches, decodePaymentHeader } from './middleware.js';

export { X402PayTool } from './x402-pay-tool.js';
export type { X402ToolContext } from './x402-pay-tool.js';

export { createEIP712Signer, walletAddress, KNOWN_TOKENS } from './signer.js';
export type { EIP712SignerOpts } from './signer.js';

export type {
  X402Config,
  X402ClientConfig,
  X402ServerConfig,
  X402Response,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402PaymentAuthorization,
} from './types.js';
