import { describe, it, expect, vi } from 'vitest';

// Mock wallet to avoid Dynamic SDK import
vi.mock('../src/lib/wallet.js', () => ({
  signTypedData: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b'),
  getWalletAddress: vi.fn().mockResolvedValue('0xAgentWalletAddress'),
}));

vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    x402FacilitatorUrl: 'http://localhost:8080',
  }),
  chainFamily: vi.fn().mockReturnValue('EVM'),
}));

const {
  detectProtocol,
  parseMppChallenges,
  decodeMppRequest,
  isEip712Request,
  selectChallenge,
  buildMppCredential,
  handleMppPaywall,
  parsePaymentRequired,
  SUPPORTED_MPP_METHODS,
} = await import('../src/lib/x402-handler.js');

describe('detectProtocol', () => {
  it('detects MPP from WWW-Authenticate header', () => {
    expect(detectProtocol({
      'www-authenticate': 'Payment id="abc", realm="test", method="transferwithauth", intent="charge", request="eyJ0ZXN0IjoiMSJ9"',
    })).toBe('mpp');
  });

  it('detects Coinbase x402 from PAYMENT-REQUIRED header', () => {
    const payload = Buffer.from(JSON.stringify({ amount: '100', currency: 'USDC', recipient: '0x123' })).toString('base64');
    expect(detectProtocol({ 'payment-required': payload })).toBe('x402-coinbase');
  });

  it('returns none for unrecognized headers', () => {
    expect(detectProtocol({ 'content-type': 'text/html' })).toBe('none');
  });

  it('prefers MPP when both headers present', () => {
    expect(detectProtocol({
      'www-authenticate': 'Payment id="abc", realm="test", method="permit", intent="charge", request="eyJ0ZXN0IjoiMSJ9"',
      'payment-required': 'base64stuff',
    })).toBe('mpp');
  });
});

describe('parseMppChallenges', () => {
  it('parses a single Payment challenge with all fields', () => {
    const header = 'Payment id="abc123", realm="merchant", method="transferwithauth", intent="charge", request="eyJ0ZXN0IjoxfQ", expires="2026-04-01T19:00:00Z", digest="sha-256=:abc=:", description="Pay for access", opaque="eyJwIjoiMSJ9"';
    const challenges = parseMppChallenges(header);

    expect(challenges).toHaveLength(1);
    expect(challenges[0].id).toBe('abc123');
    expect(challenges[0].realm).toBe('merchant');
    expect(challenges[0].method).toBe('transferwithauth');
    expect(challenges[0].intent).toBe('charge');
    expect(challenges[0].expires).toBe('2026-04-01T19:00:00Z');
    expect(challenges[0].digest).toBe('sha-256=:abc=:');
    expect(challenges[0].description).toBe('Pay for access');
    expect(challenges[0].opaque).toBe('eyJwIjoiMSJ9');
  });

  it('parses challenge without optional fields', () => {
    const header = 'Payment id="abc", realm="r", method="permit", intent="charge", request="eyJ0ZXN0IjoxfQ"';
    const challenges = parseMppChallenges(header);
    expect(challenges).toHaveLength(1);
    expect(challenges[0].expires).toBeUndefined();
    expect(challenges[0].digest).toBeUndefined();
    expect(challenges[0].description).toBeUndefined();
    expect(challenges[0].opaque).toBeUndefined();
  });

  it('returns empty for invalid header', () => {
    expect(parseMppChallenges('Bearer token123')).toHaveLength(0);
  });
});

