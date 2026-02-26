import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createX402Middleware, pathMatches, decodePaymentHeader } from './middleware.js';
import type { X402Config, X402PaymentPayload } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReq(
  url = '/',
  headers: Record<string, string | undefined> = {},
  method = 'GET',
): IncomingMessage {
  return { url, headers, method } as unknown as IncomingMessage;
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  writeHead: (status: number, h: Record<string, string | number>) => void;
  end: (data?: string) => void;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, h) {
      this.statusCode = status;
      Object.assign(this.headers, h);
    },
    end(data?: string) {
      if (data) this.body = data;
    },
  };
  return res;
}

function makePayload(overrides: Partial<X402PaymentPayload> = {}): X402PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0xabc',
      authorization: {
        from: '0x1234567890123456789012345678901234567890',
        to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0xdeadbeef',
      },
    },
    ...overrides,
  };
}

function encodePayment(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

const BASE_CONFIG: X402Config = {
  enabled: true,
  server: {
    payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    amount: '1000000',
    network: 'base',
    protectedPaths: ['/sessions', '/sessions/*', '/webhooks/*'],
  },
};

// ---------------------------------------------------------------------------
// pathMatches
// ---------------------------------------------------------------------------

describe('pathMatches', () => {
  it('matches wildcard "*"', () => {
    expect(pathMatches('/anything', '*')).toBe(true);
  });

  it('matches "/**"', () => {
    expect(pathMatches('/foo/bar', '/**')).toBe(true);
  });

  it('matches prefix wildcard "/sessions/*"', () => {
    expect(pathMatches('/sessions/abc', '/sessions/*')).toBe(true);
    expect(pathMatches('/sessions', '/sessions/*')).toBe(true);
  });

  it('does not prefix-match unrelated paths', () => {
    expect(pathMatches('/other', '/sessions/*')).toBe(false);
  });

  it('exact match', () => {
    expect(pathMatches('/sessions', '/sessions')).toBe(true);
    expect(pathMatches('/sessions/abc', '/sessions')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodePaymentHeader
// ---------------------------------------------------------------------------

describe('decodePaymentHeader', () => {
  it('returns null for non-base64 garbage', () => {
    expect(decodePaymentHeader('!!!not base64!!!')).toBeNull();
  });

  it('returns null for valid base64 but non-JSON', () => {
    expect(decodePaymentHeader(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('returns null when x402Version is wrong', () => {
    const bad = { ...makePayload(), x402Version: 2 };
    expect(decodePaymentHeader(encodePayment(bad as unknown as X402PaymentPayload))).toBeNull();
  });

  it('returns null when scheme is missing', () => {
    const bad = { x402Version: 1, network: 'base', payload: { signature: '0x', authorization: { from: '0x1', to: '0x2', value: '1' } } };
    expect(decodePaymentHeader(Buffer.from(JSON.stringify(bad)).toString('base64'))).toBeNull();
  });

  it('parses a valid payload', () => {
    const payload = makePayload();
    const result = decodePaymentHeader(encodePayment(payload));
    expect(result).not.toBeNull();
    expect(result?.network).toBe('base');
    expect(result?.payload.authorization.from).toBe(payload.payload.authorization.from);
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — disabled / null cases
// ---------------------------------------------------------------------------

describe('createX402Middleware — disabled', () => {
  it('returns null when enabled is false', () => {
    expect(createX402Middleware({ enabled: false, server: BASE_CONFIG.server })).toBeNull();
  });

  it('returns null when enabled is missing', () => {
    expect(createX402Middleware({ server: BASE_CONFIG.server })).toBeNull();
  });

  it('returns null when server config is missing', () => {
    expect(createX402Middleware({ enabled: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — public paths pass through
// ---------------------------------------------------------------------------

describe('createX402Middleware — public paths', () => {
  it('passes /health through (returns false)', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/health'), res as unknown as ServerResponse);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(200); // no response written
  });

  it('passes /.well-known/agent.json through', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/.well-known/agent.json'), res as unknown as ServerResponse);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('passes /pair through', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/pair'), res as unknown as ServerResponse);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — unprotected paths pass through
// ---------------------------------------------------------------------------

describe('createX402Middleware — unprotected paths', () => {
  it('passes through paths not in protectedPaths', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/other'), res as unknown as ServerResponse);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — 402 responses
// ---------------------------------------------------------------------------

describe('createX402Middleware — 402 responses', () => {
  it('returns 402 when X-PAYMENT header is absent on a protected path', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/sessions'), res as unknown as ServerResponse);
    expect(result).toBe(true); // handled
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('X402');
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0].payTo).toBe(BASE_CONFIG.server!.payTo);
  });

  it('returns 402 for a sub-path of a wildcard pattern', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/sessions/abc-123'), res as unknown as ServerResponse);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(402);
  });

  it('returns 402 on malformed X-PAYMENT header', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const req = makeReq('/sessions', { 'x-payment': 'not-base64!!!' });
    const result = await handler(req, res as unknown as ServerResponse);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(402);
  });

  it('returns 402 when payment network does not match', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const payload = makePayload({ network: 'ethereum' });
    const req = makeReq('/sessions', { 'x-payment': encodePayment(payload) });
    const result = await handler(req, res as unknown as ServerResponse);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(402);
  });

  it('strips query string before path matching', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const result = await handler(makeReq('/sessions?foo=bar'), res as unknown as ServerResponse);
    expect(result).toBe(true); // protected path, no payment
    expect(res.statusCode).toBe(402);
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — valid payment
// ---------------------------------------------------------------------------

describe('createX402Middleware — valid payment', () => {
  it('tags req._x402Authenticated and returns false on valid payment', async () => {
    const handler = createX402Middleware(BASE_CONFIG)!;
    const res = makeRes();
    const payload = makePayload();
    const req = makeReq('/sessions', { 'x-payment': encodePayment(payload) });
    const result = await handler(req, res as unknown as ServerResponse);
    expect(result).toBe(false); // not handled — continue routing
    expect(res.statusCode).toBe(200); // no 402 written
    expect((req as unknown as Record<string, unknown>)['_x402Authenticated']).toBe(true);
  });

  it('calls verifyPayment and passes when it returns true', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const cfg: X402Config = {
      enabled: true,
      server: { ...BASE_CONFIG.server!, verifyPayment: verify },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    const payload = makePayload();
    const req = makeReq('/sessions', { 'x-payment': encodePayment(payload) });
    const result = await handler(req, res as unknown as ServerResponse);
    expect(result).toBe(false);
    expect(verify).toHaveBeenCalledOnce();
  });

  it('returns 402 when verifyPayment returns false', async () => {
    const verify = vi.fn().mockResolvedValue(false);
    const cfg: X402Config = {
      enabled: true,
      server: { ...BASE_CONFIG.server!, verifyPayment: verify },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    const payload = makePayload();
    const req = makeReq('/sessions', { 'x-payment': encodePayment(payload) });
    const result = await handler(req, res as unknown as ServerResponse);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(402);
    expect(verify).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — per-route pricing
// ---------------------------------------------------------------------------

describe('createX402Middleware — per-route pricing', () => {
  const ROUTE_CONFIG: X402Config = {
    enabled: true,
    server: {
      payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      amount: '1000000',   // global: 1 USDC
      description: 'Global description',
      protectedPaths: ['/sessions', '/sessions/*', '/webhooks/*'],
      routes: [
        { path: '/sessions',    amount: '500000',  description: 'Session route' },
        { path: '/sessions/*',  amount: '250000' },
        { path: '/webhooks/*',  amount: '2000000', description: 'Webhook route' },
      ],
    },
  };

  it('route-specific amount overrides global amount', async () => {
    const handler = createX402Middleware(ROUTE_CONFIG)!;
    const res = makeRes();
    await handler(makeReq('/sessions'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].maxAmountRequired).toBe('500000');
  });

  it('route-specific description overrides global description', async () => {
    const handler = createX402Middleware(ROUTE_CONFIG)!;
    const res = makeRes();
    await handler(makeReq('/sessions'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].description).toBe('Session route');
  });

  it('wildcard route matches sub-path with its amount', async () => {
    const handler = createX402Middleware(ROUTE_CONFIG)!;
    const res = makeRes();
    await handler(makeReq('/sessions/abc'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].maxAmountRequired).toBe('250000');
  });

  it('falls back to global description when route has none', async () => {
    const handler = createX402Middleware(ROUTE_CONFIG)!;
    const res = makeRes();
    await handler(makeReq('/sessions/abc'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].description).toBe('Global description');
  });

  it('path not in routes falls back to global amount', async () => {
    const cfg: X402Config = {
      enabled: true,
      server: {
        payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        amount: '1000000',
        protectedPaths: ['/other'],
        routes: [{ path: '/sessions', amount: '500000' }],
      },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    await handler(makeReq('/other'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].maxAmountRequired).toBe('1000000');
  });

  it('routes: [] (empty) falls back to global amount', async () => {
    const cfg: X402Config = {
      enabled: true,
      server: {
        payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        amount: '1000000',
        protectedPaths: ['/sessions'],
        routes: [],
      },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    await handler(makeReq('/sessions'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].maxAmountRequired).toBe('1000000');
  });

  it('first matching route wins when multiple routes could match', async () => {
    const cfg: X402Config = {
      enabled: true,
      server: {
        payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        amount: '1000000',
        protectedPaths: ['/api/*'],
        routes: [
          { path: '/api/*',     amount: '100000' },
          { path: '/api/data',  amount: '999999' }, // should never be reached for /api/data
        ],
      },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    await handler(makeReq('/api/data'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].maxAmountRequired).toBe('100000');
  });
});

// ---------------------------------------------------------------------------
// createX402Middleware — defaults
// ---------------------------------------------------------------------------

describe('createX402Middleware — defaults', () => {
  it('uses default /* protection when protectedPaths not specified', async () => {
    const cfg: X402Config = {
      enabled: true,
      server: {
        payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        amount: '1000000',
      },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    // Any non-public path should be protected
    const result = await handler(makeReq('/anything'), res as unknown as ServerResponse);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(402);
  });

  it('uses USDC on Base as default asset', async () => {
    const cfg: X402Config = {
      enabled: true,
      server: {
        payTo: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        amount: '500000',
      },
    };
    const handler = createX402Middleware(cfg)!;
    const res = makeRes();
    await handler(makeReq('/protected'), res as unknown as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.accepts[0].asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(body.accepts[0].network).toBe('base');
    expect(body.accepts[0].maxTimeoutSeconds).toBe(300);
  });
});
