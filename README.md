# Dynamic Agent Payments

Let AI agents pay for x402-protected APIs autonomously. One MCP tool, two env vars.

## What it does

When your Claude Code agent hits a paid API (HTTP 402), it automatically:
1. Detects the payment requirements
2. Signs a crypto payment using a Dynamic embedded wallet
3. Retries the request with proof of payment
4. Returns the data

No manual intervention. Works with any x402-protected service.

## Quick Start

```bash
git clone https://github.com/YOUR_ORG/dynamic-agent-payments.git
cd dynamic-agent-payments
npm install
npm run build
```

Create `.env` with your Dynamic credentials:
```bash
DYNAMIC_ENVIRONMENT_ID=your-env-id
DYNAMIC_AUTH_TOKEN=dyn_your-token
```

Get these from the [Dynamic dashboard](https://app.dynamic.xyz).

Add to Claude Code (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "dynamic-agent-payments": {
      "command": "node",
      "args": ["/path/to/dynamic-agent-payments/dist/mcp/server.js"],
      "cwd": "/path/to/dynamic-agent-payments"
    }
  }
}
```

Install the skill:
```bash
cp -r skill/ ~/.claude/skills/agent-pay/
```

Restart Claude Code. Done.

## How it works

Your agent gets one new tool: `pay_x402`. When it encounters an HTTP 402 response, it calls this tool with the URL. The tool handles everything — detecting the payment protocol, signing with the agent's Dynamic wallet, and retrying the request.

```
Agent: "Fetch crypto prices from https://x402-api.fly.dev/api/price-feed"

Claude → GET https://x402-api.fly.dev/api/price-feed
       ← 402 Payment Required (0.001 USDC on Base)
       → calls pay_x402({ url: "https://x402-api.fly.dev/api/price-feed" })
         ├── Signs TransferWithAuthorization via Dynamic MPC wallet
         └── Retries with X-PAYMENT header
       ← 200 OK + crypto price data

Agent: "BTC is at $66,559, ETH at $1,827..."
```

## Supported Protocols

| Protocol | Format | Examples |
|----------|--------|---------|
| Coinbase x402 v1 | JSON body with `accepts[]` | x402-api.fly.dev, 402payment-test.com |
| x402 header | `PAYMENT-REQUIRED` header | Various x402 services |
| MPP | `WWW-Authenticate: Payment` | Fireblocks-based facilitators |

## What you need

- A [Dynamic](https://dynamic.xyz) account (free to create)
- USDC on Base in your agent's wallet (the agent creates its own wallet on first use)
- Claude Code

## Live Dashboard

Watch payments in real-time:
```bash
npm run dashboard
# Open http://localhost:3456
```

## Architecture

```
Claude Code Agent
  │
  ├── Skill (SKILL.md) — teaches agent when to use pay_x402
  │
  └── MCP Server (stdio) — one tool: pay_x402
        │
        ├── x402 Handler — detects protocol, signs EIP-712, retries request
        ├── Dynamic Wallet — server-side MPC signing (no private keys)
        └── Checkout Client — cross-chain swaps if agent has wrong token
```

The agent's wallet is a Dynamic embedded wallet using MPC — no private keys are stored locally. All signing happens via Dynamic's infrastructure.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMIC_ENVIRONMENT_ID` | Yes | From Dynamic dashboard |
| `DYNAMIC_AUTH_TOKEN` | Yes | API token starting with `dyn_` |
| `MIN_FUNDING_THRESHOLD_USD` | No | Minimum swap amount (default $1.00) |

## Development

```bash
npm run dev        # Watch mode
npm run test       # Run tests (42 passing)
npm run build      # Compile TypeScript
npm run dashboard  # Start activity feed UI
```
