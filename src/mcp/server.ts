#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createEventEmitter } from '../lib/events.js';
import { loadConfig } from '../lib/config.js';
import { payX402, payX402Schema } from './tools/pay-x402.js';
import { getWallets } from './tools/get-wallets.js';
import { checkBalance, checkBalanceSchema } from './tools/check-balance.js';
import { fundAgent, fundAgentSchema } from './tools/fund-agent.js';
import { getTxStatus, txStatusSchema } from './tools/tx-status.js';

// Validate config at startup
loadConfig();

const emit = createEventEmitter();

const server = new McpServer({
  name: 'dynamic-agent-payments',
  version: '0.1.0',
});

server.tool(
  'pay_x402',
  'Pay for an x402-protected service. Pass the URL — the tool handles everything: ' +
  'detects payment requirements, signs via Dynamic wallet, retries the request. ' +
  'Supports both MPP (WWW-Authenticate: Payment) and Coinbase x402 protocols.',
  payX402Schema.shape,
  async (input) => {
    const result = await payX402(input as any, emit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  'get_wallets',
  'Get the agent wallet addresses and balances. Returns EVM and SOL wallet addresses. ' +
  'Use this when the user asks to see their wallets, check addresses, or fund their wallet.',
  {},
  async () => {
    const wallets = await getWallets();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(wallets, null, 2) }],
    };
  },
);

server.tool(
  'check_balance',
  'Check token balances for the agent wallet on a specific chain. ' +
  'Returns native and token balances. Use networkId to filter to a specific chain (e.g. "8453" for Base).',
  checkBalanceSchema.shape,
  async (input) => {
    const result = await checkBalance(input as any, emit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  'fund_agent',
  'Fund the agent wallet by swapping or bridging tokens via Dynamic Checkout. ' +
  'Specify source chain/token and destination chain/token. Handles the full flow: ' +
  'checkout creation, quoting, signing, broadcasting, and settlement polling.',
  fundAgentSchema.shape,
  async (input) => {
    const result = await fundAgent(input as any, emit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  'tx_status',
  'Check the status of a Checkout API transaction. Pass the transaction ID (UUID) ' +
  'returned from a fund operation. Returns execution and settlement state.',
  txStatusSchema.shape,
  async (input) => {
    const result = await getTxStatus(input as any);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
