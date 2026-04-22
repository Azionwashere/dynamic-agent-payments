import { createPublicClient, createWalletClient, http, encodeAbiParameters, defineChain, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import crypto from 'node:crypto';
import { signTypedData, signAuthorization, getWalletAddress, getPublicRpc } from './wallet.js';
import type { X402Accept } from './x402-handler.js';

// ── MetaMask Delegation Framework constants ──────────────────────────────────
// Canonical deployments — same address on every supported chain.
const MDF_DELEGATION_MANAGER: Address = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
const MDF_EIP7702_STATELESS_DELEGATOR: Address = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
// ROOT_AUTHORITY sentinel — delegation whose authority == this is a top-level grant.
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as `0x${string}`;

// EIP-7702 designation prefix (0xef0100 + 20-byte address).
const EIP7702_PREFIX = '0xef0100';

// ── EIP-7702 upgrade ─────────────────────────────────────────────────────────

/**
 * Check whether an EOA already has the EIP7702StatelessDeleGator code installed.
 */
export async function checkEip7702Status(
  address: string,
  chainId: number,
  rpcUrl: string,
): Promise<'installed' | 'unset' | 'other'> {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const code = (await publicClient.getCode({ address: address as Address }))?.toLowerCase() ?? '0x';

  const expected = (EIP7702_PREFIX + MDF_EIP7702_STATELESS_DELEGATOR.slice(2)).toLowerCase();
  if (code === expected) return 'installed';
  if (code === '0x' || code === '') return 'unset';
  return 'other';
}

/**
 * Install the EIP7702StatelessDeleGator on the agent's EOA via a type-4 transaction.
 *
 * The Dynamic MPC wallet signs the EIP-7702 authorization; a funded relayer EOA
 * submits the type-4 transaction (it pays gas, and its tx does not consume the
 * agent's nonce, so `authorization.nonce` == agent's current nonce).
 *
 * Returns the installation tx hash.
 */
export async function installDelegatorCode(
  walletAddress: string,
  chainId: number,
  relayerPrivateKey: `0x${string}`,
  rpcUrl: string,
): Promise<string> {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Agent's current nonce — the authorization must reference this nonce.
  // Since the relayer's tx doesn't touch the agent's nonce, currentNonce is correct.
  const nonce = await publicClient.getTransactionCount({ address: walletAddress as Address });

  const sig = await signAuthorization({
    address: MDF_EIP7702_STATELESS_DELEGATOR,
    chainId,
    nonce,
  });

  const relayer = createWalletClient({
    account: privateKeyToAccount(relayerPrivateKey),
    chain,
    transport: http(rpcUrl),
  });

  const txHash = await (relayer as any).sendTransaction({
    to: walletAddress as Address,
    data: '0x',
    value: 0n,
    authorizationList: [{
      address: MDF_EIP7702_STATELESS_DELEGATOR,
      chainId,
      nonce,
      ...sig,
    }],
  });

  // Wait for confirmation, then poll for the code — public nodes can lag
  // a block or two behind eth_getTransactionReceipt when returning state.
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  let status: 'installed' | 'unset' | 'other' = 'unset';
  for (let attempt = 0; attempt < 6; attempt++) {
    status = await checkEip7702Status(walletAddress, chainId, rpcUrl);
    if (status === 'installed') break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (status !== 'installed') {
    throw new Error(
      `EIP-7702 tx confirmed but code check failed (status=${status}). ` +
      `Verify the relayer tx: ${txHash}`,
    );
  }

  return txHash;
}

// ── Delegation signing ───────────────────────────────────────────────────────

export interface SignedDelegation {
  delegate: string;
  delegator: string;
  authority: string;
  caveats: Array<{ enforcer: string; terms: string; args: string }>;
  salt: string;
  signature: string;
  delegationManager: string;
  chainId: number;
}

/**
 * Sign an ERC-7710 / MDF Delegation struct (EIP-712) using the agent's MPC wallet.
 *
 * Uses ROOT_AUTHORITY (unconstrained) and empty caveats for simplicity.
 * For production, add enforcers (e.g. NativeTokenTransferAmount, AllowedTargets).
 */
export async function signMdfDelegation(
  delegate: string,
  delegationManager: string,
  chainId: number,
): Promise<SignedDelegation> {
  const delegator = await getWalletAddress();
  const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();

  const typedData = {
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId,
      verifyingContract: delegationManager as Address,
    },
    types: {
      Delegation: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        { name: 'caveats', type: 'Caveat[]' },
        { name: 'salt', type: 'uint256' },
      ],
      Caveat: [
        { name: 'enforcer', type: 'address' },
        { name: 'terms', type: 'bytes' },
      ],
    },
    primaryType: 'Delegation' as const,
    message: {
      delegate,
      delegator,
      authority: ROOT_AUTHORITY,
      caveats: [] as Array<{ enforcer: string; terms: string }>,
      salt,
    },
  };

  const signature = await signTypedData(typedData);

  return { delegate, delegator, authority: ROOT_AUTHORITY, caveats: [], salt, signature, delegationManager, chainId };
}

