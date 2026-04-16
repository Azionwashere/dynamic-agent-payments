import { z } from 'zod';
import {
  detectProtocol,
  handleMppPaywall,
  handleCoinbaseX402,
} from '../../lib/x402-handler.js';
import { parseIntegrityHeader, verifyIntegrity } from '../../lib/integrity.js';
import type { EventCallback, X402PaymentResult, IntegrityInfo } from '../../lib/types.js';
import { emitEvent } from '../../lib/events.js';

export const payX402Schema = z.object({
  url: z.string().describe('The URL that returned 402 Payment Required'),
  method: z.enum(['GET', 'POST']).default('GET').describe('HTTP method to use'),
  body: z.string().optional().describe('Request body for POST requests'),
  memo: z.record(z.unknown()).optional().describe(
    'Metadata to tag this payment (e.g., { "purpose": "crypto-price-feed" })'
  ),
  requireIntegrity: z.boolean().optional().default(false).describe(
    'Require the server to provide a signed integrity proof (X-402-Integrity header)'
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
  const requestHeaders: Record<string, string> = {};
  if (input.body) requestHeaders['Content-Type'] = 'application/json';
  if (input.requireIntegrity) requestHeaders['X-402-Require-Integrity'] = 'true';

  try {
    initialRes = await fetch(input.url, {
      method: input.method,
      headers: requestHeaders,
      ...(input.body ? { body: input.body } : {}),
    });
  } catch (err: any) {
    throw new Error(`Network error fetching ${input.url}: ${err.cause?.message ?? err.message}`);
  }

  if (initialRes.ok) {
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

  // Step 2: Extract headers
  const headers: Record<string, string> = {};
  initialRes.headers.forEach((v, k) => { headers[k] = v; });

  const headerProtocol = detectProtocol(headers);

  // Step 2b: Check payment instruction integrity
  let integrity: IntegrityInfo | undefined;
  const integrityHeader = headers['x-402-integrity'];

  if (integrityHeader) {
    try {
      const envelope = parseIntegrityHeader(integrityHeader);

      // We need the accept object for verification — parse body early for x402-coinbase
      let accept: any;
      if (headerProtocol === 'mpp') {
        // For MPP, integrity verification uses header fields — skip for now
        accept = {};
      } else {
        const bodyClone = initialRes.clone();
        const body = await bodyClone.json().catch(() => null);
        accept = body?.accepts?.[0] ?? {};
      }

      integrity = await verifyIntegrity(envelope, accept, { allowHttp: true });

      if (emit) emitEvent(emit, 'x402_integrity_verified', {
        did: integrity.did,
        kid: integrity.kid,
        alg: integrity.alg,
        domain: integrity.domain,
        url: input.url,
      });
    } catch (err: any) {
      if (emit) emitEvent(emit, 'x402_integrity_failed', {
        error: err.message,
        url: input.url,
      });
      throw new Error(`Payment instruction integrity check failed: ${err.message}`);
    }
  } else if (input.requireIntegrity) {
    if (emit) emitEvent(emit, 'x402_integrity_required_missing', { url: input.url });
    throw new Error(
      'Server did not provide integrity proof (X-402-Integrity header). ' +
      'Remove --require-integrity to proceed without verification.'
    );
  } else {
    if (emit) emitEvent(emit, 'x402_integrity_missing', { url: input.url });
  }

  // Step 3: Handle based on protocol

  // MPP Protocol (WWW-Authenticate: Payment)
  if (headerProtocol === 'mpp') {
    if (emit) emitEvent(emit, 'x402_detected', { protocol: 'mpp', url: input.url, ...(input.memo ? { memo: input.memo } : {}) });
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
      integrity,
      responseData,
    };
  }

  // x402 Protocol (JSON body with accepts[])
  if (headerProtocol === 'x402-coinbase' || headerProtocol === 'none') {
    const body = await initialRes.json().catch(() => null);

    if (body?.accepts?.length > 0) {
      if (emit) emitEvent(emit, 'x402_detected', { protocol: 'x402-coinbase', url: input.url, ...(input.memo ? { memo: input.memo } : {}) });
      const result = await handleCoinbaseX402(input.url, body.accepts[0], input.method, input.body, body.resource);

      if (emit) emitEvent(emit, 'x402_complete', {
        protocol: 'x402-coinbase',
        txHash: result.settlementHash,
        status: result.accessGranted ? 200 : 402,
        accessGranted: result.accessGranted,
        ...(input.memo ? { memo: input.memo } : {}),
      });

      return { ...result, protocol: 'x402-coinbase', integrity };
    }
  }

  throw new Error(
    'Unrecognized 402 response format. Expected either WWW-Authenticate: Payment header (MPP) or JSON body with accepts[] (Coinbase x402).'
  );
}
