#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createEventEmitter } from '../lib/events.js';
import { loadConfig } from '../lib/config.js';
import { checkBalance, checkBalanceSchema } from './tools/check-balance.js';
import { fundAgent, fundAgentSchema } from './tools/fund-agent.js';
import { payX402, payX402Schema } from './tools/pay-x402.js';
import { getTxStatus, txStatusSchema } from './tools/tx-status.js';

// Validate config at startup
loadConfig();

const emit = createEventEmitter();

const server = new McpServer({
  name: 'dynamic-agent-payments',
  version: '0.1.0',
});

server.tool(
  'check_balance',
  'Check the agent wallet balance on a specific chain and token',
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
  'Fund the agent wallet by swapping/bridging tokens via Dynamic Checkout API. ' +
  'Use when the agent needs tokens on a different chain to pay for a service.',
  fundAgentSchema.shape,
  async (input) => {
    const result = await fundAgent(input as any, emit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  'pay_x402',
  'Pay for an x402-protected service. Supports both protocols: ' +
  'MPP (pass wwwAuthenticateHeader + url) and Coinbase x402 (pass paymentRequiredHeader). ' +
  'Signs an EIP-712 payment authorization. For MPP, retries the request with Authorization header.',
  payX402Schema.shape,
  async (input) => {
    const result = await payX402(input as any, emit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  'get_transaction_status',
  'Check the status of a Checkout API transaction (funding flow). Returns execution and settlement state.',
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
