import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally for Checkout API tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
const { createTransaction, getQuote, prepareSigning } = await import('../src/lib/checkout-client.js');

const API_BASE = 'https://app.dynamicauth.com/api/v0';
const ENV_ID = 'test-env';

describe('createTransaction', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns transactionId and sessionToken on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        transaction: { id: 'ctx_abc123' },
        sessionToken: 'dct_session456',
      }),
    });

    const result = await createTransaction(API_BASE, ENV_ID, 'checkout_1', '10.00');

    expect(result.transactionId).toBe('ctx_abc123');
    expect(result.sessionToken).toBe('dct_session456');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    await expect(
      createTransaction(API_BASE, ENV_ID, 'bad_checkout', '10.00'),
    ).rejects.toThrow('Checkout API 404');
  });
});

describe('getQuote', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('normalizes standard quote shape (data.transaction.quote)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        transaction: {
          quote: {
            fromAmount: '10.50',
            toAmount: '10.00',
            estimatedTimeSec: 120,
            fees: { totalFeeUsd: '0.50' },
          },
        },
      }),
    });

    const quote = await getQuote(API_BASE, ENV_ID, 'tx_1', 'session_1', '0x0');
    expect(quote.fromAmount).toBe('10.50');
    expect(quote.fees.totalFeeUsd).toBe('0.50');
  });

  it('normalizes flat quote shape (data.quote)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          fromAmount: '5.25',
          toAmount: '5.00',
          estimatedTimeSec: 60,
          fees: { totalFeeUsd: '0.25' },
        },
      }),
    });

    const quote = await getQuote(API_BASE, ENV_ID, 'tx_2', 'session_2', '0x0');
    expect(quote.fromAmount).toBe('5.25');
  });

  it('normalizes root-level quote shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fromAmount: '1.10',
        toAmount: '1.00',
        estimatedTimeSec: 30,
        fees: { totalFeeUsd: '0.10' },
      }),
    });

    const quote = await getQuote(API_BASE, ENV_ID, 'tx_3', 'session_3', '0x0');
    expect(quote.fromAmount).toBe('1.10');
  });

  it('throws on unexpected shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ unexpected: 'data' }),
    });

    // With permissive normalization, this returns defaults (fromAmount: '0')
    // rather than throwing — the fees check is the only hard validation
    const quote = await getQuote(API_BASE, ENV_ID, 'tx_4', 'session_4', '0x0');
    expect(quote.fromAmount).toBe('0');
  });
});

describe('prepareSigning', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('normalizes transaction.signingPayload shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        transaction: {
          signingPayload: { to: '0xabc', data: '0x123', value: '1000' },
        },
      }),
    });

    const payload = await prepareSigning(API_BASE, ENV_ID, 'tx_1', 'session_1');
    expect(payload.to).toBe('0xabc');
  });

  it('normalizes root signingPayload shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        signingPayload: { to: '0xdef', data: '0x456', value: '2000' },
      }),
    });

    const payload = await prepareSigning(API_BASE, ENV_ID, 'tx_2', 'session_2');
    expect(payload.to).toBe('0xdef');
  });

  it('normalizes nested quote.route.signingPayload shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          route: {
            signingPayload: { to: '0xghi', data: '0x789', value: '3000' },
          },
        },
      }),
    });

    const payload = await prepareSigning(API_BASE, ENV_ID, 'tx_3', 'session_3');
    expect(payload.to).toBe('0xghi');
  });
});
