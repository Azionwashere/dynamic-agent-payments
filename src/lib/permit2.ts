import { getWallet, signTypedData, signAndBroadcastTransaction } from './wallet.js';
import type { SigningPayload } from './types.js';

// ---- Constants ----

/** Canonical Uniswap Permit2 contract — same address on all EVM chains. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** x402 Exact Permit2 Proxy — deployed via CREATE2 (when available). */
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

/** Max uint256 for unlimited approval. */
const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// ---- Known tokens ----

export const TOKENS: Record<string, { address: string; name: string; decimals: number }> = {
  'USDC:8453': { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USDC', decimals: 6 },
  'USDC:1': { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USDC', decimals: 6 },
  'WETH:8453': { address: '0x4200000000000000000000000000000000000006', name: 'WETH', decimals: 18 },
  'DAI:8453': { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', name: 'DAI', decimals: 18 },
};

// ---- EIP-712 Types for Permit2 PermitWitnessTransferFrom ----

/**
 * The witness type string must match the contract exactly:
 * "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
 */
export const PERMIT2_DOMAIN = (chainId: number) => ({
  name: 'Permit2',
  chainId,
  verifyingContract: PERMIT2_ADDRESS as `0x${string}`,
});

export const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
};

// ---- Permit2 Operations ----

export interface Permit2ApproveResult {
  txHash: string;
  token: string;
  spender: string;
  wallet: string;
}

/**
 * One-time approval of the Permit2 contract to spend a token.
 */
export async function permit2Approve(
  tokenAddress: string,
  chainId = '8453',
): Promise<Permit2ApproveResult> {
  const wallet = getWallet('EVM');

  // ERC-20 approve(address spender, uint256 amount) = 0x095ea7b3
  const spender = PERMIT2_ADDRESS.slice(2).padStart(64, '0');
  const amount = MAX_UINT256.slice(2);
  const data = '0x095ea7b3' + spender + amount;

  const txHash = await signAndBroadcastTransaction(
    {
      to: tokenAddress,
      data,
      value: '0',
      transactionRequest: { to: tokenAddress, data, value: '0' },
    },
    'EVM',
  );

  return {
    txHash,
    token: tokenAddress,
    spender: PERMIT2_ADDRESS,
    wallet: wallet.accountAddress,
  };
}

export interface Permit2SignResult {
  signature: string;
  permit2Authorization: {
    permitted: { token: string; amount: string };
    from: string;
    spender: string;
    nonce: string;
    deadline: string;
    witness: { to: string; validAfter: string };
  };
  recoveredSigner?: string;
}

/**
 * Sign a Permit2 PermitWitnessTransferFrom message.
 * This is off-chain — no gas needed.
 */
export async function permit2Sign(params: {
  tokenAddress: string;
  amount: string;
  recipient: string;
  chainId?: number;
  deadlineSeconds?: number;
}): Promise<Permit2SignResult> {
  const {
    tokenAddress,
    amount,
    recipient,
    chainId = 8453,
    deadlineSeconds = 60,
  } = params;

  const wallet = getWallet('EVM');
  const now = Math.floor(Date.now() / 1000);
  const deadline = (now + deadlineSeconds).toString();
  const validAfter = now.toString();

  // Random nonce (Permit2 uses unordered nonces)
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = '0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const domain = PERMIT2_DOMAIN(chainId);

  const message = {
    permitted: {
      token: tokenAddress,
      amount,
    },
    spender: X402_EXACT_PERMIT2_PROXY,
    nonce,
    deadline,
    witness: {
      to: recipient,
      validAfter,
    },
  };

  const typedData = {
    domain,
    types: PERMIT2_TYPES,
    primaryType: 'PermitWitnessTransferFrom' as const,
    message,
  };

  const signature = await signTypedData(typedData);

  const permit2Authorization = {
    permitted: { token: tokenAddress, amount },
    from: wallet.accountAddress,
    spender: X402_EXACT_PERMIT2_PROXY,
    nonce,
    deadline,
    witness: { to: recipient, validAfter },
  };

  return { signature, permit2Authorization };
}

/**
 * Verify a Permit2 signature off-chain using viem's verifyTypedData.
 * Returns the recovered signer address.
 */
export async function permit2Verify(
  signResult: Permit2SignResult,
  chainId = 8453,
): Promise<{ valid: boolean; recoveredSigner: string; expectedSigner: string }> {
  // Dynamic import viem for signature recovery
  const { verifyTypedData } = await import('viem');

  const wallet = getWallet('EVM');
  const domain = PERMIT2_DOMAIN(chainId);
  const auth = signResult.permit2Authorization;

  const message = {
    permitted: auth.permitted,
    spender: auth.spender,
    nonce: BigInt(auth.nonce),
    deadline: BigInt(auth.deadline),
    witness: {
      to: auth.witness.to as `0x${string}`,
      validAfter: BigInt(auth.witness.validAfter),
    },
  };

  const valid = await verifyTypedData({
    address: wallet.accountAddress as `0x${string}`,
    domain: { ...domain, verifyingContract: domain.verifyingContract as `0x${string}` },
    types: PERMIT2_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message,
    signature: signResult.signature as `0x${string}`,
  });

  // Also recover the signer for display
  const { recoverTypedDataAddress } = await import('viem');
  const recoveredSigner = await recoverTypedDataAddress({
    domain: { ...domain, verifyingContract: domain.verifyingContract as `0x${string}` },
    types: PERMIT2_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message,
    signature: signResult.signature as `0x${string}`,
  });

  return {
    valid,
    recoveredSigner,
    expectedSigner: wallet.accountAddress,
  };
}

/**
 * Check the current Permit2 allowance for a token.
 */
export async function checkPermit2Allowance(
  tokenAddress: string,
  rpcUrl = 'https://mainnet.base.org',
): Promise<{ allowance: string; hasApproval: boolean }> {
  const wallet = getWallet('EVM');

  // allowance(address owner, address spender) = 0xdd62ed3e
  const owner = wallet.accountAddress.slice(2).padStart(64, '0');
  const spender = PERMIT2_ADDRESS.slice(2).padStart(64, '0');
  const data = '0xdd62ed3e' + owner + spender;

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: tokenAddress, data }, 'latest'],
    }),
  });
  const result = await res.json();
  const allowance = BigInt(result.result || '0x0').toString();
  const hasApproval = BigInt(allowance) > 0n;

  return { allowance, hasApproval };
}
