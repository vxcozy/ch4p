/**
 * Tests for the x402 EIP-712 signer.
 *
 * Uses a well-known test private key to verify:
 *   - walletAddress() derives the correct checksummed address.
 *   - createEIP712Signer() produces a 65-byte EIP-712 signature.
 *   - The signature verifies against the expected typed data.
 *   - KNOWN_TOKENS contains correct network entries.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { createEIP712Signer, walletAddress, KNOWN_TOKENS } from './signer.js';
import type { X402PaymentAuthorization } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
//
// Using the Ethereum test private key from the hardhat / foundry well-known
// set. This key has no real funds and is safe for testing.
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EXPECTED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const SAMPLE_AUTH: X402PaymentAuthorization = {
  from:        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  to:          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value:       '1000000', // 1 USDC
  validAfter:  '0',
  validBefore: '9999999999',
  nonce:       '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
};

// ---------------------------------------------------------------------------
// walletAddress
// ---------------------------------------------------------------------------

describe('walletAddress', () => {
  it('returns the checksummed Ethereum address for the hardhat test key', () => {
    const addr = walletAddress(TEST_PRIVATE_KEY);
    expect(addr).toBe(EXPECTED_ADDRESS);
  });

  it('returns a checksummed EIP-55 address (mixed-case)', () => {
    const addr = walletAddress(TEST_PRIVATE_KEY);
    // EIP-55 checksummed addresses are not all-lowercase.
    expect(addr).not.toBe(addr.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// KNOWN_TOKENS
// ---------------------------------------------------------------------------

describe('KNOWN_TOKENS', () => {
  it('contains a base entry with correct chainId', () => {
    expect(KNOWN_TOKENS.base.chainId).toBe(8453);
    expect(KNOWN_TOKENS.base.address).toMatch(/^0x/);
  });

  it('contains a base-sepolia entry with correct chainId', () => {
    expect(KNOWN_TOKENS['base-sepolia'].chainId).toBe(84532);
    expect(KNOWN_TOKENS['base-sepolia'].address).toMatch(/^0x/);
  });

  it('base and base-sepolia have different contract addresses', () => {
    expect(KNOWN_TOKENS.base.address).not.toBe(KNOWN_TOKENS['base-sepolia'].address);
  });
});

// ---------------------------------------------------------------------------
// createEIP712Signer
// ---------------------------------------------------------------------------

describe('createEIP712Signer', () => {
  it('returns a function (the signer callback)', () => {
    const signer = createEIP712Signer(TEST_PRIVATE_KEY);
    expect(typeof signer).toBe('function');
  });

  it('produces a 65-byte hex signature (0x + 130 hex chars)', async () => {
    const signer = createEIP712Signer(TEST_PRIVATE_KEY);
    const sig = await signer(SAMPLE_AUTH);

    // EIP-712 signatures are 65 bytes: 32 (r) + 32 (s) + 1 (v).
    // Represented as "0x" + 130 lowercase hex characters.
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it('signature verifies with ethers.verifyTypedData', async () => {
    const signer = createEIP712Signer(TEST_PRIVATE_KEY);
    const sig = await signer(SAMPLE_AUTH);

    const domain = {
      name:              KNOWN_TOKENS.base.name,
      version:           KNOWN_TOKENS.base.version,
      chainId:           KNOWN_TOKENS.base.chainId,
      verifyingContract: KNOWN_TOKENS.base.address,
    };
    const types = {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    };
    const message = {
      from:        SAMPLE_AUTH.from,
      to:          SAMPLE_AUTH.to,
      value:       BigInt(SAMPLE_AUTH.value),
      validAfter:  BigInt(SAMPLE_AUTH.validAfter),
      validBefore: BigInt(SAMPLE_AUTH.validBefore),
      nonce:       SAMPLE_AUTH.nonce,
    };

    const recovered = ethers.verifyTypedData(domain, types, message, sig);
    expect(recovered).toBe(EXPECTED_ADDRESS);
  });

  it('produces different signatures for different authorizations', async () => {
    const signer = createEIP712Signer(TEST_PRIVATE_KEY);

    const auth2: X402PaymentAuthorization = {
      ...SAMPLE_AUTH,
      nonce: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };

    const sig1 = await signer(SAMPLE_AUTH);
    const sig2 = await signer(auth2);

    expect(sig1).not.toBe(sig2);
  });

  it('accepts custom chainId and tokenAddress opts', async () => {
    const signer = createEIP712Signer(TEST_PRIVATE_KEY, {
      chainId:      KNOWN_TOKENS['base-sepolia'].chainId,
      tokenAddress: KNOWN_TOKENS['base-sepolia'].address,
      tokenName:    KNOWN_TOKENS['base-sepolia'].name,
      tokenVersion: KNOWN_TOKENS['base-sepolia'].version,
    });

    const sig = await signer(SAMPLE_AUTH);
    // Should be a valid 65-byte signature.
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);

    // Signature over base-sepolia domain should NOT verify against base domain.
    const baseDomain = {
      name:              KNOWN_TOKENS.base.name,
      version:           KNOWN_TOKENS.base.version,
      chainId:           KNOWN_TOKENS.base.chainId,
      verifyingContract: KNOWN_TOKENS.base.address,
    };
    const types = {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    };
    const message = {
      from:        SAMPLE_AUTH.from,
      to:          SAMPLE_AUTH.to,
      value:       BigInt(SAMPLE_AUTH.value),
      validAfter:  BigInt(SAMPLE_AUTH.validAfter),
      validBefore: BigInt(SAMPLE_AUTH.validBefore),
      nonce:       SAMPLE_AUTH.nonce,
    };

    const recovered = ethers.verifyTypedData(baseDomain, types, message, sig);
    // Different domain — recovered address should differ from expected.
    expect(recovered).not.toBe(EXPECTED_ADDRESS);
  });
});
