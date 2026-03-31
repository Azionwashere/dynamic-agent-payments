---
name: agent-pay
description: |
  Handle x402 paywalls autonomously using Dynamic's Checkout API and delegated MPC wallets.
  When you encounter an HTTP 402 response with a PAYMENT-REQUIRED header, this skill
  teaches you how to fund your wallet and pay for the service.
allowed-tools:
  - Bash
  - Read
---

# Agent Payments — x402 + Dynamic Checkout

You have access to an MCP server (`dynamic-agent-payments`) with 4 tools for handling crypto payments.

## When you hit an HTTP 402 response

1. Check if the response has a `PAYMENT-REQUIRED` header (base64-encoded JSON). If not, this is a normal 402 — do NOT try to pay.

2. Call `pay_x402` with the header value:
   ```
   pay_x402({ paymentRequiredHeader: "<the base64 value>" })
   ```

3. If `pay_x402` fails with "insufficient balance":
   - Call `check_balance` to see what tokens you have and where
   - Call `fund_agent` to swap/bridge tokens to the required chain
   - Retry `pay_x402`

4. After successful payment, retry the original HTTP request with the payment signature.

## Tools

### check_balance
Check wallet balance on a specific chain.
```json
{ "chain": "EVM", "chainId": "8453", "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
```

### fund_agent
Fund the agent wallet by swapping/bridging tokens cross-chain.
```json
{
  "fromChainId": "1",
  "fromChainName": "EVM",
  "fromTokenAddress": "0x0000000000000000000000000000000000000000",
  "toChainId": "8453",
  "toChainName": "EVM",
  "toTokenSymbol": "USDC",
  "toTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "toTokenDecimals": 6,
  "amountUsd": "5.00"
}
```

### pay_x402
Pay for an x402-protected service.
```json
{ "paymentRequiredHeader": "<base64-encoded PAYMENT-REQUIRED header value>" }
```

### get_transaction_status
Check status of a funding transaction.
```json
{ "transactionId": "ctx_xyz789..." }
```

## Important

- Do NOT attempt to pay for non-x402 402 responses (ones without PAYMENT-REQUIRED header)
- Fund in reasonable amounts ($5-10 minimum) to avoid paying bridge fees for sub-dollar payments
- The agent wallet uses delegated MPC signing — no private keys are held locally
