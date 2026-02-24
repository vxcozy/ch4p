/**
 * X402PayTool — agent tool for paying x402-gated resources.
 *
 * When an HTTP request returns 402 Payment Required with an x402 response
 * body, the agent uses this tool to construct the X-PAYMENT header value
 * required to retry the request with proof of payment.
 *
 * The tool produces a structurally correct EIP-3009 payment payload.
 * Actual signing (EIP-712 transferWithAuthorization) is delegated to an
 * optional `x402Signer` callback in the tool context. Without a signer,
 * the payload includes a placeholder signature clearly marked as unsigned
 * — suitable for development and testing.
 */

import type { ITool, ToolContext, ToolResult, ValidationResult, JSONSchema7 } from '@ch4p/core';
import type { X402Response, X402PaymentAuthorization, X402PaymentPayload } from './types.js';

/**
 * Extended ToolContext for x402 payment operations.
 *
 * x402Signer and agentWalletAddress are now part of the base ToolContext
 * in @ch4p/core, so this is a plain alias kept for backward compatibility.
 */
export type X402ToolContext = ToolContext;

interface X402PayArgs {
  url: string;
  x402_response: string;
  wallet_address?: string;
}

/** Placeholder signature used when no signer is available. */
const PLACEHOLDER_SIG =
  '0x0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

export class X402PayTool implements ITool {
  readonly name = 'x402_pay';
  readonly description =
    'Generate an X-PAYMENT header for a resource that returned HTTP 402 Payment Required. ' +
    'Provide the 402 response body JSON and a payer wallet address. ' +
    'Returns the base64-encoded X-PAYMENT value to include when retrying the request. ' +
    'Full payment execution requires an IIdentityProvider with wallet signing support.';

  readonly weight = 'lightweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL of the resource that returned 402 (used to match the requirement).',
        minLength: 1,
      },
      x402_response: {
        type: 'string',
        description:
          'The JSON body of the 402 response. Stringify the x402 error response object.',
        minLength: 2,
      },
      wallet_address: {
        type: 'string',
        description:
          'Payer wallet address (0x + 40 hex chars). ' +
          'If omitted, the identity provider wallet address is used when available.',
        pattern: '^0x[0-9a-fA-F]{40}$',
      },
    },
    required: ['url', 'x402_response'],
    additionalProperties: false,
  };

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }
    const { url, x402_response, wallet_address } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push('url must be a non-empty string.');
    }
    if (typeof x402_response !== 'string' || x402_response.trim().length === 0) {
      errors.push('x402_response must be a non-empty string.');
    }
    if (wallet_address !== undefined) {
      if (
        typeof wallet_address !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(wallet_address)
      ) {
        errors.push('wallet_address must be a valid Ethereum address (0x + 40 hex chars).');
      }
    }
    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validation = this.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `Invalid arguments: ${validation.errors!.join(' ')}`,
      };
    }

    const { url, x402_response, wallet_address } = args as X402PayArgs;
    const x402Context = context as X402ToolContext;

    // Parse the 402 response body.
    let response: X402Response;
    try {
      response = JSON.parse(x402_response) as X402Response;
    } catch {
      return { success: false, output: '', error: 'x402_response is not valid JSON.' };
    }

    if (!Array.isArray(response.accepts) || response.accepts.length === 0) {
      return {
        success: false,
        output: '',
        error: 'x402 response contains no payment requirements in "accepts".',
      };
    }

    // Prefer Base network, fall back to first exact scheme, then first entry.
    const requirements =
      response.accepts.find((r) => r.scheme === 'exact' && r.network === 'base') ??
      response.accepts.find((r) => r.scheme === 'exact') ??
      response.accepts[0]!;

    // Determine payer wallet address (explicit arg takes priority).
    const payer = wallet_address ?? x402Context.agentWalletAddress;
    if (!payer) {
      return {
        success: false,
        output: '',
        error:
          'No wallet address available. Provide wallet_address or configure ' +
          'agentWalletAddress via toolContextExtensions in the agent runtime.',
      };
    }

    // Build EIP-3009 authorization struct.
    const nowSecs = Math.floor(Date.now() / 1000);
    const randomBytes = new Uint8Array(32);
    if (typeof globalThis.crypto !== 'undefined') {
      globalThis.crypto.getRandomValues(randomBytes);
    } else {
      // Fallback for environments without Web Crypto (should not happen in Node 22+).
      // WARNING: Math.random() is not cryptographically secure — nonce may be predictable.
      console.warn('x402: crypto.getRandomValues unavailable; using insecure Math.random fallback for nonce.');
      for (let i = 0; i < 32; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const nonce =
      '0x' + Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

    const authorization: X402PaymentAuthorization = {
      from: payer,
      to: requirements.payTo,
      value: requirements.maxAmountRequired,
      validAfter: '0',
      validBefore: String(nowSecs + requirements.maxTimeoutSeconds),
      nonce,
    };

    // Sign if a signer is available, otherwise emit a placeholder.
    let signature: string;
    let unsigned = false;
    if (x402Context.x402Signer) {
      try {
        signature = await x402Context.x402Signer(authorization);
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `Signing failed: ${(err as Error).message}`,
        };
      }
    } else {
      signature = PLACEHOLDER_SIG;
      unsigned = true;
    }

    const paymentPayload: X402PaymentPayload = {
      x402Version: 1,
      scheme: 'exact',
      network: requirements.network,
      payload: { signature, authorization },
    };

    const headerValue = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const lines: string[] = [
      `Resource:  ${url}`,
      `Network:   ${requirements.network}`,
      `Amount:    ${requirements.maxAmountRequired} (asset ${requirements.asset})`,
      `Pay to:    ${requirements.payTo}`,
      `From:      ${payer}`,
      '',
      'X-PAYMENT header value (add to your retry request):',
      headerValue,
    ];

    if (unsigned) {
      lines.push(
        '',
        'WARNING: Placeholder signature — cannot be used for real on-chain payments.',
        'Configure an IIdentityProvider with a bound wallet to enable live signing.',
      );
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        headerValue,
        network: requirements.network,
        amount: requirements.maxAmountRequired,
        payTo: requirements.payTo,
        asset: requirements.asset,
        unsigned,
      },
    };
  }
}
