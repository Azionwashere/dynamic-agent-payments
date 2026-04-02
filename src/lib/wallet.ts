import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { SigningPayload, WalletInfo } from './types.js';
import { loadConfig } from './config.js';

let _evmClient: DynamicEvmWalletClient | null = null;
let _authenticated = false;

// Cached wallets: chainId → wallet info
const walletCache = new Map<string, WalletInfo>();

// Chain ID → viem chain mapping
const chainMap: Record<string, any> = {
  '1': mainnet,
  '8453': base,
  '84532': baseSepolia,
};

async function getEvmClient(): Promise<DynamicEvmWalletClient> {
  if (_evmClient && _authenticated) return _evmClient;
  const config = loadConfig();
  _evmClient = new DynamicEvmWalletClient({
    environmentId: config.dynamicEnvironmentId,
  });
  await _evmClient.authenticateApiToken(config.dynamicAuthToken);
  _authenticated = true;
  return _evmClient;
}

/**
 * Create a new EVM wallet on a specific chain.
 */
export async function createEvmWallet(): Promise<WalletInfo> {
  const client = await getEvmClient();
  const result = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    backUpToClientShareService: true,
  });
  const info: WalletInfo = {
    accountAddress: result.accountAddress,
    walletId: result.walletId,
    chain: 'EVM',
  };
  return info;
}

/**
 * Ensure a wallet exists. If we have one cached, use it. Otherwise create one.
 * For v1, a single EVM wallet works across all EVM chains (same address).
 */
export async function ensureWallet(): Promise<WalletInfo> {
  const cached = walletCache.get('evm');
  if (cached) return cached;

  // Check if wallet address is provided via env
  const envAddress = process.env.WALLET_ADDRESS;
  const envWalletId = process.env.WALLET_ID;
  if (envAddress && envWalletId) {
    const info: WalletInfo = {
      accountAddress: envAddress,
      walletId: envWalletId,
      chain: 'EVM',
    };
    walletCache.set('evm', info);
    return info;
  }

  // Create a new wallet
  const info = await createEvmWallet();
  walletCache.set('evm', info);
  return info;
}

/**
 * Get the wallet address (creates wallet if needed).
 */
export async function getWalletAddress(): Promise<string> {
  const wallet = await ensureWallet();
  return wallet.accountAddress;
}

/**
 * Sign an EVM transaction and broadcast it. Returns tx hash.
 */
export async function signAndBroadcastTransaction(
  payload: SigningPayload,
  chainName: string,
): Promise<string> {
  if (chainName !== 'EVM') {
    throw new Error(`Chain ${chainName} signing not yet supported. Use EVM for v1.`);
  }

  const client = await getEvmClient();
  const wallet = await ensureWallet();
  const config = loadConfig();

  const txReq = payload.transactionRequest ?? payload;

  // Sign the transaction via Dynamic's server-side MPC
  const signedTx = await client.signTransaction({
    senderAddress: wallet.accountAddress,
    transaction: {
      to: txReq.to as `0x${string}`,
      data: txReq.data as `0x${string}` | undefined,
      value: BigInt(txReq.value || '0'),
    },
  } as any);

  // Broadcast via viem publicClient
  const rpcUrl = config.rpcUrlBase;
  if (!rpcUrl) {
    throw new Error('RPC_URL_BASE is required to broadcast transactions');
  }

  // Determine chain from payload or default to Base
  const chainId = (txReq as any).chainId?.toString() ?? '8453';
  const chain = chainMap[chainId] ?? base;

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const txHash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx as `0x${string}`,
  });

  return txHash;
}

/**
 * Sign EIP-712 typed data (for x402 payments).
 */
export async function signTypedData(typedData: any): Promise<string> {
  const client = await getEvmClient();
  const wallet = await ensureWallet();

  const signature = await client.signTypedData({
    accountAddress: wallet.accountAddress,
    typedData,
  });

  return signature;
}

/**
 * Get token balances via Dynamic's balance API.
 */
export async function getBalances(
  chainName: string,
  accountAddress: string,
  networkId?: string,
): Promise<Array<{ symbol: string; balance: string; tokenAddress: string }>> {
  const config = loadConfig();

  const res = await fetch(
    `${config.checkoutApiBase}/sdk/${config.dynamicEnvironmentId}/chains/${chainName}/balances`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-account-address': accountAddress,
        ...(networkId ? { 'x-network-id': networkId } : {}),
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Balance API error ${res.status}: ${body}`);
  }

  const data = await res.json() as any;

  // Normalize response — may be an array of token balances
  const tokens = Array.isArray(data) ? data : data.tokens ?? data.balances ?? [];
  return tokens.map((t: any) => ({
    symbol: t.symbol ?? t.name ?? 'unknown',
    balance: t.balance ?? t.amount ?? '0',
    tokenAddress: t.tokenAddress ?? t.address ?? t.mint ?? '',
  }));
}
