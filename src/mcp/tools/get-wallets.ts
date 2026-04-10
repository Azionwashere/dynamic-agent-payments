import { getWallet, getBalances } from '../../lib/wallet.js';

export interface WalletInfo {
  address: string;
  chain: string;
  balances?: Array<{ symbol: string; balance: string; tokenAddress: string }>;
}

export async function getWallets(): Promise<{ evm: WalletInfo; sol?: WalletInfo }> {
  const evmWallet = getWallet('EVM');
  const evm: WalletInfo = { address: evmWallet.accountAddress, chain: 'EVM' };

  // Try to get EVM balances (non-blocking — ok if it fails)
  try {
    evm.balances = await getBalances('EVM', evmWallet.accountAddress);
  } catch { /* no balances available */ }

  let sol: WalletInfo | undefined;
  try {
    const solWallet = getWallet('SOL');
    sol = { address: solWallet.accountAddress, chain: 'SOL' };
    try {
      sol.balances = await getBalances('SOL', solWallet.accountAddress);
    } catch { /* no balances available */ }
  } catch { /* SOL wallet not configured */ }

  return { evm, ...(sol ? { sol } : {}) };
}
