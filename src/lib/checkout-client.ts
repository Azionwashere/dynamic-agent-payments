import type {
  CheckoutConfig,
  PaymentSession,
  PaymentQuote,
  SigningPayload,
  SettlementResult,
  SignTransactionFn,
  EventCallback,
} from './types.js';
import { emitEvent } from './events.js';

async function checkoutApi(
  apiBase: string,
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Checkout API ${res.status} ${options.method || 'GET'} ${path}: ${body}`);
  }
  return res.json();
}

// Step 1: Create checkout (one-time per agent, cached externally)
export async function createCheckout(config: CheckoutConfig): Promise<string> {
  const data = await checkoutApi(config.apiBase, `/environments/${config.environmentId}/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}` },
    body: JSON.stringify({
      mode: 'deposit',
      settlementConfig: {
        strategy: 'cheapest',
        settlements: [
          {
            chainName: config.settlementChainName,
            chainId: config.settlementChainId,
            tokenAddress: config.settlementTokenAddress,
            symbol: config.settlementTokenSymbol,
            tokenDecimals: config.settlementTokenDecimals,
          },
        ],
      },
      destinationConfig: {
        destinations: [
          {
            chainName: config.settlementChainName,
            type: 'address',
            identifier: config.destinationAddress,
          },
        ],
      },
    }),
  });
  return data.id;
}

// Step 2: Create transaction
export async function createTransaction(
  apiBase: string,
  environmentId: string,
  checkoutId: string,
  amountUsd: string,
  memo?: Record<string, unknown>,
): Promise<PaymentSession> {
  const data = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/checkouts/${checkoutId}/transactions`,
    {
      method: 'POST',
      body: JSON.stringify({
        amount: amountUsd,
        currency: 'USD',
        ...(memo ? { memo } : {}),
      }),
    },
  );
  return {
    transactionId: data.transaction.id,
    sessionToken: data.sessionToken,
  };
}

// Step 3: Attach source
export async function attachSource(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
  walletAddress: string,
  chainId: string,
  chainName: string,
): Promise<void> {
  await checkoutApi(apiBase, `/sdk/${environmentId}/transactions/${transactionId}/source`, {
    method: 'POST',
    headers: { 'X-Dynamic-Checkout-Session-Token': sessionToken },
    body: JSON.stringify({
      sourceType: 'wallet',
      fromAddress: walletAddress,
      fromChainId: chainId,
      fromChainName: chainName,
    }),
  });
}

// Step 4a: Wait for risk clearance
export async function waitForRiskClearance(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  maxWaitMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tx = await checkoutApi(
      apiBase,
      `/sdk/${environmentId}/transactions/${transactionId}`,
      { method: 'GET' },
    );
    const risk = tx.riskState ?? tx.transaction?.riskState;
    if (risk === 'cleared' || risk === 'not_required') return;
    if (risk === 'blocked') throw new Error('Payment source blocked by risk screening');
    await new Promise(r => setTimeout(r, 2_000));
  }
  // Timeout — proceed and let the quote call fail if risk isn't cleared
}

// Step 4b: Get quote
// The mainnet response returns the full transaction object with quote nested inside.
// The quote includes fromAmount/toAmount (not fromTokenAmount/toTokenAmount)
// and the signingPayload is embedded in the quote (no separate /prepare call needed).
export async function getQuote(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
  fromTokenAddress: string,
): Promise<PaymentQuote> {
  const data = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}/quote`,
    {
      method: 'POST',
      headers: { 'X-Dynamic-Checkout-Session-Token': sessionToken },
      body: JSON.stringify({ fromTokenAddress }),
    },
  );
  // Normalize: quote can be at data.quote, data.transaction.quote, or data itself
  const quote = data.quote ?? data.transaction?.quote ?? data;

  // Normalize field names: mainnet uses fromAmount/toAmount, docs say fromTokenAmount/toTokenAmount
  const normalized: PaymentQuote = {
    fromAmount: quote.fromAmount ?? quote.fromTokenAmount ?? '0',
    toAmount: quote.toAmount ?? quote.toTokenAmount ?? '0',
    estimatedTimeSec: quote.estimatedTimeSec ?? 0,
    fees: quote.fees ?? { totalFeeUsd: '0' },
    quoteExpiresAt: quote.expiresAt,
    signingPayload: quote.signingPayload,
  };

  if (!normalized.fees) {
    throw new Error(`Unexpected quote response shape: ${JSON.stringify(data)}`);
  }
  return normalized;
}

// Step 5: Prepare signing
export async function prepareSigning(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
): Promise<SigningPayload> {
  const data = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}/prepare`,
    {
      method: 'POST',
      headers: { 'X-Dynamic-Checkout-Session-Token': sessionToken },
    },
  );
  // Normalize: 4 possible payload locations
  const payload =
    data.transaction?.signingPayload ??
    data.signingPayload ??
    data.quote?.route?.signingPayload ??
    data;

  return payload;
}

