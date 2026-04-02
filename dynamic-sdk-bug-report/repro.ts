/**
 * Bug: signTransaction() fails with "Cannot read properties of undefined (reading 'toLowerCase')"
 * when calling it on a wallet created in a PREVIOUS session.
 *
 * signTypedData() works fine on the same wallet.
 *
 * Reproduction steps:
 *   1. cp .env.example .env && fill in credentials
 *   2. npm install
 *   3. npm run repro
 *
 *   First run creates a wallet and saves its address to .wallet-address
 *   Second run tries to sign with that wallet — signTypedData succeeds, signTransaction fails.
 *
 * Versions:
 *   @dynamic-labs-wallet/node: 0.0.320
 *   @dynamic-labs-wallet/node-evm: 0.0.320
 *   Node: v24.13.1 (also tested on v20)
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';

const WALLET_FILE = '.wallet-address';

async function main() {
  const client = new DynamicEvmWalletClient({
    environmentId: process.env.DYNAMIC_ENVIRONMENT_ID!,
  });
  await client.authenticateApiToken(process.env.DYNAMIC_AUTH_TOKEN!);

  // --- Step 1: Get or create a wallet ---
  let address: string;

  if (existsSync(WALLET_FILE)) {
    address = readFileSync(WALLET_FILE, 'utf-8').trim();
    console.log(`Using existing wallet: ${address}`);
    console.log('(This was created in a previous session — this is the bug trigger)\n');
  } else {
    console.log('No wallet found — creating one...');
    const wallet = await client.createWalletAccount({
      thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
      backUpToClientShareService: true,
    });
    address = wallet.accountAddress;
    writeFileSync(WALLET_FILE, address);
    console.log(`Created wallet: ${address}`);
    console.log(`Saved to ${WALLET_FILE}`);
    console.log('\nRun this script again to reproduce the bug.\n');
    console.log('On second run, signTypedData will work but signTransaction will fail.');
    return;
  }

  // --- Step 2: Verify getWalletByAddress works ---
  console.log('1. getWalletByAddress (public API)...');
  try {
    const wallet = await (client as any).getWalletByAddress(address);
    console.log(`   ✅ Found wallet: ${wallet.walletId}\n`);
  } catch (e: any) {
    console.log(`   ❌ Failed: ${e.message}\n`);
  }

  // --- Step 3: signTypedData (works) ---
  console.log('2. signTypedData...');
  try {
    const sig = await client.signTypedData({
      accountAddress: address,
      typedData: {
        domain: { name: 'Test', version: '1', chainId: 8453 },
        types: { Test: [{ name: 'value', type: 'uint256' }] },
        primaryType: 'Test',
        message: { value: '1' },
      },
    });
    console.log(`   ✅ Success: ${sig.slice(0, 20)}...\n`);
  } catch (e: any) {
    console.log(`   ❌ Failed: ${e.message}\n`);
  }

  // --- Step 4: signTransaction (fails) ---
  console.log('3. signTransaction...');
  try {
    const tx = await client.signTransaction({
      accountAddress: address,
      transaction: {
        to: '0x0000000000000000000000000000000000000001' as `0x${string}`,
        value: 0n,
      },
    });
    console.log(`   ✅ Success: ${tx.slice(0, 20)}...\n`);
  } catch (e: any) {
    console.log(`   ❌ Failed: ${e.message}`);
    console.log(`   Stack: ${e.stack?.split('\n').slice(0, 4).join('\n   ')}\n`);
  }

  // --- Summary ---
  console.log('---');
  console.log('Expected: both signTypedData and signTransaction succeed');
  console.log('Actual: signTypedData works, signTransaction throws TypeError');
  console.log('');
  console.log('Root cause: signTransaction → verifyPassword → getWallet → getWalletByAddress');
  console.log('uses an internal fallback that iterates user.verifiedCredentials and calls');
  console.log('vc.address.toLowerCase() without null-checking vc.address.');
  console.log('');
  console.log('The public getWalletByAddress() API works fine (step 1 above).');
  console.log('The internal fallback at node/index.esm.js:1535 does not.');
}

main().catch(err => console.error('Failed:', err.message));
