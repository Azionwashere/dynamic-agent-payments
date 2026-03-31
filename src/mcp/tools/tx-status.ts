import { z } from 'zod';
import { getTransactionStatus } from '../../lib/checkout-client.js';
import { loadConfig } from '../../lib/config.js';

export const txStatusSchema = z.object({
  transactionId: z.string().describe('The Checkout API transaction ID to check'),
});

export type TxStatusInput = z.infer<typeof txStatusSchema>;

export async function getTxStatus(input: TxStatusInput) {
  const config = loadConfig();
  return getTransactionStatus(
    config.checkoutApiBase,
    config.dynamicEnvironmentId,
    input.transactionId,
  );
}
