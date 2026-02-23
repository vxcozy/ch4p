/**
 * x402 Payment Required protocol types.
 *
 * Based on the x402 open standard for HTTP micropayments.
 * Reference: https://www.x402.org
 */

/**
 * Payment requirement describing what is needed to access a resource.
 * Returned as part of the 402 Payment Required response body.
 */
export interface X402PaymentRequirements {
  /** Always "exact" — pay exactly this amount. */
  scheme: 'exact';
  /** Network identifier (e.g. "base", "base-sepolia", "ethereum"). */
  network: string;
  /** Amount in the asset's smallest unit (e.g. "1000000" = 1 USDC at 6 decimals). */
  maxAmountRequired: string;
  /** The URL path being protected (e.g. "/api/data"). */
  resource: string;
  /** Human-readable payment description shown to the payer. */
  description: string;
  /** MIME type of the gated resource (e.g. "application/json"). */
  mimeType: string;
  /** Wallet address that receives the payment. */
  payTo: string;
  /** Seconds before the payment authorization expires. */
  maxTimeoutSeconds: number;
  /** ERC-20 token contract address (zero address "0x0" for native ETH). */
  asset: string;
  /** Scheme-specific extra data. */
  extra: Record<string, unknown>;
}

/**
 * Body of an HTTP 402 Payment Required response.
 */
export interface X402Response {
  x402Version: 1;
  error: 'X402';
  accepts: X402PaymentRequirements[];
}

/**
 * EIP-3009 transferWithAuthorization parameters.
 * Embedded inside X402PaymentPayload.payload.
 */
export interface X402PaymentAuthorization {
  /** Payer wallet address. */
  from: string;
  /** Recipient wallet address (must match payTo). */
  to: string;
  /** Transfer amount in the asset's smallest unit. */
  value: string;
  /** Unix timestamp (seconds) after which the auth is valid. Use "0" for immediate. */
  validAfter: string;
  /** Unix timestamp (seconds) before which the auth must be submitted. */
  validBefore: string;
  /** Random 32-byte nonce (0x hex) to prevent replay attacks. */
  nonce: string;
}

/**
 * Payment proof sent in the X-PAYMENT HTTP header (base64-encoded JSON).
 */
export interface X402PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: {
    /** EIP-712 signature over the EIP-3009 authorization struct. */
    signature: string;
    authorization: X402PaymentAuthorization;
  };
}

/**
 * Server-side x402 protection configuration.
 */
export interface X402ServerConfig {
  /** Wallet address that receives payments. */
  payTo: string;
  /**
   * Payment amount in the asset's smallest unit.
   * Example: "1000000" = 1 USDC (6 decimals).
   */
  amount: string;
  /**
   * ERC-20 token contract address.
   * Defaults to USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
   */
  asset?: string;
  /**
   * Network identifier.
   * Defaults to "base".
   */
  network?: string;
  /** Human-readable description shown in the 402 response. */
  description?: string;
  /**
   * URL paths to gate. Supports trailing "/*" wildcard suffix.
   * Examples: "/sessions", "/webhooks/*", "/*" (all paths).
   * Default: all paths except /health, /.well-known/agent.json, and /pair.
   */
  protectedPaths?: string[];
  /** Seconds before a payment authorization expires. Default: 300. */
  maxTimeoutSeconds?: number;
  /**
   * Optional payment verifier. Called with the decoded payment and the
   * active requirements after the X-PAYMENT header passes structural
   * validation. Return true to grant access, false to re-issue 402.
   *
   * If omitted, structural validity of the X-PAYMENT header is sufficient.
   * For production deployments, provide an on-chain verifier that calls
   * transferWithAuthorization on the ERC-20 asset contract.
   */
  verifyPayment?: (
    payment: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ) => Promise<boolean>;
}

/**
 * Client-side wallet configuration for signing x402 payment authorizations.
 * Set `x402.client.privateKey` (or `${X402_PRIVATE_KEY}` env substitution)
 * in ~/.ch4p/config.json to enable live on-chain payments.
 */
export interface X402ClientConfig {
  /**
   * 0x-prefixed hex private key used to sign EIP-712 payment authorizations.
   * Supports env-var substitution: `"${X402_PRIVATE_KEY}"`.
   *
   * ⚠️  Never commit a real private key to source control.
   */
  privateKey?: string;
  /**
   * ERC-20 token contract address.
   * Default: USDC on Base mainnet (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
   */
  tokenAddress?: string;
  /**
   * EIP-712 domain chain ID.
   * Default: 8453 (Base mainnet).
   */
  chainId?: number;
  /**
   * EIP-712 domain token name.
   * Default: "USD Coin".
   */
  tokenName?: string;
  /**
   * EIP-712 domain token version.
   * Default: "2".
   */
  tokenVersion?: string;
}

/**
 * Top-level x402 plugin configuration (added to ~/.ch4p/config.json).
 */
export interface X402Config {
  /** Whether x402 payment enforcement is active. Default: false. */
  enabled?: boolean;
  /** Server-side: protect gateway endpoints with payment requirements. */
  server?: X402ServerConfig;
  /** Client-side: wallet config for signing payment authorizations. */
  client?: X402ClientConfig;
}
