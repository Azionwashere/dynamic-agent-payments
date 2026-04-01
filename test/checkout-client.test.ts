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

  it('passes memo when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        transaction: { id: 'ctx_memo' },
        sessionToken: 'dct_memo',
      }),
    });

    await createTransaction(API_BASE, ENV_ID, 'checkout_1', '5.00', {
      purpose: 'anthropic-credits',
      service: 'api.anthropic.com',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.memo.purpose).toBe('anthropic-credits');
    expect(body.memo.service).toBe('api.anthropic.com');
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

  it('normalizes quote at data.quote (spec format)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          fromAmount: '10.50',
          toAmount: '10.00',
          estimatedTimeSec: 120,
          fees: { totalFeeUsd: '0.50', gasEstimate: { usdValue: '0.30', nativeValue: '0.00012', nativeSymbol: 'ETH' } },
          version: 1,
        },
      }),
    });

    const quote = await getQuote(API_BASE, ENV_ID, 'tx_1', 'session_1', '0x0');
    expect(quote.fromAmount).toBe('10.50');
    expect(quote.fees.totalFeeUsd).toBe('0.50');
    expect(quote.fees.gasEstimate?.nativeSymbol).toBe('ETH');
    expect(quote.version).toBe(1);
  });

  it('normalizes flat quote shape (data itself)', async () => {
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

  it('passes slippage parameter when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: { fromAmount: '5', toAmount: '5', estimatedTimeSec: 60, fees: { totalFeeUsd: '0.01' } },
      }),
    });

    await getQuote(API_BASE, ENV_ID, 'tx_s', 'session_s', '0x0', 0.005);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.slippage).toBe(0.005);
  });

  it('omits slippage when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: { fromAmount: '5', toAmount: '5', estimatedTimeSec: 60, fees: { totalFeeUsd: '0.01' } },
      }),
    });

    await getQuote(API_BASE, ENV_ID, 'tx_ns', 'session_ns', '0x0');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.slippage).toBeUndefined();
  });

  it('returns defaults for unexpected shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ unexpected: 'data' }),
    });

    const quote = await getQuote(API_BASE, ENV_ID, 'tx_4', 'session_4', '0x0');
    expect(quote.fromAmount).toBe('0');
  });
});

describe('prepareSigning', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('extracts signing payload from quote.signingPayload (spec format)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          signingPayload: {
            chainName: 'EVM',
            chainId: '8453',
            evmTransaction: { to: '0xabc', data: '0x123', value: '0x0', gasLimit: '0x5208' },
          },
        },
      }),
    });

    const payload = await prepareSigning(API_BASE, ENV_ID, 'tx_1', 'session_1');
    expect(payload.chainName).toBe('EVM');
    expect(payload.evmTransaction?.to).toBe('0xabc');
  });

  it('extracts signing payload with evmApproval', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          signingPayload: {
            chainName: 'EVM',
            chainId: '8453',
            evmTransaction: { to: '0xrouter', data: '0xswap', value: '0x0', gasLimit: '0x5208' },
            evmApproval: {
              tokenAddress: '0xUSDC',
              spenderAddress: '0xrouter',
              amount: '10000000',
            },
          },
        },
      }),
    });

    const payload = await prepareSigning(API_BASE, ENV_ID, 'tx_2', 'session_2');
    expect(payload.evmApproval).toBeDefined();
    expect(payload.evmApproval?.tokenAddress).toBe('0xUSDC');
    expect(payload.evmApproval?.spenderAddress).toBe('0xrouter');
    expect(payload.evmApproval?.amount).toBe('10000000');
  });

  it('throws when no signing payload found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ unexpected: 'response' }),
    });

    await expect(
      prepareSigning(API_BASE, ENV_ID, 'tx_3', 'session_3'),
    ).rejects.toThrow('No signing payload');
  });

  it('uses lowercase session header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quote: {
          signingPayload: { chainName: 'EVM', chainId: '8453', evmTransaction: { to: '0x', data: '0x', value: '0x0', gasLimit: '0x' } },
        },
      }),
    });

    await prepareSigning(API_BASE, ENV_ID, 'tx_h', 'session_h');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-dynamic-checkout-session-token']).toBe('session_h');
  });
});
