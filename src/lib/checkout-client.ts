import type {
  CheckoutConfig,
  PaymentSession,
  PaymentQuote,
  CheckoutSigningPayload,
  SigningPayload,
  SettlementResult,
  SignTransactionFn,
  ApprovalFn,
  EventCallback,
} from './types.js';
import { emitEvent } from './events.js';

const SESSION_HEADER = 'x-dynamic-checkout-session-token';

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
    headers: { [SESSION_HEADER]: sessionToken },
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
}

// Step 4b: Get quote
export async function getQuote(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
  fromTokenAddress: string,
  slippage?: number,
): Promise<PaymentQuote> {
  const body: Record<string, unknown> = { fromTokenAddress };
  if (slippage !== undefined) body.slippage = slippage;

  const data = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}/quote`,
    {
      method: 'POST',
      headers: { [SESSION_HEADER]: sessionToken },
      body: JSON.stringify(body),
    },
  );
  // Quote is at data.quote per spec
  const quote = data.quote ?? data.transaction?.quote ?? data;

  return {
    fromAmount: quote.fromAmount ?? quote.fromTokenAmount ?? '0',
    toAmount: quote.toAmount ?? quote.toTokenAmount ?? '0',
    estimatedTimeSec: quote.estimatedTimeSec ?? 0,
    fees: quote.fees ?? { totalFeeUsd: '0' },
    quoteExpiresAt: quote.expiresAt,
    version: quote.version,
  };
}

// Step 5: Prepare signing — locks the quote and returns signing payload
export async function prepareSigning(
  apiBase: string,
  environmentId: string,
  transactionId: string,
  sessionToken: string,
): Promise<CheckoutSigningPayload> {
  const data = await checkoutApi(
    apiBase,
    `/sdk/${environmentId}/transactions/${transactionId}/prepare`,
    {
      method: 'POST',
      headers: { [SESSION_HEADER]: sessionToken },
    },
  );
  // Per spec: signing payload is at quote.signingPayload
  const payload =
    data.quote?.signingPayload ??
    data.transaction?.signingPayload ??
    data.signingPayload;

  if (!payload) {
    throw new Error(`No signing payload in prepare response: ${JSON.stringify(data).slice(0, 200)}`);
  }
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
      headers: { [SESSION_HEADER]: sessionToken },
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
  maxDurationMs = 300_000,
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
        memo: tx.memo,
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
  sendApproval?: ApprovalFn;
  slippage?: number;
  minFundingThresholdUsd?: string;
  emit?: EventCallback;
  memo?: Record<string, unknown>;
}): Promise<SettlementResult> {
  const {
    apiBase, environmentId, checkoutId, amountUsd,
    sourceAddress, sourceChainId, sourceChainName,
    fromTokenAddress, signTransaction, sendApproval,
    slippage, emit, memo,
    minFundingThresholdUsd = '1.00',
  } = params;

  const log = (type: string, data: Record<string, unknown> = {}) => {
    if (memo) data.memo = memo;
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

  // Step 4b + 5: Get quote then prepare signing (with retry on expiry)
  let retries = 0;
  const MAX_QUOTE_RETRIES = 3;
  while (true) {
    // Step 4b: Get quote
    const quote = await getQuote(
      apiBase, environmentId,
      session.transactionId, session.sessionToken,
      fromTokenAddress, slippage,
    );
    log('checkout_quoted', {
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      feesUsd: quote.fees.totalFeeUsd,
      estimatedTimeSec: quote.estimatedTimeSec,
    });

    try {
      // Step 5: Prepare signing — locks the quote, returns signing payload
      log('checkout_preparing', { transactionId: session.transactionId });
      const signingPayload = await prepareSigning(
        apiBase, environmentId,
        session.transactionId, session.sessionToken,
      );

      // Step 6a: Handle ERC-20 approval if required
      if (signingPayload.evmApproval) {
        log('checkout_approval', {
          tokenAddress: signingPayload.evmApproval.tokenAddress,
          spenderAddress: signingPayload.evmApproval.spenderAddress,
          amount: signingPayload.evmApproval.amount,
        });
        if (!sendApproval) {
          throw new Error(
            'ERC-20 approval required but no sendApproval function provided. ' +
            'This token requires an approval transaction before the swap.'
          );
        }
        await sendApproval(signingPayload.evmApproval);
      }

      // Step 6b: Sign and broadcast the main transaction
      const mainPayload: SigningPayload = signingPayload.evmTransaction
        ? {
            to: signingPayload.evmTransaction.to,
            data: signingPayload.evmTransaction.data,
            value: signingPayload.evmTransaction.value,
            transactionRequest: signingPayload.evmTransaction,
          }
        : { serializedTransaction: signingPayload.serializedTransaction };

      log('checkout_signing', { chainName: sourceChainName });
      const txHash = await signTransaction(mainPayload, sourceChainName);

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

      log('checkout_complete', {
        txHash: result.txHash,
        settlementState: result.settlementState,
      });
      return { ...result, memo };
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
