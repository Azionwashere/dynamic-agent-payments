import type { X402PaymentRequirements, X402PaymentResult } from './types.js';
import { signTypedData, getWalletAddress } from './wallet.js';
import { loadConfig } from './config.js';

// ============================================================
// Protocol Detection
// ============================================================

export type PaymentProtocol = 'x402-coinbase' | 'mpp' | 'none';

/**
 * Detect which payment protocol a 402 response uses.
 */
export function detectProtocol(
  headers: Record<string, string | undefined>,
): PaymentProtocol {
  // MPP: WWW-Authenticate: Payment ...
  const wwwAuth = headers['www-authenticate'] ?? headers['WWW-Authenticate'];
  if (wwwAuth && wwwAuth.includes('Payment ')) return 'mpp';

  // Coinbase x402: PAYMENT-REQUIRED header
  const payReq = headers['payment-required'] ?? headers['PAYMENT-REQUIRED'];
  if (payReq) return 'x402-coinbase';

  return 'none';
}

// ============================================================
// MPP Protocol (HTTP Payment Authentication Scheme)
// ============================================================

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires?: string;
  opaque?: string;
}

export interface MppRequestPayload {
  amount: string;
  currency: string;
  recipient: string;
  chainId: number;
  tokenAddress: string;
  signatureData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  paymentId?: string;
}

/**
 * Parse WWW-Authenticate: Payment headers into challenges.
 */
export function parseMppChallenges(wwwAuthHeader: string): MppChallenge[] {
  const challenges: MppChallenge[] = [];
  const parts = wwwAuthHeader.split(/(?:^|,\s*)Payment\s+/).filter(Boolean);

  for (const part of parts) {
    const params: Record<string, string> = {};
    const regex = /(\w+)="([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part)) !== null) {
      params[match[1]] = match[2];
    }

    if (params.id && params.realm && params.method && params.intent && params.request) {
      challenges.push({
        id: params.id,
        realm: params.realm,
        method: params.method,
        intent: params.intent,
        request: params.request,
        expires: params.expires,
        opaque: params.opaque,
      });
    }
  }
  return challenges;
}

/**
 * Decode the base64url-encoded request parameter from an MPP challenge.
 */
export function decodeMppRequest(requestB64: string): MppRequestPayload {
  const decoded = Buffer.from(requestB64, 'base64url').toString('utf-8');
  return JSON.parse(decoded);
}

/**
 * Select the best challenge from available options.
 * Priority: transferwithauth > permit > opdata
 */
export function selectChallenge(challenges: MppChallenge[]): MppChallenge | null {
  const priority = ['transferwithauth', 'permit', 'opdata'];
  for (const method of priority) {
    const challenge = challenges.find(c => c.method === method);
    if (challenge) return challenge;
  }
  return challenges[0] ?? null;
}

/**
 * Recursively replace {{from}} placeholders with the wallet address.
 */
function replacePlaceholders(obj: any, walletAddress: string): void {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string' && obj[key].includes('{{from}}')) {
      obj[key] = obj[key].replace(/\{\{from\}\}/g, walletAddress);
    } else if (typeof obj[key] === 'object') {
      replacePlaceholders(obj[key], walletAddress);
    }
  }
}

/**
 * Split an ECDSA signature hex string into { v, r, s } components.
 */
function splitSignature(sig: string): { v: number; r: string; s: string } {
  const raw = sig.startsWith('0x') ? sig.slice(2) : sig;
  return {
    r: '0x' + raw.slice(0, 64),
    s: '0x' + raw.slice(64, 128),
    v: parseInt(raw.slice(128, 130), 16),
  };
}

/**
 * Build and encode an MPP credential for the Authorization header.
 */
