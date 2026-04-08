import { z } from 'zod';

const configSchema = z.object({
  dynamicEnvironmentId: z.string().min(1, 'DYNAMIC_ENVIRONMENT_ID is required'),
  dynamicAuthToken: z.string().startsWith('dyn_', 'DYNAMIC_AUTH_TOKEN must start with dyn_'),
  minFundingThresholdUsd: z.string().default('1.00'),
  checkoutApiBase: z.string().default('https://app.dynamicauth.com/api/v0'),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = configSchema.safeParse({
    dynamicEnvironmentId: process.env.DYNAMIC_ENVIRONMENT_ID,
    dynamicAuthToken: process.env.DYNAMIC_AUTH_TOKEN,
    minFundingThresholdUsd: process.env.MIN_FUNDING_THRESHOLD_USD || '1.00',
    checkoutApiBase: process.env.CHECKOUT_API_BASE || 'https://app.dynamicauth.com/api/v0',
  });

  if (!result.success) {
    const errors = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  _config = result.data;
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

/** Map chain ID to Dynamic chain family (EVM or SOL). */
const SVM_CHAIN_IDS = new Set(['101', '102', '103']); // mainnet, testnet, devnet

export function chainFamily(chainId: string): 'EVM' | 'SOL' {
  return SVM_CHAIN_IDS.has(chainId) ? 'SOL' : 'EVM';
}
