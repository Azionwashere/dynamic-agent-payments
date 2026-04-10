import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- Mock Dynamic SDK clients ----

const MOCK_WALLETS = [
  { walletId: 'wallet-1', chainName: 'EVM', accountAddress: '0xWalletA' },
  { walletId: 'wallet-2', chainName: 'EVM', accountAddress: '0xWalletB' },
  { walletId: 'wallet-3', chainName: 'SVM', accountAddress: 'SolWalletC' },
];

const mockSignTypedData = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b');
const mockGetWallets = vi.fn().mockResolvedValue(MOCK_WALLETS);
const mockCreateWalletAccount = vi.fn().mockResolvedValue({
  accountAddress: '0xNewWallet',
  walletId: 'wallet-new',
});
const mockAuthenticateApiToken = vi.fn().mockResolvedValue(undefined);

vi.mock('@dynamic-labs-wallet/node-evm', () => ({
  DynamicEvmWalletClient: vi.fn().mockImplementation(() => ({
    authenticateApiToken: mockAuthenticateApiToken,
    createWalletAccount: mockCreateWalletAccount,
    getWallets: mockGetWallets,
    signTypedData: mockSignTypedData,
  })),
}));

vi.mock('@dynamic-labs-wallet/node-svm', () => ({
  DynamicSvmWalletClient: vi.fn().mockImplementation(() => ({
    authenticateApiToken: mockAuthenticateApiToken,
    createWalletAccount: vi.fn().mockResolvedValue({
      accountAddress: 'SolNewWallet',
      walletId: 'wallet-sol-new',
    }),
  })),
}));

vi.mock('@dynamic-labs-wallet/node', () => ({
  ThresholdSignatureScheme: { TWO_OF_TWO: 'TWO_OF_TWO' },
}));

vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    dynamicEnvironmentId: 'test-env',
    dynamicAuthToken: 'dyn_testtoken',
    checkoutApiBase: 'https://test.api',
    minFundingThresholdUsd: '1.00',
  }),
}));

// ---- Import after mocks ----

const {
  getWallet,
  getWalletAddress,
  createAndPersistWallet,
  listAllWallets,
  setActiveWallet,
  signTypedData,
  resetWalletState,
} = await import('../src/lib/wallet.js');

// ---- Test env file management ----

const ENV_PATH = resolve(process.cwd(), '.env');
let originalEnv: Record<string, string | undefined>;
let originalEnvFile: string | null = null;

beforeEach(() => {
  originalEnv = { ...process.env };
  resetWalletState();

  // Back up real .env if it exists
  if (existsSync(ENV_PATH)) {
    originalEnvFile = readFileSync(ENV_PATH, 'utf-8');
  }
});

afterEach(() => {
  // Restore process.env
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetWalletState();

  // Restore .env file
  if (originalEnvFile !== null) {
    writeFileSync(ENV_PATH, originalEnvFile);
  }
});

// ---- Tests ----

describe('wallet access (getWallet)', () => {
  it('throws when no wallet is configured', () => {
    delete process.env.WALLET_ADDRESS;
    delete process.env.WALLET_ID;

    expect(() => getWallet('EVM')).toThrow(
      'No EVM wallet configured. Run `dynamic-agent-payments wallet` to create one.'
    );
  });

  it('throws for SOL when not configured', () => {
    delete process.env.SOL_WALLET_ADDRESS;
    delete process.env.SOL_WALLET_ID;

    expect(() => getWallet('SOL')).toThrow('No SOL wallet configured');
  });

  it('returns wallet when env vars are set', () => {
    process.env.WALLET_ADDRESS = '0xRestoredWallet';
    process.env.WALLET_ID = 'restored-id';

    const wallet = getWallet('EVM');
    expect(wallet.accountAddress).toBe('0xRestoredWallet');
    expect(wallet.walletId).toBe('restored-id');
    expect(wallet.chain).toBe('EVM');
  });

  it('getWalletAddress returns address from env', () => {
    process.env.WALLET_ADDRESS = '0xMyAddress';
    process.env.WALLET_ID = 'my-id';

    expect(getWalletAddress('EVM')).toBe('0xMyAddress');
  });
});

describe('wallet creation (createAndPersistWallet)', () => {
  it('creates wallet and writes to .env', async () => {
    delete process.env.WALLET_ADDRESS;
    delete process.env.WALLET_ID;

    const wallet = await createAndPersistWallet('EVM');

    expect(wallet.accountAddress).toBe('0xNewWallet');
    expect(wallet.walletId).toBe('wallet-new');
    expect(wallet.chain).toBe('EVM');

    // Verify process.env was updated
    expect(process.env.WALLET_ADDRESS).toBe('0xNewWallet');
    expect(process.env.WALLET_ID).toBe('wallet-new');

    // Verify .env file was written
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    expect(envContent).toContain('WALLET_ADDRESS=0xNewWallet');
    expect(envContent).toContain('WALLET_ID=wallet-new');
  });

  it('getWallet works after create without re-reading env', async () => {
    delete process.env.WALLET_ADDRESS;
    delete process.env.WALLET_ID;

    await createAndPersistWallet('EVM');
    const wallet = getWallet('EVM');

    expect(wallet.accountAddress).toBe('0xNewWallet');
  });
});

