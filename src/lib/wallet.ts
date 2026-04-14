import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { DynamicSvmWalletClient } from '@dynamic-labs-wallet/node-svm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SigningPayload, WalletInfo } from './types.js';
import { loadConfig } from './config.js';

type ChainFamily = 'EVM' | 'SOL';

let _evmClient: DynamicEvmWalletClient | null = null;
let _svmClient: DynamicSvmWalletClient | null = null;
let _evmAuthenticated = false;
let _svmAuthenticated = false;

const walletCache = new Map<string, WalletInfo>();

/** Public RPC endpoints per chain. Override with RPC_URL env var. */
const PUBLIC_RPCS: Record<string, string> = {
  '1': 'https://eth.llamarpc.com',
  '8453': 'https://mainnet.base.org',
  '84532': 'https://sepolia.base.org',
  '137': 'https://polygon-rpc.com',
  '42161': 'https://arb1.arbitrum.io/rpc',
  '10': 'https://mainnet.optimism.io',
  '43114': 'https://api.avax.network/ext/bc/C/rpc',
  '43113': 'https://api.avax-test.network/ext/bc/C/rpc',
};

function getPublicRpc(chainId: string): string {
  return process.env.RPC_URL || PUBLIC_RPCS[chainId] || `https://mainnet.base.org`;
}

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

// ---- .env persistence ----

const ENV_KEYS: Record<ChainFamily, { address: string; id: string }> = {
  EVM: { address: 'WALLET_ADDRESS', id: 'WALLET_ID' },
  SOL: { address: 'SOL_WALLET_ADDRESS', id: 'SOL_WALLET_ID' },
};

function envPath(): string {
  return resolve(process.cwd(), '.env');
}

function writeToEnv(key: string, value: string): void {
  const path = envPath();
  let content = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  // Replace existing key or append
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  writeFileSync(path, content);
  // Also update process.env so the current session picks it up
  process.env[key] = value;
}

function persistWalletToEnv(wallet: WalletInfo): void {
  const keys = ENV_KEYS[wallet.chain];
  writeToEnv(keys.address, wallet.accountAddress);
  writeToEnv(keys.id, wallet.walletId);
}

// ---- Wallet access (read-only, throws if not configured) ----

/**
 * Get the configured wallet for a chain family.
 * Throws if no wallet is configured in .env — never creates one.
 */
export function getWallet(chain: ChainFamily = 'EVM'): WalletInfo {
  const cacheKey = chain.toLowerCase();
  const cached = walletCache.get(cacheKey);
  if (cached) return cached;

  const keys = ENV_KEYS[chain];
  const addr = process.env[keys.address];
  const id = process.env[keys.id];

  if (!addr || !id) {
    throw new Error(
      `No ${chain} wallet configured. Run \`dynamic-agent-payments wallet\` to create one.`
    );
  }

  const info: WalletInfo = { accountAddress: addr, walletId: id, chain };
  walletCache.set(cacheKey, info);
  return info;
}

/**
 * Get the wallet address for a chain family. Throws if not configured.
 */
export function getWalletAddress(chain: ChainFamily = 'EVM'): string {
  return getWallet(chain).accountAddress;
}

// ---- Wallet creation (explicit only, persists to .env) ----

/**
 * Create a new wallet and persist it to .env. Only called by the `wallet` command.
 */
export async function createAndPersistWallet(chain: ChainFamily = 'EVM'): Promise<WalletInfo> {
  const info = chain === 'SOL'
    ? await createSvmWallet()
    : await createEvmWallet();

  persistWalletToEnv(info);
  walletCache.set(chain.toLowerCase(), info);
  return info;
}

async function createEvmWallet(): Promise<WalletInfo> {
  const client = await getEvmClient();
  const result = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    backUpToClientShareService: true,
  });
  return { accountAddress: result.accountAddress, walletId: result.walletId, chain: 'EVM' };
}

async function createSvmWallet(): Promise<WalletInfo> {
  const client = await getSvmClient();
  const result = await (client as any).createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    backUpToClientShareService: true,
  });
  return { accountAddress: result.accountAddress, walletId: result.walletId, chain: 'SOL' };
}

// ---- List all wallets from Dynamic API ----

export interface RemoteWallet {
  walletId: string;
  chainName: string;
  accountAddress: string;
}

/**
 * Query Dynamic API for all wallets in this environment.
 */
export async function listAllWallets(): Promise<RemoteWallet[]> {
  const client = await getEvmClient();
  const wallets = await (client as any).getWallets();
  return (wallets as any[]).map(w => ({
    walletId: w.walletId,
    chainName: w.chainName,
    accountAddress: w.accountAddress,
  }));
}

// ---- Switch active wallet ----

/**
 * Set an existing wallet as active by writing to .env.
 * Looks up the wallet from Dynamic API to get the walletId.
 */
export async function setActiveWallet(address: string): Promise<WalletInfo> {
  const all = await listAllWallets();
  const match = all.find(w =>
    w.accountAddress.toLowerCase() === address.toLowerCase()
  );

  if (!match) {
    throw new Error(
      `Wallet ${address} not found in this environment. Run \`wallet list\` to see available wallets.`
    );
  }

  const chain: ChainFamily = match.chainName === 'SVM' ? 'SOL' : 'EVM';
  const info: WalletInfo = {
    accountAddress: match.accountAddress,
    walletId: match.walletId,
    chain,
  };

  persistWalletToEnv(info);
  walletCache.set(chain.toLowerCase(), info);
  return info;
}

// ---- Keep ensureWallet as alias for getWallet (backward compat for imports) ----
/** @deprecated Use getWallet() instead */
export const ensureWallet = getWallet;

/** Reset internal state (for testing only). */
export function resetWalletState(): void {
  walletCache.clear();
  _evmClient = null;
  _svmClient = null;
  _evmAuthenticated = false;
  _svmAuthenticated = false;
}

// ---- Signing ----

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
  const wallet = getWallet();

  const txReq = (payload.transactionRequest ?? payload) as any;
  const chainId = txReq.chainId?.toString() ?? '8453';

  const walletClient = await (client as any).getWalletClient({
    accountAddress: wallet.accountAddress,
    chainId: parseInt(chainId),
    rpcUrl: getPublicRpc(chainId),
  });

  try {
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
  } catch (err: any) {
    if (err.message?.includes('insufficient funds') || err.message?.includes('exceeds the balance')) {
      throw new Error(
        `Insufficient native token for gas on chain ${chainId}. ` +
        `Send ETH (or the chain's native token) to ${wallet.accountAddress} to cover gas fees.`
      );
    }
    throw err;
  }
}

/**
 * Sign EIP-712 typed data (for x402 payments).
 */
export async function signTypedData(typedData: any): Promise<string> {
  const client = await getEvmClient();
  const wallet = getWallet();

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
