import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import type { SigningPayload, WalletInfo } from './types.js';
import { loadConfig } from './config.js';

let _evmClient: DynamicEvmWalletClient | null = null;
let _authenticated = false;

// Cached wallets: chainId → wallet info
const walletCache = new Map<string, WalletInfo>();

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
 * A single EVM wallet works across all EVM chains (same address).
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
    throw new Error(`Chain ${chainName} signing not yet supported. Currently EVM only.`);
  }

  const client = await getEvmClient();
  const wallet = await ensureWallet();

  const txReq = (payload.transactionRequest ?? payload) as any;
  const chainId = txReq.chainId?.toString() ?? '8453';

  // Get a viem wallet client from Dynamic — handles RPC internally
  const walletClient = await (client as any).getWalletClient({
    accountAddress: wallet.accountAddress,
    chainId: parseInt(chainId),
    rpcUrl: `https://${chainId === '8453' ? 'mainnet.base.org' : 'mainnet.base.org'}`,
  });

  // Sign and broadcast via Dynamic's wallet client
  const txHash = await walletClient.sendTransaction({
    to: txReq.to as `0x${string}`,
    data: txReq.data as `0x${string}` | undefined,
    value: BigInt(txReq.value || '0'),
    gas: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
    gasPrice: txReq.gasPrice ? BigInt(txReq.gasPrice) : undefined,
    maxFeePerGas: txReq.maxFeePerGas ? BigInt(txReq.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: txReq.maxPriorityFeePerGas ? BigInt(txReq.maxPriorityFeePerGas) : undefined,
    type: txReq.maxFeePerGas ? 'eip1559' as const : 'legacy' as const,
    chainId: parseInt(chainId),
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

  const params = new URLSearchParams({ accountAddress });
  if (networkId) params.set('networkId', networkId);

  const res = await fetch(
    `${config.checkoutApiBase}/sdk/${config.dynamicEnvironmentId}/chains/${chainName}/balances?${params}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
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