describe('listAllWallets', () => {
  it('returns all wallets from Dynamic API', async () => {
    const wallets = await listAllWallets();

    expect(wallets).toHaveLength(3);
    expect(wallets[0]).toEqual({ walletId: 'wallet-1', chainName: 'EVM', accountAddress: '0xWalletA' });
    expect(wallets[1]).toEqual({ walletId: 'wallet-2', chainName: 'EVM', accountAddress: '0xWalletB' });
    expect(wallets[2]).toEqual({ walletId: 'wallet-3', chainName: 'SVM', accountAddress: 'SolWalletC' });
  });

  it('finds wallets that are not currently active', async () => {
    process.env.WALLET_ADDRESS = '0xWalletA';
    process.env.WALLET_ID = 'wallet-1';

    const wallets = await listAllWallets();
    const inactive = wallets.filter(w => w.accountAddress !== process.env.WALLET_ADDRESS);

    expect(inactive).toHaveLength(2);
    expect(inactive.map(w => w.accountAddress)).toContain('0xWalletB');
  });
});

describe('setActiveWallet (restore)', () => {
  it('restores a previous wallet by address', async () => {
    process.env.WALLET_ADDRESS = '0xWalletA';
    process.env.WALLET_ID = 'wallet-1';

    const restored = await setActiveWallet('0xWalletB');

    expect(restored.accountAddress).toBe('0xWalletB');
    expect(restored.walletId).toBe('wallet-2');
    expect(restored.chain).toBe('EVM');
  });

  it('updates process.env after restore', async () => {
    const restored = await setActiveWallet('0xWalletB');

    expect(process.env.WALLET_ADDRESS).toBe('0xWalletB');
    expect(process.env.WALLET_ID).toBe('wallet-2');
  });

  it('persists restored wallet to .env file', async () => {
    await setActiveWallet('0xWalletB');

    const envContent = readFileSync(ENV_PATH, 'utf-8');
    expect(envContent).toContain('WALLET_ADDRESS=0xWalletB');
    expect(envContent).toContain('WALLET_ID=wallet-2');
  });

  it('getWallet returns restored wallet immediately', async () => {
    await setActiveWallet('0xWalletB');

    const wallet = getWallet('EVM');
    expect(wallet.accountAddress).toBe('0xWalletB');
    expect(wallet.walletId).toBe('wallet-2');
  });

  it('restores SOL wallet from SVM chain', async () => {
    const restored = await setActiveWallet('SolWalletC');

    expect(restored.chain).toBe('SOL');
    expect(process.env.SOL_WALLET_ADDRESS).toBe('SolWalletC');
    expect(process.env.SOL_WALLET_ID).toBe('wallet-3');
  });

  it('handles case-insensitive address matching', async () => {
    const restored = await setActiveWallet('0xwalletb');

    expect(restored.accountAddress).toBe('0xWalletB');
  });

  it('throws for unknown address', async () => {
    await expect(setActiveWallet('0xNonExistent')).rejects.toThrow(
      'Wallet 0xNonExistent not found in this environment'
    );
  });
});

describe('sign with restored wallet', () => {
  it('signTypedData uses the active wallet from env', async () => {
    process.env.WALLET_ADDRESS = '0xWalletA';
    process.env.WALLET_ID = 'wallet-1';

    const typedData = { domain: {}, types: {}, primaryType: 'Test', message: {} };
    const sig = await signTypedData(typedData);

    expect(sig).toMatch(/^0x/);
    expect(mockSignTypedData).toHaveBeenCalledWith({
      accountAddress: '0xWalletA',
      typedData,
    });
  });

  it('signTypedData works after wallet restore', async () => {
    // Start with wallet A
    process.env.WALLET_ADDRESS = '0xWalletA';
    process.env.WALLET_ID = 'wallet-1';

    // Restore to wallet B
    await setActiveWallet('0xWalletB');

    const typedData = { domain: {}, types: {}, primaryType: 'Test', message: {} };
    await signTypedData(typedData);

    expect(mockSignTypedData).toHaveBeenCalledWith({
      accountAddress: '0xWalletB',
      typedData,
    });
  });
});

describe('cross-session restore flow', () => {
  it('simulates: create → lose env → list → restore → sign', async () => {
    // Session 1: Create a wallet
    delete process.env.WALLET_ADDRESS;
    delete process.env.WALLET_ID;
    const created = await createAndPersistWallet('EVM');
    expect(created.accountAddress).toBe('0xNewWallet');

    // Simulate new session: clear cache, wipe env vars
    resetWalletState();
    delete process.env.WALLET_ADDRESS;
    delete process.env.WALLET_ID;

    // Session 2: No wallet configured — getWallet fails
    expect(() => getWallet('EVM')).toThrow('No EVM wallet configured');

    // User runs `wallet list` — sees all wallets including the one from session 1
    const all = await listAllWallets();
    expect(all.length).toBeGreaterThan(0);

    // User picks wallet B to restore
    const restored = await setActiveWallet('0xWalletB');
    expect(restored.accountAddress).toBe('0xWalletB');

    // Signing works with the restored wallet
    const typedData = { domain: {}, types: {}, primaryType: 'Test', message: {} };
    await signTypedData(typedData);
    expect(mockSignTypedData).toHaveBeenCalledWith({
      accountAddress: '0xWalletB',
      typedData,
    });

    // getWallet returns the restored wallet
    const wallet = getWallet('EVM');
    expect(wallet.accountAddress).toBe('0xWalletB');
  });
});
