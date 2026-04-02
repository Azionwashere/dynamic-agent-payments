/**
 * Bug: DynamicEvmWalletClient.signTransaction fails with
 * "Cannot read properties of undefined (reading 'toLowerCase')"
 * for wallets created in a previous session.
 *
 * signTypedData works fine with the same wallet.
 *
 * Environment:
 *   @dynamic-labs-wallet/node-evm: latest
 *   @dynamic-labs-wallet/node: latest
 *   Node: v24.13.1
 *
 * Steps to reproduce:
 *   1. Create a wallet with createWalletAccount() in one session
 *   2. In a NEW session, authenticate and call signTransaction() with that wallet address
 *   3. Observe: TypeError at getWalletByAddress -> .toLowerCase()
 *   4. signTypedData() with the same address works fine
 */
import 'dotenv/config';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';

async function main() {
  const client = new DynamicEvmWalletClient({
    environmentId: process.env.DYNAMIC_ENVIRONMENT_ID!,
  });
  await client.authenticateApiToken(process.env.DYNAMIC_AUTH_TOKEN!);

  const address = process.env.WALLET_ADDRESS!; // wallet created in a prior session

  // ✅ This works
  console.log('signTypedData...');
  const sig = await client.signTypedData({
    accountAddress: address,
    typedData: {
      domain: { name: 'Test', version: '1', chainId: 8453 },
      types: { Test: [{ name: 'value', type: 'uint256' }] },
      primaryType: 'Test',
      message: { value: '1' },
    },
  });
  console.log('signTypedData OK:', sig.slice(0, 20) + '...');

  // ❌ This fails
  console.log('\nsignTransaction...');
  const tx = await client.signTransaction({
    accountAddress: address,
    transaction: {
      to: '0x0000000000000000000000000000000000000001' as `0x${string}`,
      value: 0n,
    },
  });
  console.log('signTransaction OK:', tx.slice(0, 20) + '...');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  console.error('Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
});