// Step 7: Record broadcast
export async function recordBroadcast(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
  txHash: string,
): Promise<void> {
  await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}/broadcast`,
    {
      method: 'POST',
      headers: { 'X-Dynamic-Checkout-Session-Token': sessionToken },
      body: JSON.stringify({ txHash }),
    },
  );
}

// Step 8: Poll for settlement
export async function pollSettlement(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  onStatus?: (executionState: string, settlementState: string) => void,
  maxDurationMs = 300_000, // 5 minutes
): Promise<SettlementResult> {
  const start = Date.now();
  while (Date.now() - start < maxDurationMs) {
    await new Promise(r => setTimeout(r, 3_000));
    const tx = await checkoutApi(
      apiBase,
      `/sdk/${environmentId}/transactions/${transactionId}`,
      { method: 'GET' },
    );
    const exec = tx.executionState ?? '';
    const settle = tx.settlementState ?? '';
    onStatus?.(exec, settle);

    if (settle === 'completed') {
      return {
        transactionId,
        txHash: tx.txHash ?? '',
        executionState: exec,
        settlementState: settle,
        completedAt: tx.completedAt,
      };
    }
    if (settle === 'failed' || ['cancelled', 'expired', 'failed'].includes(exec)) {
      throw new Error(`Settlement failed: execution=${exec}, settlement=${settle}`);
    }
  }
  throw new Error(`Settlement timeout after ${maxDurationMs / 1000}s for transaction ${transactionId}`);
}

// Get transaction status (for external polling)
export async function getTransactionStatus(
  apiBase: string,
  environmentId: string,
  transactionId: string,
): Promise<{ executionState: string; settlementState: string; riskState: string }> {
  const tx = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}`,
    { method: 'GET' },
  );
  return {
    executionState: tx.executionState ?? '',
    settlementState: tx.settlementState ?? '',
    riskState: tx.riskState ?? '',
  };
}

// Full checkout flow: steps 2-8 as one deterministic function
export async function executeCheckoutFlow(params: {
  apiBase: string;
  environmentId: string;
  checkoutId: string;
  amountUsd: string;
  sourceAddress: string;
  sourceChainId: string;
  sourceChainName: string;
  fromTokenAddress: string;
  signTransaction: SignTransactionFn;
  minFundingThresholdUsd?: string;
  emit?: EventCallback;
  memo?: Record<string, unknown>;
}): Promise<SettlementResult> {
  const {
    apiBase, environmentId, checkoutId, amountUsd,
    sourceAddress, sourceChainId, sourceChainName,
    fromTokenAddress, signTransaction, emit, memo,
    minFundingThresholdUsd = '1.00',
  } = params;

  const log = (type: string, data: Record<string, unknown> = {}) => {
    if (emit) emitEvent(emit, type, data);
  };

  // Check minimum funding threshold
  if (parseFloat(amountUsd) < parseFloat(minFundingThresholdUsd)) {
    throw new Error(
      `Amount $${amountUsd} is below minimum funding threshold $${minFundingThresholdUsd}. ` +
      `Increase the amount or adjust MIN_FUNDING_THRESHOLD_USD.`
    );
  }

  // Step 2: Create transaction
  log('checkout_tx_created', { amountUsd, checkoutId });
  const session = await createTransaction(apiBase, environmentId, checkoutId, amountUsd, memo);

  // Step 3: Attach source
  log('checkout_source_attached', { sourceAddress, sourceChainName });
  await attachSource(
    apiBase, environmentId,
    session.transactionId, session.sessionToken,
    sourceAddress, sourceChainId, sourceChainName,
  );

  // Step 4a: Wait for risk clearance
  log('checkout_risk_check', { transactionId: session.transactionId });
  await waitForRiskClearance(apiBase, environmentId, session.transactionId);

  // Step 4b: Get quote (with retry on expiry)
  // The quote response includes the signing payload — no separate /prepare call needed.
  let quote: PaymentQuote;
  let retries = 0;
  const MAX_QUOTE_RETRIES = 3;
  while (true) {
    quote = await getQuote(
      apiBase, environmentId,
      session.transactionId, session.sessionToken,
      fromTokenAddress,
    );
    log('checkout_quoted', {
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      feesUsd: quote.fees.totalFeeUsd,
      estimatedTimeSec: quote.estimatedTimeSec,
    });

    try {
      // Step 5: Extract signing payload from quote
      // Mainnet returns signingPayload inside quote; fall back to /prepare if missing
      let signingPayload: SigningPayload;
      if (quote.signingPayload?.evmTransaction) {
        signingPayload = {
          to: quote.signingPayload.evmTransaction.to,
          data: quote.signingPayload.evmTransaction.data,
          value: quote.signingPayload.evmTransaction.value,
          transactionRequest: quote.signingPayload.evmTransaction,
        };
      } else {
        // Fallback to separate /prepare call (for API versions that don't embed it)
        signingPayload = await prepareSigning(
          apiBase, environmentId,
          session.transactionId, session.sessionToken,
        );
      }

      // Step 6: Sign and broadcast via wallet
      log('checkout_signing', { chainName: sourceChainName });
      const txHash = await signTransaction(signingPayload, sourceChainName);

      // Step 7: Record broadcast
      log('checkout_broadcast', { txHash });
      await recordBroadcast(
        apiBase, environmentId,
        session.transactionId, session.sessionToken,
        txHash,
      );

      // Step 8: Poll settlement
      log('checkout_settling', { transactionId: session.transactionId });
      const result = await pollSettlement(
        apiBase, environmentId,
        session.transactionId,
        (exec, settle) => log('checkout_status', { exec, settle }),
      );

      log('checkout_complete', { txHash: result.txHash, settlementState: result.settlementState });
      return result;
    } catch (err: any) {
      // 422 = quote expired, retry
      if (err.message?.includes('422') && retries < MAX_QUOTE_RETRIES) {
        retries++;
        log('checkout_requote', { retry: retries });
        continue;
      }
      throw err;
    }
  }
}
