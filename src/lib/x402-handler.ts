import type { X402PaymentRequirements, X402PaymentResult } from './types.js';
import { signTypedData, getWalletAddress } from './wallet.js';
import { handleErc7710Payment } from './delegation.js';

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
// draft-ryan-httpauth-payment-00
// ============================================================

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires?: string;
  digest?: string;
  description?: string;
  opaque?: string;
}

/** EIP-712 request format used by our x402-facilitator. */
export interface Eip712MppRequest {
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

/** Generic decoded MPP request — structure depends on the payment method. */
export type MppRequestPayload = Eip712MppRequest | Record<string, unknown>;

/** Methods this agent can handle (EIP-712 signing on EVM chains). */
export const SUPPORTED_MPP_METHODS = ['transferwithauth', 'permit', 'opdata'];

/**
 * Parse WWW-Authenticate: Payment headers into challenges.
 * Supports multiple challenges per header (comma-separated) and
 * multiple WWW-Authenticate headers (pass them joined with ', ').
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
        digest: params.digest,
        description: params.description,
        opaque: params.opaque,
      });
    }
  }
  return challenges;
}

/**
 * Decode the base64url-encoded request parameter from an MPP challenge.
 * Returns the raw parsed JSON — structure depends on the payment method.
 */
export function decodeMppRequest(requestB64: string): Record<string, unknown> {
  const decoded = Buffer.from(requestB64, 'base64url').toString('utf-8');
  return JSON.parse(decoded);
}

/** Check if a decoded request has our facilitator's EIP-712 signatureData format. */
export function isEip712Request(request: Record<string, unknown>): boolean {
  const sd = request.signatureData;
  return sd != null && typeof sd === 'object' && 'domain' in sd && 'types' in sd && 'primaryType' in sd;
}

/**
 * Select the best challenge from available options.
 * Picks the first challenge whose method this agent supports.
 * Falls back to the first challenge if none match (caller will get
 * a descriptive error when trying to handle it).
 */
export function selectChallenge(
  challenges: MppChallenge[],
  supportedMethods: string[] = SUPPORTED_MPP_METHODS,
): MppChallenge | null {
  for (const method of supportedMethods) {
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
 * Per spec: Authorization: Payment <base64url(JSON)>
 * Credential echoes the full challenge, includes source (payer) and method-specific payload.
 */
export function buildMppCredential(
  challenge: MppChallenge,
  source: string,
  payload: Record<string, unknown>,
): string {
  const challengeEcho: Record<string, unknown> = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
  };
  if (challenge.expires) challengeEcho.expires = challenge.expires;
  if (challenge.digest) challengeEcho.digest = challenge.digest;
  if (challenge.description) challengeEcho.description = challenge.description;
  if (challenge.opaque) challengeEcho.opaque = challenge.opaque;

  const credential = { challenge: challengeEcho, source, payload };
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}`;
}

export interface MppPaywallResult {
  authorizationHeader: string;
  paymentId?: string;
  challenge: MppChallenge;
  requestPayload: Record<string, unknown>;
}

/**
 * Handle an MPP 402 response: parse challenge, sign, build credential.
 * Currently supports EIP-712 signing methods (transferwithauth, permit, opdata)
 * used by our x402-facilitator. Other methods (tempo, stripe, etc.) will be
 * added as Dynamic SDK adds support for those networks.
 */
export async function handleMppPaywall(
  wwwAuthHeader: string,
): Promise<MppPaywallResult | null> {
  const challenges = parseMppChallenges(wwwAuthHeader);
  if (challenges.length === 0) return null;

  const challenge = selectChallenge(challenges);
  if (!challenge) return null;

  // Check expiry — spec says clients MUST NOT submit expired challenges
  if (challenge.expires && new Date(challenge.expires) < new Date()) {
    throw new Error(`MPP challenge has expired (${challenge.expires})`);
  }

  const requestPayload = decodeMppRequest(challenge.request);

  // Route based on request format
  if (isEip712Request(requestPayload)) {
    // EIP-712 method (our facilitator): sign typed data and build credential
    const eip712 = requestPayload as unknown as Eip712MppRequest;
    const walletAddress = getWalletAddress();
    replacePlaceholders(eip712.signatureData, walletAddress);

    const typedData = {
      domain: eip712.signatureData.domain,
      types: eip712.signatureData.types,
      primaryType: eip712.signatureData.primaryType,
      message: eip712.signatureData.message,
    };

    const signatureHex = await signTypedData(typedData);
    const sigParts = splitSignature(signatureHex);

    const authHeader = buildMppCredential(
      challenge,
      walletAddress,
      { signature: sigParts, message: eip712.signatureData.message },
    );

    return {
      authorizationHeader: authHeader,
      paymentId: eip712.paymentId,
      challenge,
      requestPayload,
    };
  }

  // Unknown method — give a descriptive error
  throw new Error(
    `Unsupported MPP method "${challenge.method}". ` +
    `This agent supports EIP-712 methods: ${SUPPORTED_MPP_METHODS.join(', ')}. ` +
    `Tempo and Solana support coming when Dynamic Node SDK adds those networks.`
  );
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
      facilitator: parsed.facilitator ?? '',
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
  if (!req.facilitator) {
    return null; // No facilitator URL — can't settle
  }
  const facilitatorUrl = req.facilitator;
  const result = await submitToFacilitator(facilitatorUrl, req, signature);

  return {
    settlementHash: result.txHash,
    accessGranted: result.status === 'settled',
  };
}

// ============================================================
// Coinbase x402 v1 Protocol (JSON body with accepts[])
// ============================================================

export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  extra?: {
    name?: string;
    version?: string;
    assetTransferMethod?: string;
  };
}

export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
  method?: string;
}

/** Parse chain ID from CAIP-2 network string ("eip155:8453") or name ("base"). */
function parseChainId(network: string): number {
  if (network.includes(':')) {
    return parseInt(network.split(':')[1], 10);
  }
  // Legacy name-based fallbacks
  const map: Record<string, number> = { base: 8453, ethereum: 1, polygon: 137, arbitrum: 42161 };
  return map[network] ?? 8453;
}

/**
 * Handle x402 payment: sign TransferWithAuthorization + retry with payment header.
 * Supports both v1 (Coinbase X-PAYMENT) and v2 (payment-signature) wire formats.
 */
export async function handleCoinbaseX402(
  url: string,
  accept: X402Accept,
  method = 'GET',
  body?: string,
  resource?: X402Resource,
): Promise<X402PaymentResult & { responseData?: unknown }> {
  const chainId = parseChainId(accept.network);
  const mechanism = (accept.extra?.assetTransferMethod ?? '').toLowerCase();

  // ── ERC-7710: MetaMask Delegation Framework via EIP-7702 ──────────────────
  if (mechanism === 'erc7710') {
    const delegationBody = await handleErc7710Payment(accept, chainId);

    const paymentPayload = {
      x402Version: 2,
      ...(resource ? { resource } : {}),
      accepted: accept,
      payload: delegationBody,
    };

    const encodedPayload = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const retryRes = await fetch(url, {
      method,
      headers: {
        'payment-signature': encodedPayload,
        'X-PAYMENT': encodedPayload,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });

    const responseText = await retryRes.text();
    let responseData: unknown;
    try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

    const paymentResponse = retryRes.headers.get('payment-response') ?? retryRes.headers.get('x-payment-response');
    let settlementHash = paymentResponse ?? '';
    if (paymentResponse) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf-8'));
        const hash = typeof decoded === 'object'
          ? (decoded.txHash ?? decoded.transaction ?? paymentResponse)
          : decoded;
        settlementHash = typeof hash === 'string' ? hash : paymentResponse;
      } catch { /* keep raw */ }
    }

    return { settlementHash, accessGranted: retryRes.ok, protocol: 'x402-coinbase', responseData };
  }

  const walletAddress = await getWalletAddress();
  const amount = accept.amount ?? accept.maxAmountRequired ?? '0';

  // Build EIP-712 TransferWithAuthorization typed data
  const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const validAfter = '0';
  const validBefore = String(Math.floor(Date.now() / 1000) + (accept.maxTimeoutSeconds ?? 300));

  const typedData = {
    domain: {
      name: accept.extra?.name ?? 'USD Coin',
      version: accept.extra?.version ?? '2',
      chainId,
      verifyingContract: accept.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: walletAddress,
      to: accept.payTo,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  };

  const signature = await signTypedData(typedData);

  // Build v2 payment payload (backward compatible with v1 endpoints)
  const paymentPayload = {
    x402Version: 2,
    ...(resource ? { resource } : {}),
    accepted: accept,
    payload: {
      signature,
      authorization: typedData.message,
    },
  };

  const encodedPayload = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // Retry with payment — send both headers for compatibility
  const retryRes = await fetch(url, {
    method,
    headers: {
      'payment-signature': encodedPayload,
      'X-PAYMENT': encodedPayload,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body } : {}),
  });

  const responseText = await retryRes.text();
  let responseData: unknown;
  try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

  // Check both v2 and v1 response headers
  const paymentResponse = retryRes.headers.get('payment-response')
    ?? retryRes.headers.get('x-payment-response');

  let settlementHash = paymentResponse ?? '';
  if (paymentResponse) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf-8'));
      const hash = typeof decoded === 'object'
        ? (decoded.txHash ?? decoded.transaction ?? paymentResponse)
        : decoded;
      settlementHash = typeof hash === 'string' ? hash : paymentResponse;
    } catch { /* keep raw */ }
  }

  return {
    settlementHash,
    accessGranted: retryRes.ok,
    protocol: 'x402-coinbase',
    responseData,
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
