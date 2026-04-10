import { z } from 'zod';
import { getTransactionStatus } from '../../lib/checkout-client.js';
import { loadConfig } from '../../lib/config.js';

export const txStatusSchema = z.object({
  transactionId: z.string().describe('The Checkout API transaction ID (UUID) to check'),
});

export type TxStatusInput = z.infer<typeof txStatusSchema>;

export async function getTxStatus(input: TxStatusInput) {
  const config = loadConfig();
  try {
    return await getTransactionStatus(
      config.checkoutApiBase,
      config.dynamicEnvironmentId,
      input.transactionId,
    );
  } catch (err: any) {
    if (err.message?.includes('400')) {
      throw new Error('Invalid transaction ID. Expected a UUID (e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890).');
    }
    // Strip environment ID from error messages
    throw new Error(err.message?.replace(config.dynamicEnvironmentId, '[env]') ?? 'Failed to get transaction status');
  }
}
