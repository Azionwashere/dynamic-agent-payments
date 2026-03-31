import { describe, it, expect, vi } from 'vitest';

// Mock wallet module to avoid Dynamic SDK import issues
vi.mock('../src/lib/wallet.js', () => ({
  signTypedData: vi.fn().mockResolvedValue('0xmockedsignature'),
  getWalletAddress: vi.fn().mockResolvedValue('0xmockaddress'),
}));

// Mock config to avoid env var requirements
vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    x402FacilitatorUrl: 'http://localhost:8080',
  }),
}));

const { parsePaymentRequired, buildPaymentTypedData } = await import('../src/lib/x402-handler.js');

describe('parsePaymentRequired', () => {
  it('parses a valid base64-encoded PAYMENT-REQUIRED header', () => {
    const payload = {
      amount: '100000',
      currency: 'USDC',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      facilitator: 'https://facilitator.example.com',
      chainId: '8453',
      scheme: 'exact',
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const result = parsePaymentRequired({ 'payment-required': encoded });

    expect(result).not.toBeNull();
    expect(result!.amount).toBe('100000');
    expect(result!.currency).toBe('USDC');
    expect(result!.recipient).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(result!.facilitator).toBe('https://facilitator.example.com');
    expect(result!.chainId).toBe('8453');
    expect(result!.scheme).toBe('exact');
  });

  it('returns null when PAYMENT-REQUIRED header is missing', () => {
    const result = parsePaymentRequired({ 'content-type': 'text/html' });
    expect(result).toBeNull();
  });

  it('returns null for malformed base64', () => {
    const result = parsePaymentRequired({ 'payment-required': '!!!not-base64!!!' });
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const partial = { amount: '100', currency: 'USDC' }; // no recipient
    const encoded = Buffer.from(JSON.stringify(partial)).toString('base64');
    const result = parsePaymentRequired({ 'payment-required': encoded });
    expect(result).toBeNull();
  });

  it('handles uppercase header name', () => {
    const payload = { amount: '50', currency: 'USDC', recipient: '0xabc' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = parsePaymentRequired({ 'PAYMENT-REQUIRED': encoded });
    expect(result).not.toBeNull();
    expect(result!.amount).toBe('50');
  });

  it('defaults scheme to "exact" when not provided', () => {
    const payload = { amount: '50', currency: 'USDC', recipient: '0xabc' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = parsePaymentRequired({ 'payment-required': encoded });
    expect(result!.scheme).toBe('exact');
  });

  it('uses facilitator from config when not in header', () => {
    const payload = { amount: '50', currency: 'USDC', recipient: '0xabc' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = parsePaymentRequired({ 'payment-required': encoded });
    expect(result!.facilitator).toBe('http://localhost:8080');
  });

  it('coerces numeric amount to string', () => {
    const payload = { amount: 100, currency: 'USDC', recipient: '0xabc' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = parsePaymentRequired({ 'payment-required': encoded });
    expect(result!.amount).toBe('100');
  });
});

describe('buildPaymentTypedData', () => {
  it('constructs valid EIP-712 typed data', () => {
    const result = buildPaymentTypedData({
      amount: '100000',
      currency: 'USDC',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      facilitator: 'https://facilitator.example.com',
      chainId: '8453',
      scheme: 'exact',
    });

    expect(result.domain.name).toBe('x402');
    expect(result.domain.version).toBe('1');
    expect(result.domain.chainId).toBe(8453);
    expect(result.primaryType).toBe('PaymentAuthorization');
    expect(result.message.amount).toBe('100000');
    expect(result.message.recipient).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.types.PaymentAuthorization).toHaveLength(4);
  });

  it('defaults chainId to 8453 (Base) when not provided', () => {
    const result = buildPaymentTypedData({
      amount: '100',
      currency: 'USDC',
      recipient: '0xabc',
      facilitator: 'https://f.example.com',
    });
    expect(result.domain.chainId).toBe(8453);
  });
});
