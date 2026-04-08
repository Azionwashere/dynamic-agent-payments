import { z } from 'zod';
import { getWalletAddress, getBalances } from '../../lib/wallet.js';
import type { EventCallback } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const checkBalanceSchema = z.object({
  chain: z.enum(['EVM', 'SOL']).describe('Blockchain family to check balance on'),
  networkId: z.string().optional().describe('Network ID (e.g., "8453" for Base, "1" for Ethereum)'),
});

export type CheckBalanceInput = z.infer<typeof checkBalanceSchema>;

export async function checkBalance(
  input: CheckBalanceInput,
  emit?: EventCallback,
): Promise<{ address: string; chain: string; balances: Array<{ symbol: string; balance: string; tokenAddress: string }> }> {
  if (emit) emitEvent(emit, 'check_balance_start', { chain: input.chain });

  const address = await getWalletAddress(input.chain as 'EVM' | 'SOL');
  const balances = await getBalances(input.chain, address, input.networkId);

  if (emit) emitEvent(emit, 'check_balance_complete', {
    address,
    chain: input.chain,
    tokenCount: balances.length,
  });

  return { address, chain: input.chain, balances };
}
