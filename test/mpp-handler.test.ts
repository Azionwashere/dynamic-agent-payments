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
}));

const {
  detectProtocol,
  parseMppChallenges,
  decodeMppRequest,
  selectChallenge,
  parsePaymentRequired,
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
  it('parses a single Payment challenge', () => {
    const header = 'Payment id="abc123", realm="merchant", method="transferwithauth", intent="charge", request="eyJ0ZXN0IjoxfQ", expires="2026-04-01T19:00:00Z", opaque="eyJwIjoiMSJ9"';
    const challenges = parseMppChallenges(header);

    expect(challenges).toHaveLength(1);
    expect(challenges[0].id).toBe('abc123');
    expect(challenges[0].realm).toBe('merchant');
    expect(challenges[0].method).toBe('transferwithauth');
    expect(challenges[0].intent).toBe('charge');
    expect(challenges[0].expires).toBe('2026-04-01T19:00:00Z');
    expect(challenges[0].opaque).toBe('eyJwIjoiMSJ9');
  });

  it('returns empty for invalid header', () => {
    expect(parseMppChallenges('Bearer token123')).toHaveLength(0);
  });
});

describe('decodeMppRequest', () => {
  it('decodes base64url request payload', () => {
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
    expect(decoded.signatureData.message.from).toBe('{{from}}');
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
      { id: '1', realm: 'r', method: 'unknown', intent: 'charge', request: 'x' },
    ];
    expect(selectChallenge(challenges)?.id).toBe('1');
  });

  it('returns null for empty array', () => {
    expect(selectChallenge([])).toBeNull();
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
