import { getWallet, getBalances } from '../../lib/wallet.js';

/** Public-facing wallet summary (differs from internal WalletInfo). */
export interface WalletSummary {
  address: string;
  chain: string;
  balances?: Array<{ symbol: string; balance: string; tokenAddress: string }>;
}

export async function getWallets(): Promise<{ evm: WalletSummary; sol?: WalletSummary }> {
  const evmWallet = getWallet('EVM');
  const evm: WalletSummary = { address: evmWallet.accountAddress, chain: 'EVM' };

  try {
    evm.balances = await getBalances('EVM', evmWallet.accountAddress);
  } catch { /* no balances available */ }

  let sol: WalletSummary | undefined;
  try {
    const solWallet = getWallet('SOL');
    sol = { address: solWallet.accountAddress, chain: 'SOL' };
    try {
      sol.balances = await getBalances('SOL', solWallet.accountAddress);
    } catch { /* no balances available */ }
  } catch { /* SOL wallet not configured */ }

  return { evm, ...(sol ? { sol } : {}) };
}
