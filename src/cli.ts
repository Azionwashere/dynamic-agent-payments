#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig, chainFamily } from './lib/config.js';
import { createEventEmitter } from './lib/events.js';
import { ensureWallet } from './lib/wallet.js';
import { payX402 } from './mcp/tools/pay-x402.js';
import { checkBalance } from './mcp/tools/check-balance.js';
import { fundAgent } from './mcp/tools/fund-agent.js';
import { getTxStatus } from './mcp/tools/tx-status.js';
import { detectProtocol, parseMppChallenges, selectChallenge, handleMppPaywall } from './lib/x402-handler.js';
import { emitEvent } from './lib/events.js';

const USAGE = `
dynamic-agent-payments — CLI for x402 payments via Dynamic wallets

Commands:
  wallet             Show your wallet addresses
  balance            Check token balances
  pay <url>          Pay for an x402-protected resource
  pay-mpp <url>      Pay for an MPP-protected resource
  fund               Fund wallet via checkout swap/bridge
  status <txId>      Check transaction status
  dashboard          Open live activity dashboard

Run any command with --help for details.
`.trim();

const PAY_USAGE = `
Usage: dynamic-agent-payments pay <url> [options]

Pay for an x402-protected resource. Handles the full flow:
detect payment requirements, sign via Dynamic wallet, retry.
Supports both x402 v1 (Coinbase) and v2 (Fireblocks facilitator).

Options:
  --method   HTTP method (GET or POST, default: GET)
  --body     Request body for POST (JSON string)
  --memo     Payment metadata (JSON string, e.g. '{"purpose":"price-feed"}')
`.trim();

const PAY_MPP_USAGE = `
Usage: dynamic-agent-payments pay-mpp <url> [options]

Pay for an MPP-protected resource (RFC draft-httpauth-payment).
Handles the full flow: parse WWW-Authenticate: Payment challenge,
sign via Dynamic wallet, retry with Authorization: Payment credential.

Currently supports EIP-712 methods (transferwithauth, permit, opdata).
Tempo and Solana methods coming when Dynamic Node SDK adds support.

Options:
  --method   HTTP method (GET or POST, default: GET)
  --body     Request body for POST (JSON string)
`.trim();

const BALANCE_USAGE = `
Usage: dynamic-agent-payments balance [options]

Check token balances for the agent wallet.

Options:
  --chain       Blockchain family: EVM or SOL (default: EVM)
  --network-id  Network ID (e.g. "8453" for Base, "1" for Ethereum)
`.trim();

const FUND_USAGE = `
Usage: dynamic-agent-payments fund [options]

Fund the agent wallet by swapping/bridging tokens via Dynamic Checkout.

Required:
  --amount             Amount in USD
  --from-chain-id      Source chain ID (e.g. "1" for Ethereum, "101" for Solana)
  --from-token         Source token address (0x0000...0000 for native)
  --to-chain-id        Destination chain ID (e.g. "8453" for Base)
  --to-token-address   Settlement token contract address

Optional:
  --from-chain-name    Override source chain family (default: inferred from chain ID)
  --to-chain-name      Override destination chain family (default: inferred from chain ID)
  --to-token-symbol    Settlement token symbol (default: USDC)
  --to-token-decimals  Settlement token decimals (default: 6)
  --slippage           Slippage tolerance as decimal (e.g. 0.005 for 0.5%)
  --memo               Metadata (JSON string)
`.trim();

const STATUS_USAGE = `
Usage: dynamic-agent-payments status <txId>

Check the status of a Checkout API transaction.
`.trim();

function fatal(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseJson(raw: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    fatal(`Invalid JSON for --${label}: ${raw}`);
  }
}

async function cmdWallet() {
  loadConfig();
  const evmWallet = await ensureWallet('EVM');
  console.log('');
  console.log('EVM:  ' + evmWallet.accountAddress);
  try {
    const solWallet = await ensureWallet('SOL');
    console.log('SOL:  ' + solWallet.accountAddress);
  } catch { /* SOL not configured */ }
  console.log('');
}

