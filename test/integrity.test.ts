import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as jose from 'jose';

// Mock config and wallet (integrity module imports them indirectly via types only)
vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    dynamicEnvironmentId: 'test-env',
    dynamicAuthToken: 'dyn_test',
  }),
}));

const {
  parseIntegrityHeader,
  didWebToUrl,
  buildCanonicalPayload,
  verifyIntegrity,
  signIntegrity,
} = await import('../src/lib/integrity.js');

// ---- Test fixtures ----

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let publicJwk: jose.JWK;

const TEST_DID = 'did:web:example.com';
const TEST_KID = 'key-1';
const TEST_ALG = 'ES256';

const TEST_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
};

// Build a mock DID document
function mockDidDocument(did: string, kid: string, jwk: jose.JWK) {
  return {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: did,
    verificationMethod: [{
      id: `${did}#${kid}`,
      type: 'JsonWebKey2020',
      controller: did,
      publicKeyJwk: jwk,
    }],
    assertionMethod: [`${did}#${kid}`],
  };
}

beforeAll(async () => {
  const pair = await jose.generateKeyPair(TEST_ALG, { extractable: true });
  publicKey = pair.publicKey as CryptoKey;
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await jose.exportJWK(publicKey);
});

// ---- parseIntegrityHeader ----

describe('parseIntegrityHeader', () => {
  it('decodes a valid base64url envelope', () => {
    const envelope = { v: 1, did: TEST_DID, kid: TEST_KID, alg: TEST_ALG, iat: 1000, exp: 2000, sig: 'abc' };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    const result = parseIntegrityHeader(encoded);
    expect(result.v).toBe(1);
    expect(result.did).toBe(TEST_DID);
    expect(result.kid).toBe(TEST_KID);
  });

  it('rejects unsupported version', () => {
    const envelope = { v: 2, did: TEST_DID, kid: TEST_KID, alg: TEST_ALG, iat: 1000, exp: 2000, sig: 'abc' };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    expect(() => parseIntegrityHeader(encoded)).toThrow('Unsupported integrity envelope version');
  });

  it('rejects missing fields', () => {
    const envelope = { v: 1, did: TEST_DID };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    expect(() => parseIntegrityHeader(encoded)).toThrow('missing required fields');
  });

  it('rejects malformed base64', () => {
    expect(() => parseIntegrityHeader('not-valid-json!!!')).toThrow();
  });
});

// ---- didWebToUrl ----

describe('didWebToUrl', () => {
  it('converts standard did:web to HTTPS URL', () => {
    expect(didWebToUrl('did:web:api.example.com')).toBe('https://api.example.com/.well-known/did.json');
  });

  it('handles port-encoded did:web', () => {
    expect(didWebToUrl('did:web:localhost%3A3402')).toBe('https://localhost:3402/.well-known/did.json');
  });

  it('uses HTTP for localhost when allowHttp is true', () => {
    expect(didWebToUrl('did:web:localhost%3A3402', true)).toBe('http://localhost:3402/.well-known/did.json');
  });

  it('still uses HTTPS for non-localhost even with allowHttp', () => {
    expect(didWebToUrl('did:web:api.example.com', true)).toBe('https://api.example.com/.well-known/did.json');
  });

  it('rejects non-did:web identifiers', () => {
    expect(() => didWebToUrl('did:key:z123')).toThrow('Not a did:web');
  });
});

// ---- buildCanonicalPayload ----

describe('buildCanonicalPayload', () => {
  it('produces deterministic output', () => {
    const envelope = { iat: 1000, exp: 2000 };
    const result = buildCanonicalPayload(TEST_ACCEPT, envelope);
    expect(result).toBe('2\nexact\neip155:8453\n1000\n0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n0x209693Bc6afc0C5328bA36FaF03C514EF312287C\n1000\n2000');
  });

  it('same inputs always produce same output', () => {
    const envelope = { iat: 1000, exp: 2000 };
    const a = buildCanonicalPayload(TEST_ACCEPT, envelope);
    const b = buildCanonicalPayload(TEST_ACCEPT, envelope);
    expect(a).toBe(b);
  });

  it('different amounts produce different output', () => {
    const envelope = { iat: 1000, exp: 2000 };
    const a = buildCanonicalPayload(TEST_ACCEPT, envelope);
    const b = buildCanonicalPayload({ ...TEST_ACCEPT, amount: '2000' }, envelope);
    expect(a).not.toBe(b);
  });
});