describe('decodeMppRequest', () => {
  it('decodes base64url request with signatureData', () => {
    const payload = {
      amount: '100000',
      currency: 'usdc',
      recipient: '0xMerchant',
      chainId: 8453,
      tokenAddress: '0xUSDC',
      signatureData: {
        domain: { name: 'USD Coin', chainId: 8453 },
        types: { TransferWithAuthorization: [] },
        primaryType: 'TransferWithAuthorization',
        message: { from: '{{from}}', to: '0xMerchant', value: '100000' },
      },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const decoded = decodeMppRequest(encoded);

    expect(decoded.amount).toBe('100000');
    expect(decoded.chainId).toBe(8453);
  });

  it('decodes base64url request without signatureData (generic format)', () => {
    const payload = {
      amount: '1000',
      currency: '0x20c0000000000000000000000000000000000000',
      recipient: '0xDeposit',
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const decoded = decodeMppRequest(encoded);

    expect(decoded.amount).toBe('1000');
    expect(decoded.recipient).toBe('0xDeposit');
    expect(decoded.signatureData).toBeUndefined();
  });
});

describe('isEip712Request', () => {
  it('returns true for requests with signatureData', () => {
    expect(isEip712Request({
      amount: '100',
      signatureData: {
        domain: {}, types: {}, primaryType: 'Test', message: {},
      },
    })).toBe(true);
  });

  it('returns false for requests without signatureData', () => {
    expect(isEip712Request({ amount: '100', currency: 'usd' })).toBe(false);
  });

  it('returns false for null signatureData', () => {
    expect(isEip712Request({ signatureData: null })).toBe(false);
  });
});

describe('selectChallenge', () => {
  it('prefers transferwithauth over permit', () => {
    const challenges = [
      { id: '1', realm: 'r', method: 'permit', intent: 'charge', request: 'x' },
      { id: '2', realm: 'r', method: 'transferwithauth', intent: 'charge', request: 'y' },
    ];
    expect(selectChallenge(challenges)?.method).toBe('transferwithauth');
  });

  it('falls back to first challenge if no known method', () => {
    const challenges = [
      { id: '1', realm: 'r', method: 'tempo', intent: 'charge', request: 'x' },
    ];
    expect(selectChallenge(challenges)?.id).toBe('1');
  });

  it('returns null for empty array', () => {
    expect(selectChallenge([])).toBeNull();
  });

  it('accepts custom supported methods list', () => {
    const challenges = [
      { id: '1', realm: 'r', method: 'permit', intent: 'charge', request: 'x' },
      { id: '2', realm: 'r', method: 'tempo', intent: 'charge', request: 'y' },
    ];
    expect(selectChallenge(challenges, ['tempo'])?.method).toBe('tempo');
  });
});

describe('buildMppCredential', () => {
  it('builds spec-compliant credential with challenge echo', () => {
    const challenge = {
      id: 'abc', realm: 'test', method: 'permit', intent: 'charge',
      request: 'eyJ0ZXN0IjoxfQ', expires: '2026-12-01T00:00:00Z',
    };
    const raw = buildMppCredential(challenge, '0xAgent', { signature: { v: 27, r: '0xr', s: '0xs' } });

    expect(raw.startsWith('Payment ')).toBe(true);
    const decoded = JSON.parse(Buffer.from(raw.slice(8), 'base64url').toString('utf-8'));

    expect(decoded.challenge.id).toBe('abc');
    expect(decoded.challenge.realm).toBe('test');
    expect(decoded.challenge.method).toBe('permit');
    expect(decoded.challenge.intent).toBe('charge');
    expect(decoded.challenge.request).toBe('eyJ0ZXN0IjoxfQ');
    expect(decoded.challenge.expires).toBe('2026-12-01T00:00:00Z');
    expect(decoded.source).toBe('0xAgent');
    expect(decoded.payload.signature.v).toBe(27);
  });

  it('omits undefined optional fields from challenge echo', () => {
    const challenge = {
      id: 'abc', realm: 'test', method: 'permit', intent: 'charge', request: 'x',
    };
    const raw = buildMppCredential(challenge, '0xAgent', { proof: true });
    const decoded = JSON.parse(Buffer.from(raw.slice(8), 'base64url').toString('utf-8'));

    expect(decoded.challenge.expires).toBeUndefined();
    expect(decoded.challenge.digest).toBeUndefined();
    expect(decoded.challenge.opaque).toBeUndefined();
    expect(decoded.challenge.description).toBeUndefined();
  });
});

describe('handleMppPaywall', () => {
  it('handles EIP-712 challenge end-to-end', async () => {
    const requestPayload = {
      amount: '100000',
      currency: 'usdc',
      recipient: '0xMerchant',
      chainId: 8453,
      tokenAddress: '0xUSDC',
      signatureData: {
        domain: { name: 'USD Coin', chainId: 8453 },
        types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }] },
        primaryType: 'TransferWithAuthorization',
        message: { from: '{{from}}', to: '0xMerchant', value: '100000' },
      },
      paymentId: 'pay_123',
    };
    const encodedRequest = Buffer.from(JSON.stringify(requestPayload)).toString('base64url');
    const header = `Payment id="test", realm="merchant", method="transferwithauth", intent="charge", request="${encodedRequest}"`;

    const result = await handleMppPaywall(header);

    expect(result).not.toBeNull();
    expect(result!.authorizationHeader).toMatch(/^Payment /);
    expect(result!.paymentId).toBe('pay_123');
    expect(result!.challenge.method).toBe('transferwithauth');

    // Verify credential structure
    const decoded = JSON.parse(Buffer.from(result!.authorizationHeader.slice(8), 'base64url').toString('utf-8'));
    expect(decoded.challenge.id).toBe('test');
    expect(decoded.source).toBe('0xAgentWalletAddress');
    expect(decoded.payload.signature).toHaveProperty('v');
    expect(decoded.payload.signature).toHaveProperty('r');
    expect(decoded.payload.signature).toHaveProperty('s');
    // Verify {{from}} was replaced
    expect(decoded.payload.message.from).toBe('0xAgentWalletAddress');
  });

  it('rejects expired challenges', async () => {
    const requestPayload = {
      signatureData: { domain: {}, types: {}, primaryType: 'Test', message: {} },
    };
    const encodedRequest = Buffer.from(JSON.stringify(requestPayload)).toString('base64url');
    const header = `Payment id="test", realm="r", method="permit", intent="charge", request="${encodedRequest}", expires="2020-01-01T00:00:00Z"`;

    await expect(handleMppPaywall(header)).rejects.toThrow('MPP challenge has expired');
  });

  it('throws descriptive error for unsupported methods', async () => {
    const requestPayload = { amount: '1000', currency: 'pathusd', recipient: '0xDeposit' };
    const encodedRequest = Buffer.from(JSON.stringify(requestPayload)).toString('base64url');
    const header = `Payment id="test", realm="r", method="tempo", intent="charge", request="${encodedRequest}"`;

    await expect(handleMppPaywall(header)).rejects.toThrow('Unsupported MPP method "tempo"');
  });
});

describe('parsePaymentRequired (Coinbase x402)', () => {
  it('still works for Coinbase-style headers', () => {
    const payload = { amount: '50', currency: 'USDC', recipient: '0xabc' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = parsePaymentRequired({ 'payment-required': encoded });
    expect(result).not.toBeNull();
    expect(result!.amount).toBe('50');
    expect(result!.scheme).toBe('exact');
  });
});
