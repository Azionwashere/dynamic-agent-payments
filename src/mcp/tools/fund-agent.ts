import { z } from 'zod';
import { executeCheckoutFlow, createCheckout } from '../../lib/checkout-client.js';
import { signAndBroadcastTransaction, getWalletAddress } from '../../lib/wallet.js';
import { loadConfig, chainFamily } from '../../lib/config.js';
import type { EventCallback, SettlementResult } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const fundAgentSchema = z.object({
  fromChainId: z.string().describe('Source chain ID (e.g., "1" for Ethereum, "101" for Solana)'),
  fromChainName: z.enum(['EVM', 'SOL']).optional().describe('Source chain family (inferred from chain ID if omitted)'),
  fromTokenAddress: z.string().describe('Token to pay from. Use 0x0000...0000 for EVM native.'),
  toChainId: z.string().describe('Target chain ID (e.g., "8453" for Base)'),
  toChainName: z.enum(['EVM', 'SOL']).optional().describe('Target chain family (inferred from chain ID if omitted)'),
  toTokenSymbol: z.string().default('USDC').describe('Token to receive'),
  toTokenAddress: z.string().describe('Settlement token contract address'),
  toTokenDecimals: z.number().default(6).describe('Settlement token decimals'),
  amountUsd: z.string().describe('Amount in USD to fund'),
  slippage: z.number().optional().describe('Slippage tolerance as decimal (e.g., 0.005 for 0.5%)'),
  memo: z.record(z.unknown()).optional().describe('Metadata to tag this transaction (e.g., { "purpose": "anthropic-credits" })'),
});

export type FundAgentInput = z.infer<typeof fundAgentSchema>;

// Cache checkout IDs per destination chain
const checkoutCache = new Map<string, string>();

export async function fundAgent(
  input: FundAgentInput,
  emit?: EventCallback,
): Promise<SettlementResult> {
  const config = loadConfig();
  const fromChainName = input.fromChainName ?? chainFamily(input.fromChainId);
  const toChainName = input.toChainName ?? chainFamily(input.toChainId);

  if (emit) emitEvent(emit, 'fund_start', {
    fromChain: fromChainName,
    toChain: toChainName,
    amountUsd: input.amountUsd,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  const sourceAddress = await getWalletAddress(fromChainName);
  const destAddress = await getWalletAddress(toChainName);

  // Get or create checkout for this destination chain
  const cacheKey = `${input.toChainId}-${input.toTokenAddress}`;
  let checkoutId = checkoutCache.get(cacheKey);

  if (!checkoutId) {
    if (emit) emitEvent(emit, 'fund_creating_checkout', { toChain: toChainName });
    checkoutId = await createCheckout({
      environmentId: config.dynamicEnvironmentId,
      apiToken: config.dynamicAuthToken,
      apiBase: config.checkoutApiBase,
      settlementChainId: input.toChainId,
      settlementChainName: toChainName,
      settlementTokenAddress: input.toTokenAddress,
      settlementTokenSymbol: input.toTokenSymbol,
      settlementTokenDecimals: input.toTokenDecimals,
      destinationAddress: destAddress,
    });
    checkoutCache.set(cacheKey, checkoutId);
  }

  // Execute the full checkout flow
  const result = await executeCheckoutFlow({
    apiBase: config.checkoutApiBase,
    environmentId: config.dynamicEnvironmentId,
    checkoutId,
    amountUsd: input.amountUsd,
    sourceAddress,
    sourceChainId: input.fromChainId,
    sourceChainName: fromChainName,
    fromTokenAddress: input.fromTokenAddress,
    signTransaction: signAndBroadcastTransaction,
    slippage: input.slippage,
    minFundingThresholdUsd: config.minFundingThresholdUsd,
    emit,
    memo: input.memo,
    // TODO: implement sendApproval for ERC-20 token swaps
  });

  if (emit) emitEvent(emit, 'fund_complete', {
    txHash: result.txHash,
    settlementState: result.settlementState,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  return result;
}
