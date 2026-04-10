import { z } from 'zod';
import {
  detectProtocol,
  handleMppPaywall,
  handleCoinbaseX402,
} from '../../lib/x402-handler.js';
import type { EventCallback, X402PaymentResult } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const payX402Schema = z.object({
  url: z.string().describe('The URL that returned 402 Payment Required'),
  method: z.enum(['GET', 'POST']).default('GET').describe('HTTP method to use'),
  body: z.string().optional().describe('Request body for POST requests'),
  memo: z.record(z.unknown()).optional().describe(
    'Metadata to tag this payment (e.g., { "purpose": "crypto-price-feed" })'
  ),
});

export type PayX402Input = z.infer<typeof payX402Schema>;

export async function payX402(
  input: PayX402Input,
  emit?: EventCallback,
): Promise<X402PaymentResult & { responseData?: unknown }> {
  if (emit) emitEvent(emit, 'x402_start', {
    url: input.url,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  // Step 1: Make the request — expect 402
  let initialRes: Response;
  try {
    initialRes = await fetch(input.url, {
      method: input.method,
      ...(input.body ? { body: input.body, headers: { 'Content-Type': 'application/json' } } : {}),
    });
  } catch (err: any) {
    throw new Error(`Network error fetching ${input.url}: ${err.cause?.message ?? err.message}`);
  }

  if (initialRes.ok) {
    // Not a 402 — no payment needed
    const rawText = await initialRes.text();
    let data: unknown;
    try { data = JSON.parse(rawText); } catch { data = rawText; }
    return {
      settlementHash: '',
      accessGranted: true,
      protocol: 'none' as any,
      noPaymentRequired: true,
      responseData: data,
    } as any;
  }

  if (initialRes.status !== 402) {
    throw new Error(`Expected 402 Payment Required, got ${initialRes.status}`);
  }

  // Step 2: Detect protocol from headers and body
  const headers: Record<string, string> = {};
  initialRes.headers.forEach((v, k) => { headers[k] = v; });

  const protocol = detectProtocol(headers);

  if (emit) emitEvent(emit, 'x402_detected', {
    protocol,
    url: input.url,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  // Step 3: Handle based on protocol

  // MPP Protocol (WWW-Authenticate: Payment)
  if (protocol === 'mpp') {
    const mppResult = await handleMppPaywall(headers['www-authenticate']!);
    if (!mppResult) throw new Error('Failed to parse MPP challenge');

    const retryRes = await fetch(input.url, {
      method: input.method,
      headers: { 'Authorization': mppResult.authorizationHeader },
      ...(input.body ? { body: input.body } : {}),
    });

    const retryText = await retryRes.text();
    let responseData: unknown;
    try { responseData = JSON.parse(retryText); } catch { responseData = retryText; }

    if (emit) emitEvent(emit, 'x402_complete', {
      protocol: 'mpp',
      status: retryRes.status,
      accessGranted: retryRes.ok,
      ...(input.memo ? { memo: input.memo } : {}),
    });

    return {
      settlementHash: retryRes.headers.get('payment-receipt') ?? '',
      accessGranted: retryRes.ok,
      protocol: 'mpp',
      responseData,
    };
  }

  // x402 Protocol (JSON body with accepts[])
  if (protocol === 'x402-coinbase' || protocol === 'none') {
    // Try parsing the response body for x402 payment requirements
    const body = await initialRes.json().catch(() => null);

    if (body?.accepts?.length > 0) {
      const result = await handleCoinbaseX402(input.url, body.accepts[0], input.method, input.body, body.resource);

      if (emit) emitEvent(emit, 'x402_complete', {
        protocol: 'x402-coinbase',
        status: result.accessGranted ? 200 : 402,
        accessGranted: result.accessGranted,
        ...(input.memo ? { memo: input.memo } : {}),
      });

      return { ...result, protocol: 'x402-coinbase' };
    }
  }

  throw new Error(
    'Unrecognized 402 response format. Expected either WWW-Authenticate: Payment header (MPP) or JSON body with accepts[] (Coinbase x402).'
  );
}
