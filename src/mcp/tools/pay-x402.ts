import { z } from 'zod';
import { detectProtocol, handleMppPaywall, handleCoinbasePaywall } from '../../lib/x402-handler.js';
import type { EventCallback, X402PaymentResult } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const payX402Schema = z.object({
  url: z.string().optional().describe(
    'The URL that returned 402. Required for MPP protocol (agent retries the request with Authorization header).'
  ),
  paymentRequiredHeader: z.string().optional().describe(
    'Coinbase x402: the base64-encoded PAYMENT-REQUIRED header value'
  ),
  wwwAuthenticateHeader: z.string().optional().describe(
    'MPP: the full WWW-Authenticate: Payment header value from the 402 response'
  ),
  memo: z.record(z.unknown()).optional().describe(
    'Metadata to tag this payment (e.g., { "purpose": "anthropic-credits" })'
  ),
});

export type PayX402Input = z.infer<typeof payX402Schema>;

export async function payX402(
  input: PayX402Input,
  emit?: EventCallback,
): Promise<X402PaymentResult & { responseData?: unknown }> {
  // Auto-detect protocol from provided headers
  const headers: Record<string, string | undefined> = {};
  if (input.wwwAuthenticateHeader) headers['www-authenticate'] = input.wwwAuthenticateHeader;
  if (input.paymentRequiredHeader) headers['payment-required'] = input.paymentRequiredHeader;

  const protocol = detectProtocol(headers);

  if (emit) emitEvent(emit, 'x402_start', {
    protocol,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  if (protocol === 'mpp') {
    // MPP: sign the challenge, then retry the original request
    const mppResult = await handleMppPaywall(input.wwwAuthenticateHeader!);
    if (!mppResult) {
      throw new Error('Failed to parse MPP challenge from WWW-Authenticate header');
    }

    // Retry the original request with the Authorization header
    if (!input.url) {
      // Can't retry without URL — return the auth header for the caller to use
      if (emit) emitEvent(emit, 'x402_signed', {
        protocol: 'mpp',
        paymentId: mppResult.paymentId,
        ...(input.memo ? { memo: input.memo } : {}),
      });
      return {
        settlementHash: '',
        accessGranted: false,
        authorizationHeader: mppResult.authorizationHeader,
        paymentId: mppResult.paymentId,
        protocol: 'mpp',
      };
    }

    // Retry the request with payment
    const retryRes = await fetch(input.url, {
      headers: { 'Authorization': mppResult.authorizationHeader },
    });

    const responseData = await retryRes.json().catch(() => retryRes.text());

    // Check for Payment-Receipt header
    const receiptHeader = retryRes.headers.get('payment-receipt');

    if (emit) emitEvent(emit, 'x402_complete', {
      protocol: 'mpp',
      status: retryRes.status,
      paymentId: mppResult.paymentId,
      hasReceipt: !!receiptHeader,
      ...(input.memo ? { memo: input.memo } : {}),
    });

    return {
      settlementHash: receiptHeader ?? '',
      accessGranted: retryRes.ok,
      paymentId: mppResult.paymentId,
      protocol: 'mpp',
      responseData,
    };
  }

  if (protocol === 'x402-coinbase') {
    const result = await handleCoinbasePaywall(headers);
    if (!result) {
      throw new Error(
        'Failed to parse PAYMENT-REQUIRED header. Ensure it is valid base64-encoded JSON with amount, currency, and recipient.'
      );
    }

    if (emit) emitEvent(emit, 'x402_complete', {
      protocol: 'x402-coinbase',
      settlementHash: result.settlementHash,
      accessGranted: result.accessGranted,
      ...(input.memo ? { memo: input.memo } : {}),
    });

    return { ...result, protocol: 'x402-coinbase' };
  }

  throw new Error(
    'No recognized payment protocol. Provide either wwwAuthenticateHeader (MPP) or paymentRequiredHeader (Coinbase x402).'
  );
}