// ---- Full round-trip: signIntegrity + verifyIntegrity ----

describe('verifyIntegrity', () => {
  // Mock fetch to return DID document
  function mockFetch(did: string, kid: string, jwk: jose.JWK) {
    return vi.fn().mockImplementation(async (url: string) => {
      return new Response(JSON.stringify(mockDidDocument(did, kid, jwk)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('verifies a valid signed envelope', async () => {
    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey,
      accept: TEST_ACCEPT,
    });

    const envelope = parseIntegrityHeader(headerValue);
    const fetchFn = mockFetch(TEST_DID, TEST_KID, publicJwk);

    const result = await verifyIntegrity(envelope, TEST_ACCEPT, { fetchFn, allowHttp: true });
    expect(result.verified).toBe(true);
    expect(result.did).toBe(TEST_DID);
    expect(result.kid).toBe(TEST_KID);
    expect(result.domain).toBe('example.com');
  });

  it('rejects tampered payTo', async () => {
    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey,
      accept: TEST_ACCEPT,
    });

    const envelope = parseIntegrityHeader(headerValue);
    const fetchFn = mockFetch(TEST_DID, TEST_KID, publicJwk);

    const tamperedAccept = { ...TEST_ACCEPT, payTo: '0xATTACKER' };
    await expect(verifyIntegrity(envelope, tamperedAccept, { fetchFn, allowHttp: true }))
      .rejects.toThrow('signature verification failed');
  });

  it('rejects tampered amount', async () => {
    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey,
      accept: TEST_ACCEPT,
    });

    const envelope = parseIntegrityHeader(headerValue);
    const fetchFn = mockFetch(TEST_DID, TEST_KID, publicJwk);

    const tamperedAccept = { ...TEST_ACCEPT, amount: '999999' };
    await expect(verifyIntegrity(envelope, tamperedAccept, { fetchFn, allowHttp: true }))
      .rejects.toThrow('signature verification failed');
  });

  it('rejects expired envelope', async () => {
    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey,
      accept: TEST_ACCEPT,
      ttlSeconds: -3600, // expired 1 hour ago
    });

    const envelope = parseIntegrityHeader(headerValue);
    const fetchFn = mockFetch(TEST_DID, TEST_KID, publicJwk);

    await expect(verifyIntegrity(envelope, TEST_ACCEPT, { fetchFn, allowHttp: true }))
      .rejects.toThrow('expired');
  });

  it('rejects signature from wrong key', async () => {
    // Sign with our key but present a different public key in the DID doc
    const otherPair = await jose.generateKeyPair(TEST_ALG, { extractable: true });
    const otherPublicJwk = await jose.exportJWK(otherPair.publicKey);

    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey, // signed with our key
      accept: TEST_ACCEPT,
    });

    const envelope = parseIntegrityHeader(headerValue);
    const fetchFn = mockFetch(TEST_DID, TEST_KID, otherPublicJwk); // but DID has a different key

    await expect(verifyIntegrity(envelope, TEST_ACCEPT, { fetchFn, allowHttp: true }))
      .rejects.toThrow('signature verification failed');
  });

  it('rejects when DID document has no matching key', async () => {
    const headerValue = await signIntegrity({
      did: TEST_DID,
      kid: TEST_KID,
      alg: TEST_ALG,
      privateKey,
      accept: TEST_ACCEPT,
    });

    const envelope = parseIntegrityHeader(headerValue);
    // Mock returns a DID doc with a different kid
    const fetchFn = mockFetch(TEST_DID, 'wrong-key-id', publicJwk);

    await expect(verifyIntegrity(envelope, TEST_ACCEPT, { fetchFn, allowHttp: true }))
      .rejects.toThrow('not found in DID document');
  });
});
