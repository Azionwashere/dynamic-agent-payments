---
name: fund-wallet
description: |
  Help the user fund their agent wallet. Show wallet addresses and
  guide them through sending tokens.
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

## Step 2: Guide Funding

Tell the user to send tokens to the wallet address from any wallet or exchange:
- Remind them of the address (plain text so they can copy it)
- The EVM address works on all EVM chains (Ethereum, Base, Polygon, etc.)
- They can send any supported token on any chain

## Step 3: Confirm

Offer to check the balance once they've sent tokens:
- Call `check_balance` with the appropriate chain and networkId
- Confirm when new tokens are detected

## Important

- Always show the wallet address as plain text — the user needs to be able to copy it
- If the user just wants to see their address (not fund), just show it without the funding flow
