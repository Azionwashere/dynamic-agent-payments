# Dynamic Agent Payments

**Your AI agent can pay for services with any token, on any chain.**

Most x402 services demand USDC on Base. Your agent has ETH on Ethereum. Or SOL on Solana. Or MATIC on Polygon. With Dynamic Agent Payments, that doesn't matter — the agent automatically swaps and bridges to whatever the merchant needs, then pays. One tool, fully autonomous.

## The Problem

AI agents are increasingly hitting paid APIs that use the x402 payment protocol. But agents hold different tokens on different chains than what merchants accept. Today, someone has to manually:
1. Check what token the merchant wants
2. Bridge/swap to the right token on the right chain
3. Sign the payment
4. Retry the request

This tool makes that invisible.

## What Happens

```
Agent needs crypto price data from an x402-protected API

→ GET https://x402-api.fly.dev/api/price-feed
← 402: "Pay 0.001 USDC on Base"

Agent's wallet has ETH on Base — no USDC.

→ Dynamic Checkout API: swap 0.001 ETH → USDC on Base
→ Sign TransferWithAuthorization via Dynamic MPC wallet
→ Retry request with payment proof
← 200 OK + price data

Total time: ~30 seconds. Zero human involvement.
```

The agent can pay from **ETH, SOL, MATIC, USDC, or any supported token** across **Ethereum, Base, Solana, Polygon, Arbitrum, and more**. Dynamic's Checkout API handles the routing, swapping, and bridging — the agent just says "pay."

## Quick Start

```bash
git clone https://github.com/YOUR_ORG/dynamic-agent-payments.git
cd dynamic-agent-payments
npm install && npm run build
```

Create `.env`:
```bash
DYNAMIC_ENVIRONMENT_ID=your-env-id
DYNAMIC_AUTH_TOKEN=dyn_your-token
```

Get these from [app.dynamic.xyz](https://app.dynamic.xyz).

Add to Claude Code settings (`~/.claude/settings.json`):
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

Restart Claude Code. Your agent can now pay for x402 services.

## How It Works

**One MCP tool: `pay_x402`**

The agent passes a URL. The tool handles everything:

1. **Hits the URL** — gets the 402 payment requirements
2. **Checks the wallet** — does the agent have the right token?
3. **Swaps if needed** — uses Dynamic's Checkout API to convert any token → the required token, across any chain
4. **Signs the payment** — EIP-712 via Dynamic's MPC wallet (no private keys stored locally)
5. **Retries the request** — submits proof of payment, returns the data

The agent's wallet is created automatically on first use. Fund it with any token on any chain — the Checkout API handles the rest.

## Supported Chains & Tokens

**Source (what your agent holds):** ETH, USDC, SOL, MATIC, BNB, and any token on Ethereum, Base, Solana, Polygon, Arbitrum, BNB Chain, Sui, Tron

**Settlement (what merchants accept):** Routed automatically via Dynamic's Checkout API — cheapest, fastest, or preferred order

**Payment Protocols:** Coinbase x402, MPP (HTTP Payment Authentication Scheme)

## Why Dynamic

Other solutions require the agent to already have the exact token the merchant wants. Dynamic is the only platform that owns the full stack:

| Layer | What | Why It Matters |
|-------|------|----------------|
| **Embedded Wallet** | MPC wallet across all chains | Agent has one identity, works everywhere |
| **Checkout API** | Cross-chain swap/bridge engine | Any token → merchant's preferred token |
| **x402 Signing** | EIP-712 via server-side MPC | Gasless, no private keys on disk |

## Live Dashboard

Watch your agent's payments in real-time:
```bash
npm run dashboard
# Open http://localhost:3456
```

Shows every step: paywall detection → balance check → swap → signing → payment → access.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMIC_ENVIRONMENT_ID` | Yes | From Dynamic dashboard |
| `DYNAMIC_AUTH_TOKEN` | Yes | API token (starts with `dyn_`) |
| `MIN_FUNDING_THRESHOLD_USD` | No | Minimum swap amount to avoid bridging for tiny payments (default $1.00) |

## Development

```bash
npm run dev        # Watch mode
npm run test       # 42 tests passing
npm run build      # Compile
npm run dashboard  # Activity feed UI
```
