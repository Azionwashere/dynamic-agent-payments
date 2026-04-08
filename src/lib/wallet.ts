import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { DynamicSvmWalletClient } from '@dynamic-labs-wallet/node-svm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import type { SigningPayload, WalletInfo } from './types.js';
import { loadConfig } from './config.js';

type ChainFamily = 'EVM' | 'SOL';

let _evmClient: DynamicEvmWalletClient | null = null;
let _svmClient: DynamicSvmWalletClient | null = null;
let _evmAuthenticated = false;
let _svmAuthenticated = false;

// Cached wallets: chain family → wallet info
const walletCache = new Map<string, WalletInfo>();

async function getEvmClient(): Promise<DynamicEvmWalletClient> {
  if (_evmClient && _evmAuthenticated) return _evmClient;
  const config = loadConfig();
  _evmClient = new DynamicEvmWalletClient({
    environmentId: config.dynamicEnvironmentId,
  });
  await _evmClient.authenticateApiToken(config.dynamicAuthToken);
  _evmAuthenticated = true;
  return _evmClient;
}

async function getSvmClient(): Promise<DynamicSvmWalletClient> {
  if (_svmClient && _svmAuthenticated) return _svmClient;
  const config = loadConfig();
  _svmClient = new DynamicSvmWalletClient({
    environmentId: config.dynamicEnvironmentId,
  });
  await _svmClient.authenticateApiToken(config.dynamicAuthToken);
  _svmAuthenticated = true;
  return _svmClient;
}

/**
 * Create a new EVM wallet.
 */
export async function createEvmWallet(): Promise<WalletInfo> {
  const client = await getEvmClient();
  const result = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    backUpToClientShareService: true,
  });
  return { accountAddress: result.accountAddress, walletId: result.walletId, chain: 'EVM' };
}

/**
 * Create a new SOL wallet.
 */
export async function createSvmWallet(): Promise<WalletInfo> {
  const client = await getSvmClient();
  const result = await (client as any).createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    backUpToClientShareService: true,
  });
  return { accountAddress: result.accountAddress, walletId: result.walletId, chain: 'SOL' };
}

/**
 * Ensure a wallet exists for the given chain family.
 * Checks cache, then env vars, then creates a new one.
 */
export async function ensureWallet(chain: ChainFamily = 'EVM'): Promise<WalletInfo> {
  const cacheKey = chain.toLowerCase();
  const cached = walletCache.get(cacheKey);
  if (cached) return cached;

  // Check env vars
  if (chain === 'EVM') {
    const addr = process.env.WALLET_ADDRESS;
    const id = process.env.WALLET_ID;
    if (addr && id) {
      const info: WalletInfo = { accountAddress: addr, walletId: id, chain: 'EVM' };
      walletCache.set(cacheKey, info);
      return info;
    }
  } else if (chain === 'SOL') {
    const addr = process.env.SOL_WALLET_ADDRESS;
    const id = process.env.SOL_WALLET_ID;
    if (addr && id) {
      const info: WalletInfo = { accountAddress: addr, walletId: id, chain: 'SOL' };
      walletCache.set(cacheKey, info);
      return info;
    }
  }

  // Create a new wallet
  const info = chain === 'SOL' ? await createSvmWallet() : await createEvmWallet();
  walletCache.set(cacheKey, info);
  return info;
}

/**
 * Get the wallet address for a chain family (creates wallet if needed).
 */
export async function getWalletAddress(chain: ChainFamily = 'EVM'): Promise<string> {
  const wallet = await ensureWallet(chain);
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
