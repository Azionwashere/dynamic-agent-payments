#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createEventEmitter } from '../lib/events.js';
import { loadConfig } from '../lib/config.js';
import { payX402, payX402Schema } from './tools/pay-x402.js';
import { getWallets } from './tools/get-wallets.js';

// Validate config at startup
loadConfig();

const emit = createEventEmitter();

const server = new McpServer({
  name: 'dynamic-agent-payments',
  version: '0.1.0',
});

server.tool(
  'pay_x402',
  'Pay for an x402-protected service. Pass the URL and the payment header from an HTTP 402 response. ' +
  'Handles everything: checks wallet balance, swaps tokens if needed, signs the payment, and retries the request. ' +
  'Supports both MPP (WWW-Authenticate: Payment) and Coinbase x402 (PAYMENT-REQUIRED) protocols.',
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
