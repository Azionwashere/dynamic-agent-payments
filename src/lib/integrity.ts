/**
 * Payment Instruction Integrity (PII) — verifies that x402 payment
 * instructions are authentic and untampered using did:web + signatures.
 *
 * See: x402 Extension: Payment Instruction Integrity spec
 */

import * as jose from 'jose';
import type { IntegrityEnvelope, IntegrityInfo } from './types.js';

// ---- Parse ----

/**
 * Decode the X-402-Integrity header (base64url-encoded JSON envelope).
 */
export function parseIntegrityHeader(header: string): IntegrityEnvelope {
  const json = Buffer.from(header, 'base64url').toString('utf-8');
  const envelope = JSON.parse(json);

  if (envelope.v !== 1) {
    throw new Error(`Unsupported integrity envelope version: ${envelope.v}`);
  }
  if (!envelope.did || !envelope.kid || !envelope.alg || !envelope.sig) {
    throw new Error('Integrity envelope missing required fields (did, kid, alg, sig)');
  }
  if (typeof envelope.iat !== 'number' || typeof envelope.exp !== 'number') {
    throw new Error('Integrity envelope missing iat/exp timestamps');
  }

  return envelope as IntegrityEnvelope;
}

// ---- DID Resolution ----

/**
 * Convert a did:web identifier to the HTTPS URL for its DID document.
 * did:web:api.example.com → https://api.example.com/.well-known/did.json
 * did:web:localhost%3A3402 → https://localhost:3402/.well-known/did.json
 */
export function didWebToUrl(did: string, allowHttp = false): string {
  if (!did.startsWith('did:web:')) {
    throw new Error(`Not a did:web identifier: ${did}`);
  }

  const domainPart = did.slice('did:web:'.length);
  // did:web spec: colons (:) are path separators, %3A are literal colons (ports)
  // Replace path-separator colons with / BEFORE decoding %3A
  const withSlashes = domainPart.replace(/:/g, '/');
  // Now decode %3A → : (restoring ports)
  const decoded = decodeURIComponent(withSlashes);

  const slashIdx = decoded.indexOf('/');
  const domain = slashIdx === -1 ? decoded : decoded.slice(0, slashIdx);
  const subpath = slashIdx === -1 ? '' : decoded.slice(slashIdx + 1);

  const protocol = allowHttp && domain.startsWith('localhost') ? 'http' : 'https';

  if (!subpath) {
    return `${protocol}://${domain}/.well-known/did.json`;
  }

  return `${protocol}://${domain}/${subpath}/did.json`;
}

/**
 * Resolve a did:web document and extract the public key for the given kid.
 */
export async function resolveDidWeb(
  did: string,
  kid: string,
  options: { allowHttp?: boolean; fetchFn?: typeof fetch; alg?: string } = {},
): Promise<CryptoKey> {
  const { allowHttp = false, fetchFn = fetch, alg = 'ES256' } = options;
  const url = didWebToUrl(did, allowHttp);

  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Failed to resolve DID document at ${url}: ${res.status}`);
  }

  const didDoc = await res.json() as any;

  // Find the verification method matching the kid
  const fullKid = kid.includes('#') ? kid : `${did}#${kid}`;
  const methods = didDoc.verificationMethod ?? [];
  const method = methods.find((m: any) =>
    m.id === fullKid || m.id === kid || m.id === `#${kid}`
  );

  if (!method) {
    throw new Error(`Key ${kid} not found in DID document. Available: ${methods.map((m: any) => m.id).join(', ')}`);
  }

  // Import the key — supports publicKeyJwk
  if (method.publicKeyJwk) {
    return await jose.importJWK(method.publicKeyJwk, alg) as CryptoKey;
  }

  throw new Error(`Unsupported key format for ${kid}. Only publicKeyJwk is supported.`);
}

// ---- Canonical Payload ----

