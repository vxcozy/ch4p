/**
 * x402 gateway middleware — server-side payment enforcement.
 *
 * Call createX402Middleware(config) to obtain a pre-handler compatible with
 * GatewayServer's `preHandler` option. For each incoming request the handler:
 *
 *   1. Skips system paths (/health, /.well-known/agent.json, /pair).
 *   2. Skips paths not matched by `protectedPaths`.
 *   3. If no X-PAYMENT header: responds 402 with payment requirements and
 *      returns true (request handled, no further routing).
 *   4. If X-PAYMENT header present: structurally validates the decoded
 *      payload and, if a verifyPayment callback is configured, calls it.
 *      - Invalid or rejected: sends 402 and returns true.
 *      - Valid: tags `req._x402Authenticated = true` and returns false
 *        so the request proceeds through normal routing with pairing auth
 *        bypassed (GatewayServer.checkAuth respects this flag).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { X402Config, X402PaymentRequirements, X402PaymentPayload } from './types.js';

/** Paths always excluded from payment gating. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/.well-known/agent.json',
  '/pair',
]);

/** Default USDC on Base contract address. */
const DEFAULT_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Default network. */
const DEFAULT_NETWORK = 'base';

/** Default payment timeout in seconds. */
const DEFAULT_TIMEOUT = 300;

/**
 * Returns true if urlPath matches the protection pattern.
 *
 * Pattern rules:
 *   - "*" or "/**": matches every path
 *   - "/foo/*": prefix match — matches /foo and /foo/bar/baz
 *   - "/foo": exact match only
 */
export function pathMatches(urlPath: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '/**') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return urlPath === prefix || urlPath.startsWith(prefix + '/');
  }
  return urlPath === pattern;
}

/** Strip query string from a URL to get the path only. */
function extractPath(url: string): string {
  const qIdx = url.indexOf('?');
  return qIdx >= 0 ? url.slice(0, qIdx) : url;
}

/** Send a 402 Payment Required response with the x402 JSON body. */
function send402(res: ServerResponse, requirements: X402PaymentRequirements): void {
  const body = JSON.stringify({
    x402Version: 1,
    error: 'X402',
    accepts: [requirements],
  });
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Decode and structurally validate the X-PAYMENT header value.
 * Returns null on any parse or structure failure.
 */
export function decodePaymentHeader(header: string): X402PaymentPayload | null {
  try {
    const json = Buffer.from(header, 'base64').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;

    const p = parsed as Record<string, unknown>;
    if (p['x402Version'] !== 1) return null;
    if (p['scheme'] !== 'exact') return null;
    if (typeof p['network'] !== 'string') return null;

    const payload = p['payload'];
    if (typeof payload !== 'object' || payload === null) return null;
    const pl = payload as Record<string, unknown>;
    if (typeof pl['signature'] !== 'string') return null;

    const auth = pl['authorization'];
    if (typeof auth !== 'object' || auth === null) return null;
    const a = auth as Record<string, unknown>;
    if (
      typeof a['from'] !== 'string' ||
      typeof a['to'] !== 'string' ||
      typeof a['value'] !== 'string'
    ) {
      return null;
    }

    return parsed as X402PaymentPayload;
  } catch {
    return null;
  }
}

export type X402PreHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Create an x402 middleware pre-handler for GatewayServer.
 *
 * Returns null when x402 is disabled or no server config is provided.
 *
 * @param config x402 plugin configuration
 * @returns Pre-handler function, or null if x402 is not enabled.
 */
export function createX402Middleware(config: X402Config): X402PreHandler | null {
  if (!config.enabled || !config.server) return null;

  const serverCfg = config.server;
  const asset = serverCfg.asset ?? DEFAULT_ASSET;
  const network = serverCfg.network ?? DEFAULT_NETWORK;
  const maxTimeoutSeconds = serverCfg.maxTimeoutSeconds ?? DEFAULT_TIMEOUT;
  const description =
    serverCfg.description ?? 'Payment required to access this gateway resource.';
  const protectedPaths = serverCfg.protectedPaths ?? ['/*'];

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawUrl = req.url ?? '/';
    const urlPath = extractPath(rawUrl);

    // Never gate well-known system paths.
    if (PUBLIC_PATHS.has(urlPath)) return false;

    // Only gate paths listed in protectedPaths.
    const isProtected = protectedPaths.some((p) => pathMatches(urlPath, p));
    if (!isProtected) return false;

    // Per-route pricing: find the first route whose path pattern matches.
    const matchedRoute = serverCfg.routes?.find((r) => pathMatches(urlPath, r.path));
    const effectiveAmount = matchedRoute?.amount ?? serverCfg.amount;
    const effectiveDescription =
      matchedRoute?.description ?? description;

    const requirements: X402PaymentRequirements = {
      scheme: 'exact',
      network,
      maxAmountRequired: effectiveAmount,
      resource: urlPath,
      description: effectiveDescription,
      mimeType: 'application/json',
      payTo: serverCfg.payTo,
      maxTimeoutSeconds,
      asset,
      extra: {},
    };

    const paymentHeader = req.headers['x-payment'];
    if (!paymentHeader || typeof paymentHeader !== 'string') {
      send402(res, requirements);
      return true; // handled — no further routing
    }

    const payment = decodePaymentHeader(paymentHeader);
    if (!payment) {
      send402(res, requirements);
      return true; // handled — malformed header
    }

    // Network mismatch — reject.
    if (payment.network !== network) {
      send402(res, requirements);
      return true;
    }

    // Optional on-chain verifier.
    if (serverCfg.verifyPayment) {
      const allowed = await serverCfg.verifyPayment(payment, requirements);
      if (!allowed) {
        send402(res, requirements);
        return true;
      }
    }

    // Payment accepted — tag the request so checkAuth bypasses pairing.
    (req as unknown as Record<string, unknown>)['_x402Authenticated'] = true;
    return false; // continue routing
  };
}
