#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig, chainFamily } from './lib/config.js';
import { createEventEmitter } from './lib/events.js';
import { payX402 } from './mcp/tools/pay-x402.js';
import { checkBalance } from './mcp/tools/check-balance.js';
import { fundAgent } from './mcp/tools/fund-agent.js';
import { getTxStatus } from './mcp/tools/tx-status.js';

const USAGE = `
dynamic-agent-payments — CLI for x402 payments via Dynamic wallets

Commands:
  pay <url>          Pay for an x402-protected resource
  balance            Check agent wallet balances
  fund               Fund agent wallet via checkout swap/bridge
  status <txId>      Check transaction status
  dashboard          Open live activity dashboard

Run any command with --help for details.
`.trim();

const PAY_USAGE = `
Usage: dynamic-agent-payments pay <url> [options]

Hit a URL. If it returns 402, detect the protocol (MPP or Coinbase x402),
sign the payment via Dynamic MPC wallet, and retry.

Options:
  --method   HTTP method (GET or POST, default: GET)
  --body     Request body for POST (JSON string)
  --memo     Payment metadata (JSON string, e.g. '{"purpose":"price-feed"}')
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
    case 'pay':       await cmdPay(rest); break;
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