async function cmdPay(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      method: { type: 'string', short: 'm' },
      body: { type: 'string', short: 'b' },
      memo: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help) { console.error(PAY_USAGE); process.exit(0); }

  const url = positionals[0];
  if (!url) fatal('Missing URL. Usage: dynamic-agent-payments pay <url>');

  const method = (values.method?.toUpperCase() ?? 'GET') as 'GET' | 'POST';
  if (method !== 'GET' && method !== 'POST') fatal('--method must be GET or POST');

  loadConfig();
  const emit = createEventEmitter();
  console.error(`Requesting ${url}...`);

  const result = await payX402({
    url,
    method,
    body: values.body,
    memo: parseJson(values.memo, 'memo'),
  }, emit);

  console.log(JSON.stringify(result, null, 2));
}

async function cmdPayMpp(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      method: { type: 'string', short: 'm' },
      body: { type: 'string', short: 'b' },
    },
    allowPositionals: true,
  });

  if (values.help) { console.error(PAY_MPP_USAGE); process.exit(0); }

  const url = positionals[0];
  if (!url) fatal('Missing URL. Usage: dynamic-agent-payments pay-mpp <url>');

  const method = (values.method?.toUpperCase() ?? 'GET') as 'GET' | 'POST';
  if (method !== 'GET' && method !== 'POST') fatal('--method must be GET or POST');

  loadConfig();
  const emit = createEventEmitter();
  console.error(`Requesting ${url}...`);

  // Step 1: Make the initial request — expect 402
  const initialRes = await fetch(url, {
    method,
    ...(values.body ? { body: values.body, headers: { 'Content-Type': 'application/json' } } : {}),
  });

  if (initialRes.ok) {
    const responseText = await initialRes.text();
    let data: unknown;
    try { data = JSON.parse(responseText); } catch { data = responseText; }
    console.log(JSON.stringify({ accessGranted: true, protocol: 'mpp', responseData: data }, null, 2));
    return;
  }

  if (initialRes.status !== 402) {
    fatal(`Expected 402 Payment Required, got ${initialRes.status}`);
  }

  // Step 2: Check for WWW-Authenticate: Payment header
  const wwwAuth = initialRes.headers.get('www-authenticate');
  if (!wwwAuth || !wwwAuth.includes('Payment ')) {
    fatal('Server returned 402 but no WWW-Authenticate: Payment header. This is not an MPP endpoint — try "pay" for Coinbase x402.');
  }

  emitEvent(emit, 'mpp_challenge_received', { url });
  console.error('MPP challenge received, signing...');

  // Step 3: Parse, sign, build credential
  const result = await handleMppPaywall(wwwAuth);
  if (!result) fatal('Failed to handle MPP challenge — no supported payment method found.');

  emitEvent(emit, 'mpp_credential_built', { method: result.challenge.method });
  console.error(`Retrying with ${result.challenge.method} credential...`);

  // Step 4: Retry with Authorization: Payment credential
  const retryRes = await fetch(url, {
    method,
    headers: {
      'Authorization': result.authorizationHeader,
      ...(values.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(values.body ? { body: values.body } : {}),
  });

  const responseText = await retryRes.text();
  let responseData: unknown;
  try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

  const receipt = retryRes.headers.get('payment-receipt');
  let parsedReceipt: unknown = receipt;
  if (receipt) {
    try { parsedReceipt = JSON.parse(Buffer.from(receipt, 'base64url').toString('utf-8')); } catch { /* keep raw */ }
  }

  emitEvent(emit, 'mpp_complete', {
    status: retryRes.status,
    accessGranted: retryRes.ok,
    method: result.challenge.method,
  });

  console.log(JSON.stringify({
    accessGranted: retryRes.ok,
    protocol: 'mpp',
    method: result.challenge.method,
    receipt: parsedReceipt ?? null,
    responseData,
  }, null, 2));
}

async function cmdBalance(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      chain: { type: 'string', short: 'c' },
      'network-id': { type: 'string' },
    },
  });

  if (values.help) { console.error(BALANCE_USAGE); process.exit(0); }

  const chain = (values.chain?.toUpperCase() ?? 'EVM') as 'EVM' | 'SOL';
  if (chain !== 'EVM' && chain !== 'SOL') fatal('--chain must be EVM or SOL');

  loadConfig();
  const emit = createEventEmitter();
  console.error(`Checking ${chain} balances...`);

  const result = await checkBalance({
    chain,
    networkId: values['network-id'],
  }, emit);

  console.log(JSON.stringify(result, null, 2));
}

