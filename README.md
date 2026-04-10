# Dynamic Agent Payments

**Your AI agent can pay for services with any token, on any chain.**

Most x402 services demand USDC on Base. Your agent has ETH on Ethereum. Or SOL on Solana. Or MATIC on Polygon. With Dynamic Agent Payments, that doesn't matter — the agent automatically swaps and bridges to whatever the merchant needs, then pays. One CLI command, fully autonomous.

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

Create your agent wallet:
```bash
npx dynamic-agent-payments wallet
```

This creates an EVM wallet and saves `WALLET_ADDRESS` and `WALLET_ID` to `.env` automatically.

## CLI Usage

```bash
# Create or show your agent wallet
npx dynamic-agent-payments wallet

# List all wallets in your environment (find previous wallets)
npx dynamic-agent-payments wallet list

# Switch to a different wallet
npx dynamic-agent-payments wallet use 0xYourAddress

# Check wallet balances
npx dynamic-agent-payments balance

# Pay for a Coinbase x402-protected resource
npx dynamic-agent-payments pay https://x402-api.fly.dev/api/price-feed

# Pay for an MPP-protected resource (Stripe, custom MPP servers)
npx dynamic-agent-payments pay-mpp https://api.example.com/resource

# Fund agent wallet (swap ETH on Ethereum → USDC on Base)
npx dynamic-agent-payments fund --amount 5.00 \
  --from-chain-id 1 --from-token 0x0000...0000 \
  --to-chain-id 8453 --to-token-address 0x8335...2913

# Check transaction status
npx dynamic-agent-payments status tx_abc123

# Live activity dashboard
npx dynamic-agent-payments dashboard
```

All commands output JSON to stdout and status to stderr, so they're pipeable:
```bash
npx dynamic-agent-payments pay https://x402-api.fly.dev/api/price-feed 2>/dev/null | jq '.responseData.data'
```

Run any command with `--help` for all options.

## How It Works

**One command: `pay`**

The agent passes a URL. The CLI handles everything:

1. **Hits the URL** — gets the 402 payment requirements
2. **Checks the wallet** — does the agent have the right token?
3. **Swaps if needed** — uses Dynamic's Checkout API to convert any token → the required token, across any chain
4. **Signs the payment** — EIP-712 via Dynamic's MPC wallet (no private keys stored locally)
5. **Retries the request** — submits proof of payment, returns the data

Run `wallet` to create your agent's wallet (saved to `.env`). Fund it with any token on any chain — the Checkout API handles the rest. Use `wallet list` to see all wallets in your environment and `wallet use` to switch between them.

## Claude Code Integration (MCP)

For Claude Code users, this also ships as an MCP server:

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

Install the skill for auto-triggering on 402 responses:
```bash
cp -r skill/ ~/.claude/skills/agent-pay/
```

Restart Claude Code. Your agent can now pay for x402 services automatically.

## Supported Chains & Tokens

**Source (what your agent holds):** ETH, USDC, SOL, MATIC, BNB, and any token on Ethereum, Base, Solana, Polygon, Arbitrum, BNB Chain, Sui, Tron

**Settlement (what merchants accept):** Routed automatically via Dynamic's Checkout API — cheapest, fastest, or preferred order

**Payment Protocols:**
- **Coinbase x402** — `pay` command (TransferWithAuthorization on Base)
- **MPP** — `pay-mpp` command (EIP-712 methods: transferwithauth, permit, opdata)

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
| `WALLET_ADDRESS` | Yes | EVM wallet address (auto-set by `wallet` command) |
| `WALLET_ID` | Yes | EVM wallet ID (auto-set by `wallet` command) |
| `SOL_WALLET_ADDRESS` | No | Solana wallet address (auto-set by `wallet` command) |
| `SOL_WALLET_ID` | No | Solana wallet ID (auto-set by `wallet` command) |
| `MIN_FUNDING_THRESHOLD_USD` | No | Minimum swap amount to avoid bridging for tiny payments (default $1.00) |

## Development

```bash
npm run build      # Compile
npm run cli        # Run CLI
npm run mcp        # Run MCP server
npm run dev        # Watch mode
npm run test       # 72 tests passing
npm run dashboard  # Activity feed UI
```