function buildMppCredential(
  challenge: MppChallenge,
  source: string,
  signature: { v: number; r: string; s: string },
  message: Record<string, unknown>,
): string {
  const credential = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      expires: challenge.expires,
      opaque: challenge.opaque,
    },
    source,
    payload: { signature, message },
  };
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}`;
}

/**
 * Handle an MPP 402 response: parse challenge, sign, build credential.
 * Returns the Authorization header value to retry the request with.
 */
export async function handleMppPaywall(
  wwwAuthHeader: string,
): Promise<{ authorizationHeader: string; paymentId?: string; challenge: MppChallenge; requestPayload: MppRequestPayload } | null> {
  const challenges = parseMppChallenges(wwwAuthHeader);
  if (challenges.length === 0) return null;

  const challenge = selectChallenge(challenges);
  if (!challenge) return null;

  const requestPayload = decodeMppRequest(challenge.request);
  const walletAddress = await getWalletAddress();

  // Replace {{from}} placeholders with our wallet address
  replacePlaceholders(requestPayload.signatureData, walletAddress);

  // Build the EIP-712 typed data from the challenge
  const typedData = {
    domain: requestPayload.signatureData.domain,
    types: requestPayload.signatureData.types,
    primaryType: requestPayload.signatureData.primaryType,
    message: requestPayload.signatureData.message,
  };

  // Sign via Dynamic wallet
  const signatureHex = await signTypedData(typedData);
  const sigParts = splitSignature(signatureHex);

  // Build the Authorization: Payment credential
  const authHeader = buildMppCredential(
    challenge,
    walletAddress,
    sigParts,
    requestPayload.signatureData.message as Record<string, unknown>,
  );

  return {
    authorizationHeader: authHeader,
    paymentId: requestPayload.paymentId,
    challenge,
    requestPayload,
  };
}

// ============================================================
// Coinbase x402 Protocol (PAYMENT-REQUIRED header)
// ============================================================

/**
 * Parse the PAYMENT-REQUIRED header from a Coinbase-style x402 response.
 * Returns null if not a valid x402 response.
 */
export function parsePaymentRequired(
  headers: Record<string, string | undefined>,
): X402PaymentRequirements | null {
  const raw = headers['payment-required'] ?? headers['PAYMENT-REQUIRED'];
  if (!raw) return null;

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);

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
 * Build EIP-712 typed data for a Coinbase-style x402 payment.
 */
export function buildPaymentTypedData(req: X402PaymentRequirements) {
  return {
    domain: {
      name: 'x402',
      version: '1',
      chainId: req.chainId ? parseInt(req.chainId) : 8453,
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
 * Sign a Coinbase-style x402 payment.
 */
export async function signPayment(req: X402PaymentRequirements): Promise<string> {
  const typedData = buildPaymentTypedData(req);
  return signTypedData(typedData);
}

/**
 * Submit to a Coinbase-style x402 facilitator for settlement.
 */
export async function submitToFacilitator(
  facilitatorUrl: string,
  paymentPayload: X402PaymentRequirements,
  signature: string,
): Promise<{ txHash: string; status: string }> {
  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: paymentPayload, signature }),
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
 * Handle a Coinbase-style x402 paywall end-to-end.
 */
export async function handleCoinbasePaywall(
  headers: Record<string, string | undefined>,
): Promise<X402PaymentResult | null> {
  const req = parsePaymentRequired(headers);
  if (!req) return null;

  const signature = await signPayment(req);
  const facilitatorUrl = req.facilitator ?? loadConfig().x402FacilitatorUrl;
  const result = await submitToFacilitator(facilitatorUrl, req, signature);

  return {
    settlementHash: result.txHash,
    accessGranted: result.status === 'settled',
  };
}

// ============================================================
// Unified Handler (auto-detects protocol)
// ============================================================

/**
 * Handle any 402 response. Auto-detects the protocol and returns
 * the appropriate payment result or authorization header.
 */
export async function handlePaywall(
  responseHeaders: Record<string, string | undefined>,
): Promise<X402PaymentResult | null> {
  const protocol = detectProtocol(responseHeaders);

  if (protocol === 'mpp') {
    const wwwAuth = responseHeaders['www-authenticate'] ?? responseHeaders['WWW-Authenticate'];
    if (!wwwAuth) return null;

    const result = await handleMppPaywall(wwwAuth);
    if (!result) return null;

    // For MPP, the "settlement" happens when the merchant verifies + settles
    // after we retry with the Authorization header. Return the auth header
    // so the caller can retry.
    return {
      settlementHash: '', // populated after retry
      accessGranted: false, // caller must retry with authorizationHeader
      authorizationHeader: result.authorizationHeader,
      paymentId: result.paymentId,
      protocol: 'mpp',
    } as any; // extended result — caller checks protocol
  }

  if (protocol === 'x402-coinbase') {
    return handleCoinbasePaywall(responseHeaders);
  }

  return null;
}
