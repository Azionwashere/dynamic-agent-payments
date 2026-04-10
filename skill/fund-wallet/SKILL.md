---
name: fund-wallet
description: |
  Help the user fund their agent wallet. Show wallet addresses, offer funding
  options (direct transfer or browser-based wallet connection).
allowed-tools:
  - Bash
  - Read
---

# Fund Wallet

When the user asks to fund their wallet, add funds, or send tokens:

## Step 1: Show Wallets

Call `get_wallets` to get the agent's wallet addresses. Present them clearly:

**Your wallets:**
- **EVM:** `{evm.address}`
- **SOL:** `{sol.address}` (if available)

If any balances are returned, show them too.

## Step 2: Offer Funding Options

Ask the user how they want to fund:

1. **Connect wallet** — opens a browser to connect MetaMask or another wallet and send tokens
2. **Direct transfer** — the user copies the address and sends tokens manually from any wallet or exchange

## Step 3: Handle Choice

**If "direct transfer":**
- Remind them of the address
- Tell them to send any supported token on any chain
- Offer to check the balance once they've sent

**If "connect wallet" or "MetaMask":**
- Call `fund_via_browser` to open a browser page
- Tell the user to complete the transaction in the browser
- Poll `get_wallets` periodically to detect when funds arrive
- Confirm when new tokens are detected

## Important

- Always show the wallet address as plain text — the user needs to be able to copy it
- If the user just wants to see their address (not fund), just show it without the funding options
- The EVM address works on all EVM chains (Ethereum, Base, Polygon, etc.)
