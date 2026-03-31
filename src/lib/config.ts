import { z } from 'zod';

const configSchema = z.object({
  dynamicEnvironmentId: z.string().min(1, 'DYNAMIC_ENVIRONMENT_ID is required'),
  dynamicAuthToken: z.string().startsWith('dyn_', 'DYNAMIC_AUTH_TOKEN must start with dyn_'),
  x402FacilitatorUrl: z.string().url('X402_FACILITATOR_URL must be a valid URL'),
  minFundingThresholdUsd: z.string().default('1.00'),
  checkoutApiBase: z.string().default('https://app.dynamicauth.com/api/v0'),
  rpcUrlBase: z.string().optional(), // RPC for broadcasting signed txs
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = configSchema.safeParse({
    dynamicEnvironmentId: process.env.DYNAMIC_ENVIRONMENT_ID,
    dynamicAuthToken: process.env.DYNAMIC_AUTH_TOKEN,
    x402FacilitatorUrl: process.env.X402_FACILITATOR_URL,
    minFundingThresholdUsd: process.env.MIN_FUNDING_THRESHOLD_USD || '1.00',
    checkoutApiBase: process.env.CHECKOUT_API_BASE || 'https://app.dynamicauth.com/api/v0',
    rpcUrlBase: process.env.RPC_URL_BASE,
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
