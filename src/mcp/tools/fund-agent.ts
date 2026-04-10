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

// Cache checkout IDs per destination chain (with 1-hour TTL)
const CHECKOUT_TTL_MS = 60 * 60 * 1000;
const checkoutCache = new Map<string, { id: string; createdAt: number }>();

function getCachedCheckout(key: string): string | undefined {
  const entry = checkoutCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CHECKOUT_TTL_MS) {
    checkoutCache.delete(key);
    return undefined;
  }
  return entry.id;
}

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

  const sourceAddress = getWalletAddress(fromChainName);
  const destAddress = getWalletAddress(toChainName);

  // Get or create checkout for this destination chain
  const cacheKey = `${input.toChainId}-${input.toTokenAddress}`;
  let checkoutId = getCachedCheckout(cacheKey);

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
    checkoutCache.set(cacheKey, { id: checkoutId, createdAt: Date.now() });
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
    sendApproval: async (approval) => {
      const txHash = await signAndBroadcastTransaction(
        {
          to: approval.tokenAddress,
          data: buildApprovalData(approval.spenderAddress, approval.amount),
          value: '0',
          transactionRequest: {
            to: approval.tokenAddress,
            data: buildApprovalData(approval.spenderAddress, approval.amount),
            value: '0',
          },
        },
        fromChainName,
      );
      return txHash;
    },
    slippage: input.slippage,
    minFundingThresholdUsd: config.minFundingThresholdUsd,
    emit,
    memo: input.memo,
  });

  if (emit) emitEvent(emit, 'fund_complete', {
    txHash: result.txHash,
    settlementState: result.settlementState,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  return result;
}

/** Build ERC-20 approve(address,uint256) calldata. */
function buildApprovalData(spender: string, amount: string): string {
  const s = spender.replace('0x', '').padStart(64, '0');
  const a = BigInt(amount).toString(16).padStart(64, '0');
  return '0x095ea7b3' + s + a;
}
