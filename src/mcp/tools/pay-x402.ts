import { z } from 'zod';
import { parsePaymentRequired, handlePaywall } from '../../lib/x402-handler.js';
import type { EventCallback, X402PaymentResult } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const payX402Schema = z.object({
  paymentRequiredHeader: z.string().describe(
    'The base64-encoded PAYMENT-REQUIRED header value from the HTTP 402 response'
  ),
  memo: z.record(z.unknown()).optional().describe(
    'Metadata to tag this payment (e.g., { "purpose": "anthropic-credits", "service": "api.anthropic.com" })'
  ),
});

export type PayX402Input = z.infer<typeof payX402Schema>;

export async function payX402(
  input: PayX402Input,
  emit?: EventCallback,
): Promise<X402PaymentResult> {
  if (emit) emitEvent(emit, 'x402_start', {
    headerLength: input.paymentRequiredHeader.length,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  // Parse into headers format expected by handler
  const headers: Record<string, string> = {
    'payment-required': input.paymentRequiredHeader,
  };

  const result = await handlePaywall(headers);

  if (!result) {
    throw new Error(
      'Failed to parse PAYMENT-REQUIRED header. Ensure the value is a valid base64-encoded ' +
      'JSON object with amount, currency, and recipient fields.'
    );
  }

  if (emit) emitEvent(emit, 'x402_complete', {
    settlementHash: result.settlementHash,
    accessGranted: result.accessGranted,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  return result;
}
