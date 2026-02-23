/**
 * EIP-712 signer for x402 EIP-3009 transferWithAuthorization.
 *
 * Provides a ready-to-use signer factory for the `x402Signer` callback in
 * X402ToolContext.  Uses ethers.js v6 `Wallet.signTypedData()` to produce a
 * standards-compliant EIP-712 signature over the `TransferWithAuthorization`
 * struct defined in USDC (ERC-20 + EIP-3009).
 *
 * Quick start:
 *
 * ```ts
 * import { createEIP712Signer, walletAddress } from '@ch4p/plugin-x402';
 *
 * const signer = createEIP712Signer(process.env.X402_PRIVATE_KEY!);
 * const agentWallet = walletAddress(process.env.X402_PRIVATE_KEY!);
 * ```
 */

import { ethers } from 'ethers';
import type { X402PaymentAuthorization } from './types.js';

// ---------------------------------------------------------------------------
// Well-known token addresses
// ---------------------------------------------------------------------------

/**
 * USDC contract addresses and EIP-712 domain parameters for supported networks.
 * Import `KNOWN_TOKENS` when you need to look up token details by network name.
 */
export const KNOWN_TOKENS = {
  base: {
    address:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId:  8453,
    name:     'USD Coin',
    version:  '2',
  },
  'base-sepolia': {
    address:  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    chainId:  84532,
    name:     'USD Coin',
    version:  '2',
  },
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EIP712SignerOpts {
  /**
   * EIP-712 domain chain ID.
   * Default: 8453 (Base mainnet).
   */
  chainId?: number;
  /**
   * ERC-20 contract address whose `TransferWithAuthorization` is signed.
   * Default: USDC on Base mainnet.
   */
  tokenAddress?: string;
  /**
   * Token name for the EIP-712 domain separator.
   * Default: "USD Coin".
   */
  tokenName?: string;
  /**
   * Token version for the EIP-712 domain separator.
   * Default: "2".
   */
  tokenVersion?: string;
}

// ---------------------------------------------------------------------------
// EIP-712 type definitions (fixed for EIP-3009 transferWithAuthorization)
// ---------------------------------------------------------------------------

const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
};

// ---------------------------------------------------------------------------
// createEIP712Signer
// ---------------------------------------------------------------------------

/**
 * Create an EIP-712 signer for x402 EIP-3009 `transferWithAuthorization`.
 *
 * Returns the `x402Signer` callback expected by `X402ToolContext`.
 *
 * @param privateKey  0x-prefixed hex private key. Typically sourced from an
 *                    environment variable (e.g. `process.env.X402_PRIVATE_KEY`).
 * @param opts        Optional overrides for chain ID, token address, name,
 *                    and version used in the EIP-712 domain separator.
 *
 * @example
 * ```ts
 * const signer = createEIP712Signer(process.env.X402_PRIVATE_KEY!, {
 *   chainId: 84532,  // base-sepolia
 *   tokenAddress: KNOWN_TOKENS['base-sepolia'].address,
 * });
 * ```
 */
export function createEIP712Signer(
  privateKey: string,
  opts: EIP712SignerOpts = {},
): (authorization: X402PaymentAuthorization) => Promise<string> {
  const wallet = new ethers.Wallet(privateKey);

  const domain = {
    name:              opts.tokenName    ?? KNOWN_TOKENS.base.name,
    version:           opts.tokenVersion ?? KNOWN_TOKENS.base.version,
    chainId:           opts.chainId      ?? KNOWN_TOKENS.base.chainId,
    verifyingContract: opts.tokenAddress ?? KNOWN_TOKENS.base.address,
  };

  return async (auth: X402PaymentAuthorization): Promise<string> => {
    const message = {
      from:        auth.from,
      to:          auth.to,
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce,
    };

    return wallet.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, message);
  };
}

// ---------------------------------------------------------------------------
// walletAddress
// ---------------------------------------------------------------------------

/**
 * Derive the checksummed Ethereum address from a private key.
 * Use this to populate `agentWalletAddress` in `toolContextExtensions`.
 *
 * @param privateKey  0x-prefixed hex private key.
 */
export function walletAddress(privateKey: string): string {
  return new ethers.Wallet(privateKey).address;
}
