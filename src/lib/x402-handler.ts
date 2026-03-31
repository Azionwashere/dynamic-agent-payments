import type { X402PaymentRequirements, X402PaymentResult } from './types.js';
import { signTypedData } from './wallet.js';
import { loadConfig } from './config.js';

/**
 * Parse the PAYMENT-REQUIRED header from an HTTP 402 response.
 * Returns null if this is not an x402 response (critical: don't pay random 402s).
 */
export function parsePaymentRequired(
  headers: Record<string, string | undefined>,
): X402PaymentRequirements | null {
  const raw = headers['payment-required'] ?? headers['PAYMENT-REQUIRED'];
  if (!raw) return null;

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);

    // Validate required fields
    if (!parsed.amount || !parsed.currency || !parsed.recipient) {
      return null;
    }

    return {
      amount: String(parsed.amount),
      currency: parsed.currency,
      recipient: parsed.recipient,
      facilitator: parsed.facilitator ?? loadConfig().x402FacilitatorUrl,
      chainId: parsed.chainId,
      network: parsed.network,
      scheme: parsed.scheme ?? 'exact',
      extra: parsed,
    };
  } catch {
    return null;
  }
}

/**
 * Construct the EIP-712 typed data for an x402 payment authorization.
 * Per x402 spec: gasless USDC transfer via permit-style signature.
 */
export function buildPaymentTypedData(req: X402PaymentRequirements): {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  return {
    domain: {
      name: 'x402',
      version: '1',
      chainId: req.chainId ? parseInt(req.chainId) : 8453, // default Base
    },
    types: {
      PaymentAuthorization: [
        { name: 'amount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'currency', type: 'string' },
        { name: 'scheme', type: 'string' },
      ],
    },
    primaryType: 'PaymentAuthorization',
    message: {
      amount: req.amount,
      recipient: req.recipient,
      currency: req.currency,
      scheme: req.scheme ?? 'exact',
    },
  };
}

/**
 * Sign an x402 payment using delegated EIP-712 signing.
 */
export async function signPayment(
  req: X402PaymentRequirements,
): Promise<string> {
  const typedData = buildPaymentTypedData(req);
  return signTypedData(typedData);
}

/**
 * Submit the signed payment to the x402 facilitator for settlement.
 */
export async function submitToFacilitator(
  facilitatorUrl: string,
  paymentPayload: X402PaymentRequirements,
  signature: string,
): Promise<{ txHash: string; status: string }> {
  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: paymentPayload,
      signature,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facilitator settlement failed (${res.status}): ${body}`);
  }

  const data = await res.json() as any;
  return {
    txHash: data.txHash ?? data.transactionHash ?? '',
    status: data.status ?? 'settled',
  };
}

/**
 * Full x402 paywall handler: parse → sign → submit → return result.
 * Returns null if the response is not an x402 paywall.
 */
export async function handlePaywall(
  responseHeaders: Record<string, string | undefined>,
): Promise<X402PaymentResult | null> {
  const req = parsePaymentRequired(responseHeaders);
  if (!req) return null;

  const signature = await signPayment(req);

  const facilitatorUrl = req.facilitator ?? loadConfig().x402FacilitatorUrl;
  const result = await submitToFacilitator(facilitatorUrl, req, signature);

  return {
    settlementHash: result.txHash,
    accessGranted: result.status === 'settled',
  };
}