// ── Permission context encoding ──────────────────────────────────────────────

/**
 * ABI-encode a signed delegation into the permissionContext bytes expected by
 * DelegationManager.redeemDelegations (and the x402-facilitator).
 *
 * Encoding: abi.encode(Delegation[]) where Delegation includes the full
 * on-chain struct (delegate, delegator, authority, caveats[], salt, signature).
 * Note: caveats include an `args` field (not signed, set to 0x) for on-chain use.
 */
export function buildPermissionContext(d: SignedDelegation): string {
  return encodeAbiParameters(
    [{
      type: 'tuple[]',
      components: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        {
          name: 'caveats',
          type: 'tuple[]',
          components: [
            { name: 'enforcer', type: 'address' },
            { name: 'terms', type: 'bytes' },
            { name: 'args', type: 'bytes' },
          ],
        },
        { name: 'salt', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    [[{
      delegate: d.delegate as Address,
      delegator: d.delegator as Address,
      authority: d.authority as `0x${string}`,
      caveats: d.caveats.map(c => ({
        enforcer: c.enforcer as Address,
        terms: c.terms as `0x${string}`,
        args: c.args as `0x${string}`,
      })),
      salt: BigInt(d.salt),
      signature: d.signature as `0x${string}`,
    }]],
  );
}

// ── x402 payment handler ─────────────────────────────────────────────────────

export interface Erc7710PaymentBody {
  delegation: {
    delegationManager: string;
    permissionContext: string;
    delegator: string;
  };
}

/**
 * Handle an erc7710 x402 accept entry:
 *   1. Verify EIP-7702 upgrade is installed (error if not — run setup-delegation first).
 *   2. Sign a fresh delegation to the delegate in the quote.
 *   3. Return the payment body expected by the facilitator.
 */
export async function handleErc7710Payment(
  accept: X402Accept,
  chainId: number,
): Promise<Erc7710PaymentBody> {
  const extra = accept.extra as Record<string, unknown>;
  const delegationManager = (extra.delegationManager as string | undefined) ?? MDF_DELEGATION_MANAGER;
  const delegate = (extra.delegate as string | undefined) ?? accept.payTo;

  const walletAddress = await getWalletAddress();
  const rpcUrl = getPublicRpc(String(chainId));

  const status = await checkEip7702Status(walletAddress, chainId, rpcUrl);
  if (status !== 'installed') {
    throw new Error(
      `EIP-7702 upgrade not installed on ${walletAddress} (chain ${chainId}). ` +
      `Run: dynamic-agent-payments setup-delegation --chain-id ${chainId}`,
    );
  }

  const signed = await signMdfDelegation(delegate, delegationManager, chainId);
  const permissionContext = buildPermissionContext(signed);

  return {
    delegation: {
      delegationManager,
      permissionContext,
      delegator: walletAddress,
    },
  };
}