async function cmdFund(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      amount: { type: 'string' },
      'from-chain-id': { type: 'string' },
      'from-chain-name': { type: 'string' },
      'from-token': { type: 'string' },
      'to-chain-id': { type: 'string' },
      'to-chain-name': { type: 'string' },
      'to-token-address': { type: 'string' },
      'to-token-symbol': { type: 'string' },
      'to-token-decimals': { type: 'string' },
      slippage: { type: 'string' },
      memo: { type: 'string' },
    },
  });

  if (values.help) { console.error(FUND_USAGE); process.exit(0); }

  const required = ['amount', 'from-chain-id', 'from-token', 'to-chain-id', 'to-token-address'] as const;
  for (const key of required) {
    if (!values[key]) fatal(`Missing required --${key}. Run with --help for usage.`);
  }

  const fromChainName = values['from-chain-name']
    ? values['from-chain-name'].toUpperCase() as 'EVM' | 'SOL'
    : chainFamily(values['from-chain-id']!);
  const toChainName = values['to-chain-name']
    ? values['to-chain-name'].toUpperCase() as 'EVM' | 'SOL'
    : chainFamily(values['to-chain-id']!);

  if (fromChainName !== 'EVM' && fromChainName !== 'SOL') fatal('--from-chain-name must be EVM or SOL');
  if (toChainName !== 'EVM' && toChainName !== 'SOL') fatal('--to-chain-name must be EVM or SOL');

  loadConfig();
  const emit = createEventEmitter();
  console.error(`Funding $${values.amount} from ${fromChainName}:${values['from-chain-id']} → ${toChainName}:${values['to-chain-id']}...`);

  const result = await fundAgent({
    fromChainId: values['from-chain-id']!,
    fromChainName,
    fromTokenAddress: values['from-token']!,
    toChainId: values['to-chain-id']!,
    toChainName,
    toTokenAddress: values['to-token-address']!,
    toTokenSymbol: values['to-token-symbol'] ?? 'USDC',
    toTokenDecimals: values['to-token-decimals'] ? parseInt(values['to-token-decimals'], 10) : 6,
    amountUsd: values.amount!,
    slippage: values.slippage ? parseFloat(values.slippage) : undefined,
    memo: parseJson(values.memo, 'memo'),
  }, emit);

  console.log(JSON.stringify(result, null, 2));
}

async function cmdStatus(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) { console.error(STATUS_USAGE); process.exit(0); }

  const txId = positionals[0];
  if (!txId) fatal('Missing transaction ID. Usage: dynamic-agent-payments status <txId>');

  loadConfig();
  console.error(`Checking status for ${txId}...`);

  const result = await getTxStatus({ transactionId: txId });
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error(USAGE);
    process.exit(0);
  }

  switch (command) {
    case 'wallet':    await cmdWallet(); break;
    case 'pay':       await cmdPay(rest); break;
    case 'pay-mpp':   await cmdPayMpp(rest); break;
    case 'balance':   await cmdBalance(rest); break;
    case 'fund':      await cmdFund(rest); break;
    case 'status':    await cmdStatus(rest); break;
    case 'dashboard': await import('./dashboard/server.js'); break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