/**
 * Build the canonical payload for signature verification.
 * Fields concatenated with \n in spec-defined order:
 * version, scheme, network, amount, asset, payTo, iat, exp
 */
export function buildCanonicalPayload(
  accept: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string },
  envelope: { iat: number; exp: number },
  version = 2,
): string {
  return [
    version.toString(),
    accept.scheme ?? 'exact',
    accept.network ?? '',
    accept.amount ?? '',
    accept.asset ?? '',
    accept.payTo ?? '',
    envelope.iat.toString(),
    envelope.exp.toString(),
  ].join('\n');
}

// ---- Verification ----

const CLOCK_SKEW_SECONDS = 30;

/**
 * Verify an X-402-Integrity envelope against the payment requirements.
 * Resolves the did:web document, extracts the key, verifies the signature.
 */
export async function verifyIntegrity(
  envelope: IntegrityEnvelope,
  accept: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string },
  options: { allowHttp?: boolean; fetchFn?: typeof fetch } = {},
): Promise<IntegrityInfo> {
  const now = Math.floor(Date.now() / 1000);

  // Check expiry (with clock skew tolerance)
  if (envelope.exp + CLOCK_SKEW_SECONDS < now) {
    throw new Error(`Integrity envelope expired at ${new Date(envelope.exp * 1000).toISOString()}`);
  }
  if (envelope.iat - CLOCK_SKEW_SECONDS > now) {
    throw new Error(`Integrity envelope issued in the future: ${new Date(envelope.iat * 1000).toISOString()}`);
  }

  // Resolve DID and extract key
  const key = await resolveDidWeb(envelope.did, envelope.kid, { ...options, alg: envelope.alg });

  // Build canonical payload
  const canonical = buildCanonicalPayload(accept, envelope);
  const payloadBytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', payloadBytes);

  // Verify signature
  const sigBytes = Buffer.from(envelope.sig, 'base64url');

  const algMap: Record<string, string> = {
    ES256: 'ES256',
    ES256K: 'ES256K',
    EdDSA: 'EdDSA',
  };
  const alg = algMap[envelope.alg];
  if (!alg) {
    throw new Error(`Unsupported algorithm: ${envelope.alg}`);
  }

  // Use jose.compactVerify-style manual verification
  // Sign(privateKey, SHA-256(canonical_payload)) per spec
  const valid = await jose.flattenedVerify(
    {
      payload: jose.base64url.encode(new Uint8Array(hash)),
      signature: envelope.sig,
      protected: jose.base64url.encode(JSON.stringify({ alg })),
    },
    key,
  ).then(() => true).catch(() => false);

  if (!valid) {
    throw new Error('Integrity signature verification failed — payment instruction may be tampered');
  }

  // Extract domain from did:web
  const domain = envelope.did.replace('did:web:', '').replace(/%3A/gi, ':');

  return {
    verified: true,
    did: envelope.did,
    kid: envelope.kid,
    alg: envelope.alg,
    domain,
  };
}

// ---- Signing (for demo server) ----

/**
 * Sign a canonical payload and produce an integrity envelope.
 * Used by the demo server — not by the agent.
 */
export async function signIntegrity(params: {
  did: string;
  kid: string;
  alg: string;
  privateKey: CryptoKey;
  accept: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string };
  ttlSeconds?: number;
}): Promise<string> {
  const { did, kid, alg, privateKey, accept, ttlSeconds = 3600 } = params;
  const now = Math.floor(Date.now() / 1000);
  const iat = now;
  const exp = now + ttlSeconds;

  const canonical = buildCanonicalPayload(accept, { iat, exp });
  const payloadBytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', payloadBytes);

  // Sign the hash
  const { signature } = await new jose.FlattenedSign(new Uint8Array(hash))
    .setProtectedHeader({ alg })
    .sign(privateKey);

  const envelope: IntegrityEnvelope = { v: 1, did, kid, alg, iat, exp, sig: signature };
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
